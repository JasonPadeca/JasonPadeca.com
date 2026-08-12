-- =============================================================================
-- 0028_family_volunteering.sql
-- Letting a family see its own volunteering.
--
-- Offers are made inside the class sign-up flow, which a family reaches from an
-- emailed link. The portal — where families now actually live — said nothing
-- about volunteering at all. So a mother could sign in, see her week, edit her
-- children, register, propose a class, and have no way to learn that her
-- twelve-year-old had offered to help in the preschool class, or that he had
-- since been assigned to it.
--
-- Nothing was removed to cause that. The portal simply grew up around the
-- volunteer flow without ever including it.
--
-- Read-only here. Offers are still made during class sign-up and assignments
-- are still made by an administrator; this only lets a family SEE both, which
-- is the part that was missing.
-- =============================================================================

select public.migration_guard('0028', '0027');

create or replace function public.family_volunteering(p_semester_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_kids uuid[] := public.current_child_ids();
  v_sem  uuid;
begin
  if array_length(v_kids, 1) is null then
    return jsonb_build_object('ok', true, 'children', '[]'::jsonb);
  end if;

  v_sem := coalesce(p_semester_id, (
    select id from public.semesters
     where archived_at is null
     order by class_start_date desc nulls last
     limit 1));

  return jsonb_build_object(
    'ok', true,
    'semester', (select jsonb_build_object('id', id, 'name', name)
                   from public.semesters where id = v_sem),
    'children', coalesce((
      select jsonb_agg(jsonb_build_object(
        'child_id', c.id,
        'name', c.first_name || ' ' || coalesce(c.last_name, ''),

        -- What they offered, if anything.
        'offered', exists (
          select 1 from public.volunteer_interest vi
           where vi.child_id = c.id and vi.semester_id = v_sem
             and vi.wants_to_volunteer),
        'note', (select vi.note from public.volunteer_interest vi
                  where vi.child_id = c.id and vi.semester_id = v_sem),

        -- The particular classes they put themselves forward for.
        'offered_for', coalesce((
          select jsonb_agg(distinct coalesce(cl.name, p.display_name))
            from public.volunteer_interest_slot vs
            join public.volunteer_interest vi on vi.id = vs.interest_id
            left join public.classes cl on cl.id = vs.class_id
            left join public.periods p on p.id = vs.period_id
           where vi.child_id = c.id and vi.semester_id = v_sem), '[]'::jsonb),

        -- And where the co-op actually put them, which is the bit a family
        -- currently has no way of learning.
        -- class_volunteers carries its own period and semester, so this needs
        -- no journey through classes to find either.
        'assigned_to', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'class', cl.name,
                   'period', p.display_name,
                   'starts', p.start_time,
                   'note', cv.note))
            from public.class_volunteers cv
            join public.classes cl on cl.id = cv.class_id
            left join public.periods p on p.id = cv.period_id
           where cv.child_id = c.id and cv.semester_id = v_sem), '[]'::jsonb)
      ) order by c.first_name)
      from public.children c
     where c.id = any(v_kids) and c.active and c.archived_at is null), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.family_volunteering(uuid) from public, anon;
grant execute on function public.family_volunteering(uuid) to authenticated;

select public.record_migration('0028');
