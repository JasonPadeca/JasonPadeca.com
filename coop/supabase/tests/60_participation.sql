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

\set fam  '''41111111-1111-1111-1111-111111111111'''
\set sem  '''11111111-1111-1111-1111-111111111111'''
\set emma '''51111111-1111-1111-1111-111111111111'''
\set cale '''52222222-2222-2222-2222-222222222222'''

-- =============================================================================
-- Default state: nobody has said anything, so everybody is participating.
-- =============================================================================
select pg_temp.check('children default to participating',
  (select count(*)::text from
     jsonb_array_elements(public.family_registration_payload(:fam::uuid, :sem::uuid) -> 'children') c
    where (c ->> 'participating')::boolean), '2');

-- =============================================================================
-- Emma registers; Caleb sits the semester out.
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid,
  '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111"}]'::jsonb,
  'family', false, array[:cale::uuid]);

select pg_temp.check('Caleb is recorded as sitting out',
  (select participating::text from public.semester_participation
    where child_id = :cale::uuid and semester_id = :sem::uuid), 'false');

select pg_temp.check('Emma is recorded as participating',
  (select participating::text from public.semester_participation
    where child_id = :emma::uuid and semester_id = :sem::uuid), 'true');

select pg_temp.check('Emma still got her class',
  (select status from public.registrations
    where child_id = :emma::uuid and class_id = '31111111-1111-1111-1111-111111111111'), 'registered');

select pg_temp.check('the payload reports Caleb as not participating',
  (select c ->> 'participating' from
     jsonb_array_elements(public.family_registration_payload(:fam::uuid, :sem::uuid) -> 'children') c
    where c ->> 'first_name' = 'Caleb'), 'false');

-- =============================================================================
-- A stale tab submitting classes for a child who is now sitting out.
-- The opt-out must win, and it must not cost the other child their place.
-- =============================================================================
select pg_temp.check('selections for a sitting-out child are refused',
  (public.submit_family_registration(:fam::uuid, :sem::uuid,
    '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111"},
      {"child_id":"52222222-2222-2222-2222-222222222222","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb,
    'family', false, array[:cale::uuid]) -> 'results' -> 1 ->> 'detail'),
  'That child is not participating this semester.');

select pg_temp.check('...and Caleb has no live registration',
  (select count(*)::text from public.registrations
    where child_id = :cale::uuid and status in ('registered','waitlisted')), '0');

select pg_temp.check('...while Emma keeps hers',
  (select count(*)::text from public.registrations
    where child_id = :emma::uuid and status = 'registered'), '1');

-- =============================================================================
-- Opting a child out AFTER they were registered clears their schedule.
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid,
  '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111"},
    {"child_id":"52222222-2222-2222-2222-222222222222","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb);

select pg_temp.check('both children registered first',
  (select count(*)::text from public.registrations r join public.children ch on ch.id = r.child_id
    where ch.family_id = :fam::uuid and r.status = 'registered'), '2');

select public.submit_family_registration(:fam::uuid, :sem::uuid,
  '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111"}]'::jsonb,
  'family', false, array[:cale::uuid]);

select pg_temp.check('opting Caleb out cancelled his class',
  (select status from public.registrations
    where child_id = :cale::uuid and class_id = '32222222-2222-2222-2222-222222222222'), 'cancelled');

-- =============================================================================
-- Changing your mind: leaving the array empty puts them back in.
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid,
  '[{"child_id":"52222222-2222-2222-2222-222222222222","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb);

select pg_temp.check('Caleb participates again once unticked',
  (select participating::text from public.semester_participation
    where child_id = :cale::uuid and semester_id = :sem::uuid), 'true');

select pg_temp.check('...and can register again',
  (select status from public.registrations
    where child_id = :cale::uuid and class_id = '32222222-2222-2222-2222-222222222222'), 'registered');

-- =============================================================================
-- A whole family sitting out: an empty submission must still be accepted.
-- =============================================================================
select pg_temp.check('a family with nobody participating can still submit',
  (public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb, 'family', false,
     array[:emma::uuid, :cale::uuid]) ->> 'ok'), 'true');

select pg_temp.check('both are marked out',
  (select count(*)::text from public.semester_participation
    where semester_id = :sem::uuid and not participating
      and child_id in (:emma::uuid, :cale::uuid)), '2');

select pg_temp.check('the family holds no live registrations',
  (select count(*)::text from public.registrations r join public.children ch on ch.id = r.child_id
    where ch.family_id = :fam::uuid and r.status in ('registered','waitlisted')), '0');

-- =============================================================================
-- A family may only opt out its OWN children (§19).
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb, 'family', false,
  array['53333333-3333-3333-3333-333333333333'::uuid]);   -- Billy Smith

select pg_temp.check('cannot opt out another family''s child',
  (select count(*)::text from public.semester_participation
    where child_id = '53333333-3333-3333-3333-333333333333'), '0');

-- An inactive child has left the program, which is a different thing from
-- sitting out; they should not accumulate a row every semester.
select pg_temp.check('inactive children get no participation row',
  (select count(*)::text from public.semester_participation
    where child_id = '56666666-6666-6666-6666-666666666666'), '0');

-- The call above named no Johnson child, which correctly put both of them back
-- to participating. Opt them out again for the dashboard check.
select public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb, 'family', false,
  array[:emma::uuid, :cale::uuid]);

-- =============================================================================
-- Dashboard: sitting out is not the same as unfinished (§8).
-- =============================================================================
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select pg_temp.check('summary counts the two children sitting out',
  (public.semester_summary(:sem::uuid) ->> 'sitting_out'), '2');

select pg_temp.check('sitting-out children are not counted as registered',
  (public.semester_summary(:sem::uuid) ->> 'children_registered'), '0');

select pg_temp.check('opting out is written to the audit log',
  (select case when count(*) > 0 then 'yes' else 'no' end from public.audit_log
    where action = 'family_registration_submitted'
      and jsonb_array_length(details -> 'not_participating') > 0), 'yes');
