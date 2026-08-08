-- =============================================================================
-- 0006_preferences.sql
-- Second choices, and volunteering.
--
-- Two additions, both of which are about capturing what a family wanted rather
-- than only what they got.
--
-- SECOND CHOICES (§21, §22)
--   A parent names a first and, optionally, a second class for a period. If the
--   first is full at the moment of submission, the second is taken instead —
--   which is the difference between a family getting a class and a family
--   getting an apology. Both choices are recorded either way, so an
--   administrator reshuffling a full class can see what each child actually
--   wanted instead of guessing.
--
-- VOLUNTEERING
--   Co-ops run on parent and teen labour, and finding out who is willing is
--   currently a separate round of emails. Asking during registration costs the
--   family one extra question at the moment they are already thinking about it.
--   This is captured data, not an assignment: nothing here schedules anybody.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- What the family asked for, per period, whether or not they got it.
-- -----------------------------------------------------------------------------
create table public.class_preferences (
  id          uuid primary key default gen_random_uuid(),
  child_id    uuid not null references public.children(id) on delete cascade,
  semester_id uuid not null references public.semesters(id) on delete cascade,
  period_id   uuid not null references public.periods(id) on delete cascade,
  rank        smallint not null check (rank in (1, 2)),
  class_id    uuid not null references public.classes(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (child_id, semester_id, period_id, rank)
);

create index class_preferences_semester_idx
  on public.class_preferences (semester_id, period_id);
create index class_preferences_class_idx
  on public.class_preferences (class_id, rank);

create trigger class_preferences_touch before update on public.class_preferences
  for each row execute function public.touch_updated_at();

alter table public.class_preferences enable row level security;
create policy admin_all on public.class_preferences
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());
revoke all on public.class_preferences from anon;
grant all on public.class_preferences to service_role;

-- -----------------------------------------------------------------------------
-- Volunteering.
--
-- Split in two so that "yes, happy to help, no preference" is expressible — a
-- header row with no slots. Folding it into a single table would make
-- willingness indistinguishable from silence.
-- -----------------------------------------------------------------------------
create table public.volunteer_interest (
  id                 uuid primary key default gen_random_uuid(),
  child_id           uuid not null references public.children(id) on delete cascade,
  semester_id        uuid not null references public.semesters(id) on delete cascade,
  wants_to_volunteer boolean not null default false,
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (child_id, semester_id)
);

create trigger volunteer_interest_touch before update on public.volunteer_interest
  for each row execute function public.touch_updated_at();

create table public.volunteer_interest_slot (
  id          uuid primary key default gen_random_uuid(),
  interest_id uuid not null references public.volunteer_interest(id) on delete cascade,
  period_id   uuid not null references public.periods(id) on delete cascade,
  -- NULL means "any class in this period".
  class_id    uuid references public.classes(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Two partial indexes rather than one UNIQUE NULLS NOT DISTINCT, which would
-- tie this migration to Postgres 15+ for no benefit.
create unique index volunteer_slot_period_any
  on public.volunteer_interest_slot (interest_id, period_id) where class_id is null;
create unique index volunteer_slot_specific
  on public.volunteer_interest_slot (interest_id, class_id) where class_id is not null;

create index volunteer_slot_interest_idx on public.volunteer_interest_slot (interest_id);

alter table public.volunteer_interest      enable row level security;
alter table public.volunteer_interest_slot enable row level security;

create policy admin_all on public.volunteer_interest
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());
create policy admin_all on public.volunteer_interest_slot
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

revoke all on public.volunteer_interest      from anon;
revoke all on public.volunteer_interest_slot from anon;
grant all on public.volunteer_interest      to service_role;
grant all on public.volunteer_interest_slot to service_role;

-- =============================================================================
-- submit_family_registration
--
-- p_selections entries now carry an optional rank:
--   { child_id, class_id, intent: 'register'|'waitlist', rank: 1|2 }
--
-- Confirmed choices are resolved per (child, period) rather than one row at a
-- time, because a second choice only means anything relative to the first.
-- Waitlist entries stay independent — they are interest, not a seat.
--
-- p_volunteer is keyed by child id:
--   { "<child_id>": { "wants": bool, "note": text,
--                     "slots": [ { "period_id": uuid, "class_id": uuid|null } ] } }
-- =============================================================================
create or replace function public.submit_family_registration(
  p_family_id          uuid,
  p_semester_id        uuid,
  p_selections         jsonb,
  p_actor              text default 'family',
  p_allow_closed       boolean default false,
  p_not_participating  uuid[] default '{}',
  p_volunteer          jsonb default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sem        public.semesters;
  grp        record;
  sel        jsonb;
  class_ids  uuid[];
  cid        uuid;
  results    jsonb := '[]'::jsonb;
  keep_ids   uuid[] := '{}';
  v_child    public.children;
  v_class    public.classes;
  v_existing public.registrations;
  v_reasons  text[];
  v_taken    integer;
  v_new_id   uuid;
  v_reg_id   uuid;
  v_outcome  text;
  v_detail   text;
  v_pos      integer;
  v_out      uuid[] := coalesce(p_not_participating, '{}');
  v_taken_class uuid;
  v_fellback boolean;
  v_interest_id uuid;
  v_vol      jsonb;
  v_slot     jsonb;
  v_kid      text;
begin
  select * into sem from public.semesters where id = p_semester_id;
  if sem.id is null then
    raise exception 'Semester not found';
  end if;

  if not p_allow_closed then
    if sem.status <> 'registration_open' then
      return jsonb_build_object('ok', false, 'error', 'registration_closed',
        'message', 'Registration is not currently open for this semester.');
    end if;
    if sem.registration_close_at is not null and now() > sem.registration_close_at then
      return jsonb_build_object('ok', false, 'error', 'registration_closed',
        'message', 'The registration deadline has passed.');
    end if;
  end if;

  -- --- participation (0005) --------------------------------------------------
  insert into public.semester_participation (child_id, semester_id, participating, set_by)
  select ch.id, p_semester_id, false, p_actor
    from public.children ch
   where ch.family_id = p_family_id and ch.active and ch.archived_at is null
     and ch.id = any(v_out)
  on conflict (child_id, semester_id)
    do update set participating = false, set_by = excluded.set_by;

  insert into public.semester_participation (child_id, semester_id, participating, set_by)
  select ch.id, p_semester_id, true, p_actor
    from public.children ch
   where ch.family_id = p_family_id and ch.active and ch.archived_at is null
     and not (ch.id = any(v_out))
  on conflict (child_id, semester_id)
    do update set participating = true, set_by = excluded.set_by;

  -- --- lock every class involved, in a deterministic order (§20) -------------
  select coalesce(array_agg(distinct (s ->> 'class_id')::uuid order by (s ->> 'class_id')::uuid), '{}')
    into class_ids
    from jsonb_array_elements(coalesce(p_selections, '[]'::jsonb)) s;

  foreach cid in array class_ids loop
    perform 1 from public.classes where id = cid for update;
  end loop;

  -- --- record what was asked for, before working out what is available -------
  delete from public.class_preferences cp
   using public.children ch
   where cp.child_id = ch.id and ch.family_id = p_family_id
     and cp.semester_id = p_semester_id;

  insert into public.class_preferences (child_id, semester_id, period_id, rank, class_id)
  select distinct on (ch.id, c.period_id, coalesce((s ->> 'rank')::smallint, 1))
         ch.id, p_semester_id, c.period_id,
         coalesce((s ->> 'rank')::smallint, 1), c.id
    from jsonb_array_elements(coalesce(p_selections, '[]'::jsonb)) s
    join public.children ch on ch.id = (s ->> 'child_id')::uuid
    join public.classes  c  on c.id  = (s ->> 'class_id')::uuid
   where ch.family_id = p_family_id
     and not (ch.id = any(v_out))
     and c.semester_id = p_semester_id
     and coalesce(s ->> 'intent', 'register') = 'register'
  on conflict (child_id, semester_id, period_id, rank) do nothing;

  -- ===========================================================================
  -- Confirmed seats, resolved one (child, period) at a time.
  -- ===========================================================================
  for grp in
    select ch.id as child_id, c.period_id,
           min(coalesce((s ->> 'rank')::smallint, 1)) as best_rank
      from jsonb_array_elements(coalesce(p_selections, '[]'::jsonb)) s
      join public.children ch on ch.id = (s ->> 'child_id')::uuid
      join public.classes  c  on c.id  = (s ->> 'class_id')::uuid
     where coalesce(s ->> 'intent', 'register') = 'register'
     group by ch.id, c.period_id
     order by ch.id, c.period_id
  loop
    v_taken_class := null;
    v_fellback    := false;
    v_outcome     := null;
    v_detail      := null;

    select * into v_child from public.children where id = grp.child_id;

    if v_child.id is null or v_child.family_id <> p_family_id then
      results := results || jsonb_build_object(
        'child_id', grp.child_id, 'class_id', null, 'outcome', 'rejected',
        'detail', 'That child does not belong to this family.');
      continue;
    end if;

    if v_child.id = any(v_out) then
      results := results || jsonb_build_object(
        'child_id', grp.child_id, 'class_id', null, 'outcome', 'rejected',
        'detail', 'That child is not participating this semester.');
      continue;
    end if;

    -- Try the ranked choices in order and stop at the first that works.
    --
    -- WITH ORDINALITY so ties break on the order the browser sent them: two
    -- entries at the same rank must not resolve differently run to run.
    --
    -- Every attempt that fails gets its own result, so a parent still learns
    -- that their first choice was full or that a class was not open to their
    -- child, even when a later choice succeeded. Choices after the winner are
    -- never tried and produce nothing.
    for sel in
      select s from jsonb_array_elements(coalesce(p_selections, '[]'::jsonb))
             with ordinality as t(s, ord)
       where (s ->> 'child_id')::uuid = grp.child_id
         and coalesce(s ->> 'intent', 'register') = 'register'
         and exists (select 1 from public.classes c
                      where c.id = (s ->> 'class_id')::uuid and c.period_id = grp.period_id)
       order by coalesce((s ->> 'rank')::smallint, 1), t.ord
    loop
      select * into v_class from public.classes where id = (sel ->> 'class_id')::uuid;

      if v_class.id is null or v_class.semester_id <> p_semester_id then
        results := results || jsonb_build_object(
          'child_id', v_child.id, 'class_id', sel ->> 'class_id',
          'outcome', 'rejected', 'detail', 'That class is not part of this semester.',
          'used_second_choice', false, 'waitlist_position', null);
        continue;
      end if;

      v_reasons := public.eligibility_reasons(v_child.id, v_class.id);
      if array_length(v_reasons, 1) > 0 then
        results := results || jsonb_build_object(
          'child_id', v_child.id, 'class_id', v_class.id,
          'outcome', 'ineligible', 'detail', array_to_string(v_reasons, '; '),
          'used_second_choice', false, 'waitlist_position', null);
        continue;
      end if;

      select count(*) into v_taken from public.registrations
       where class_id = v_class.id and status = 'registered' and child_id <> v_child.id;

      if v_class.capacity is not null and v_taken >= v_class.capacity then
        results := results || jsonb_build_object(
          'child_id', v_child.id, 'class_id', v_class.id,
          'outcome', 'full', 'detail', 'This class filled up.',
          'used_second_choice', false, 'waitlist_position', null);
        v_fellback := true;      -- if a later choice works, this is why
        continue;
      end if;

      -- This one is available. Take it.
      update public.registrations
         set status = 'cancelled', cancelled_at = now(), waitlisted_at = null
       where child_id = v_child.id and period_id = v_class.period_id
         and status = 'registered' and class_id <> v_class.id;

      select * into v_existing from public.registrations
       where child_id = v_child.id and class_id = v_class.id
       order by (status in ('registered', 'waitlisted')) desc, created_at desc
       limit 1;

      if v_existing.id is not null then
        update public.registrations
           set status = 'registered', waitlisted_at = null,
               cancelled_at = null, source = p_actor
         where id = v_existing.id;
        v_new_id := v_existing.id;
      else
        insert into public.registrations (child_id, class_id, status, source)
        values (v_child.id, v_class.id, 'registered', p_actor)
        returning id into v_new_id;
      end if;

      keep_ids      := keep_ids || v_new_id;
      v_taken_class := v_class.id;
      exit;
    end loop;

    -- Only the success needs a summary row; the failures already emitted theirs.
    if v_taken_class is not null then
      results := results || jsonb_build_object(
        'child_id',           grp.child_id,
        'class_id',           v_taken_class,
        'outcome',            'registered',
        'detail',             case when v_fellback
                              then 'Your first choice was full, so your next choice was used.' end,
        'used_second_choice', v_fellback,
        'waitlist_position',  null);
    end if;
  end loop;

  -- ===========================================================================
  -- Waitlist entries — independent of the period's confirmed seat.
  -- ===========================================================================
  for sel in
    select s from jsonb_array_elements(coalesce(p_selections, '[]'::jsonb)) s
     where (s ->> 'intent') = 'waitlist'
  loop
    select * into v_child from public.children where id = (sel ->> 'child_id')::uuid;
    select * into v_class from public.classes  where id = (sel ->> 'class_id')::uuid;

    v_outcome := null; v_detail := null; v_reg_id := null;

    if v_child.id is null or v_child.family_id <> p_family_id then
      v_outcome := 'rejected'; v_detail := 'That child does not belong to this family.';
    elsif v_child.id = any(v_out) then
      v_outcome := 'rejected'; v_detail := 'That child is not participating this semester.';
    elsif v_class.id is null or v_class.semester_id <> p_semester_id then
      v_outcome := 'rejected'; v_detail := 'That class is not part of this semester.';
    else
      v_reasons := public.eligibility_reasons(v_child.id, v_class.id);
      if array_length(v_reasons, 1) > 0 then
        v_outcome := 'ineligible'; v_detail := array_to_string(v_reasons, '; ');
      end if;
    end if;

    if v_outcome is null then
      select * into v_existing from public.registrations
       where child_id = v_child.id and class_id = v_class.id
       order by (status in ('registered', 'waitlisted')) desc, created_at desc
       limit 1;

      if v_existing.id is not null and v_existing.status = 'registered' then
        v_outcome := 'registered';
        v_reg_id  := v_existing.id;
        keep_ids  := keep_ids || v_existing.id;
      elsif v_existing.id is not null then
        update public.registrations
           set status = 'waitlisted',
               waitlisted_at = coalesce(v_existing.waitlisted_at, now()),
               cancelled_at = null, source = p_actor
         where id = v_existing.id;
        v_outcome := 'waitlisted';
        v_reg_id  := v_existing.id;
        keep_ids  := keep_ids || v_existing.id;
      else
        insert into public.registrations (child_id, class_id, status, source, waitlisted_at)
        values (v_child.id, v_class.id, 'waitlisted', p_actor, now())
        returning id into v_new_id;
        v_outcome := 'waitlisted';
        v_reg_id  := v_new_id;
        keep_ids  := keep_ids || v_new_id;
      end if;
    end if;

    v_pos := null;
    if v_outcome = 'waitlisted' and v_reg_id is not null then
      select count(*) into v_pos
        from public.registrations r
        join public.registrations me on me.id = v_reg_id
       where r.class_id = me.class_id and r.status = 'waitlisted'
         and r.waitlisted_at <= me.waitlisted_at;
    end if;

    results := results || jsonb_build_object(
      'child_id', sel ->> 'child_id', 'class_id', sel ->> 'class_id',
      'outcome', v_outcome, 'detail', v_detail,
      'used_second_choice', false, 'waitlist_position', v_pos);
  end loop;

  -- --- reconcile -------------------------------------------------------------
  update public.registrations r
     set status = 'cancelled', cancelled_at = now(), waitlisted_at = null
    from public.children ch
   where r.child_id = ch.id
     and ch.family_id = p_family_id
     and r.semester_id = p_semester_id
     and r.status in ('registered', 'waitlisted')
     and not (r.id = any(keep_ids));

  -- ===========================================================================
  -- Volunteering
  -- ===========================================================================
  for v_kid in select jsonb_object_keys(coalesce(p_volunteer, '{}'::jsonb))
  loop
    -- Only this family's own active children, whatever the browser sent.
    if not exists (select 1 from public.children
                    where id = v_kid::uuid and family_id = p_family_id
                      and active and archived_at is null) then
      continue;
    end if;

    v_vol := p_volunteer -> v_kid;

    insert into public.volunteer_interest (child_id, semester_id, wants_to_volunteer, note)
    values (v_kid::uuid, p_semester_id,
            coalesce((v_vol ->> 'wants')::boolean, false),
            nullif(trim(coalesce(v_vol ->> 'note', '')), ''))
    on conflict (child_id, semester_id) do update
      set wants_to_volunteer = excluded.wants_to_volunteer,
          note = excluded.note
    returning id into v_interest_id;

    delete from public.volunteer_interest_slot where interest_id = v_interest_id;

    if coalesce((v_vol ->> 'wants')::boolean, false) then
      for v_slot in select * from jsonb_array_elements(coalesce(v_vol -> 'slots', '[]'::jsonb))
      loop
        insert into public.volunteer_interest_slot (interest_id, period_id, class_id)
        select v_interest_id, p.id, c.id
          from public.periods p
          left join public.classes c
            on c.id = nullif(v_slot ->> 'class_id', '')::uuid and c.period_id = p.id
         where p.id = (v_slot ->> 'period_id')::uuid
           and p.semester_id = p_semester_id
        on conflict do nothing;
      end loop;
    end if;
  end loop;

  perform public.write_audit(
    'family_registration_submitted', 'family', p_family_id,
    jsonb_build_object('semester_id', p_semester_id, 'results', results,
                       'not_participating', to_jsonb(v_out)),
    p_actor, null);

  return jsonb_build_object('ok', true, 'results', results);
end;
$$;

revoke execute on function public.submit_family_registration(uuid, uuid, jsonb, text, boolean, uuid[], jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_family_registration(uuid, uuid, jsonb, text, boolean, uuid[], jsonb)
  to service_role;

-- The six-argument version from 0005 would otherwise linger as an overload
-- that silently drops volunteering and second choices.
drop function if exists public.submit_family_registration(uuid, uuid, jsonb, text, boolean, uuid[]);

-- =============================================================================
-- The family page must show back what was chosen last time — including the
-- second choices and the volunteering answers, which are not derivable from
-- the registrations alone.
-- =============================================================================
create or replace function public.family_registration_payload(
  p_family_id   uuid,
  p_semester_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_family   jsonb;
  v_semester jsonb;
  v_children jsonb;
  v_periods  jsonb;
  v_settings public.settings;
begin
  select * into v_settings from public.settings where id = 1;

  select jsonb_build_object('id', f.id, 'display_name', f.display_name,
                            'primary_email', f.primary_email)
    into v_family from public.families f where f.id = p_family_id;
  if v_family is null then
    return jsonb_build_object('ok', false, 'error', 'family_not_found');
  end if;

  select jsonb_build_object(
           'id', s.id, 'name', s.name, 'description', s.description,
           'class_start_date', s.class_start_date, 'class_end_date', s.class_end_date,
           'registration_close_at', s.registration_close_at, 'status', s.status,
           'is_open', s.status = 'registration_open'
                      and (s.registration_close_at is null
                           or now() <= s.registration_close_at))
    into v_semester from public.semesters s where s.id = p_semester_id;
  if v_semester is null then
    return jsonb_build_object('ok', false, 'error', 'semester_not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', ch.id,
           'first_name', ch.first_name,
           'last_name', ch.last_name,
           'age', public.age_at(ch.birth_date,
                    coalesce((v_semester ->> 'class_start_date')::date, current_date)),
           'participating', coalesce(sp.participating, true),
           'volunteer', jsonb_build_object(
             'wants', coalesce(vi.wants_to_volunteer, false),
             'note', vi.note,
             'slots', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'period_id', vs.period_id, 'class_id', vs.class_id))
                 from public.volunteer_interest_slot vs
                where vs.interest_id = vi.id), '[]'::jsonb))
         ) order by ch.birth_date nulls last), '[]'::jsonb)
    into v_children
    from public.children ch
    left join public.semester_participation sp
      on sp.child_id = ch.id and sp.semester_id = p_semester_id
    left join public.volunteer_interest vi
      on vi.child_id = ch.id and vi.semester_id = p_semester_id
   where ch.family_id = p_family_id and ch.active and ch.archived_at is null;

  select coalesce(jsonb_agg(period_row order by sort_order, period_number), '[]'::jsonb)
    into v_periods
  from (
    select p.sort_order, p.period_number,
      jsonb_build_object(
        'id', p.id, 'period_number', p.period_number,
        'display_name', coalesce(p.display_name, 'Period ' || p.period_number),
        'start_time', p.start_time, 'end_time', p.end_time,
        'classes', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', c.id, 'name', c.name, 'description', c.description,
                   'teacher_name', c.teacher_name, 'age_min', c.age_min,
                   'age_max', c.age_max, 'sex_requirement', c.sex_requirement,
                   'capacity', c.capacity,
                   'registered_count', cs.registered_count,
                   'waitlisted_count', cs.waitlisted_count,
                   'seats_open', cs.seats_open, 'is_full', cs.is_full,
                   'eligibility', coalesce((
                     select jsonb_object_agg(ch.id::text,
                              to_jsonb(public.eligibility_reasons(ch.id, c.id)))
                       from public.children ch
                      where ch.family_id = p_family_id
                        and ch.active and ch.archived_at is null), '{}'::jsonb)
                 ) order by c.option_number nulls last, c.name)
            from public.classes c
            join public.class_seats cs on cs.class_id = c.id
           where c.period_id = p.id and c.archived_at is null), '[]'::jsonb)
      ) as period_row
      from public.periods p
     where p.semester_id = p_semester_id and p.archived_at is null
  ) sub;

  return jsonb_build_object(
    'ok', true,
    'program_name', v_settings.program_name,
    'show_ineligible', v_settings.show_ineligible_classes,
    'allow_edits', v_settings.allow_family_edits,
    'family', v_family,
    'semester', v_semester,
    'children', v_children,
    'periods', v_periods,
    'registrations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'child_id', r.child_id, 'class_id', r.class_id,
               'period_id', r.period_id, 'status', r.status,
               'waitlist_position', case when r.status = 'waitlisted' then (
                 select count(*) from public.registrations r2
                  where r2.class_id = r.class_id and r2.status = 'waitlisted'
                    and r2.waitlisted_at <= r.waitlisted_at) end))
        from public.registrations r
        join public.children ch on ch.id = r.child_id
       where ch.family_id = p_family_id and r.semester_id = p_semester_id
         and r.status in ('registered', 'waitlisted')), '[]'::jsonb),
    -- What they asked for, which is not the same as what they got.
    'preferences', coalesce((
      select jsonb_agg(jsonb_build_object(
               'child_id', cp.child_id, 'period_id', cp.period_id,
               'rank', cp.rank, 'class_id', cp.class_id))
        from public.class_preferences cp
        join public.children ch on ch.id = cp.child_id
       where ch.family_id = p_family_id and cp.semester_id = p_semester_id), '[]'::jsonb));
end;
$$;

revoke execute on function public.family_registration_payload(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.family_registration_payload(uuid, uuid) to service_role;

-- =============================================================================
-- Volunteering, gathered for the administrator's list (§35).
-- =============================================================================
create or replace function public.volunteer_report(p_semester_id uuid)
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

  select coalesce(jsonb_agg(row_data order by family_name, child_name), '[]'::jsonb)
    into v
  from (
    select f.display_name as family_name,
           (ch.first_name || ' ' || coalesce(ch.last_name, '')) as child_name,
           jsonb_build_object(
             'child_id', ch.id,
             'child_name', trim(ch.first_name || ' ' || coalesce(ch.last_name, '')),
             'family_id', f.id,
             'family_name', f.display_name,
             'family_email', f.primary_email,
             'age', public.age_at(ch.birth_date,
                      coalesce((select class_start_date from public.semesters
                                 where id = p_semester_id), current_date)),
             'note', vi.note,
             'slots', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'period_id', p.id,
                        'period_name', coalesce(p.display_name, 'Period ' || p.period_number),
                        'period_number', p.period_number,
                        'class_id', c.id,
                        'class_name', c.name) order by p.period_number, c.name)
                 from public.volunteer_interest_slot vs
                 join public.periods p on p.id = vs.period_id
                 left join public.classes c on c.id = vs.class_id
                where vs.interest_id = vi.id), '[]'::jsonb)
           ) as row_data
      from public.volunteer_interest vi
      join public.children ch on ch.id = vi.child_id
      join public.families f on f.id = ch.family_id
     where vi.semester_id = p_semester_id
       and vi.wants_to_volunteer
       and ch.active and ch.archived_at is null
  ) s;

  return v;
end;
$$;

revoke execute on function public.volunteer_report(uuid) from public, anon;
grant execute on function public.volunteer_report(uuid) to authenticated, service_role;
