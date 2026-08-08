-- =============================================================================
-- 0012_family_accounts.sql
-- Families get real accounts.
--
-- Until now no family had a login. Every family-facing operation went through an
-- Edge Function holding a hashed invitation token, and anonymous visitors had
-- precisely zero database access. That is simple to reason about and very hard
-- to get wrong.
--
-- Real logins trade that simplicity for a row-level boundary, and the stakes go
-- up accordingly: the tables on the other side hold children's birth dates,
-- allergies, and medical notes. A policy that is slightly too generous does not
-- fail loudly — it quietly shows one family another family's children. So this
-- migration is deliberately paranoid:
--
--   * Families get SELECT and nothing else. Every write still goes through a
--     function that checks ownership itself.
--   * Every policy is scoped through one helper, current_family_ids(), so there
--     is a single place to audit rather than a dozen hand-written predicates.
--   * Tables with no business being family-readable — admins, invitations, the
--     audit log — get no family policy at all and are tested for it.
--
-- Membership is claimed by email rather than granted by an administrator. That
-- is safe precisely because sign-in is a magic link: possessing the address is
-- proved before the claim can happen. It also means no administrator has to
-- hand out 26 invitations and field the ones that go astray.
-- =============================================================================

create table public.family_users (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  family_id    uuid not null references public.families(id) on delete cascade,
  email        text not null,
  created_at   timestamptz not null default now(),

  unique (auth_user_id, family_id)
);

create index family_users_auth_idx on public.family_users (auth_user_id);
create index family_users_family_idx on public.family_users (family_id);

alter table public.family_users enable row level security;

-- =============================================================================
-- The one helper every family policy goes through.
--
-- SECURITY DEFINER because it reads family_users, which is itself protected —
-- an invoker-rights function here would recurse into the policy that calls it.
-- =============================================================================
create or replace function public.current_family_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(family_id), '{}'::uuid[])
    from public.family_users
   where auth_user_id = auth.uid();
$$;

create or replace function public.is_family_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.family_users where auth_user_id = auth.uid());
$$;

-- Children belonging to the signed-in person's families. Used by the policies
-- that hang off children rather than families.
create or replace function public.current_child_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(ch.id), '{}'::uuid[])
    from public.children ch
   where ch.family_id = any(public.current_family_ids());
$$;

grant execute on function public.current_family_ids() to authenticated;
grant execute on function public.current_child_ids() to authenticated;
grant execute on function public.is_family_member() to authenticated;

-- =============================================================================
-- Claiming membership.
--
-- Matches the verified address against family primary emails and parent emails.
-- Both are checked because a co-op records the household address on the family
-- and, often, a different one on each parent — and a father who only ever gave
-- his own address should still get in.
--
-- Returns what the caller is entitled to, so the front end makes one call after
-- sign-in rather than three.
-- =============================================================================
create or replace function public.establish_session()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text := lower(nullif(trim(coalesce(auth.jwt() ->> 'email', '')), ''));
  v_admin  public.admins;
  v_fams   jsonb;
begin
  if v_uid is null or v_email is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  -- --- administrator, if this address is one -------------------------------
  select * into v_admin from public.admins
   where lower(email) = v_email and active;

  if v_admin.id is not null and v_admin.auth_user_id is distinct from v_uid then
    update public.admins set auth_user_id = v_uid where id = v_admin.id;
  end if;

  -- --- family membership, claimed from the verified address ----------------
  insert into public.family_users (auth_user_id, family_id, email)
  select v_uid, f.id, v_email
    from public.families f
   where f.active and f.archived_at is null
     and lower(f.primary_email) = v_email
  on conflict (auth_user_id, family_id) do nothing;

  insert into public.family_users (auth_user_id, family_id, email)
  select v_uid, p.family_id, v_email
    from public.parents p
    join public.families f on f.id = p.family_id
   where f.active and f.archived_at is null
     and lower(p.email) = v_email
  on conflict (auth_user_id, family_id) do nothing;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'display_name', f.display_name)), '[]'::jsonb)
    into v_fams
    from public.families f
   where f.id = any(public.current_family_ids());

  return jsonb_build_object(
    'ok', true,
    'email', v_email,
    'is_admin', v_admin.id is not null,
    'admin_role', v_admin.role,
    'families', v_fams,
    -- Neither an administrator nor a recognised family: the front end says so
    -- plainly rather than showing an empty portal.
    'recognised', v_admin.id is not null or jsonb_array_length(v_fams) > 0);
end;
$$;

revoke execute on function public.establish_session() from public, anon;
grant execute on function public.establish_session() to authenticated;

-- =============================================================================
-- Policies.
--
-- Every one is SELECT only, and every one routes through current_family_ids()
-- or current_child_ids(). The pre-existing admin_all policies are untouched and
-- still grant administrators everything; Postgres ORs permissive policies, so
-- an administrator who is also a parent simply passes on the admin one.
-- =============================================================================

-- Who you are.
create policy family_reads_own on public.family_users
  for select to authenticated
  using (auth_user_id = auth.uid());

create policy family_reads_own on public.families
  for select to authenticated
  using (id = any(public.current_family_ids()));

create policy family_reads_own on public.parents
  for select to authenticated
  using (family_id = any(public.current_family_ids()));

create policy family_reads_own on public.children
  for select to authenticated
  using (family_id = any(public.current_family_ids()));

-- What your children are doing.
create policy family_reads_own on public.registrations
  for select to authenticated
  using (child_id = any(public.current_child_ids()));

create policy family_reads_own on public.semester_participation
  for select to authenticated
  using (child_id = any(public.current_child_ids()));

create policy family_reads_own on public.class_preferences
  for select to authenticated
  using (child_id = any(public.current_child_ids()));

create policy family_reads_own on public.volunteer_interest
  for select to authenticated
  using (child_id = any(public.current_child_ids()));

create policy family_reads_own on public.volunteer_interest_slot
  for select to authenticated
  using (interest_id in (
    select id from public.volunteer_interest
     where child_id = any(public.current_child_ids())));

create policy family_reads_own on public.class_volunteers
  for select to authenticated
  using (child_id = any(public.current_child_ids()));

-- The catalogue. Not sensitive — it is what the registration page already shows
-- families — but restricted to members so it is not simply public.
create policy member_reads_catalogue on public.semesters
  for select to authenticated using (public.is_family_member());

create policy member_reads_catalogue on public.periods
  for select to authenticated using (public.is_family_member());

create policy member_reads_catalogue on public.classes
  for select to authenticated using (public.is_family_member());

create policy member_reads_settings on public.settings
  for select to authenticated using (public.is_family_member());

grant select on public.families, public.parents, public.children,
                public.registrations, public.semester_participation,
                public.class_preferences, public.volunteer_interest,
                public.volunteer_interest_slot, public.class_volunteers,
                public.semesters, public.periods, public.classes,
                public.settings, public.family_users
  to authenticated;

-- Deliberately absent, and tested for: admins, registration_invites, audit_log.
-- Those get no family policy, so a signed-in parent reading them sees nothing.

-- =============================================================================
-- Seat counts, via a gated function rather than the view.
--
-- class_seats is security_invoker: it counts with the CALLER's permissions.
-- That was harmless while only administrators could read it, because they can
-- see every registration. But granting families the catalogue above is enough
-- to make the view run for them — and it would then count only the
-- registrations that family can see. Every class would report itself empty and
-- a full class would look wide open. Silently, with no error.
--
-- Flipping the view to definer rights is worse, not better: a definer view
-- bypasses RLS altogether and this one is reachable by anon, so that hands seat
-- counts to anonymous visitors and to anyone who has merely signed in. Both are
-- asserted against in 40_authorization.sql.
--
-- So: the view goes back to being unreachable by anyone but the owner, and
-- counting happens in a SECURITY DEFINER function that checks who is asking
-- first. Correct counts, and only for people entitled to them.
-- =============================================================================
revoke select on public.class_seats from anon, authenticated;

create or replace function public.class_seat_counts()
returns table (
  class_id         uuid,
  capacity         integer,
  registered_count bigint,
  waitlisted_count bigint,
  seats_open       integer,
  is_full          boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select cs.class_id, cs.capacity, cs.registered_count, cs.waitlisted_count,
         cs.seats_open, cs.is_full
    from public.class_seats cs
   where public.is_active_admin() or public.is_family_member();
$$;

revoke execute on function public.class_seat_counts() from public, anon;
grant execute on function public.class_seat_counts() to authenticated;

-- =============================================================================
-- For the avoidance of doubt, since this bit is easy to get wrong.
--
-- The view is security_invoker, so it counts with the CALLER's permissions.
-- That is correct today, because only administrators can read it and they can
-- see every registration.
--
-- The moment a family reads it, it will count only the registrations that
-- family is allowed to see — so every class reports itself empty and a full
-- class looks wide open. Silently, with no error.
--
-- The obvious fix, flipping it to definer rights, is worse: a view with definer
-- rights bypasses RLS entirely, and this one is reachable by anon. Doing that
-- hands seat counts to anonymous visitors and to anybody who has merely signed
-- in. Both of those are asserted against in 40_authorization.sql, which is how
-- this comment came to be written.
--
-- When the portal genuinely needs seat counts, the answer is a SECURITY DEFINER
-- *function* that checks is_family_member() or is_active_admin() before
-- returning anything — not a change to this view's rights. Until then the
-- registration page gets its counts through an Edge Function, which is
-- unaffected by any of this.
-- =============================================================================
