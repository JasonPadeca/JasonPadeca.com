-- =============================================================================
-- 0004_family_payload.sql
-- The one query behind the family registration page, and the dashboard's
-- summary counts.
--
-- Spec references: §16 (family UX), §28 (family access), §45 (privacy).
--
-- Building the family payload in the database rather than the Edge Function is
-- both faster and safer. Faster because eligibility for every child against
-- every class is one pass instead of N×M round trips. Safer because the exact
-- set of columns a family may see is written down in one place, in the same
-- file as the rules — so "only that family's data" is a property you can read,
-- rather than a promise spread across handler code.
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

  -- Deliberately narrow. No notes, no created_at, no internal flags.
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

  -- Only this family's children, and only the ones currently participating.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', ch.id,
           'first_name', ch.first_name,
           'last_name', ch.last_name,
           'age', public.age_at(ch.birth_date,
                    coalesce((v_semester ->> 'class_start_date')::date, current_date))
         ) order by ch.birth_date nulls last), '[]'::jsonb)
    into v_children
    from public.children ch
   where ch.family_id = p_family_id
     and ch.active
     and ch.archived_at is null;

  -- Periods, each with its classes, each class carrying its seat state and a
  -- per-child eligibility verdict. Note what is absent: no roster, no other
  -- families, no other children's names or birth dates (§28).
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
                   -- { child_id: [reasons] }, empty array meaning eligible.
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
    -- This family's current registrations only.
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
-- Dashboard summary (§8)
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

-- =============================================================================
-- Preflight checks before opening registration (§23)
--
-- These are warnings, not blocks. The admin decides whether a co-op with one
-- teacherless class is ready to open; the software's job is to make sure nobody
-- finds out about it from a parent.
-- =============================================================================
create or replace function public.registration_preflight(p_semester_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  w jsonb := '[]'::jsonb;
  n integer;
  names text;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select count(*), string_agg(coalesce(display_name, 'Period ' || period_number), ', ')
    into n, names
    from public.periods p
   where p.semester_id = p_semester_id and p.archived_at is null
     and not exists (select 1 from public.classes c
                      where c.period_id = p.id and c.archived_at is null);
  if n > 0 then
    w := w || jsonb_build_object('level', 'warning',
      'message', format('%s has no classes.', names));
  end if;

  select count(*), string_agg(name, ', ') into n, names
    from public.classes
   where semester_id = p_semester_id and archived_at is null and capacity is null;
  if n > 0 then
    w := w || jsonb_build_object('level', 'info',
      'message', format('%s class(es) have no capacity limit: %s', n, names));
  end if;

  select count(*), string_agg(name, ', ') into n, names
    from public.classes
   where semester_id = p_semester_id and archived_at is null
     and (teacher_name is null or trim(teacher_name) = '');
  if n > 0 then
    w := w || jsonb_build_object('level', 'warning',
      'message', format('%s class(es) have no teacher listed: %s', n, names));
  end if;

  select count(*), string_agg(display_name, ', ') into n, names
    from public.families
   where active and archived_at is null
     and (primary_email is null or trim(primary_email) = '');
  if n > 0 then
    w := w || jsonb_build_object('level', 'error',
      'message', format('%s active family/families have no email address and cannot be invited: %s', n, names));
  end if;

  select count(*), string_agg(ch.first_name || ' ' || coalesce(ch.last_name, ''), ', ')
    into n, names
    from public.children ch join public.families f on f.id = ch.family_id
   where ch.active and ch.archived_at is null and f.active and f.archived_at is null
     and ch.birth_date is null;
  if n > 0 then
    w := w || jsonb_build_object('level', 'warning',
      'message', format('%s active child(ren) have no birth date, so age eligibility cannot be checked: %s', n, names));
  end if;

  -- Only worth mentioning when the semester actually has sex-restricted classes.
  if exists (select 1 from public.classes where semester_id = p_semester_id
              and archived_at is null and sex_requirement <> 'any') then
    select count(*), string_agg(ch.first_name || ' ' || coalesce(ch.last_name, ''), ', ')
      into n, names
      from public.children ch join public.families f on f.id = ch.family_id
     where ch.active and ch.archived_at is null and f.active and f.archived_at is null
       and ch.sex is null;
    if n > 0 then
      w := w || jsonb_build_object('level', 'warning',
        'message', format('This semester has sex-restricted classes, but %s active child(ren) have no sex recorded: %s', n, names));
    end if;
  end if;

  select count(*) into n from public.periods
   where semester_id = p_semester_id and archived_at is null;
  if n = 0 then
    w := w || jsonb_build_object('level', 'error',
      'message', 'This semester has no periods yet.');
  end if;

  if (select class_start_date from public.semesters where id = p_semester_id) is null then
    w := w || jsonb_build_object('level', 'error',
      'message', 'This semester has no first class date, so ages cannot be calculated.');
  end if;

  return jsonb_build_object(
    'warnings', w,
    'blocking', exists (
      select 1 from jsonb_array_elements(w) e where e ->> 'level' = 'error'));
end;
$$;

-- Family payload is service-role only; the other two are admin tools.
revoke execute on function public.family_registration_payload(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.semester_summary(uuid) from public, anon;
revoke execute on function public.registration_preflight(uuid) from public, anon;
grant execute on function public.semester_summary(uuid)       to authenticated;
grant execute on function public.registration_preflight(uuid) to authenticated;
grant execute on function public.family_registration_payload(uuid, uuid) to service_role;
grant execute on function public.semester_summary(uuid)       to service_role;
grant execute on function public.registration_preflight(uuid) to service_role;
