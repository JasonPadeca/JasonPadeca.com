-- =============================================================================
-- 0033_archive_family.sql
-- Archiving a family takes them out of everything.
--
-- Until now archiving set two columns on the family row and stopped. The
-- children stayed active, their class places stayed "registered", their
-- volunteer assignments stayed, and their registration for the term still read
-- as registered.
--
-- So a family who had left was still occupying seats — counted against
-- capacity, printed on the teacher's roster, and standing between a waiting
-- family and a place. Nothing about that is visible from the family page, which
-- cheerfully showed "Archived".
--
-- WHAT IS NOT TOUCHED: anything belonging to a semester that has been archived.
-- A child who took Chemistry last spring took Chemistry last spring, and a past
-- roster that develops holes is worse than useless — somebody will eventually
-- ask who was in that class, and the answer must not depend on whether the
-- family stayed in the co-op afterwards.
--
-- WHAT IS NOT DONE AUTOMATICALLY: promoting whoever was waiting for the seats
-- this frees. That is an email to a real family and a decision about timing, so
-- the freed places are reported and a person chooses. Software that quietly
-- promotes somebody has sent a message on the registrar's behalf.
-- =============================================================================

select public.migration_guard('0033', '0032');

create or replace function public.archive_family(
  p_family_id uuid,
  p_reason    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fam        public.families;
  v_kids       int := 0;
  v_places     int := 0;
  v_waits      int := 0;
  v_vol        int := 0;
  v_interest   int := 0;
  v_regs       int := 0;
  v_freed      jsonb;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_fam from public.families where id = p_family_id;
  if v_fam.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_such_family');
  end if;

  -- --- which classes are about to have room, and for whom ---------------------
  -- Gathered BEFORE the withdrawal, so the report names the classes this family
  -- is actually vacating rather than every class with a spare seat.
  select coalesce(jsonb_agg(distinct jsonb_build_object(
           'class', cl.name,
           'semester', s.name,
           'waiting', (select count(*) from public.registrations w
                        where w.class_id = cl.id and w.status = 'waitlisted'))), '[]'::jsonb)
    into v_freed
    from public.registrations r
    join public.children ch on ch.id = r.child_id
    join public.classes cl  on cl.id = r.class_id
    join public.semesters s on s.id = r.semester_id
   where ch.family_id = p_family_id
     and r.status = 'registered'
     and s.archived_at is null;

  -- --- class places, current and future ---------------------------------------
  with done as (
    update public.registrations r
       set status = 'withdrawn', updated_at = now()
      from public.children ch, public.semesters s
     where r.child_id = ch.id
       and s.id = r.semester_id
       and ch.family_id = p_family_id
       and s.archived_at is null
       and r.status in ('registered', 'waitlisted')
    returning r.status, (r.status = 'waitlisted') as was_waiting
  )
  select count(*) filter (where not was_waiting), count(*) filter (where was_waiting)
    into v_places, v_waits from done;

  -- --- volunteering ------------------------------------------------------------
  with gone as (
    delete from public.class_volunteers cv
     using public.children ch, public.semesters s
     where cv.child_id = ch.id
       and s.id = cv.semester_id
       and ch.family_id = p_family_id
       and s.archived_at is null
    returning 1
  )
  select count(*) into v_vol from gone;

  with gone as (
    update public.volunteer_interest vi
       set wants_to_volunteer = false
      from public.children ch, public.semesters s
     where vi.child_id = ch.id
       and s.id = vi.semester_id
       and ch.family_id = p_family_id
       and s.archived_at is null
       and vi.wants_to_volunteer
    returning 1
  )
  select count(*) into v_interest from gone;

  -- --- the family's own standing for each live semester ------------------------
  with done as (
    update public.semester_registrations sr
       set status = 'not_attending',
           note = trim(coalesce(sr.note || ' · ', '') || 'Family archived'),
           updated_by = public.current_admin_id()
      from public.semesters s
     where sr.semester_id = s.id
       and sr.family_id = p_family_id
       and s.archived_at is null
       and sr.status <> 'not_attending'
    returning 1
  )
  select count(*) into v_regs from done;

  -- --- the people --------------------------------------------------------------
  with done as (
    update public.children
       set active = false,
           archived_at = coalesce(archived_at, now()),
           inactive_reason = coalesce(inactive_reason, 'Family archived')
     where family_id = p_family_id and archived_at is null
    returning 1
  )
  select count(*) into v_kids from done;

  update public.families
     set archived_at = coalesce(archived_at, now()),
         active = false,
         notes = case when nullif(trim(coalesce(p_reason, '')), '') is null then notes
                      else trim(coalesce(notes || E'\n', '') || 'Archived: ' || p_reason) end
   where id = p_family_id;

  perform public.write_audit('family_archived', 'family', p_family_id,
    jsonb_build_object('children', v_kids, 'class_places', v_places,
                       'waitlist_places', v_waits, 'volunteer_assignments', v_vol,
                       'reason', p_reason));

  return jsonb_build_object(
    'ok', true,
    'children_archived', v_kids,
    'class_places_freed', v_places,
    'waitlist_places_removed', v_waits,
    'volunteer_assignments_removed', v_vol,
    'volunteer_offers_withdrawn', v_interest,
    'semester_registrations_closed', v_regs,
    'classes_with_room', v_freed);
end;
$$;

-- =============================================================================
-- Bringing a family back.
--
-- Restores the people and nothing else. Their old class places are deliberately
-- NOT reinstated: the seats have very likely gone to somebody else by now, and
-- silently putting a child back into a class that is full — or that somebody
-- was promoted into — would be the software overruling a decision a person
-- made. They sign up again like anybody else.
-- =============================================================================
create or replace function public.restore_family(p_family_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_kids int := 0;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  with done as (
    update public.children
       set active = true, archived_at = null,
           inactive_reason = case when inactive_reason = 'Family archived'
                                  then null else inactive_reason end
     where family_id = p_family_id
       and inactive_reason is not distinct from 'Family archived'
    returning 1
  )
  select count(*) into v_kids from done;

  update public.families
     set archived_at = null, active = true
   where id = p_family_id;

  perform public.write_audit('family_restored', 'family', p_family_id,
    jsonb_build_object('children', v_kids));

  return jsonb_build_object('ok', true, 'children_restored', v_kids,
    'note', 'Class places were not restored — they sign up again.');
end;
$$;

revoke execute on function public.archive_family(uuid, text) from public, anon;
revoke execute on function public.restore_family(uuid) from public, anon;
grant execute on function public.archive_family(uuid, text) to authenticated;
grant execute on function public.restore_family(uuid) to authenticated;

select public.record_migration('0033');
