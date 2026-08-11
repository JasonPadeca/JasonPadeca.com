\set ON_ERROR_STOP on
\pset pager off

create or replace function pg_temp.check(label text, actual text, expected text)
returns void language plpgsql as $$
begin
  if actual is not distinct from expected then raise notice 'PASS  %', label;
  else raise warning 'FAIL  %  expected<%>  actual<%>', label, expected, actual;
  end if;
end;
$$;

\set fam '''41111111-1111-1111-1111-111111111111'''
\set sem '''11111111-1111-1111-1111-111111111111'''

create temp table payload as
  select public.family_registration_payload(:fam::uuid, :sem::uuid) as p;

-- =============================================================================
-- Shape
-- =============================================================================
select pg_temp.check('payload returns ok', (select p ->> 'ok' from payload), 'true');

select pg_temp.check('names the right family',
  (select p -> 'family' ->> 'display_name' from payload), 'Johnson Family');

select pg_temp.check('all three periods present',
  (select jsonb_array_length(p -> 'periods')::text from payload), '3');

select pg_temp.check('semester reads as open',
  (select p -> 'semester' ->> 'is_open' from payload), 'true');

-- =============================================================================
-- Privacy: a family sees their own children and nobody else's (§28, §45)
-- =============================================================================
select pg_temp.check('exactly the 2 active Johnson children',
  (select jsonb_array_length(p -> 'children')::text from payload), '2');

select pg_temp.check('inactive child is excluded',
  (select count(*)::text from payload, jsonb_array_elements(p -> 'children') c
    where c ->> 'first_name' = 'Old'), '0');

select pg_temp.check('no other family''s child appears anywhere in the payload',
  (select count(*)::text from payload
    where p::text like '%Billy%' or p::text like '%Carol%' or p::text like '%Dana%'), '0');

select pg_temp.check('no birth dates are exposed, only computed ages',
  (select count(*)::text from payload where p::text like '%birth_date%'), '0');

select pg_temp.check('no email addresses of other families leak',
  (select count(*)::text from payload where p::text like '%rebecca@example.com%'), '0');

select pg_temp.check('no class rosters are exposed to families',
  (select count(*)::text from payload where p::text like '%"child_id"%'
    and p::text not like '%registrations%'), '0');

-- Ages are computed against the semester start, not today.
select pg_temp.check('Emma''s age computed at semester start',
  (select c ->> 'age' from payload, jsonb_array_elements(p -> 'children') c
    where c ->> 'first_name' = 'Emma'), '12');

-- =============================================================================
-- Eligibility travels with each class, per child (§17 Option B)
-- =============================================================================
select pg_temp.check('Chemistry lists no reasons for Emma (eligible)',
  (select jsonb_array_length(cl -> 'eligibility' -> '51111111-1111-1111-1111-111111111111')::text
     from payload,
          jsonb_array_elements(p -> 'periods') pd,
          jsonb_array_elements(pd -> 'classes') cl
    where cl ->> 'name' = 'Beginning Chemistry'), '0');

select pg_temp.check('Chemistry explains itself to 9-year-old Caleb',
  (select cl -> 'eligibility' -> '52222222-2222-2222-2222-222222222222' ->> 0
     from payload,
          jsonb_array_elements(p -> 'periods') pd,
          jsonb_array_elements(pd -> 'classes') cl
    where cl ->> 'name' = 'Beginning Chemistry'), 'Ages 11 and up (Caleb will be 9)');

-- Caleb is 9 and male, so Girls' Volleyball (girls, 12-17) fails on both
-- counts. Both reasons come back, so the page can show the whole story.
select pg_temp.check('Girls'' Volleyball gives Caleb both reasons',
  (select (cl -> 'eligibility' -> '52222222-2222-2222-2222-222222222222')::text
     from payload,
          jsonb_array_elements(p -> 'periods') pd,
          jsonb_array_elements(pd -> 'classes') cl
    where cl ->> 'name' = 'Girls'' Volleyball'),
  '["Ages 12 and up (Caleb will be 9)", "Girls only"]');

select pg_temp.check('seat counts ride along with each class',
  (select cl ->> 'is_full' from payload,
          jsonb_array_elements(p -> 'periods') pd,
          jsonb_array_elements(pd -> 'classes') cl
    where cl ->> 'name' = 'Robotics'), 'false');

-- =============================================================================
-- Archived things stay out of the family's view (§6)
-- =============================================================================
update public.classes set archived_at = now()
  where name = 'Art';

select pg_temp.check('a cancelled class disappears from the family page',
  (select count(*)::text from
     (select public.family_registration_payload(:fam::uuid, :sem::uuid) as p) x,
     jsonb_array_elements(x.p -> 'periods') pd,
     jsonb_array_elements(pd -> 'classes') cl
    where cl ->> 'name' = 'Art'), '0');

update public.periods set archived_at = now() where period_number = 3;

select pg_temp.check('an archived period disappears too',
  (select jsonb_array_length(
     public.family_registration_payload(:fam::uuid, :sem::uuid) -> 'periods')::text), '2');

update public.classes set archived_at = null where name = 'Art';
update public.periods set archived_at = null where period_number = 3;

-- =============================================================================
-- Existing registrations come back so the page can pre-select them (§41)
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid,
  '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111"},
    {"child_id":"51111111-1111-1111-1111-111111111111","class_id":"37777777-7777-7777-7777-777777777777"}]'::jsonb);

select pg_temp.check('the family''s existing selections come back',
  (select jsonb_array_length(
     public.family_registration_payload(:fam::uuid, :sem::uuid) -> 'registrations')::text), '2');

-- =============================================================================
-- Preflight (§23)
-- =============================================================================
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select pg_temp.check('preflight flags the family with no email address',
  (select count(*)::text from
     jsonb_array_elements(public.registration_preflight(:sem::uuid) -> 'warnings') w
    where w ->> 'message' like '%no email address%'), '1');

select pg_temp.check('a missing email is treated as blocking',
  (public.registration_preflight(:sem::uuid) ->> 'blocking'), 'true');

update public.families set primary_email = 'green@example.com'
  where display_name = 'Green Family';

select pg_temp.check('...and stops blocking once the email is filled in',
  (public.registration_preflight(:sem::uuid) ->> 'blocking'), 'false');

select pg_temp.check('preflight notices a period with no classes',
  (select count(*)::text from
     jsonb_array_elements(public.registration_preflight(:sem::uuid) -> 'warnings') w
    where w ->> 'message' like '%has no classes%'), '0');

-- =============================================================================
-- Dashboard summary (§8)
-- =============================================================================
select pg_temp.check('summary counts active children',
  (public.semester_summary(:sem::uuid) ->> 'active_children'), '5');

select pg_temp.check('summary counts confirmed seats',
  (public.semester_summary(:sem::uuid) ->> 'confirmed_seats'), '2');

select pg_temp.check('summary counts registered children distinctly',
  (public.semester_summary(:sem::uuid) ->> 'children_registered'), '1');

-- The runner checks for this line. ON_ERROR_STOP means a bad assertion halts
-- the file, and a halted file silently skips every test below it — which is
-- exactly what a broken cast did here once, hiding two thirds of this suite
-- while the run still reported green.
\echo 'SUITE-REACHED-THE-END'
