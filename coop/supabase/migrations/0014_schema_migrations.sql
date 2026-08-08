-- =============================================================================
-- 0014_schema_migrations.sql
-- Making a migration say what it needs.
--
-- Every update so far has been a file pasted into the SQL editor, with nothing
-- recording that it ran. That worked until updates 4, 5 and 6 went out and only
-- some were applied — after which update 6 failed with
--
--     relation "public.class_volunteers" does not exist
--
-- which is a true statement and a useless one. It says what broke, not what to
-- do. Diagnosing it took probing the live database table by table.
--
-- This is the cheap fix: a ledger, plus two helpers. From here a migration
-- opens by naming what it depends on and closes by recording itself, so running
-- one out of order says
--
--     This update needs update 0012 first. Applied so far: 0001 … 0011.
--
-- and running one twice says so instead of half-applying.
--
-- Everything up to 0013 is backfilled as applied, because it is — this file
-- cannot run otherwise.
-- =============================================================================

create table if not exists public.schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

alter table public.schema_migrations enable row level security;

-- Idempotent, so re-running this file reaches the guard in the NEXT migration
-- and reports "already applied" rather than dying here on "policy already
-- exists" — which is a true message about the wrong thing.
drop policy if exists admin_reads on public.schema_migrations;
create policy admin_reads on public.schema_migrations
  for select to authenticated
  using (public.is_active_admin());

revoke all on public.schema_migrations from anon, authenticated;
grant select on public.schema_migrations to authenticated;
grant all on public.schema_migrations to service_role;

-- -----------------------------------------------------------------------------
-- migration_guard('0015', '0014') — the one call a migration opens with.
--
-- Checks both directions at once: the update it depends on is present, and this
-- update is not already applied. Both have to be checked BEFORE any DDL runs,
-- because CREATE TABLE fails with "already exists" on a second run and that
-- error arrives before any guard placed at the foot of the file — which is
-- exactly what happened the first time this was written.
-- -----------------------------------------------------------------------------
create or replace function public.migration_guard(
  p_version  text,
  p_requires text default null
)
returns void
language plpgsql
as $$
declare
  v_when timestamptz;
begin
  if p_requires is not null then
    perform public.require_migration(p_requires);
  end if;

  select applied_at into v_when
    from public.schema_migrations where version = p_version;

  if found then
    raise exception
      E'Update % has already been applied (on %).\n'
      'Nothing has been changed.',
      p_version, to_char(v_when, 'DD Mon YYYY at HH24:MI')
    using hint = 'This file is not designed to be run twice.';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- require_migration('0012') — refuse to continue if it has not been applied.
-- -----------------------------------------------------------------------------
create or replace function public.require_migration(p_version text)
returns void
language plpgsql
as $$
declare
  v_applied text;
begin
  if exists (select 1 from public.schema_migrations where version = p_version) then
    return;
  end if;

  select coalesce(string_agg(version, ', ' order by version), 'none')
    into v_applied from public.schema_migrations;

  raise exception
    E'This update needs update % first, and it has not been applied.\n'
    'Applied so far: %.\n'
    'Run the earlier update, then run this one again. Nothing has been changed.',
    p_version, v_applied
  using hint = 'Migrations must be applied in order.';
end;
$$;

-- -----------------------------------------------------------------------------
-- record_migration('0014') — mark it done, and refuse a second run.
-- -----------------------------------------------------------------------------
create or replace function public.record_migration(p_version text)
returns void
language plpgsql
as $$
begin
  insert into public.schema_migrations (version) values (p_version);
exception when unique_violation then
  raise exception
    E'Update % has already been applied (on %).\n'
    'Nothing has been changed.',
    p_version,
    (select to_char(applied_at, 'DD Mon YYYY at HH24:MI')
       from public.schema_migrations where version = p_version)
  using hint = 'This file is not designed to be run twice.';
end;
$$;

revoke execute on function public.migration_guard(text, text) from public, anon, authenticated;
grant execute on function public.migration_guard(text, text) to service_role;
revoke execute on function public.require_migration(text) from public, anon, authenticated;
revoke execute on function public.record_migration(text)  from public, anon, authenticated;
grant execute on function public.require_migration(text) to service_role;
grant execute on function public.record_migration(text)  to service_role;

-- -----------------------------------------------------------------------------
-- Backfill. If this file is running, all of these are in place by definition.
-- -----------------------------------------------------------------------------
insert into public.schema_migrations (version) values
  ('0001'), ('0002'), ('0003'), ('0004'), ('0005'), ('0006'), ('0007'),
  ('0008'), ('0009'), ('0010'), ('0011'), ('0012'), ('0013'), ('0014')
on conflict (version) do nothing;
