-- =============================================================================
-- 0026_reload_cache.sql
-- Stop every update ending in "could not find the function in the schema cache".
--
-- PostgREST — the API layer the website talks to — keeps its own picture of
-- which functions exist. Adding one to the database does not always update that
-- picture promptly, so an update lands correctly and the page that needs it
-- still reports the function missing. It has happened after two updates in a
-- row now, and each time the fix was the same single line issued by hand.
--
-- Every migration already ends by calling record_migration. Putting the reload
-- there means every future update asks for it automatically, once, at the end,
-- after its own DDL has run — which is exactly when it should be asked for.
--
-- NOTIFY on a channel nobody is listening to is a no-op, so this is harmless in
-- the test harness and anywhere else PostgREST is not running.
-- =============================================================================

select public.migration_guard('0026', '0025');

create or replace function public.record_migration(p_version text)
returns void
language plpgsql
as $$
begin
  insert into public.schema_migrations (version) values (p_version);

  -- Tell PostgREST to look at the schema again. Without this, a new function
  -- can exist in the database and be invisible to the website for minutes.
  notify pgrst, 'reload schema';
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

-- ...and for this update itself, since the function above only takes effect
-- from the call below onwards.
notify pgrst, 'reload schema';

select public.record_migration('0026');
