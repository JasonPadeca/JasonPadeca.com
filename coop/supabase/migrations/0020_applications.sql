-- =============================================================================
-- 0020_applications.sql
-- Asking to join.
--
-- The public site's "Application for Membership" currently emails a form to
-- whoever is watching the inbox, and the applicant hears nothing until somebody
-- replies. This makes it a record with a state, so an administrator can see
-- what is outstanding and an applicant can see where they stand.
--
-- Applying also creates the beginning of an account. That is the point of the
-- Join step: it is a family asking for a way in, and from then on they follow
-- the process by signing in rather than by waiting for email. request-signin
-- recognises an applicant's address for exactly that reason.
--
-- Approval creates a family and nothing else. Parents and children are added by
-- an administrator afterwards, from the family page they already use — the
-- application's free text ("John and Jane, three kids aged 6, 9 and 12") cannot
-- be split into rows reliably, and guessing wrong is worse than typing it.
-- =============================================================================

select public.migration_guard('0020', '0019');

create table public.applications (
  id             uuid primary key default gen_random_uuid(),

  -- What the form asks. Deliberately close to the existing paper form, so a
  -- family filling it in sees the questions the co-op already asks.
  parent_names   text not null,
  email          text not null,
  phone          text,
  children_text  text not null,
  agrees_to_beliefs boolean not null default false,
  heard_about    text,
  homeschool_journey text,
  about_yourself text,
  looking_for    text,

  status         text not null default 'submitted'
                   check (status in ('submitted', 'in_review', 'approved', 'declined', 'withdrawn')),
  admin_notes    text,

  -- Set on approval. The trail from application to family is worth keeping.
  family_id      uuid references public.families(id) on delete set null,

  reviewed_by    uuid references public.admins(id) on delete set null,
  reviewed_at    timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index applications_status_idx on public.applications (status, created_at desc);
create unique index applications_email_open
  on public.applications (lower(email))
  where status in ('submitted', 'in_review');

create trigger applications_touch before update on public.applications
  for each row execute function public.touch_updated_at();

alter table public.applications enable row level security;

create policy admin_all on public.applications
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

-- An applicant may read their own, by the address they applied with. Nothing
-- else — not other applications, and not the administrator's notes about theirs.
create policy applicant_reads_own on public.applications
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

revoke all on public.applications from anon;
grant select on public.applications to authenticated;
grant all on public.applications to service_role;

-- =============================================================================
-- Is this address an open applicant?
--
-- request-signin uses this so somebody who has applied can sign in and follow
-- their application. Approved and declined are excluded: an approved family
-- signs in as a family, and a declined one should not keep a login.
-- =============================================================================
create or replace function public.is_open_applicant(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.applications
     where lower(email) = lower(p_email)
       and status in ('submitted', 'in_review'));
$$;

revoke execute on function public.is_open_applicant(text) from public, anon;
grant execute on function public.is_open_applicant(text) to authenticated, service_role;

-- =============================================================================
-- What an applicant sees of their own application.
--
-- Status and dates, and none of the administrator's notes. "We are still
-- looking at it" is the whole message; the reasoning behind a decision is a
-- conversation, not a field on a screen.
-- =============================================================================
create or replace function public.my_application()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_app   public.applications;
begin
  if v_email = '' then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  select * into v_app from public.applications
   where lower(email) = v_email
   order by created_at desc
   limit 1;

  if v_app.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_application');
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', v_app.status,
    'parent_names', v_app.parent_names,
    'submitted_at', v_app.created_at,
    'reviewed_at', v_app.reviewed_at);
end;
$$;

revoke execute on function public.my_application() from public, anon;
grant execute on function public.my_application() to authenticated;

-- =============================================================================
-- Approving one.
--
-- Creates the family and links the application to it. Parents and children are
-- left for an administrator to enter from the family page: the form collects
-- "Sarah and Michael, kids are 7, 9 and 13" as prose, and splitting that into
-- rows by guessing is how a child ends up in the system as "and".
-- =============================================================================
create or replace function public.approve_application(
  p_id           uuid,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app    public.applications;
  v_family public.families;
  v_name   text;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_app from public.applications where id = p_id;
  if v_app.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_app.status = 'approved' then
    return jsonb_build_object('ok', false, 'error', 'already_approved',
      'family_id', v_app.family_id);
  end if;

  v_name := nullif(trim(coalesce(p_display_name, '')), '');
  if v_name is null then
    -- A reasonable guess from the parent names, which the administrator can
    -- correct on the family page. Better than an empty name in a list.
    v_name := left(trim(v_app.parent_names), 60) || ' Family';
  end if;

  insert into public.families (display_name, primary_email, primary_phone, notes)
  values (v_name, lower(v_app.email), v_app.phone,
          'From application ' || to_char(v_app.created_at, 'DD Mon YYYY') ||
          E'\n\nChildren as described: ' || coalesce(v_app.children_text, '—'))
  returning * into v_family;

  update public.applications
     set status = 'approved',
         family_id = v_family.id,
         reviewed_by = public.current_admin_id(),
         reviewed_at = now()
   where id = p_id;

  perform public.write_audit('application_approved', 'application', p_id,
    jsonb_build_object('family_id', v_family.id, 'email', v_app.email));

  return jsonb_build_object('ok', true, 'family_id', v_family.id,
                            'display_name', v_family.display_name);
end;
$$;

create or replace function public.set_application_status(
  p_id     uuid,
  p_status text,
  p_notes  text default null
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

  if p_status not in ('submitted', 'in_review', 'declined', 'withdrawn') then
    return jsonb_build_object('ok', false, 'error', 'bad_status',
      'message', 'Use approve_application to approve.');
  end if;

  update public.applications
     set status = p_status,
         admin_notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), admin_notes),
         reviewed_by = public.current_admin_id(),
         reviewed_at = case when p_status in ('declined', 'withdrawn')
                            then now() else reviewed_at end
   where id = p_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  perform public.write_audit('application_' || p_status, 'application', p_id,
    jsonb_build_object('notes', p_notes));

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.approve_application(uuid, text) from public, anon;
revoke execute on function public.set_application_status(uuid, text, text) from public, anon;
grant execute on function public.approve_application(uuid, text) to authenticated;
grant execute on function public.set_application_status(uuid, text, text) to authenticated;

select public.record_migration('0020');
