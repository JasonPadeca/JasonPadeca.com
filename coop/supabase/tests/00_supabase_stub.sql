-- Local stand-in for the parts of Supabase the migrations lean on.
-- Not shipped; exists so the migrations can be exercised on a real Postgres.

-- Roles are cluster-wide, so they survive a dropped database.
do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon')
    then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated')
    then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role')
    then create role service_role nologin bypassrls; end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

create schema if not exists auth;
create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase derives these from the request JWT. Here they read session GUCs so a
-- test can say "now I am this person" with a single SET.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid;
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('test.jwt', true), '')::jsonb, '{}'::jsonb);
$$;

grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
