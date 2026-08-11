-- =============================================================================
-- 0022_registration_and_proposals.sql
-- Two things a family does, and the words for them.
--
-- Until now this project used "registration" for one thing: a child being put
-- into a class. That is not what the co-op means by the word. There are three
-- separate steps, and conflating the middle one with the last has made the
-- software describe the process differently from the people running it:
--
--   Application    Asking to join the co-op at all. Once, ever.       (0020)
--   Registration   A family saying it is taking part this semester.   (here)
--   Class Sign-up  A child being placed in a class in a period.       (0001)
--
-- Only the middle one is new. The last one already works and keeps its database
-- names — renaming `registrations` would be a large, risky change that no user
-- would ever see. What changes above ground is the wording.
--
-- Registration is admin-set for now. The submission flow families will
-- eventually use — forms, fees, agreements — is a separate design, and guessing
-- at it here would build the wrong thing twice. What this does establish is the
-- record it will attach to, and the status both sides can see today.
--
-- The other half of this file is class proposals: a parent, or a student,
-- suggesting a class the co-op might run. Those arrive as a form and stop.
-- Whether a proposal becomes a class is decided in a room by people talking to
-- each other, and the accepted ones are typed in by hand afterwards. Software
-- that tried to model that decision would be modelling a meeting.
-- =============================================================================

select public.migration_guard('0022', '0021');

-- =============================================================================
-- Registration: a family, a semester, and where they stand.
--
-- No row means "not started". That is deliberate — a semester with forty
-- families should not need forty rows written the moment it is created, and
-- "we have not heard from them" is the honest reading of nothing at all.
-- =============================================================================
create table public.semester_registrations (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id)  on delete cascade,
  semester_id uuid not null references public.semesters(id) on delete cascade,

  status      text not null default 'not_started'
              check (status in ('not_started', 'registered', 'not_attending')),

  -- Why, when it is not obvious. "Paid at the August meeting", "moving away in
  -- October". The registrar's memory, written down.
  note        text,

  updated_by  uuid references public.admins(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (family_id, semester_id)
);

create index semester_registrations_semester_idx
  on public.semester_registrations (semester_id, status);

create trigger semester_registrations_touch before update
  on public.semester_registrations
  for each row execute function public.touch_updated_at();

alter table public.semester_registrations enable row level security;
revoke all on public.semester_registrations from anon, authenticated;
grant select on public.semester_registrations to authenticated;
grant all    on public.semester_registrations to service_role;

create policy admin_all on public.semester_registrations
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

-- A family sees its own standing and nobody else's.
create policy family_reads on public.semester_registrations
  for select to authenticated
  using (family_id = any (public.current_family_ids()));

-- =============================================================================
-- Class proposals.
--
-- One table for both kinds. They ask overlapping questions in different words,
-- and splitting them into two tables would mean two of every query, two admin
-- screens, and a running argument about which one a given column belongs to.
-- `kind` says which form it came from; the columns only that form asks are null
-- on the other.
--
-- The questions are the co-op's own, copied from the forms already on their
-- site. They were not reworded to suit a database. A proposal is read by people
-- deciding whether the co-op can host the class, and "will you need the church
-- printer, and how often" is a question they ask because the answer matters.
-- =============================================================================
create table public.class_proposals (
  id          uuid primary key default gen_random_uuid(),

  kind        text not null check (kind in ('parent', 'student')),

  -- Who is proposing. Exactly one of these, matching the kind — enforced below.
  family_id   uuid not null references public.families(id) on delete cascade,
  parent_id   uuid references public.parents(id)  on delete set null,
  child_id    uuid references public.children(id) on delete set null,

  -- Which term this is aimed at. Nullable: somebody may have an idea before the
  -- next semester exists, and losing the idea would be worse than losing the
  -- tidiness.
  semester_id uuid references public.semesters(id) on delete set null,

  -- --- Asked on both forms ------------------------------------------------
  title           text not null,
  age_range       text not null
                  check (age_range in ('Preschool', '5-9', '9-12', '12+', 'Other')),
  description     text not null,
  homework        text not null check (homework in ('None', 'Light', 'Moderate')),
  technical_needs text,
  room_request    text,
  extra_info      text,

  -- --- Parent form only ----------------------------------------------------
  teacher_name      text,   -- "Teacher"
  contact_email     text,   -- "Email"
  needs_helper      text,   -- "Do you need a helper?"
  helper_details    text,   -- "...have you already spoken to someone?"
  prerequisites     text,   -- "Are there any prerequisites to your class?"
  materials_fee     text,   -- "Will there be a fee to cover materials?"
  student_materials text,   -- "Will the student need to supply any materials?"
  size_limit        text,   -- "Will there need to be a limit to the class size?"
  own_resources     text,   -- "...do you have the resources to supply them yourself?"
  printer_use       text,   -- "Will you need to use the church printer?"
  prep_hour         text    check (prep_hour is null or prep_hour in
                      ('Yes', 'No', 'It would be nice, but not necessary')),

  -- --- Student form only ---------------------------------------------------
  other_students    text,   -- "Names of at least two other students who want to take it"
  parent_email      text,
  student_email     text,
  suggested_teacher text,
  builds_on_skills  text,   -- "Does this class build on skills learned previously?"
  materials_needed  text,   -- "What materials will be needed? Be thorough."

  -- --- What happened to it -------------------------------------------------
  --
  -- Two states, not a workflow. It is either waiting to be discussed or it has
  -- been. The outcome is recorded because somebody will ask next year why a
  -- class did not run, not because anything downstream reads it.
  status      text not null default 'submitted'
              check (status in ('submitted', 'archived')),
  outcome     text check (outcome is null or outcome in ('accepted', 'declined')),
  admin_notes text,

  submitted_at timestamptz not null default now(),
  archived_at  timestamptz,
  archived_by  uuid references public.admins(id) on delete set null,
  updated_at   timestamptz not null default now(),

  -- A parent proposal comes from a parent, a student proposal from a child.
  -- Without this the kind and the proposer can drift apart, and then a student
  -- proposal shows a parent's name at the top of it.
  constraint proposer_matches_kind check (
    (kind = 'parent'  and parent_id is not null and child_id is null) or
    (kind = 'student' and child_id  is not null and parent_id is null)
  )
);

create index class_proposals_status_idx  on public.class_proposals (status, submitted_at desc);
create index class_proposals_family_idx  on public.class_proposals (family_id);

create trigger class_proposals_touch before update on public.class_proposals
  for each row execute function public.touch_updated_at();

alter table public.class_proposals enable row level security;
revoke all on public.class_proposals from anon, authenticated;
grant select on public.class_proposals to authenticated;
grant all    on public.class_proposals to service_role;

create policy admin_all on public.class_proposals
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

-- A family can read what it sent. Writing goes through the function below, so
-- that the proposer can be checked against the family rather than trusted.
create policy family_reads on public.class_proposals
  for select to authenticated
  using (family_id = any (public.current_family_ids()));

-- =============================================================================
-- Setting a family's registration.
-- =============================================================================
create or replace function public.set_family_registration(
  p_family_id   uuid,
  p_semester_id uuid,
  p_status      text,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  if p_status not in ('not_started', 'registered', 'not_attending') then
    return jsonb_build_object('ok', false, 'error', 'bad_status');
  end if;

  insert into public.semester_registrations (family_id, semester_id, status, note, updated_by)
  values (p_family_id, p_semester_id, p_status, nullif(trim(coalesce(p_note, '')), ''),
          public.current_admin_id())
  on conflict (family_id, semester_id) do update
     set status = excluded.status,
         note = excluded.note,
         updated_by = excluded.updated_by
  returning id into v_id;

  perform public.write_audit('family_registration_set', 'family', p_family_id,
    jsonb_build_object('semester_id', p_semester_id, 'status', p_status));

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke execute on function public.set_family_registration(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_family_registration(uuid, uuid, text, text) to authenticated;

-- =============================================================================
-- Every family's standing for one semester.
--
-- Left join, so a family with no row appears as "not started" rather than not
-- appearing. The registrar's question is "who have we not heard from", and a
-- list that silently omits them cannot answer it.
-- =============================================================================
create or replace function public.semester_registration_report(p_semester_id uuid)
returns table (
  family_id     uuid,
  display_name  text,
  primary_email text,
  primary_phone text,
  children      integer,
  status        text,
  note          text,
  updated_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select f.id,
         f.display_name,
         f.primary_email,
         f.primary_phone,
         (select count(*)::integer from public.children c
           where c.family_id = f.id and c.active),
         coalesce(sr.status, 'not_started'),
         sr.note,
         sr.updated_at
    from public.families f
    left join public.semester_registrations sr
           on sr.family_id = f.id and sr.semester_id = p_semester_id
   where public.is_active_admin()
     and f.archived_at is null
   order by f.display_name;
$$;

revoke execute on function public.semester_registration_report(uuid) from public, anon;
grant execute on function public.semester_registration_report(uuid) to authenticated;

-- =============================================================================
-- Sending a proposal.
--
-- The proposer is checked against the caller's own family rather than taken on
-- trust: the browser chooses who is proposing from a dropdown, and a dropdown
-- is a suggestion, not a credential.
-- =============================================================================
create or replace function public.submit_class_proposal(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent   public.parents;
  v_child    public.children;
  v_kind     text;
  v_family   uuid;
  v_id       uuid;
  v_txt      text;
begin
  if not public.is_family_member() then
    raise exception 'Not authorized';
  end if;

  -- Who is proposing decides which form this is.
  if p_payload ? 'parent_id' and p_payload->>'parent_id' is not null then
    select * into v_parent from public.parents where id = (p_payload->>'parent_id')::uuid;
    if v_parent.id is null or not (v_parent.family_id = any (public.current_family_ids())) then
      return jsonb_build_object('ok', false, 'error', 'not_your_family');
    end if;
    v_kind := 'parent';
    v_family := v_parent.family_id;

  elsif p_payload ? 'child_id' and p_payload->>'child_id' is not null then
    select * into v_child from public.children where id = (p_payload->>'child_id')::uuid;
    if v_child.id is null or not (v_child.family_id = any (public.current_family_ids())) then
      return jsonb_build_object('ok', false, 'error', 'not_your_family');
    end if;
    v_kind := 'student';
    v_family := v_child.family_id;

  else
    return jsonb_build_object('ok', false, 'error', 'no_proposer');
  end if;

  v_txt := nullif(trim(coalesce(p_payload->>'title', '')), '');
  if v_txt is null then
    return jsonb_build_object('ok', false, 'error', 'title_required');
  end if;

  insert into public.class_proposals (
    kind, family_id, parent_id, child_id, semester_id,
    title, age_range, description, homework, technical_needs, room_request, extra_info,
    teacher_name, contact_email, needs_helper, helper_details, prerequisites,
    materials_fee, student_materials, size_limit, own_resources, printer_use, prep_hour,
    other_students, parent_email, student_email, suggested_teacher,
    builds_on_skills, materials_needed
  ) values (
    v_kind, v_family,
    case when v_kind = 'parent'  then v_parent.id end,
    case when v_kind = 'student' then v_child.id  end,
    nullif(p_payload->>'semester_id', '')::uuid,
    v_txt,
    coalesce(nullif(p_payload->>'age_range', ''), 'Other'),
    coalesce(nullif(trim(coalesce(p_payload->>'description', '')), ''), ''),
    coalesce(nullif(p_payload->>'homework', ''), 'None'),
    nullif(trim(coalesce(p_payload->>'technical_needs', '')), ''),
    nullif(trim(coalesce(p_payload->>'room_request', '')), ''),
    nullif(trim(coalesce(p_payload->>'extra_info', '')), ''),
    nullif(trim(coalesce(p_payload->>'teacher_name', '')), ''),
    nullif(trim(coalesce(p_payload->>'contact_email', '')), ''),
    nullif(trim(coalesce(p_payload->>'needs_helper', '')), ''),
    nullif(trim(coalesce(p_payload->>'helper_details', '')), ''),
    nullif(trim(coalesce(p_payload->>'prerequisites', '')), ''),
    nullif(trim(coalesce(p_payload->>'materials_fee', '')), ''),
    nullif(trim(coalesce(p_payload->>'student_materials', '')), ''),
    nullif(trim(coalesce(p_payload->>'size_limit', '')), ''),
    nullif(trim(coalesce(p_payload->>'own_resources', '')), ''),
    nullif(trim(coalesce(p_payload->>'printer_use', '')), ''),
    nullif(p_payload->>'prep_hour', ''),
    nullif(trim(coalesce(p_payload->>'other_students', '')), ''),
    nullif(trim(coalesce(p_payload->>'parent_email', '')), ''),
    nullif(trim(coalesce(p_payload->>'student_email', '')), ''),
    nullif(trim(coalesce(p_payload->>'suggested_teacher', '')), ''),
    nullif(trim(coalesce(p_payload->>'builds_on_skills', '')), ''),
    nullif(trim(coalesce(p_payload->>'materials_needed', '')), '')
  )
  returning id into v_id;

  perform public.write_audit('class_proposal_submitted', 'class_proposal', v_id,
    jsonb_build_object('kind', v_kind, 'title', v_txt),
    'family', null);

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke execute on function public.submit_class_proposal(jsonb) from public, anon;
grant execute on function public.submit_class_proposal(jsonb) to authenticated;

-- =============================================================================
-- Filing a proposal away, either way.
-- =============================================================================
create or replace function public.archive_proposal(
  p_id      uuid,
  p_outcome text default null,
  p_notes   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  if p_outcome is not null and p_outcome not in ('accepted', 'declined') then
    return jsonb_build_object('ok', false, 'error', 'bad_outcome');
  end if;

  update public.class_proposals
     set status = 'archived',
         outcome = p_outcome,
         admin_notes = nullif(trim(coalesce(p_notes, '')), ''),
         archived_at = now(),
         archived_by = public.current_admin_id()
   where id = p_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  perform public.write_audit('class_proposal_archived', 'class_proposal', p_id,
    jsonb_build_object('outcome', p_outcome));

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.archive_proposal(uuid, text, text) from public, anon;
grant execute on function public.archive_proposal(uuid, text, text) to authenticated;

-- Filed by mistake, or reopened because the meeting ran out of time.
create or replace function public.reopen_proposal(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  update public.class_proposals
     set status = 'submitted', outcome = null, archived_at = null, archived_by = null
   where id = p_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  perform public.write_audit('class_proposal_reopened', 'class_proposal', p_id);
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.reopen_proposal(uuid) from public, anon;
grant execute on function public.reopen_proposal(uuid) to authenticated;

-- =============================================================================
-- What a family may propose with, and where it stands.
--
-- One call rather than three, because the page needs all of it before it can
-- draw anything: who is in the family, which terms are open to propose for, and
-- what has already been sent.
-- =============================================================================
create or replace function public.family_proposal_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_families uuid[];
begin
  if not public.is_family_member() then
    raise exception 'Not authorized';
  end if;

  v_families := public.current_family_ids();

  return jsonb_build_object(
    'parents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id,
               'name', trim(p.first_name || ' ' || coalesce(p.last_name, ''))
             ) order by p.sort_order, p.first_name)
        from public.parents p where p.family_id = any (v_families)), '[]'::jsonb),

    'children', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'name', trim(c.first_name || ' ' || coalesce(c.last_name, ''))
             ) order by c.birth_date nulls last, c.first_name)
        from public.children c
       where c.family_id = any (v_families) and c.active), '[]'::jsonb),

    'semesters', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)
             order by s.class_start_date desc nulls last)
        from public.semesters s
       where s.archived_at is null), '[]'::jsonb),

    'mine', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', cp.id,
               'kind', cp.kind,
               'title', cp.title,
               'status', cp.status,
               'outcome', cp.outcome,
               'submitted_at', cp.submitted_at,
               'proposer', coalesce(
                  (select trim(p.first_name || ' ' || coalesce(p.last_name, ''))
                     from public.parents p where p.id = cp.parent_id),
                  (select trim(c.first_name || ' ' || coalesce(c.last_name, ''))
                     from public.children c where c.id = cp.child_id))
             ) order by cp.submitted_at desc)
        from public.class_proposals cp
       where cp.family_id = any (v_families)), '[]'::jsonb),

    'registration', coalesce((
      select jsonb_agg(jsonb_build_object(
               'semester_id', s.id,
               'semester', s.name,
               'status', coalesce(sr.status, 'not_started'))
             order by s.class_start_date desc nulls last)
        from public.semesters s
        left join public.semester_registrations sr
               on sr.semester_id = s.id and sr.family_id = any (v_families)
       where s.archived_at is null), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.family_proposal_payload() from public, anon;
grant execute on function public.family_proposal_payload() to authenticated;

select public.record_migration('0022');
