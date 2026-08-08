-- =============================================================================
-- 0010_payload_volunteer_limit.sql
-- Tell the family page what the volunteering age limit is.
--
-- The page must offer exactly the classes the database will accept. Without the
-- threshold in the payload it would have to guess, and a parent would tick
-- options that vanish on submit — the worst kind of bug, because it looks like
-- it worked.
--
-- Identical to the version in 0006 apart from the one added key.
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
    -- The page must offer exactly the classes the trigger will accept.
    'volunteer_max_class_age', v_settings.volunteer_max_class_age,
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
