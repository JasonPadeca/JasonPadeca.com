-- =============================================================================
-- 0015_absences.sql
-- Telling the co-op a child will not be there.
--
-- Today this happens by text message to whichever administrator a parent has a
-- number for, and reaches the teacher if somebody remembers to pass it on. The
-- point of putting it here is not the parent's convenience — it is that the
-- teacher holding the register can see it.
--
-- Absence is not all-or-nothing. A child at the dentist at nine is back for
-- eleven, and a family leaving early misses only the last hour. So an absence
-- is either the whole day or a named set of periods, and the difference matters
-- to three different teachers.
--
-- Which day does the co-op meet? Nothing in the schema knew. Without it a
-- parent gets an empty date field and can report an absence for a Tuesday when
-- classes are on Thursday, and nobody finds out until the register does not
-- match. semesters.meeting_weekday fixes that, and the portal offers real dates
-- rather than a calendar of mostly-wrong ones.
-- =============================================================================

-- Both checks before any DDL: a second run must say so, not fail on
-- "relation already exists" a hundred lines later.
select public.migration_guard('0015', '0014');

-- -----------------------------------------------------------------------------
-- Which weekday the co-op meets. 0 = Sunday, matching Postgres extract(dow).
--
-- Nullable, because a semester created before this migration has no answer and
-- guessing would be worse than asking. The portal falls back to a plain date
-- field within the term when it is not set.
-- -----------------------------------------------------------------------------
alter table public.semesters
  add column if not exists meeting_weekday smallint
    check (meeting_weekday is null or meeting_weekday between 0 and 6);

comment on column public.semesters.meeting_weekday is
  'Day of the week classes meet. 0 = Sunday. Used to offer real dates when a '
  'parent reports an absence.';

-- =============================================================================
-- One row per child per day they will be away.
-- =============================================================================
create table public.absences (
  id            uuid primary key default gen_random_uuid(),
  child_id      uuid not null references public.children(id) on delete cascade,
  semester_id   uuid not null references public.semesters(id) on delete cascade,
  absence_date  date not null,

  -- The common case, and the default. When false, absence_periods says which
  -- hours — and a row with whole_day false and no periods would mean nothing,
  -- so the reporting function refuses to create one.
  whole_day     boolean not null default true,

  reason        text,
  reported_by   text not null default 'family'
                  check (reported_by in ('family', 'admin')),
  reported_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A second report for the same day is a correction, not a new absence.
  unique (child_id, absence_date)
);

create index absences_date_idx on public.absences (absence_date);
create index absences_semester_date_idx on public.absences (semester_id, absence_date);
create index absences_child_idx on public.absences (child_id, absence_date);

create trigger absences_touch before update on public.absences
  for each row execute function public.touch_updated_at();

create table public.absence_periods (
  id         uuid primary key default gen_random_uuid(),
  absence_id uuid not null references public.absences(id) on delete cascade,
  period_id  uuid not null references public.periods(id) on delete cascade,
  unique (absence_id, period_id)
);

create index absence_periods_absence_idx on public.absence_periods (absence_id);

alter table public.absences        enable row level security;
alter table public.absence_periods enable row level security;

create policy admin_all on public.absences
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

create policy admin_all on public.absence_periods
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

-- Families read their own. Writes go through the functions below, which check
-- ownership themselves — consistent with every other family-facing write.
create policy family_reads_own on public.absences
  for select to authenticated
  using (child_id = any(public.current_child_ids()));

create policy family_reads_own on public.absence_periods
  for select to authenticated
  using (absence_id in (
    select id from public.absences where child_id = any(public.current_child_ids())));

revoke all on public.absences, public.absence_periods from anon;
grant select on public.absences, public.absence_periods to authenticated;
grant all on public.absences, public.absence_periods to service_role;

-- =============================================================================
-- Report one, or correct one already reported.
--
-- p_period_ids is ignored when p_whole_day is true. When it is false the array
-- must have something in it: "absent for no periods" is not an absence, and
-- silently storing one would put a child on the teacher's absent list for a day
-- they attended in full.
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
  v_admin    boolean := public.is_active_admin();
  v_child    public.children;
  v_semester public.semesters;
  v_id       uuid;
  v_actor    text;
  v_count    integer;
begin
  select * into v_child from public.children where id = p_child_id;
  if v_child.id is null then
    return jsonb_build_object('ok', false, 'error', 'child_not_found');
  end if;

  -- A parent may only speak for their own children.
  if not v_admin and not (p_child_id = any(public.current_child_ids())) then
    return jsonb_build_object('ok', false, 'error', 'not_your_child');
  end if;

  v_actor := case when v_admin then 'admin' else 'family' end;

  -- Which term does this date belong to?
  select * into v_semester from public.semesters s
   where s.archived_at is null
     and s.class_start_date is not null
     and p_date between s.class_start_date and coalesce(s.class_end_date, s.class_start_date)
   order by s.class_start_date desc
   limit 1;

  if v_semester.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_term_date',
      'message', 'That date is not inside a current semester.');
  end if;

  if not p_whole_day then
    select count(*) into v_count
      from public.periods p
     where p.id = any(p_period_ids)
       and p.semester_id = v_semester.id
       and p.archived_at is null;

    if v_count = 0 then
      return jsonb_build_object('ok', false, 'error', 'no_periods',
        'message', 'Choose at least one period, or report the whole day.');
    end if;
  end if;

  insert into public.absences
    (child_id, semester_id, absence_date, whole_day, reason, reported_by)
  values
    (p_child_id, v_semester.id, p_date, p_whole_day,
     nullif(trim(coalesce(p_reason, '')), ''), v_actor)
  on conflict (child_id, absence_date) do update
    set whole_day   = excluded.whole_day,
        reason      = excluded.reason,
        reported_by = excluded.reported_by,
        semester_id = excluded.semester_id
  returning id into v_id;

  -- Replace rather than merge: the parent's latest submission is the truth,
  -- including when it removes a period they had previously named.
  delete from public.absence_periods where absence_id = v_id;

  if not p_whole_day then
    insert into public.absence_periods (absence_id, period_id)
    select v_id, p.id
      from public.periods p
     where p.id = any(p_period_ids)
       and p.semester_id = v_semester.id
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

-- =============================================================================
-- Withdraw one. The child got better, or the appointment moved.
-- =============================================================================
create or replace function public.cancel_absence(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.absences;
begin
  select * into v_row from public.absences where id = p_id;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if not public.is_active_admin()
     and not (v_row.child_id = any(public.current_child_ids())) then
    return jsonb_build_object('ok', false, 'error', 'not_your_child');
  end if;

  -- Deleted outright rather than archived. An absence that was withdrawn before
  -- the day arrived is not history worth keeping; it is a message that was
  -- retracted before anybody acted on it.
  delete from public.absences where id = p_id;

  perform public.write_audit('absence_cancelled', 'child', v_row.child_id,
    jsonb_build_object('date', v_row.absence_date),
    case when public.is_active_admin() then 'admin' else 'family' end, null);

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.report_absence(uuid, date, boolean, uuid[], text)
  from public, anon;
revoke execute on function public.cancel_absence(uuid) from public, anon;
grant execute on function public.report_absence(uuid, date, boolean, uuid[], text)
  to authenticated;
grant execute on function public.cancel_absence(uuid) to authenticated;

-- =============================================================================
-- What an administrator needs: who is away, when, and from what.
-- =============================================================================
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

  select coalesce(jsonb_agg(row_data order by absence_date, child_name), '[]'::jsonb)
    into v
  from (
    select a.absence_date,
           trim(ch.first_name || ' ' || coalesce(ch.last_name, '')) as child_name,
           jsonb_build_object(
             'id', a.id,
             'date', a.absence_date,
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
             -- What the child would otherwise be in, so a teacher can be told.
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
      join public.children ch on ch.id = a.child_id
      join public.families f on f.id = ch.family_id
     where a.semester_id = p_semester_id
       and (p_from is null or a.absence_date >= p_from)
  ) s;

  return v;
end;
$$;

revoke execute on function public.absence_report(uuid, date) from public, anon;
grant execute on function public.absence_report(uuid, date) to authenticated, service_role;

select public.record_migration('0015');
