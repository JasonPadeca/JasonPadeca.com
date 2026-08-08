-- =============================================================================
-- 0016_meeting_dates.sql
-- The weeks themselves.
--
-- Until now a date was just a date. semesters.meeting_weekday could say "we meet
-- on Thursdays", which is enough to offer a parent sensible options and nothing
-- more. It cannot say the co-op is not meeting on Thanksgiving, and it gives
-- nothing for a handout, a cancellation, or a note to attach to.
--
-- A meeting is the unit almost everything in the portal actually hangs off:
--
--   * "Is my child down as absent this week?"
--   * "What did the teacher send home last Thursday?"
--   * "Is there even class this week?"
--
-- All three are questions about a WEEK, and a week has to be a row before any
-- of them can be answered. This is that row — and it is also the calendar the
-- portal needs, arrived at from the other direction.
--
-- Absences move onto it. They were written against a free date, which accepted
-- any day inside the term: a parent could report an absence for a Tuesday and
-- nothing would object until somebody noticed the register did not match. Now a
-- date that is not a class day is an error, with a list of the days that are.
-- =============================================================================

select public.migration_guard('0016', '0015');

create table public.meeting_dates (
  id            uuid primary key default gen_random_uuid(),
  semester_id   uuid not null references public.semesters(id) on delete cascade,
  meets_on      date not null,

  -- A week that is on the calendar but is not happening. Kept rather than
  -- deleted, because "no class this week" is information a parent needs, and a
  -- missing row says nothing at all.
  cancelled     boolean not null default false,
  cancel_reason text,

  -- "Bring a packed lunch", "Picture day", "Last day of term".
  note          text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (semester_id, meets_on)
);

create index meeting_dates_semester_idx on public.meeting_dates (semester_id, meets_on);
create index meeting_dates_date_idx on public.meeting_dates (meets_on);

create trigger meeting_dates_touch before update on public.meeting_dates
  for each row execute function public.touch_updated_at();

alter table public.meeting_dates enable row level security;

create policy admin_all on public.meeting_dates
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

-- Every member can read the calendar. It is the least sensitive thing here —
-- which days the co-op meets — and the portal is unusable without it.
create policy member_reads on public.meeting_dates
  for select to authenticated
  using (public.is_family_member());

revoke all on public.meeting_dates from anon;
grant select on public.meeting_dates to authenticated;
grant all on public.meeting_dates to service_role;

-- =============================================================================
-- Fill a semester's calendar from its meeting weekday.
--
-- Idempotent, and deliberately additive: it never removes a date an
-- administrator has already adjusted. Re-running after extending the term adds
-- the new weeks and leaves cancellations and notes alone.
-- =============================================================================
create or replace function public.generate_meeting_dates(p_semester_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s       public.semesters;
  v_added integer;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into s from public.semesters where id = p_semester_id;
  if s.id is null then
    raise exception 'Semester not found';
  end if;

  if s.class_start_date is null or s.class_end_date is null then
    return jsonb_build_object('ok', false, 'error', 'no_dates',
      'message', 'Set the first and last class dates on this semester first.');
  end if;

  if s.meeting_weekday is null then
    return jsonb_build_object('ok', false, 'error', 'no_weekday',
      'message', 'Set which day of the week this semester meets first.');
  end if;

  with candidates as (
    select d::date as meets_on
      from generate_series(s.class_start_date, s.class_end_date, interval '1 day') d
     where extract(dow from d) = s.meeting_weekday
  )
  insert into public.meeting_dates (semester_id, meets_on)
  select p_semester_id, meets_on from candidates
  on conflict (semester_id, meets_on) do nothing;

  get diagnostics v_added = row_count;

  perform public.write_audit('meeting_dates_generated', 'semester', p_semester_id,
    jsonb_build_object('added', v_added));

  return jsonb_build_object('ok', true, 'added', v_added,
    'total', (select count(*) from public.meeting_dates where semester_id = p_semester_id));
end;
$$;

revoke execute on function public.generate_meeting_dates(uuid) from public, anon;
grant execute on function public.generate_meeting_dates(uuid) to authenticated;

-- =============================================================================
-- Move absences onto meetings.
--
-- There are only test rows at this point, so this converts what it can and does
-- not agonise over the rest. Doing it later, against a term of real data, would
-- be a different and much less pleasant job.
-- =============================================================================

-- Give every existing semester a calendar, so nothing is orphaned. Runs as the
-- migration's owner rather than through the admin-gated function above.
insert into public.meeting_dates (semester_id, meets_on)
select s.id, d::date
  from public.semesters s
  cross join lateral generate_series(s.class_start_date, s.class_end_date, interval '1 day') d
 where s.meeting_weekday is not null
   and s.class_start_date is not null
   and s.class_end_date is not null
   and extract(dow from d) = s.meeting_weekday
on conflict (semester_id, meets_on) do nothing;

-- Any date an absence already names becomes a meeting, even if it is not on the
-- usual weekday. Losing a reported absence to tidy modelling would be the wrong
-- trade.
insert into public.meeting_dates (semester_id, meets_on)
select a.semester_id, a.absence_date from public.absences a
on conflict (semester_id, meets_on) do nothing;

alter table public.absences
  add column if not exists meeting_id uuid references public.meeting_dates(id) on delete cascade;

update public.absences a
   set meeting_id = m.id
  from public.meeting_dates m
 where m.semester_id = a.semester_id
   and m.meets_on = a.absence_date
   and a.meeting_id is null;

alter table public.absences alter column meeting_id set not null;

-- The date now lives on the meeting. Two places holding it would eventually
-- disagree, and the meeting is the one that also knows about cancellations.
alter table public.absences drop constraint if exists absences_child_id_absence_date_key;
alter table public.absences drop column if exists absence_date;

create unique index if not exists absences_one_per_meeting
  on public.absences (child_id, meeting_id);

create index if not exists absences_meeting_idx on public.absences (meeting_id);

-- =============================================================================
-- report_absence, against meetings.
--
-- The date argument stays — a parent picks a day, not a row id — but it now has
-- to BE a class day. "That is not a class day" with the nearby ones listed is a
-- better answer than silently accepting a Tuesday.
-- =============================================================================
create or replace function public.report_absence(
  p_child_id   uuid,
  p_date       date,
  p_whole_day  boolean default true,
  p_period_ids uuid[] default '{}',
  p_reason     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin   boolean := public.is_active_admin();
  v_child   public.children;
  v_meeting public.meeting_dates;
  v_id      uuid;
  v_actor   text;
  v_count   integer;
  v_near    text;
begin
  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    return jsonb_build_object('ok', false, 'error', 'child_not_found');
  end if;

  if not v_admin and not (p_child_id = any(public.current_child_ids())) then
    return jsonb_build_object('ok', false, 'error', 'not_your_child');
  end if;

  v_actor := case when v_admin then 'admin' else 'family' end;

  select * into v_meeting from public.meeting_dates m
   where m.meets_on = p_date
   order by m.created_at
   limit 1;

  if v_meeting.id is null then
    select string_agg(to_char(m.meets_on, 'FMDay FMDD FMMonth'), ', ' order by m.meets_on)
      into v_near
      from (select meets_on from public.meeting_dates
             where meets_on >= p_date - 14 and meets_on <= p_date + 14
             order by meets_on limit 4) m;

    return jsonb_build_object('ok', false, 'error', 'not_a_class_day',
      'message', case when v_near is null
        then 'That is not a class day.'
        else 'That is not a class day. Nearby class days: ' || v_near || '.' end);
  end if;

  -- No class that week, so nothing to be absent from.
  if v_meeting.cancelled then
    return jsonb_build_object('ok', false, 'error', 'meeting_cancelled',
      'message', 'There is no class that day' ||
        coalesce(' — ' || v_meeting.cancel_reason, '') || '.');
  end if;

  if not p_whole_day then
    select count(*) into v_count
      from public.periods p
     where p.id = any(p_period_ids)
       and p.semester_id = v_meeting.semester_id
       and p.archived_at is null;

    if v_count = 0 then
      return jsonb_build_object('ok', false, 'error', 'no_periods',
        'message', 'Choose at least one period, or report the whole day.');
    end if;
  end if;

  insert into public.absences
    (child_id, semester_id, meeting_id, whole_day, reason, reported_by)
  values
    (p_child_id, v_meeting.semester_id, v_meeting.id, p_whole_day,
     nullif(trim(coalesce(p_reason, '')), ''), v_actor)
  on conflict (child_id, meeting_id) do update
    set whole_day   = excluded.whole_day,
        reason      = excluded.reason,
        reported_by = excluded.reported_by
  returning id into v_id;

  delete from public.absence_periods where absence_id = v_id;

  if not p_whole_day then
    insert into public.absence_periods (absence_id, period_id)
    select v_id, p.id
      from public.periods p
     where p.id = any(p_period_ids)
       and p.semester_id = v_meeting.semester_id
       and p.archived_at is null
    on conflict do nothing;
  end if;

  perform public.write_audit('absence_reported', 'child', p_child_id,
    jsonb_build_object('date', p_date, 'whole_day', p_whole_day,
                       'periods', to_jsonb(p_period_ids), 'reason', p_reason),
    v_actor, null);

  return jsonb_build_object('ok', true, 'absence_id', v_id);
end;
$$;

revoke execute on function public.report_absence(uuid, date, boolean, uuid[], text)
  from public, anon;
grant execute on function public.report_absence(uuid, date, boolean, uuid[], text)
  to authenticated;

-- absence_report joins the meeting for its date now.
create or replace function public.absence_report(
  p_semester_id uuid,
  p_from        date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select coalesce(jsonb_agg(row_data order by meets_on, child_name), '[]'::jsonb)
    into v
  from (
    select md.meets_on,
           trim(ch.first_name || ' ' || coalesce(ch.last_name, '')) as child_name,
           jsonb_build_object(
             'id', a.id,
             'date', md.meets_on,
             'meeting_cancelled', md.cancelled,
             'child_id', ch.id,
             'child_name', trim(ch.first_name || ' ' || coalesce(ch.last_name, '')),
             'family_id', f.id,
             'family_name', f.display_name,
             'family_phone', coalesce(f.primary_phone, (
               select p.phone from public.parents p
                where p.family_id = f.id and p.phone is not null
                order by p.sort_order limit 1)),
             'whole_day', a.whole_day,
             'reason', a.reason,
             'reported_by', a.reported_by,
             'reported_at', a.reported_at,
             'periods', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', p.id,
                        'name', coalesce(p.display_name, 'Period ' || p.period_number),
                        'number', p.period_number) order by p.period_number)
                 from public.absence_periods ap
                 join public.periods p on p.id = ap.period_id
                where ap.absence_id = a.id), '[]'::jsonb),
             'classes', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'class_id', c.id, 'class_name', c.name,
                        'period_number', pe.period_number,
                        'teacher_name', c.teacher_name) order by pe.period_number)
                 from public.registrations r
                 join public.classes c on c.id = r.class_id
                 join public.periods pe on pe.id = c.period_id
                where r.child_id = ch.id
                  and r.semester_id = a.semester_id
                  and r.status = 'registered'
                  and (a.whole_day or exists (
                        select 1 from public.absence_periods ap2
                         where ap2.absence_id = a.id and ap2.period_id = c.period_id))
               ), '[]'::jsonb)
           ) as row_data
      from public.absences a
      join public.meeting_dates md on md.id = a.meeting_id
      join public.children ch on ch.id = a.child_id
      join public.families f on f.id = ch.family_id
     where a.semester_id = p_semester_id
       and (p_from is null or md.meets_on >= p_from)
  ) s;

  return v;
end;
$$;

revoke execute on function public.absence_report(uuid, date) from public, anon;
grant execute on function public.absence_report(uuid, date) to authenticated, service_role;

-- cancel_absence read absence_date for its audit entry, and that column is gone.
create or replace function public.cancel_absence(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  public.absences;
  v_when date;
begin
  select * into v_row from public.absences where id = p_id;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if not public.is_active_admin()
     and not (v_row.child_id = any(public.current_child_ids())) then
    return jsonb_build_object('ok', false, 'error', 'not_your_child');
  end if;

  select meets_on into v_when from public.meeting_dates where id = v_row.meeting_id;

  -- Deleted outright rather than archived. An absence withdrawn before the day
  -- arrived is not history worth keeping; it is a message retracted before
  -- anybody acted on it.
  delete from public.absences where id = p_id;

  perform public.write_audit('absence_cancelled', 'child', v_row.child_id,
    jsonb_build_object('date', v_when),
    case when public.is_active_admin() then 'admin' else 'family' end, null);

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.cancel_absence(uuid) from public, anon;
grant execute on function public.cancel_absence(uuid) to authenticated;

select public.record_migration('0016');
