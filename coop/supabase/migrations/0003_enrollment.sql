-- =============================================================================
-- 0003_enrollment.sql
-- Eligibility, seat counting, and the transactional enrollment functions.
--
-- Spec references: §17 (eligibility), §19 (registration constraints),
-- §20 (atomic capacity), §21 (waitlist), §22 (admin overrides), §30 (RPCs).
--
-- This file is where the guiding rule lives: the backend enforces correctness.
-- The browser is free to be wrong; it just cannot make the database wrong.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Age is computed, never stored (§5.3). Eligibility asks how old the child is
-- on the semester's first class day, not how old they are today.
-- -----------------------------------------------------------------------------
create or replace function public.age_at(p_birth_date date, p_ref_date date)
returns integer
language sql
immutable
as $$
  select case
    when p_birth_date is null or p_ref_date is null then null
    else extract(year from age(p_ref_date, p_birth_date))::integer
  end;
$$;

-- -----------------------------------------------------------------------------
-- Live seat counts per class.
--
-- capacity NULL means uncapped, which is why is_full is a CASE and not a
-- comparison: NULL > n is NULL, and a NULL is_full would read as "full" in
-- some client code.
-- -----------------------------------------------------------------------------
-- security_invoker matters here: without it the view would run as its owner and
-- happily hand seat counts to any authenticated user, admin or not.
create or replace view public.class_seats
  with (security_invoker = true)
as
  select
    c.id as class_id,
    c.capacity,
    count(*) filter (where r.status = 'registered')  as registered_count,
    count(*) filter (where r.status = 'waitlisted')  as waitlisted_count,
    case when c.capacity is null then null
         else greatest(c.capacity - count(*) filter (where r.status = 'registered'), 0)
    end as seats_open,
    case when c.capacity is null then false
         else count(*) filter (where r.status = 'registered') >= c.capacity
    end as is_full
  from public.classes c
  left join public.registrations r on r.class_id = c.id
  group by c.id, c.capacity;

grant select on public.class_seats to authenticated;

-- -----------------------------------------------------------------------------
-- Why can't this child take this class?
--
-- Returns an array of human-readable reasons; empty array means eligible. The
-- family UI shows these verbatim next to dimmed classes (§17 Option B), so the
-- wording is user-facing, not developer-facing.
-- -----------------------------------------------------------------------------
create or replace function public.eligibility_reasons(
  p_child_id uuid,
  p_class_id uuid
)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ch      public.children;
  cl      public.classes;
  ref     date;
  yrs     integer;
  reasons text[] := '{}';
begin
  select * into ch from public.children where id = p_child_id;
  select * into cl from public.classes where id = p_class_id;

  if ch.id is null or cl.id is null then
    return array['Record not found'];
  end if;

  -- Every literal appended below is cast to ::text on purpose. An untyped
  -- literal makes `text[] || 'foo'` resolve to array-concatenation rather than
  -- array-append, and Postgres then tries to read the string as an array
  -- literal and throws. The casts are what make it an append.
  if not ch.active or ch.archived_at is not null then
    reasons := reasons || 'Child is not currently active'::text;
  end if;

  if cl.archived_at is not null then
    reasons := reasons || 'Class has been cancelled'::text;
  end if;

  if exists (select 1 from public.periods p
              where p.id = cl.period_id and p.archived_at is not null) then
    reasons := reasons || 'Period has been cancelled'::text;
  end if;

  select class_start_date into ref from public.semesters where id = cl.semester_id;
  ref := coalesce(ref, current_date);
  yrs := public.age_at(ch.birth_date, ref);

  if cl.age_min is not null or cl.age_max is not null then
    if yrs is null then
      reasons := reasons || 'Birth date is missing, so age cannot be checked'::text;
    elsif cl.age_min is not null and yrs < cl.age_min then
      reasons := reasons || format('Ages %s and up (%s will be %s)',
                                   cl.age_min, ch.first_name, yrs);
    elsif cl.age_max is not null and yrs > cl.age_max then
      reasons := reasons || format('Ages %s and under (%s will be %s)',
                                   cl.age_max, ch.first_name, yrs);
    end if;
  end if;

  if cl.sex_requirement <> 'any' then
    if ch.sex is null then
      reasons := reasons || 'This class is restricted and no sex is recorded'::text;
    elsif ch.sex <> cl.sex_requirement then
      reasons := reasons || (case cl.sex_requirement
                               when 'female' then 'Girls only'
                               else 'Boys only'
                             end)::text;
    end if;
  end if;

  return reasons;
end;
$$;

-- =============================================================================
-- submit_family_registration
--
-- The single atomic entry point for a family's registration (§20, §40).
--
-- The family submits their complete desired schedule, not a diff. This function
-- reconciles the database to that schedule: anything selected is created or
-- kept, anything previously live and no longer selected is cancelled. That
-- makes the same call correct for a first submission and for an edit, and makes
-- a double-clicked submit button idempotent instead of destructive.
--
-- p_selections is a JSON array of:
--   { "child_id": uuid, "class_id": uuid, "intent": "register" | "waitlist" }
--
-- Returns:
--   { "ok": bool, "results": [ { child_id, class_id, outcome, detail } ] }
--
-- Outcomes are reported per selection rather than aborting the whole
-- submission, because "Chemistry filled up while you were deciding" should cost
-- a family one class, not their entire afternoon of work.
-- =============================================================================
create or replace function public.submit_family_registration(
  p_family_id     uuid,
  p_semester_id   uuid,
  p_selections    jsonb,
  p_actor         text default 'family',
  p_allow_closed  boolean default false
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
  -- (child_id || ':' || period_id) for each confirmed seat granted in this
  -- call, so a submission that asks for two classes in one period is caught.
  v_claimed text[] := '{}';
  v_key     text;
begin
  select * into sem from public.semesters where id = p_semester_id;
  if sem.id is null then
    raise exception 'Semester not found';
  end if;

  -- Registration window (§19). An admin acting on a family's behalf may pass
  -- p_allow_closed; a family session never can.
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
  -- Lock every class involved, in a deterministic order.
  --
  -- This is the whole answer to §20. Two families racing for the last seat both
  -- reach this line; one waits. Sorting by id means two submissions touching an
  -- overlapping set of classes can never each hold what the other needs, so
  -- they queue instead of deadlocking.
  -- ---------------------------------------------------------------------------
  select coalesce(array_agg(distinct (s ->> 'class_id')::uuid order by (s ->> 'class_id')::uuid), '{}')
    into class_ids
    from jsonb_array_elements(coalesce(p_selections, '[]'::jsonb)) s;

  foreach cid in array class_ids loop
    perform 1 from public.classes where id = cid for update;
  end loop;

  -- ---------------------------------------------------------------------------
  -- Evaluate each selection.
  -- ---------------------------------------------------------------------------
  for sel in select * from jsonb_array_elements(coalesce(p_selections, '[]'::jsonb))
  loop
    v_outcome := null;
    v_detail  := null;
    v_intent  := coalesce(sel ->> 'intent', 'register');

    select * into v_child from public.children
      where id = (sel ->> 'child_id')::uuid;
    select * into v_class from public.classes
      where id = (sel ->> 'class_id')::uuid;

    -- Child ownership (§19). The invitation names one family; it may not
    -- register anyone else's children, whatever the browser sent.
    if v_child.id is null or v_child.family_id <> p_family_id then
      v_outcome := 'rejected';
      v_detail  := 'That child does not belong to this family.';

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
      -- Is there already a live row for this child and class? If so, keep it
      -- rather than churning the created_at that waitlist order depends on.
      select * into v_existing from public.registrations
        where child_id = v_child.id and class_id = v_class.id
          and status in ('registered', 'waitlisted');

      v_key := v_child.id::text || ':' || v_class.period_id::text;

      if v_intent = 'waitlist' then
        -- A waitlist row is interest, not a seat, so it never conflicts with
        -- the child's confirmed class in the same period (§51 Q3).
        if v_existing.id is not null then
          v_outcome := case v_existing.status when 'registered'
                       then 'registered' else 'waitlisted' end;
          -- Carry the id forward so a family revisiting their registration is
          -- still told their waitlist position, not just that they are on it.
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
        -- The submission asked for two confirmed classes in one period. The UI
        -- prevents this, so reaching here means a stale tab or a hand-built
        -- request; either way the second one does not get a seat.
        v_outcome := 'rejected';
        v_detail  := 'Only one class per period.';

      else
        -- Confirmed seat requested. Capacity is checked here, inside the lock.
        select count(*) into v_taken from public.registrations
          where class_id = v_class.id and status = 'registered'
            and child_id <> v_child.id;

        if v_class.capacity is not null and v_taken >= v_class.capacity then
          v_outcome := 'full';
          v_detail  := 'This class filled up.';

        else
          -- Cancel any other confirmed seat this child holds in this period,
          -- so the unique index has room. This is what makes a period swap work.
          update public.registrations
             set status = 'cancelled', cancelled_at = now(), waitlisted_at = null
           where child_id = v_child.id
             and period_id = v_class.period_id
             and status = 'registered'
             and class_id <> v_class.id;

          if v_existing.id is not null then
            update public.registrations
               set status = 'registered', waitlisted_at = null, source = p_actor
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

    -- Where they landed on the waitlist, counted by the order people joined.
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

  -- ---------------------------------------------------------------------------
  -- Reconcile: anything this family had live in this semester that they did not
  -- just submit has been dropped. Status change, never a delete (§2.3).
  -- ---------------------------------------------------------------------------
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
    jsonb_build_object('semester_id', p_semester_id, 'results', results),
    p_actor, null);

  return jsonb_build_object('ok', true, 'results', results);
end;
$$;

-- =============================================================================
-- Administrator enrollment tools (§22)
--
-- Admins can do things families cannot, including breaking the rules. The
-- override is deliberate, explicit, and logged — the point is that a real
-- co-op's edge cases get handled in the app instead of in a side spreadsheet.
-- =============================================================================

-- Check what would go wrong, without doing anything. The admin UI calls this
-- first so it can show the warning dialog before asking for confirmation.
create or replace function public.check_placement(
  p_child_id uuid,
  p_class_id uuid,
  p_status   text default 'registered'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_class    public.classes;
  v_warnings jsonb := '[]'::jsonb;
  v_taken    integer;
  v_reasons  text[];
  v_other    text;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_class from public.classes where id = p_class_id;
  if v_class.id is null then
    raise exception 'Class not found';
  end if;

  v_reasons := public.eligibility_reasons(p_child_id, p_class_id);
  if array_length(v_reasons, 1) > 0 then
    v_warnings := v_warnings || jsonb_build_object(
      'kind', 'eligibility', 'message', array_to_string(v_reasons, '; '));
  end if;

  if p_status = 'registered' and v_class.capacity is not null then
    select count(*) into v_taken from public.registrations
      where class_id = p_class_id and status = 'registered';
    if v_taken >= v_class.capacity then
      v_warnings := v_warnings || jsonb_build_object(
        'kind', 'capacity',
        'message', format(
          'This class is already at capacity. Adding this student will create %s registrations for a capacity of %s.',
          v_taken + 1, v_class.capacity));
    end if;
  end if;

  if p_status = 'registered' then
    select c.name into v_other
      from public.registrations r
      join public.classes c on c.id = r.class_id
     where r.child_id = p_child_id
       and r.period_id = v_class.period_id
       and r.status = 'registered'
       and r.class_id <> p_class_id;
    if v_other is not null then
      v_warnings := v_warnings || jsonb_build_object(
        'kind', 'period_conflict',
        'message', format(
          'This student is already registered for %s in the same period. That registration will be withdrawn.',
          v_other));
    end if;
  end if;

  return jsonb_build_object(
    'ok', array_length(v_reasons, 1) is null and jsonb_array_length(v_warnings) = 0,
    'warnings', v_warnings);
end;
$$;

-- Place a child in a class. p_override must be explicitly true to proceed past
-- any warning, and the reason is recorded on the registration row itself so an
-- unusual roster entry can explain itself months later.
create or replace function public.admin_place_child(
  p_child_id        uuid,
  p_class_id        uuid,
  p_status          text default 'registered',
  p_override        boolean default false,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check jsonb;
  v_class public.classes;
  v_id    uuid;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;
  if p_status not in ('registered', 'waitlisted') then
    raise exception 'Invalid status %', p_status;
  end if;

  select * into v_class from public.classes where id = p_class_id for update;
  if v_class.id is null then
    raise exception 'Class not found';
  end if;

  v_check := public.check_placement(p_child_id, p_class_id, p_status);
  if not (v_check ->> 'ok')::boolean and not p_override then
    return jsonb_build_object('ok', false, 'needs_override', true,
                              'warnings', v_check -> 'warnings');
  end if;

  if p_status = 'registered' then
    update public.registrations
       set status = 'withdrawn', cancelled_at = now(), waitlisted_at = null
     where child_id = p_child_id
       and period_id = v_class.period_id
       and status = 'registered'
       and class_id <> p_class_id;
  end if;

  insert into public.registrations
    (child_id, class_id, status, source, waitlisted_at, override_reason)
  values (p_child_id, p_class_id, p_status, 'admin',
          case when p_status = 'waitlisted' then now() end,
          case when p_override then coalesce(p_override_reason, 'Administrator override') end)
  on conflict (child_id, class_id) where status in ('registered', 'waitlisted')
  do update set status = excluded.status,
                waitlisted_at = excluded.waitlisted_at,
                override_reason = excluded.override_reason
  returning id into v_id;

  perform public.write_audit(
    case when p_override then 'admin_placed_child_with_override'
         else 'admin_placed_child' end,
    'registration', v_id,
    jsonb_build_object('child_id', p_child_id, 'class_id', p_class_id,
                       'status', p_status, 'reason', p_override_reason,
                       'warnings', v_check -> 'warnings'));

  return jsonb_build_object('ok', true, 'registration_id', v_id);
end;
$$;

-- Remove a student from a class. Status change, not deletion.
create or replace function public.admin_set_registration_status(
  p_registration_id uuid,
  p_status          text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg public.registrations;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;
  if p_status not in ('registered', 'waitlisted', 'cancelled', 'withdrawn') then
    raise exception 'Invalid status %', p_status;
  end if;

  select * into v_reg from public.registrations where id = p_registration_id;
  if v_reg.id is null then
    raise exception 'Registration not found';
  end if;

  update public.registrations
     set status        = p_status,
         waitlisted_at = case when p_status = 'waitlisted'
                              then coalesce(waitlisted_at, now()) end,
         cancelled_at  = case when p_status in ('cancelled', 'withdrawn')
                              then now() end
   where id = p_registration_id;

  perform public.write_audit('admin_changed_registration_status',
    'registration', p_registration_id,
    jsonb_build_object('from', v_reg.status, 'to', p_status,
                       'child_id', v_reg.child_id, 'class_id', v_reg.class_id));

  return jsonb_build_object('ok', true);
end;
$$;

-- Promote a waitlisted child into a confirmed seat (§21). Manual in v1;
-- automatic promotion is deliberately not built yet.
create or replace function public.promote_waitlist_entry(
  p_registration_id uuid,
  p_override        boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg   public.registrations;
  v_class public.classes;
  v_taken integer;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_reg from public.registrations where id = p_registration_id;
  if v_reg.id is null or v_reg.status <> 'waitlisted' then
    raise exception 'That registration is not on a waitlist';
  end if;

  select * into v_class from public.classes where id = v_reg.class_id for update;

  select count(*) into v_taken from public.registrations
    where class_id = v_reg.class_id and status = 'registered';

  if v_class.capacity is not null and v_taken >= v_class.capacity and not p_override then
    return jsonb_build_object('ok', false, 'needs_override', true,
      'warnings', jsonb_build_array(jsonb_build_object(
        'kind', 'capacity',
        'message', format('This class is full (%s of %s). Promoting will exceed capacity.',
                          v_taken, v_class.capacity))));
  end if;

  update public.registrations
     set status = 'withdrawn', cancelled_at = now(), waitlisted_at = null
   where child_id = v_reg.child_id
     and period_id = v_reg.period_id
     and status = 'registered';

  update public.registrations
     set status = 'registered', source = 'waitlist_promotion', waitlisted_at = null
   where id = p_registration_id;

  perform public.write_audit('waitlist_promoted', 'registration', p_registration_id,
    jsonb_build_object('child_id', v_reg.child_id, 'class_id', v_reg.class_id,
                       'override', p_override));

  return jsonb_build_object('ok', true);
end;
$$;

-- =============================================================================
-- Invitations (§15)
--
-- Token generation lives in the database so the raw token and its hash are
-- produced in one place, by one line of code, and the raw value is returned
-- exactly once — to the Edge Function that is about to put it in an email.
-- =============================================================================
create or replace function public.issue_family_invite(
  p_family_id   uuid,
  p_semester_id uuid,
  p_expires_at  timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
  v_id    uuid;
begin
  -- 32 bytes of urandom, base64url. Long enough that guessing is not a strategy.
  v_token := replace(replace(replace(
               encode(gen_random_bytes(32), 'base64'),
             '+', '-'), '/', '_'), '=', '');

  update public.registration_invites
     set revoked_at = now()
   where family_id = p_family_id
     and semester_id = p_semester_id
     and revoked_at is null;

  insert into public.registration_invites
    (family_id, semester_id, token_hash, expires_at, created_by_admin_id)
  values (p_family_id, p_semester_id,
          encode(digest(v_token, 'sha256'), 'hex'),
          coalesce(p_expires_at,
                   (select registration_close_at from public.semesters
                     where id = p_semester_id)),
          public.current_admin_id())
  returning id into v_id;

  return jsonb_build_object('invite_id', v_id, 'token', v_token);
end;
$$;

-- Exchange a raw token for the family and semester it authorizes. Called only
-- by the family-session Edge Function, under the service role.
create or replace function public.resolve_invite_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_inv public.registration_invites;
begin
  select * into v_inv from public.registration_invites
   where token_hash = encode(digest(p_token, 'sha256'), 'hex');

  if v_inv.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if v_inv.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;
  if v_inv.expires_at is not null and now() > v_inv.expires_at then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  update public.registration_invites set last_used_at = now() where id = v_inv.id;

  return jsonb_build_object('ok', true, 'invite_id', v_inv.id,
                            'family_id', v_inv.family_id,
                            'semester_id', v_inv.semester_id);
end;
$$;

-- =============================================================================
-- Keepalive (§31). Deliberately tiny, and deliberately not a general endpoint.
-- =============================================================================
create or replace function public.keepalive()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.system_status set last_keepalive_at = now() where id = 1;
  return jsonb_build_object('ok', true, 'at', now());
end;
$$;

-- =============================================================================
-- Grants.
--
-- This block is load-bearing, and the order matters.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default. Since every
-- function above is SECURITY DEFINER, leaving that default in place would mean
-- an anonymous visitor could call resolve_invite_token() or
-- submit_family_registration() directly with the anon key. So: take execute
-- away from everyone, then hand it back deliberately.
--
-- What stays revoked is as important as what is granted. The family-facing and
-- invitation functions are reachable only through Edge Functions holding the
-- service role — no browser, admin or otherwise, can call them.
-- =============================================================================
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from authenticated;

grant execute on all functions in schema public to service_role;
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- The admin browser session's allowance, in full.
grant execute on function public.bind_admin_identity()                   to authenticated;
grant execute on function public.is_active_admin()                       to authenticated;
grant execute on function public.is_owner()                              to authenticated;
grant execute on function public.current_admin_id()                      to authenticated;
grant execute on function public.age_at(date, date)                      to authenticated;
grant execute on function public.eligibility_reasons(uuid, uuid)         to authenticated;
grant execute on function public.check_placement(uuid, uuid, text)       to authenticated;
grant execute on function public.admin_place_child(uuid, uuid, text, boolean, text) to authenticated;
grant execute on function public.admin_set_registration_status(uuid, text) to authenticated;
grant execute on function public.promote_waitlist_entry(uuid, boolean)   to authenticated;

-- Future functions must opt in the same way, rather than arriving public.
alter default privileges in schema public
  revoke execute on functions from public;
