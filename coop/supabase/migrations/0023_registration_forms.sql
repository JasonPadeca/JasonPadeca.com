-- =============================================================================
-- 0023_registration_forms.sql
-- The registration form, the desk it lands on, and the gate it opens.
--
-- Until now registration was a word the registrar wrote down. This gives it the
-- three things that make it real: a form families fill in, a place an
-- administrator reviews it, and — the consequential part — a gate on class
-- sign-up, so the order the co-op does things in is the order the software
-- enforces.
--
-- What this deliberately does NOT do is decide anything. Payment is collected
-- somewhere this software cannot see, and whether a family is registered is a
-- judgement made by a person who may be holding a paper form or remembering a
-- conversation at church. Every toggle here records what somebody knows; none
-- of them concludes anything on their behalf.
--
-- See REGISTRATION-PLAN.md for the reasoning and the decisions behind it.
-- =============================================================================

select public.migration_guard('0023', '0022');

-- =============================================================================
-- The registration window.
--
-- Separate from the class sign-up window that semesters already carry. They are
-- different events weeks apart: registration opens, families register, and only
-- then does class sign-up open.
-- =============================================================================
alter table public.semesters
  add column if not exists registration_form_opens_at  timestamptz,
  add column if not exists registration_form_closes_at timestamptz;

comment on column public.semesters.registration_form_opens_at is
  'When families may begin registering. Distinct from registration_close_at, '
  'which governs class sign-up.';

-- =============================================================================
-- What a family sent, and what the co-op did about it.
--
-- form_data is jsonb rather than columns. This form will change — the co-op
-- will want to ask something new, and a schema migration per question is a tax
-- on a group who should be able to ask what they like. What they wrote is kept
-- verbatim; the columns beside it are only the things the software acts on.
-- =============================================================================
alter table public.semester_registrations
  add column if not exists form_submitted_at   timestamptz,
  add column if not exists form_data           jsonb,
  add column if not exists agreed_conduct_at   timestamptz,

  add column if not exists reviewed_at         timestamptz,
  add column if not exists reviewed_by         uuid references public.admins(id) on delete set null,

  add column if not exists payment_received_at timestamptz,
  add column if not exists payment_note        text,
  add column if not exists payment_marked_by   uuid references public.admins(id) on delete set null,

  add column if not exists registered_at       timestamptz,
  add column if not exists registered_by       uuid references public.admins(id) on delete set null,

  -- What was still outstanding at the moment somebody pressed Register.
  --
  -- The button is deliberately never disabled: a paper form handed in at church,
  -- a fee waived for a family having a hard year, a family registered at a
  -- meeting on a promise. A system that refuses gets worked around, and the
  -- workaround is a spreadsheet nobody else can see. So it registers whenever
  -- asked — and writes down what was missing, which is the part that matters
  -- when somebody asks in November.
  add column if not exists outstanding_at_registration jsonb;

comment on column public.semester_registrations.form_data is
  'What the family wrote, verbatim. Structured columns beside it carry only '
  'what the software acts on.';

-- =============================================================================
-- Grade, per child per semester.
--
-- On semester_participation rather than children, because a grade is true for a
-- year and children already have a row here for the sitting-out flag. Putting
-- it on the child would be a fact that quietly goes stale every August.
--
-- Nothing keys off it. Ages drive eligibility and will continue to; this is a
-- datapoint the co-op wants on file, and it must not become load-bearing.
-- =============================================================================
alter table public.semester_participation
  add column if not exists grade text;

-- =============================================================================
-- Whether a family may sign up for classes.
--
-- One definition, used by the submission path, by the invitation list, and by
-- the screens that explain themselves to people. Three copies of this rule
-- would be three chances to disagree.
--
-- "Resolved" means registered. A family marked not attending has resolved its
-- registration and is equally not signing up for classes.
-- =============================================================================
create or replace function public.family_may_sign_up(
  p_family_id   uuid,
  p_semester_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.semester_registrations
     where family_id = p_family_id
       and semester_id = p_semester_id
       and status = 'registered'
  );
$$;

revoke execute on function public.family_may_sign_up(uuid, uuid) from public, anon;
grant execute on function public.family_may_sign_up(uuid, uuid) to authenticated, service_role;

-- =============================================================================
-- Everything the registration form needs, in one call.
--
-- The form is mostly a confirmation. Nearly all of it — parents, children,
-- birth dates, phone — is already on file and has been since the first
-- migration, and asking a mother of seven to retype seven names every August is
-- the work this project exists to remove. So the payload carries what is known,
-- the page shows it already filled in, and the only fields presented as
-- questions are the ones that genuinely change.
--
-- first_semester tells the page which half to show: a family with no children
-- on file is being asked to describe itself for the first time.
-- =============================================================================
create or replace function public.family_registration_form()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fams   uuid[] := public.current_family_ids();
  v_fam    public.families;
  v_sem    public.semesters;
  v_reg    public.semester_registrations;
  v_result jsonb;
begin
  if array_length(v_fams, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no_family');
  end if;

  -- One family per registration. Where an address is on file for more than one
  -- (which happens, and is handled elsewhere by showing everything), the first
  -- is the one being registered; the page says which.
  select * into v_fam from public.families where id = v_fams[1];

  -- The semester currently accepting registrations, if any.
  select * into v_sem from public.semesters
   where archived_at is null
     and registration_form_opens_at is not null
     and now() >= registration_form_opens_at
     and (registration_form_closes_at is null or now() <= registration_form_closes_at)
   order by registration_form_opens_at desc
   limit 1;

  select * into v_reg from public.semester_registrations
   where family_id = v_fam.id and semester_id = v_sem.id;

  select jsonb_build_object(
    'ok', true,
    'family', jsonb_build_object(
      'id', v_fam.id,
      'display_name', v_fam.display_name,
      'primary_email', v_fam.primary_email,
      'primary_phone', v_fam.primary_phone
    ),
    'semester', case when v_sem.id is null then null else jsonb_build_object(
      'id', v_sem.id,
      'name', v_sem.name,
      'closes_at', v_sem.registration_form_closes_at
    ) end,
    'parents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
               'email', p.email, 'phone', p.phone)
             order by p.sort_order, p.first_name)
        from public.parents p where p.family_id = v_fam.id), '[]'::jsonb),
    'children', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name,
               'birth_date', c.birth_date,
               'grade', (select sp.grade from public.semester_participation sp
                          where sp.child_id = c.id and sp.semester_id = v_sem.id))
             order by c.birth_date nulls last, c.first_name)
        from public.children c
       where c.family_id = v_fam.id and c.active and c.archived_at is null), '[]'::jsonb),
    -- No children on file means nobody has ever described this family. That is
    -- the "first semester" case, and it is asked a great deal more.
    'first_semester', not exists (
      select 1 from public.children
       where family_id = v_fam.id and active and archived_at is null),
    'submitted', case when v_reg.form_submitted_at is null then null else jsonb_build_object(
      'at', v_reg.form_submitted_at,
      'status', v_reg.status,
      'reviewed', v_reg.reviewed_at is not null,
      'payment_received', v_reg.payment_received_at is not null
    ) end
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.family_registration_form() from public, anon;
grant execute on function public.family_registration_form() to authenticated;

-- =============================================================================
-- A family sends its registration.
--
-- Writes three things: the form as sent, the grades, and — for a family being
-- described for the first time — the parents and children themselves.
--
-- That last part is the point. Approving an application currently creates a
-- family with a name and an email, and an administrator types the rest in by
-- hand from a sentence like "Sarah and Michael, kids are 7, 9 and 13", which
-- cannot be split into rows without guessing. This form asks the same questions
-- of the person who actually knows the answers.
--
-- Submitting does NOT register anybody. It puts a form on a desk.
-- =============================================================================
create or replace function public.submit_registration_form(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  insert into public.semester_registrations (
    family_id, semester_id, status, form_submitted_at, form_data, agreed_conduct_at)
  values (v_fam_id, v_sem.id, 'not_started', now(), p_payload, now())
  on conflict (family_id, semester_id) do update
    set form_submitted_at = now(),
        form_data         = excluded.form_data,
        agreed_conduct_at = now()
  returning id into v_reg_id;

  perform public.write_audit('registration_form_submitted', 'family', v_fam_id,
    jsonb_build_object('semester_id', v_sem.id, 'children_added', v_added));

  return jsonb_build_object('ok', true, 'children_added', v_added);
end;
$$;

revoke execute on function public.submit_registration_form(jsonb) from public, anon;
grant execute on function public.submit_registration_form(jsonb) to authenticated;

-- =============================================================================
-- The desk: three facts an administrator records, and one act.
-- =============================================================================
create or replace function public.set_registration_review(
  p_family_id   uuid,
  p_semester_id uuid,
  p_reviewed    boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  insert into public.semester_registrations (family_id, semester_id, status)
  values (p_family_id, p_semester_id, 'not_started')
  on conflict (family_id, semester_id) do nothing;

  update public.semester_registrations
     set reviewed_at = case when p_reviewed then now() else null end,
         reviewed_by = case when p_reviewed then public.current_admin_id() else null end
   where family_id = p_family_id and semester_id = p_semester_id
  returning id into v_id;

  perform public.write_audit('registration_reviewed', 'family', p_family_id,
    jsonb_build_object('semester_id', p_semester_id, 'reviewed', p_reviewed));

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.set_registration_payment(
  p_family_id   uuid,
  p_semester_id uuid,
  p_received    boolean,
  p_note        text default null
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

  insert into public.semester_registrations (family_id, semester_id, status)
  values (p_family_id, p_semester_id, 'not_started')
  on conflict (family_id, semester_id) do nothing;

  update public.semester_registrations
     set payment_received_at = case when p_received then now() else null end,
         payment_marked_by   = case when p_received then public.current_admin_id() else null end,
         payment_note        = nullif(trim(coalesce(p_note, '')), '')
   where family_id = p_family_id and semester_id = p_semester_id;

  perform public.write_audit('registration_payment_marked', 'family', p_family_id,
    jsonb_build_object('semester_id', p_semester_id, 'received', p_received));

  return jsonb_build_object('ok', true);
end;
$$;

-- =============================================================================
-- Registering a family. The act, not a conclusion.
--
-- Never refuses for a missing form, an unread form, or an unpaid fee. It
-- records what was outstanding at the moment it happened, and returns that so
-- the screen can say so out loud.
-- =============================================================================
create or replace function public.register_family(
  p_family_id   uuid,
  p_semester_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg         public.semester_registrations;
  v_outstanding jsonb;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  insert into public.semester_registrations (family_id, semester_id, status)
  values (p_family_id, p_semester_id, 'not_started')
  on conflict (family_id, semester_id) do nothing;

  select * into v_reg from public.semester_registrations
   where family_id = p_family_id and semester_id = p_semester_id;

  v_outstanding := (
    select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select 'form' as x where v_reg.form_submitted_at is null
      union all
      select 'review' where v_reg.reviewed_at is null
      union all
      select 'payment' where v_reg.payment_received_at is null
    ) t
  );

  update public.semester_registrations
     set status = 'registered',
         registered_at = now(),
         registered_by = public.current_admin_id(),
         outstanding_at_registration = v_outstanding,
         updated_by = public.current_admin_id()
   where id = v_reg.id;

  perform public.write_audit('family_registered', 'family', p_family_id,
    jsonb_build_object('semester_id', p_semester_id, 'outstanding', v_outstanding));

  return jsonb_build_object('ok', true, 'outstanding', v_outstanding);
end;
$$;

revoke execute on function public.set_registration_review(uuid, uuid, boolean) from public, anon;
revoke execute on function public.set_registration_payment(uuid, uuid, boolean, text) from public, anon;
revoke execute on function public.register_family(uuid, uuid) from public, anon;
grant execute on function public.set_registration_review(uuid, uuid, boolean) to authenticated;
grant execute on function public.set_registration_payment(uuid, uuid, boolean, text) to authenticated;
grant execute on function public.register_family(uuid, uuid) to authenticated;

-- =============================================================================
-- The report, now carrying the desk.
-- =============================================================================
-- Recreated rather than replaced: the returned columns have changed, and
-- Postgres will not redefine a function's row type in place.
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
  outstanding_at_registration jsonb
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
    r.form_submitted_at, r.form_data, r.reviewed_at,
    r.payment_received_at, r.payment_note, r.registered_at,
    r.outstanding_at_registration
  from public.families f
  left join public.semester_registrations r
         on r.family_id = f.id and r.semester_id = p_semester_id
  -- Everybody except families fully archived at the family level. No filtering
  -- on who came last semester or who has children of the right age.
  where f.archived_at is null
    and public.is_active_admin()
  order by f.display_name;
$$;

revoke execute on function public.semester_registration_report(uuid) from public, anon;
grant execute on function public.semester_registration_report(uuid) to authenticated;

-- =============================================================================
-- The gate.
--
-- Class sign-up now requires a resolved registration. This is enforced in
-- submit_family_registration rather than only in the invitation list, because a
-- link sitting in an inbox from last semester must not be a way round it. The
-- invitation list is a courtesy; this is the boundary.
--
-- An administrator placing a child by hand goes through admin_place_child,
-- which is untouched — that is the escape hatch for the corner cases, and it is
-- deliberately a human one.
-- =============================================================================
create or replace function public.registration_gate_message()
returns text
language sql
immutable
as $$
  select 'Your family is not registered for this semester yet, so classes '
      || 'cannot be chosen. If you have sent your registration form, it is '
      || 'waiting to be reviewed.';
$$;

-- The function is recreated in full rather than patched, so what runs is what
-- is written down here. The only change from 0003 is the gate below.
CREATE OR REPLACE FUNCTION public.submit_family_registration(p_family_id uuid, p_semester_id uuid, p_selections jsonb, p_actor text DEFAULT 'family'::text, p_allow_closed boolean DEFAULT false, p_not_participating uuid[] DEFAULT '{}'::uuid[], p_volunteer jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- --- the registration gate (0023) ---------------------------------------
    --
    -- Registration comes first, and this is where that is enforced rather than
    -- merely suggested. Checked HERE, not only in the invitation list: a link
    -- sitting in an inbox from last semester must not be a way round it.
    --
    -- p_allow_closed is an administrator acting deliberately, and they keep
    -- their override — admin_place_child is the escape hatch for the corner
    -- cases the co-op will certainly have, and it is meant to be a human one.
    if not public.family_may_sign_up(p_family_id, p_semester_id) then
      return jsonb_build_object('ok', false, 'error', 'not_registered',
        'message', public.registration_gate_message());
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
$function$;

select public.record_migration('0023');
