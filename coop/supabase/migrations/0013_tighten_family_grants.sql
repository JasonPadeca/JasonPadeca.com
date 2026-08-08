-- =============================================================================
-- 0013_tighten_family_grants.sql
-- Closing two gaps left by 0012.
--
-- Neither leaks anything today. Both are the kind of thing that becomes a leak
-- later, quietly, when somebody changes what the function returns.
--
-- 1. The three membership helpers were granted to `authenticated` but never
--    revoked from PUBLIC — and Postgres grants EXECUTE to PUBLIC by default, so
--    anonymous visitors inherited it. They currently answer harmlessly (auth.uid()
--    is null, so they return an empty array or false), but they are SECURITY
--    DEFINER functions reachable with a key that is published in the page source.
--    Every other definer function in this schema is explicitly revoked; these
--    three were the exception, and exceptions are what get exploited.
--
-- 2. family_users had RLS and a correct policy, so anon got an empty result —
--    but it got that result by being allowed to run the query and matching no
--    rows, rather than by being refused. Every other table refuses outright.
--    Same posture everywhere is easier to verify than "this one is fine because
--    of the policy".
-- =============================================================================

revoke execute on function public.current_family_ids() from public, anon;
revoke execute on function public.current_child_ids()  from public, anon;
revoke execute on function public.is_family_member()   from public, anon;

grant execute on function public.current_family_ids() to authenticated;
grant execute on function public.current_child_ids()  to authenticated;
grant execute on function public.is_family_member()   to authenticated;

revoke all on public.family_users from anon;

-- Belt and braces: the same posture for everything 0012 opened to families.
-- A family is authenticated, so revoking anon costs nothing and means an
-- anonymous request is refused at the privilege check rather than relying on a
-- policy to return zero rows.
revoke all on public.families, public.parents, public.children,
              public.registrations, public.semester_participation,
              public.class_preferences, public.volunteer_interest,
              public.volunteer_interest_slot, public.class_volunteers,
              public.semesters, public.periods, public.classes,
              public.settings
  from anon;
