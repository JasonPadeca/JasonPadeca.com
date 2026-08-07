-- =============================================================================
-- 0002_authorization.sql
-- Row Level Security, admin authorization, and the audit helper.
--
-- Spec references: §27 (admin login), §28 (authorization and security).
--
-- The security model in one paragraph:
--
--   Administrators authenticate with Google through Supabase Auth and then talk
--   to Postgres directly with the anon key. Every table has RLS on, and every
--   policy funnels through is_active_admin(). An authenticated Google user who
--   is not an active row in `admins` can read nothing and write nothing.
--
--   Families never touch Postgres directly at all. They have no session, no
--   key, and no policy grants them anything. Their browser talks only to Edge
--   Functions, which validate an invitation token and use the service role on
--   their behalf. That is why there are no anon policies below — their absence
--   is the design, not an oversight.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Who is asking?
--
-- SECURITY DEFINER so these bypass RLS on `admins` — without that, the policy
-- on `admins` would recurse into itself while trying to evaluate itself.
--
-- Matching on auth_user_id OR email means an admin the owner added by email
-- works on their very first sign-in, before anything has been bound.
-- -----------------------------------------------------------------------------
create or replace function public.current_admin_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select a.id
    from public.admins a
   where a.active
     and (a.auth_user_id = auth.uid()
          or lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', '')))
   limit 1;
$$;

create or replace function public.is_active_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_admin_id() is not null;
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a
     where a.active
       and a.role = 'owner'
       and (a.auth_user_id = auth.uid()
            or lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  );
$$;

-- Called by the admin UI once after sign-in. Attaches the Google identity to
-- the pre-existing admin row so the audit log can name a real person, and so
-- authorization keeps working if someone's email address changes later.
create or replace function public.bind_admin_identity()
returns public.admins
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.admins;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.admins a
     set auth_user_id = auth.uid(),
         display_name = coalesce(a.display_name,
                                 auth.jwt() -> 'user_metadata' ->> 'full_name')
   where a.active
     and a.auth_user_id is null
     and lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
   returning * into result;

  if result.id is null then
    select * into result from public.admins a
     where a.active and a.auth_user_id = auth.uid();
  end if;

  return result;  -- NULL row means "authenticated, but not an administrator"
end;
$$;

-- -----------------------------------------------------------------------------
-- Audit helper. Called from the RPCs in 0003 and from Edge Functions.
-- -----------------------------------------------------------------------------
create or replace function public.write_audit(
  p_action      text,
  p_entity_type text default null,
  p_entity_id   uuid default null,
  p_details     jsonb default '{}'::jsonb,
  p_actor_type  text default 'admin',
  p_actor_label text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid := public.current_admin_id();
  v_label    text := p_actor_label;
begin
  if v_label is null and v_admin_id is not null then
    select coalesce(display_name, email) into v_label
      from public.admins where id = v_admin_id;
  end if;

  insert into public.audit_log (actor_type, actor_id, actor_label, action,
                                entity_type, entity_id, details)
  values (p_actor_type, v_admin_id, v_label, p_action,
          p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb));
end;
$$;

-- =============================================================================
-- Enable RLS everywhere.
-- =============================================================================
alter table public.admins               enable row level security;
alter table public.families             enable row level security;
alter table public.parents              enable row level security;
alter table public.children             enable row level security;
alter table public.semesters            enable row level security;
alter table public.periods              enable row level security;
alter table public.classes              enable row level security;
alter table public.registrations        enable row level security;
alter table public.registration_invites enable row level security;
alter table public.audit_log            enable row level security;
alter table public.settings             enable row level security;
alter table public.system_status        enable row level security;

-- =============================================================================
-- Administrator policies.
--
-- All administrators share one permission set over co-op data. The only
-- distinction in v1 is that managing the administrator list itself is
-- owner-only, so an admin cannot quietly promote themselves.
-- =============================================================================

-- Roster and schedule data: any active admin, full access.
do $$
declare
  t text;
begin
  foreach t in array array[
    'families', 'parents', 'children',
    'semesters', 'periods', 'classes',
    'registrations', 'registration_invites'
  ]
  loop
    execute format($f$
      create policy admin_all on public.%I
        for all to authenticated
        using (public.is_active_admin())
        with check (public.is_active_admin());
    $f$, t);
  end loop;
end;
$$;

-- Administrators: everyone active can see the list; only an owner may change it.
create policy admin_read on public.admins
  for select to authenticated
  using (public.is_active_admin());

create policy owner_write on public.admins
  for all to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- Audit log: readable by admins, never writable from the browser. Rows arrive
-- only through write_audit(), which is SECURITY DEFINER.
create policy admin_read on public.audit_log
  for select to authenticated
  using (public.is_active_admin());

-- Settings: any admin may read and edit.
create policy admin_all on public.settings
  for all to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());

-- System status: readable by admins so the dashboard can show backend health.
-- Only the keepalive function (service role) writes it.
create policy admin_read on public.system_status
  for select to authenticated
  using (public.is_active_admin());

-- =============================================================================
-- Lock down the token hashes.
--
-- Admins legitimately need to see invitation *status* — was it sent, was it
-- used, did the email bounce — but nothing needs the hash itself in a browser.
--
-- Postgres cannot revoke one column out of a table-level SELECT grant, so the
-- table grant comes off and the columns go back on individually.
-- =============================================================================
revoke select on public.registration_invites from authenticated;
grant select (id, family_id, semester_id, created_at, expires_at, revoked_at,
              sent_at, send_error, last_used_at, created_by_admin_id)
  on public.registration_invites to authenticated;

-- =============================================================================
-- Nothing is granted to `anon`.
--
-- Supabase grants broad table privileges to anon and authenticated by default;
-- with RLS on and no anon policy, anon reads return zero rows. Revoking as well
-- means a future policy added carelessly still cannot expose child data to an
-- unauthenticated visitor.
-- =============================================================================
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

-- Only these two are safe for an admin session to call directly.
grant execute on function public.bind_admin_identity() to authenticated;
grant execute on function public.is_active_admin() to authenticated;
