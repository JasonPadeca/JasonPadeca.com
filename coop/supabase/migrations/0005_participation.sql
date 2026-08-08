-- =============================================================================
-- 0005_participation.sql
-- Sitting a semester out.
--
-- A co-op family often has one child taking classes and another who simply is
-- not doing it this term — travelling, working, too busy, or just not
-- interested. Before this, the only ways to express that were to mark the child
-- inactive (wrong: that is about leaving the program) or to leave them blank
-- (wrong: the dashboard then nags the administrator that the family has not
-- finished registering).
--
-- So this is a third state, and it belongs to the semester rather than to the
-- child, exactly as §2.4 separates permanent membership from semester
-- enrollment. The child stays a full member; they are just not registering
-- this time.
--
-- The parent sets it themselves during registration. It is not an
-- administrative judgement, which is why it is not `children.active`.
-- =============================================================================

create table public.semester_participation (
  id            uuid primary key default gen_random_uuid(),
  child_id      uuid not null references public.children(id) on delete cascade,
  semester_id   uuid not null references public.semesters(id) on delete cascade,
  participating boolean not null default true,
  note          text,
  set_by        text not null default 'family' check (set_by in ('family', 'admin')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (child_id, semester_id)
);

create index participation_semester_idx
  on public.semester_participation (semester_id, participating);

create trigger participation_touch before update on public.semester_participation
  for each row execute function public.touch_updated_at();

alter table public.semester_participation enable row level security;

create policy admin_all on public.semester_participation
  for all to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());

revoke all on public.semester_participation from anon;
grant all on public.semester_participation to service_role;

-- =============================================================================
-- submit_family_registration, now aware of opting out.
--
-- p_not_participating is the list of this family's children who are sitting the
-- semester out. Anything they had registered is cancelled, and the flag is
-- recorded so the page remembers the choice and the dashboard stops counting
-- them as unfinished.
--
-- Absence is meaningful in both directions: a child NOT in the array is marked
-- participating again, so a parent can change their mind by unticking the box
-- and resubmitting.
-- =============================================================================
create or replace function public.submit_family_registration(
  p_family_id          uuid,
  p_semester_id        uuid,
  p_selections         jsonb,
  p_actor              text default 'family',
  p_allow_closed       boolean default false,
  p_not_participating  uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sem       public.semesters;
  sel       jsonb;
  class_ids uuid[];
  cid       uuid;
  results   jsonb := '[]'::jsonb;
  keep_ids  uuid[] := '{}';
  v_child   public.children;
  v_class   public.classes;
  v_reasons text[];
  v_taken   integer;
  v_existing public.registrations;
  v_new_id  uuid;
  v_reg_id  uuid;
  v_outcome text;
  v_detail  text;
  v_intent  text;
  v_pos     integer;
  v_claimed text[] := '{}';
  v_key     text;
  v_out     uuid[] := coalesce(p_not_participating, '{}');
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

  -- ---------------------------------------------------------------------------
  -- Record who is sitting out. Only this family's children, whatever was sent.
  -- ---------------------------------------------------------------------------
  -- Restricted to the family's *active* children throughout: a child who has
  -- left the program is not sitting a semester out, and should not collect a
  -- participation row for every term thereafter.
  insert into public.semester_participation (child_id, semester_id, participating, set_by)
  select ch.id, p_semester_id, false, p_actor
    from public.children ch
   where ch.family_id = p_family_id
     and ch.active and ch.archived_at is null
     and ch.id = any(v_out)
  on conflict (child_id, semester_id)
    do update set participating = false, set_by = excluded.set_by;

  -- Everyone else in the family is participating, so a change of mind sticks.
  insert into public.semester_participation (child_id, semester_id, participating, set_by)
  select ch.id, p_semester_id, true, p_actor
    from public.children ch
   where ch.family_id = p_family_id
     and ch.active and ch.archived_at is null
     and not (ch.id = any(v_out))
  on conflict (child_id, semester_id)
    do update set participating = true, set_by = excluded.set_by;

  -- ---------------------------------------------------------------------------
  -- Lock every class involved, in a deterministic order (§20).
  -- ---------------------------------------------------------------------------
  select coalesce(array_agg(distinct (s ->> 'class_id')::uuid order by (s ->> 'class_id')::uuid), '{}')
    into class_ids
    from jsonb_array_elements(coalesce(p_selections, '[]'::jsonb)) s;

  foreach cid in array class_ids loop
    perform 1 from public.classes where id = cid for update;
  end loop;

  for sel in select * from jsonb_array_elements(coalesce(p_selections, '[]'::jsonb))
  loop
    v_outcome := null;
    v_detail  := null;
    v_intent  := coalesce(sel ->> 'intent', 'register');

    select * into v_child from public.children where id = (sel ->> 'child_id')::uuid;
    select * into v_class from public.classes  where id = (sel ->> 'class_id')::uuid;

    if v_child.id is null or v_child.family_id <> p_family_id then
      v_outcome := 'rejected';
      v_detail  := 'That child does not belong to this family.';

    elsif v_child.id = any(v_out) then
      -- A stale tab could submit selections for a child the parent has since
      -- marked as sitting out. The opt-out wins.
      v_outcome := 'rejected';
      v_detail  := 'That child is not participating this semester.';

    elsif v_class.id is null or v_class.semester_id <> p_semester_id then
      v_outcome := 'rejected';
      v_detail  := 'That class is not part of this semester.';

    else
      v_reasons := public.eligibility_reasons(v_child.id, v_class.id);
      if array_length(v_reasons, 1) > 0 then
        v_outcome := 'ineligible';
        v_detail  := array_to_string(v_reasons, '; ');
      end if;
    end if;

    if v_outcome is null then
      -- Any prior row for this child and class, live or not — preferring a live
      -- one, then the most recent.
      --
      -- Reviving a cancelled row rather than inserting a fresh one matters
      -- because dropping and re-picking a class is ordinary parent behaviour.
      -- Inserting each time would leave the same child listed simultaneously
      -- under the roster and under "previously enrolled", and would grow a row
      -- per change of mind. The audit log already records each submission.
      select * into v_existing from public.registrations
       where child_id = v_child.id and class_id = v_class.id
       order by (status in ('registered', 'waitlisted')) desc, created_at desc
       limit 1;

      v_key := v_child.id::text || ':' || v_class.period_id::text;

      if v_intent = 'waitlist' then
        if v_existing.id is not null then
          if v_existing.status in ('registered', 'waitlisted') then
            v_outcome := case v_existing.status when 'registered'
                         then 'registered' else 'waitlisted' end;
          else
            -- Revive a previously dropped row back onto the waitlist.
            update public.registrations
               set status = 'waitlisted', waitlisted_at = now(),
                   cancelled_at = null, source = p_actor
             where id = v_existing.id;
            v_outcome := 'waitlisted';
          end if;
          v_reg_id  := v_existing.id;
          keep_ids  := keep_ids || v_existing.id;
        else
          insert into public.registrations
            (child_id, class_id, status, source, waitlisted_at)
          values (v_child.id, v_class.id, 'waitlisted', p_actor, now())
          returning id into v_new_id;
          v_outcome := 'waitlisted';
          v_reg_id  := v_new_id;
          keep_ids  := keep_ids || v_new_id;
        end if;

      elsif v_key = any(v_claimed) then
        v_outcome := 'rejected';
        v_detail  := 'Only one class per period.';

      else
        select count(*) into v_taken from public.registrations
          where class_id = v_class.id and status = 'registered'
            and child_id <> v_child.id;

        if v_class.capacity is not null and v_taken >= v_class.capacity then
          v_outcome := 'full';
          v_detail  := 'This class filled up.';
        else
          update public.registrations
             set status = 'cancelled', cancelled_at = now(), waitlisted_at = null
           where child_id = v_child.id
             and period_id = v_class.period_id
             and status = 'registered'
             and class_id <> v_class.id;

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

          v_outcome := 'registered';
          v_reg_id  := v_new_id;
          v_claimed := v_claimed || v_key;
          keep_ids  := keep_ids || v_new_id;
        end if;
      end if;
    end if;

    v_pos := null;
    if v_outcome = 'waitlisted' and v_reg_id is not null then
      select count(*) into v_pos
        from public.registrations r
        join public.registrations me on me.id = v_reg_id
       where r.class_id = me.class_id
         and r.status = 'waitlisted'
         and r.waitlisted_at <= me.waitlisted_at;
    end if;
    v_reg_id := null;

    results := results || jsonb_build_object(
      'child_id',          sel ->> 'child_id',
      'class_id',          sel ->> 'class_id',
      'outcome',           v_outcome,
      'detail',            v_detail,
      'waitlist_position', v_pos
    );
  end loop;

  -- Reconcile: anything live and no longer selected is dropped. This is also
  -- what clears the schedule of a child who has just been marked as sitting out.
  update public.registrations r
     set status = 'cancelled', cancelled_at = now(), waitlisted_at = null
    from public.children ch
   where r.child_id = ch.id
     and ch.family_id = p_family_id
     and r.semester_id = p_semester_id
     and r.status in ('registered', 'waitlisted')
     and not (r.id = any(keep_ids));

  perform public.write_audit(
    'family_registration_submitted', 'family', p_family_id,
    jsonb_build_object('semester_id', p_semester_id, 'results', results,
                       'not_participating', to_jsonb(v_out)),
    p_actor, null);

  return jsonb_build_object('ok', true, 'results', results);
end;
$$;

-- =============================================================================
-- The family page needs to know who is already marked as sitting out, so
-- reopening the link shows the choice rather than silently resetting it.
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

  select jsonb_build_object(
           'id', f.id,
           'display_name', f.display_name,
           'primary_email', f.primary_email)
    into v_family
    from public.families f where f.id = p_family_id;

  if v_family is null then
    return jsonb_build_object('ok', false, 'error', 'family_not_found');
  end if;

  select jsonb_build_object(
           'id', s.id,
           'name', s.name,
           'description', s.description,
           'class_start_date', s.class_start_date,
           'class_end_date', s.class_end_date,
           'registration_close_at', s.registration_close_at,
           'status', s.status,
           'is_open', s.status = 'registration_open'
                      and (s.registration_close_at is null
                           or now() <= s.registration_close_at))
    into v_semester
    from public.semesters s where s.id = p_semester_id;

  if v_semester is null then
    return jsonb_build_object('ok', false, 'error', 'semester_not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', ch.id,
           'first_name', ch.first_name,
           'last_name', ch.last_name,
           'age', public.age_at(ch.birth_date,
                    coalesce((v_semester ->> 'class_start_date')::date, current_date)),
           -- No row means nobody has said otherwise, which is participating.
           'participating', coalesce(sp.participating, true)
         ) order by ch.birth_date nulls last), '[]'::jsonb)
    into v_children
    from public.children ch
    left join public.semester_participation sp
      on sp.child_id = ch.id and sp.semester_id = p_semester_id
   where ch.family_id = p_family_id
     and ch.active
     and ch.archived_at is null;

  select coalesce(jsonb_agg(period_row order by sort_order, period_number), '[]'::jsonb)
    into v_periods
  from (
    select p.sort_order, p.period_number,
      jsonb_build_object(
        'id', p.id,
        'period_number', p.period_number,
        'display_name', coalesce(p.display_name, 'Period ' || p.period_number),
        'start_time', p.start_time,
        'end_time', p.end_time,
        'classes', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', c.id,
                   'name', c.name,
                   'description', c.description,
                   'teacher_name', c.teacher_name,
                   'age_min', c.age_min,
                   'age_max', c.age_max,
                   'sex_requirement', c.sex_requirement,
                   'capacity', c.capacity,
                   'registered_count', cs.registered_count,
                   'waitlisted_count', cs.waitlisted_count,
                   'seats_open', cs.seats_open,
                   'is_full', cs.is_full,
                   'eligibility', coalesce((
                     select jsonb_object_agg(ch.id::text,
                              to_jsonb(public.eligibility_reasons(ch.id, c.id)))
                       from public.children ch
                      where ch.family_id = p_family_id
                        and ch.active and ch.archived_at is null
                   ), '{}'::jsonb)
                 ) order by c.option_number nulls last, c.name)
            from public.classes c
            join public.class_seats cs on cs.class_id = c.id
           where c.period_id = p.id and c.archived_at is null
        ), '[]'::jsonb)
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
               'child_id', r.child_id,
               'class_id', r.class_id,
               'period_id', r.period_id,
               'status', r.status,
               'waitlist_position', case when r.status = 'waitlisted' then (
                 select count(*) from public.registrations r2
                  where r2.class_id = r.class_id and r2.status = 'waitlisted'
                    and r2.waitlisted_at <= r.waitlisted_at) end))
        from public.registrations r
        join public.children ch on ch.id = r.child_id
       where ch.family_id = p_family_id
         and r.semester_id = p_semester_id
         and r.status in ('registered', 'waitlisted')
    ), '[]'::jsonb));
end;
$$;

-- =============================================================================
-- Dashboard: children sitting out are not "not yet registered" (§8).
--
-- The whole point of the opt-out is that the administrator stops chasing them,
-- so the summary has to stop counting them as outstanding.
-- =============================================================================
create or replace function public.semester_summary(p_semester_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select jsonb_build_object(
    'active_children', (
      select count(*) from public.children ch
       join public.families f on f.id = ch.family_id
      where ch.active and ch.archived_at is null and f.active and f.archived_at is null),
    'active_families', (
      select count(*) from public.families where active and archived_at is null),
    'sitting_out', (
      select count(*) from public.semester_participation sp
       join public.children ch on ch.id = sp.child_id
       join public.families f on f.id = ch.family_id
      where sp.semester_id = p_semester_id and not sp.participating
        and ch.active and ch.archived_at is null and f.active and f.archived_at is null),
    'children_registered', (
      select count(distinct r.child_id) from public.registrations r
       where r.semester_id = p_semester_id and r.status = 'registered'),
    'confirmed_seats', (
      select count(*) from public.registrations
       where semester_id = p_semester_id and status = 'registered'),
    'waitlisted', (
      select count(*) from public.registrations
       where semester_id = p_semester_id and status = 'waitlisted'),
    'classes_full', (
      select count(*) from public.class_seats cs
       join public.classes c on c.id = cs.class_id
      where c.semester_id = p_semester_id and c.archived_at is null and cs.is_full),
    'classes_over_capacity', (
      select count(*) from public.class_seats cs
       join public.classes c on c.id = cs.class_id
      where c.semester_id = p_semester_id and c.archived_at is null
        and cs.capacity is not null and cs.registered_count > cs.capacity),
    'invites_sent', (
      select count(*) from public.registration_invites
       where semester_id = p_semester_id and revoked_at is null and sent_at is not null),
    'invite_failures', (
      select count(*) from public.registration_invites
       where semester_id = p_semester_id and revoked_at is null and send_error is not null),
    'last_keepalive_at', (select last_keepalive_at from public.system_status where id = 1)
  ) into v;

  return v;
end;
$$;

-- Grants, matching 0003/0004: the family path stays service-role only.
revoke execute on function public.submit_family_registration(uuid, uuid, jsonb, text, boolean, uuid[])
  from public, anon, authenticated;
revoke execute on function public.family_registration_payload(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.semester_summary(uuid) from public, anon;
grant execute on function public.submit_family_registration(uuid, uuid, jsonb, text, boolean, uuid[])
  to service_role;
grant execute on function public.family_registration_payload(uuid, uuid) to service_role;
grant execute on function public.semester_summary(uuid) to authenticated, service_role;

-- The five-argument version from 0003 would otherwise linger as a second,
-- older overload that quietly ignores the opt-out.
drop function if exists public.submit_family_registration(uuid, uuid, jsonb, text, boolean);
