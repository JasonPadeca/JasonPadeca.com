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

-- ---------------------------------------------------------------------------
-- Storage, enough of it for handout policies to be created and exercised.
-- Supabase provides these; locally they are stubbed so the migrations run
-- unmodified and the folder rules can actually be tested.
-- ---------------------------------------------------------------------------
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  -- Real Supabase carries this too. It was missing here, so a migration that
  -- set it applied against the live project and failed against the tests —
  -- the stub being wrong in the direction that hides a working migration.
  allowed_mime_types text[]
);

alter table storage.buckets add column if not exists allowed_mime_types text[];

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid,
  created_at timestamptz default now()
);

alter table storage.objects enable row level security;

-- Real Supabase splits the path on "/" and returns everything but the filename.
create or replace function storage.foldername(name text)
returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 1)];
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.objects to authenticated;
grant all on storage.buckets to service_role;
