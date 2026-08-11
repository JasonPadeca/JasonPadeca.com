-- =============================================================================
-- 0025_records.sql
-- Applications and registrations as records: printable, and hard to quietly
-- disagree with later.
--
-- Update 18 let parents edit their children's dates of birth. That was the
-- right call — they are the only people who know — but it created a gap this
-- closes: a date of birth decides which classes a child may join, and nothing
-- was writing down what it WAS when the co-op agreed to the registration.
--
-- What was stored as form_data was the payload the browser sent, and for a
-- child already on file that payload carried a grade and nothing else. So there
-- was no earlier value to compare against, and no way to answer "was she
-- eleven when we registered her, or has that changed since".
--
-- Two things happen here.
--
--   1. The snapshot is built by the DATABASE at the moment of submission, not
--      sent by the browser. Every child, their name and date of birth and age
--      at the semester's start, as the co-op held them at that instant.
--
--   2. Reading a registration back reports DRIFT: anything that has changed
--      since. Not as an accusation — a date of birth genuinely gets corrected,
--      and a family that has to ring the registrar to fix a typo is a family
--      that stops using the software. It is shown, with both values, so a
--      person can look at it and decide.
--
-- The printing itself is a screen, not a stored document. The record is these
-- rows; paper is a view of them.
-- =============================================================================

select public.migration_guard('0025', '0024');

-- =============================================================================
-- What the co-op held about a family, at one instant.
--
-- Ages are computed here and stored, rather than left to be recalculated when
-- somebody reads the record. A recalculated age tells you how old the child is
-- today; this has to say how old the co-op believed they were on the day it
-- agreed to their registration, which is the only figure that means anything
-- afterwards.
-- =============================================================================
create or replace function public.build_registration_snapshot(
  p_family_id   uuid,
  p_semester_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'taken_at', now(),
    'semester', (select jsonb_build_object(
                   'id', s.id, 'name', s.name,
                   'class_start_date', s.class_start_date)
                   from public.semesters s where s.id = p_semester_id),
    'family', (select jsonb_build_object(
                 'id', f.id, 'display_name', f.display_name,
                 'primary_email', f.primary_email, 'primary_phone', f.primary_phone)
                 from public.families f where f.id = p_family_id),
    'parents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'first_name', p.first_name, 'last_name', p.last_name,
               'email', p.email, 'phone', p.phone)
             order by p.sort_order, p.first_name)
        from public.parents p where p.family_id = p_family_id), '[]'::jsonb),
    'children', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'first_name', c.first_name, 'last_name', c.last_name,
               'birth_date', c.birth_date,
               'age_at_start', public.age_at(c.birth_date,
                 (select class_start_date from public.semesters where id = p_semester_id)),
               'email', c.email, 'phone', c.phone,
               'allergies', c.allergies, 'medical_notes', c.medical_notes,
               'grade', (select sp.grade from public.semester_participation sp
                          where sp.child_id = c.id and sp.semester_id = p_semester_id))
             order by c.birth_date nulls last, c.first_name)
        from public.children c
       where c.family_id = p_family_id and c.active and c.archived_at is null), '[]'::jsonb)
  );
$$;

revoke execute on function public.build_registration_snapshot(uuid, uuid) from public, anon;
grant execute on function public.build_registration_snapshot(uuid, uuid)
  to authenticated, service_role;

-- =============================================================================
-- Reading a registration back, with anything that has moved since.
--
-- Drift is computed by comparing the snapshot against the children as they
-- stand now. Only dates of birth are compared: they are the field that decides
-- eligibility, and flagging a corrected phone number would bury the one thing
-- worth noticing under a list of things that are not.
-- =============================================================================
create or replace function public.registration_record(
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
  v_reg      public.semester_registrations;
  v_snap     jsonb;
  v_drift    jsonb;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_reg from public.semester_registrations
   where family_id = p_family_id and semester_id = p_semester_id;

  if v_reg.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_registration');
  end if;

  v_snap := v_reg.form_data -> 'snapshot';

  -- Registrations submitted before this update have no snapshot, and saying so
  -- plainly is better than an empty record that looks like nothing changed.
  if v_snap is null then
    v_drift := null;
  else
    select coalesce(jsonb_agg(d), '[]'::jsonb) into v_drift
      from (
        select jsonb_build_object(
                 'child', (snap ->> 'first_name') || ' ' || coalesce(snap ->> 'last_name', ''),
                 'field', 'date of birth',
                 'was', snap ->> 'birth_date',
                 'now', c.birth_date::text
               ) as d
          from jsonb_array_elements(v_snap -> 'children') snap
          join public.children c on c.id = (snap ->> 'id')::uuid
         where (snap ->> 'birth_date') is distinct from c.birth_date::text
      ) t;
  end if;

  return jsonb_build_object(
    'ok', true,
    'family_id', p_family_id,
    'semester_id', p_semester_id,
    'status', v_reg.status,
    'submitted_at', v_reg.form_submitted_at,
    'agreed_conduct_at', v_reg.agreed_conduct_at,
    'reviewed_at', v_reg.reviewed_at,
    'payment_received_at', v_reg.payment_received_at,
    'payment_note', v_reg.payment_note,
    'registered_at', v_reg.registered_at,
    'outstanding_at_registration', v_reg.outstanding_at_registration,
    'answers', v_reg.form_data - 'snapshot',
    'snapshot', v_snap,
    'drift', v_drift
  );
end;
$$;

revoke execute on function public.registration_record(uuid, uuid) from public, anon;
grant execute on function public.registration_record(uuid, uuid) to authenticated;

-- =============================================================================
-- An application, as submitted.
--
-- Applications were already immutable in practice — nothing edits the answers
-- once they are in, only the status beside them. This is a reader for them, so
-- the printable page has one shape to work with rather than two.
-- =============================================================================
create or replace function public.application_record(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_app public.applications;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_app from public.applications where id = p_id;
  if v_app.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_app.id,
    'submitted_at', v_app.created_at,
    'status', v_app.status,
    'reviewed_at', v_app.reviewed_at,
    'admin_notes', v_app.admin_notes,
    'family_id', v_app.family_id,
    'answers', jsonb_build_object(
      'parent_names', v_app.parent_names,
      'email', v_app.email,
      'phone', v_app.phone,
      'children_text', v_app.children_text,
      'agrees_to_beliefs', v_app.agrees_to_beliefs,
      'heard_about', v_app.heard_about,
      'homeschool_journey', v_app.homeschool_journey,
      'about_yourself', v_app.about_yourself,
      'looking_for', v_app.looking_for
    )
  );
end;
$$;

revoke execute on function public.application_record(uuid) from public, anon;
grant execute on function public.application_record(uuid) to authenticated;

-- =============================================================================
-- Every registration a family has ever sent, for the family page.
-- =============================================================================
create or replace function public.family_registration_history(p_family_id uuid)
returns table (
  semester_id   uuid,
  semester_name text,
  status        text,
  submitted_at  timestamptz,
  registered_at timestamptz,
  has_snapshot  boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select r.semester_id, s.name, r.status, r.form_submitted_at, r.registered_at,
         (r.form_data -> 'snapshot') is not null
    from public.semester_registrations r
    join public.semesters s on s.id = r.semester_id
   where r.family_id = p_family_id
     and public.is_active_admin()
   order by s.class_start_date desc nulls last;
$$;

revoke execute on function public.family_registration_history(uuid) from public, anon;
grant execute on function public.family_registration_history(uuid) to authenticated;

-- =============================================================================
-- Submitting now takes the snapshot.
--
-- Recreated in full so what runs is what is written down here. The only change
-- from 0023 is the snapshot on the way in.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.submit_registration_form(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fams    uuid[] := public.current_family_ids();
  v_fam_id  uuid;
  v_sem     public.semesters;
  v_reg_id  uuid;
  v_child   jsonb;
  v_parent  jsonb;
  v_cid     uuid;
  v_added   int := 0;
begin
  if array_length(v_fams, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no_family');
  end if;
  v_fam_id := v_fams[1];

  select * into v_sem from public.semesters
   where id = (p_payload ->> 'semester_id')::uuid;

  if v_sem.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_semester');
  end if;

  -- The window is checked here, not only on the page. A form left open in a
  -- tab overnight must not be a way past a closed window.
  if v_sem.registration_form_opens_at is null
     or now() < v_sem.registration_form_opens_at
     or (v_sem.registration_form_closes_at is not null
         and now() > v_sem.registration_form_closes_at) then
    return jsonb_build_object('ok', false, 'error', 'registration_closed');
  end if;

  if coalesce((p_payload ->> 'agreed_conduct')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'error', 'conduct_required');
  end if;

  -- --- the family's own details, where they were asked for -------------------
  if nullif(trim(coalesce(p_payload ->> 'primary_phone', '')), '') is not null then
    update public.families
       set primary_phone = trim(p_payload ->> 'primary_phone')
     where id = v_fam_id;
  end if;

  -- --- parents named on the form, if this family has none on file ------------
  for v_parent in select * from jsonb_array_elements(coalesce(p_payload -> 'new_parents', '[]'::jsonb))
  loop
    if nullif(trim(coalesce(v_parent ->> 'first_name', '')), '') is not null then
      insert into public.parents (family_id, first_name, last_name, email, phone)
      values (v_fam_id,
              trim(v_parent ->> 'first_name'),
              nullif(trim(coalesce(v_parent ->> 'last_name', '')), ''),
              nullif(trim(coalesce(v_parent ->> 'email', '')), ''),
              nullif(trim(coalesce(v_parent ->> 'phone', '')), ''));
    end if;
  end loop;

  -- --- children named on the form -------------------------------------------
  for v_child in select * from jsonb_array_elements(coalesce(p_payload -> 'new_children', '[]'::jsonb))
  loop
    if nullif(trim(coalesce(v_child ->> 'first_name', '')), '') is not null then
      insert into public.children (family_id, first_name, last_name, birth_date)
      values (v_fam_id,
              trim(v_child ->> 'first_name'),
              nullif(trim(coalesce(v_child ->> 'last_name', '')), ''),
              (nullif(trim(coalesce(v_child ->> 'birth_date', '')), ''))::date)
      returning id into v_cid;
      v_added := v_added + 1;

      if nullif(trim(coalesce(v_child ->> 'grade', '')), '') is not null then
        insert into public.semester_participation (child_id, semester_id, grade, set_by)
        values (v_cid, v_sem.id, trim(v_child ->> 'grade'), 'family')
        on conflict (child_id, semester_id) do update set grade = excluded.grade;
      end if;
    end if;
  end loop;

  -- --- grades for children already on file ----------------------------------
  for v_child in select * from jsonb_array_elements(coalesce(p_payload -> 'grades', '[]'::jsonb))
  loop
    v_cid := (v_child ->> 'child_id')::uuid;

    -- A family may only set grades for its own children. The page offers no
    -- other option; that is not the same as it being impossible.
    if v_cid = any(public.current_child_ids()) then
      insert into public.semester_participation (child_id, semester_id, grade, set_by)
      values (v_cid, v_sem.id, nullif(trim(coalesce(v_child ->> 'grade', '')), ''), 'family')
      on conflict (child_id, semester_id) do update set grade = excluded.grade;
    end if;
  end loop;

  -- --- the form itself -------------------------------------------------------
  -- The snapshot is taken HERE, after the family's own edits have landed and
  -- before anything else can move, and it is built by the database rather than
  -- sent by the browser. That is the whole point: it has to be the co-op's
  -- record of what it believed, not the applicant's account of it.
  insert into public.semester_registrations (
    family_id, semester_id, status, form_submitted_at, form_data, agreed_conduct_at)
  values (v_fam_id, v_sem.id, 'not_started', now(),
          p_payload || jsonb_build_object('snapshot',
            public.build_registration_snapshot(v_fam_id, v_sem.id)),
          now())
  on conflict (family_id, semester_id) do update
    set form_submitted_at = now(),
        form_data         = excluded.form_data,
        agreed_conduct_at = now()
  returning id into v_reg_id;

  perform public.write_audit('registration_form_submitted', 'family', v_fam_id,
    jsonb_build_object('semester_id', v_sem.id, 'children_added', v_added));

  return jsonb_build_object('ok', true, 'children_added', v_added);
end;
$function$;

-- =============================================================================
-- Drift, on the desk as well as on paper.
--
-- A notice that only appears when somebody prints is a notice nobody reads.
-- The registration report gains a count, so the block itself can say it.
-- =============================================================================
drop function if exists public.semester_registration_report(uuid);

create function public.semester_registration_report(p_semester_id uuid)
returns table (
  family_id       uuid,
  display_name    text,
  primary_email   text,
  children        bigint,
  status          text,
  note            text,
  updated_at      timestamptz,
  form_submitted_at   timestamptz,
  form_data           jsonb,
  reviewed_at         timestamptz,
  payment_received_at timestamptz,
  payment_note        text,
  registered_at       timestamptz,
  outstanding_at_registration jsonb,
  drift_count         integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    f.id, f.display_name, f.primary_email,
    (select count(*) from public.children c
      where c.family_id = f.id and c.active and c.archived_at is null),
    coalesce(r.status, 'not_started'),
    r.note, r.updated_at,
    r.form_submitted_at, r.form_data - 'snapshot', r.reviewed_at,
    r.payment_received_at, r.payment_note, r.registered_at,
    r.outstanding_at_registration,
    (select count(*)::integer
       from jsonb_array_elements(coalesce(r.form_data -> 'snapshot' -> 'children',
                                          '[]'::jsonb)) snap
       join public.children c2 on c2.id = (snap ->> 'id')::uuid
      where (snap ->> 'birth_date') is distinct from c2.birth_date::text)
  from public.families f
  left join public.semester_registrations r
         on r.family_id = f.id and r.semester_id = p_semester_id
  where f.archived_at is null
    and public.is_active_admin()
  order by f.display_name;
$$;

revoke execute on function public.semester_registration_report(uuid) from public, anon;
grant execute on function public.semester_registration_report(uuid) to authenticated;

select public.record_migration('0025');
