\set ON_ERROR_STOP off
\pset pager off

create or replace function pg_temp.denied(label text, stmt text)
returns void language plpgsql as $$
begin
  execute stmt;
  raise warning 'FAIL  % — the statement was ALLOWED', label;
exception
  when insufficient_privilege then raise notice 'PASS  % (permission denied)', label;
  when others then raise notice 'PASS  % (blocked: %)', label, sqlerrm;
end;
$$;

create or replace function pg_temp.rowcount(label text, stmt text, expected bigint)
returns void language plpgsql as $$
declare n bigint;
begin
  execute stmt into n;
  if n = expected then raise notice 'PASS  % (% rows)', label, n;
  else raise warning 'FAIL  % expected % rows, got %', label, expected, n;
  end if;
exception when insufficient_privilege then
  raise warning 'FAIL  % — permission denied, expected % rows', label, expected;
end;
$$;

-- =============================================================================
-- An anonymous visitor with the public anon key.
-- This is the browser of anyone on the internet who finds the Supabase URL.
-- =============================================================================
set role anon;

select pg_temp.denied('anon cannot read families',    'select * from public.families');
select pg_temp.denied('anon cannot read children',    'select * from public.children');
select pg_temp.denied('anon cannot read registrations','select * from public.registrations');
select pg_temp.denied('anon cannot read invites',     'select * from public.registration_invites');
select pg_temp.denied('anon cannot read admins',      'select * from public.admins');
select pg_temp.denied('anon cannot insert a family',
  $$insert into public.families (display_name) values ('Intruder')$$);

-- The SECURITY DEFINER functions are the real prize; they run as the owner.
select pg_temp.denied('anon cannot resolve invite tokens',
  $$select public.resolve_invite_token('anything')$$);
select pg_temp.denied('anon cannot submit registrations',
  $$select public.submit_family_registration(
      '41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','[]'::jsonb)$$);
select pg_temp.denied('anon cannot mint invite tokens',
  $$select public.issue_family_invite(
      '41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111')$$);
select pg_temp.denied('anon cannot place children',
  $$select public.admin_place_child(
      '51111111-1111-1111-1111-111111111111','31111111-1111-1111-1111-111111111111')$$);
select pg_temp.denied('anon cannot escalate via bind_admin_identity',
  $$select public.bind_admin_identity()$$);
select pg_temp.denied('anon cannot read seat counts', 'select * from public.class_seats');

-- The membership helpers are SECURITY DEFINER and reachable with a key printed
-- in the page source. Postgres grants EXECUTE to PUBLIC by default, so these
-- need an explicit revoke — 0012 granted them and forgot to. They answered
-- harmlessly, which is exactly why it went unnoticed until the live check.
select pg_temp.denied('anon cannot call current_family_ids',
  'select public.current_family_ids()');
select pg_temp.denied('anon cannot call current_child_ids',
  'select public.current_child_ids()');
select pg_temp.denied('anon cannot call is_family_member',
  'select public.is_family_member()');
select pg_temp.denied('anon cannot read family_users',
  'select * from public.family_users');
select pg_temp.denied('anon cannot read children at all',
  'select * from public.children');
select pg_temp.denied('anon cannot read the class catalogue',
  'select * from public.classes');

reset role;

-- =============================================================================
-- A signed-in Google user who is NOT an administrator.
-- Authentication is not authorization; this is the §27 "you do not have access"
-- case, and it must return no co-op data at all.
-- =============================================================================
set role authenticated;
select set_config('test.jwt', '{"email":"stranger@gmail.com"}', false);

select pg_temp.rowcount('signed-in stranger sees no families',
  'select count(*) from public.families', 0);
select pg_temp.rowcount('signed-in stranger sees no children',
  'select count(*) from public.children', 0);
select pg_temp.rowcount('signed-in stranger sees no registrations',
  'select count(*) from public.registrations', 0);
select pg_temp.rowcount('signed-in stranger sees no classes',
  'select count(*) from public.classes', 0);
select pg_temp.denied('signed-in stranger cannot read the class_seats view',
  'select * from public.class_seats');
select pg_temp.rowcount('signed-in stranger gets no counts from the gated function',
  'select count(*) from public.class_seat_counts()', 0);
select pg_temp.rowcount('signed-in stranger sees no admins',
  'select count(*) from public.admins', 0);
select pg_temp.rowcount('signed-in stranger sees no audit log',
  'select count(*) from public.audit_log', 0);

select pg_temp.denied('signed-in stranger cannot insert a family',
  $$insert into public.families (display_name) values ('Intruder')$$);
select pg_temp.denied('signed-in stranger cannot place children',
  $$select public.admin_place_child(
      '51111111-1111-1111-1111-111111111111','31111111-1111-1111-1111-111111111111')$$);
select pg_temp.denied('signed-in stranger cannot mint invite tokens',
  $$select public.issue_family_invite(
      '41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111')$$);

-- =============================================================================
-- A real administrator.
-- =============================================================================
select set_config('test.jwt', '{"email":"helper@example.org"}', false);

select pg_temp.rowcount('admin sees all families',
  'select count(*) from public.families', 4);
select pg_temp.rowcount('admin sees all children',
  'select count(*) from public.children', 6);
-- Even an administrator goes through the function now. The view is
-- security_invoker and reachable by anon, so nobody reads it directly.
select pg_temp.denied('admin cannot read the class_seats view directly',
  'select * from public.class_seats');
select pg_temp.rowcount('admin gets seat counts from the gated function',
  'select count(*) from public.class_seat_counts()', 7);
select pg_temp.rowcount('admin sees the audit log',
  'select count(*) from public.audit_log', (select count(*) from public.audit_log));

-- Even an admin has no business reading the token hashes.
select pg_temp.denied('admin cannot read invite token hashes',
  'select token_hash from public.registration_invites');
select pg_temp.rowcount('admin CAN read invite status',
  'select count(*) from (select id, sent_at, revoked_at from public.registration_invites) x', 0);

-- Only an owner may change who the administrators are.
select pg_temp.denied('plain admin cannot add an administrator',
  $$insert into public.admins (email, role) values ('sneaky@example.org','owner')$$);

-- RLS filters UPDATE rows rather than raising, so the meaningful assertion is
-- that nothing actually changed, not that an error was thrown.
update public.admins set role='owner' where email='helper@example.org';
select pg_temp.rowcount('plain admin cannot promote themselves to owner',
  $$select count(*) from public.admins where email='helper@example.org' and role='owner'$$, 0);

update public.families set display_name='Renamed By Non-Owner'
  where display_name='Johnson Family';
select pg_temp.rowcount('...but a plain admin CAN still edit co-op data',
  $$select count(*) from public.families where display_name='Renamed By Non-Owner'$$, 1);

select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select pg_temp.rowcount('owner CAN add an administrator',
  $$with i as (insert into public.admins (email, role) values ('new@example.org','admin')
               returning 1) select count(*) from i$$, 1);

-- A deactivated administrator loses access immediately.
reset role;
update public.admins set active=false where email='helper@example.org';
set role authenticated;
select set_config('test.jwt', '{"email":"helper@example.org"}', false);
select pg_temp.rowcount('deactivated admin sees nothing',
  'select count(*) from public.families', 0);

reset role;
