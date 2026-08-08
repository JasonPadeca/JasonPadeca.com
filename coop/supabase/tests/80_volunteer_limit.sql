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

-- The seed's classes, by upper age:
--   Chemistry 11-14, Art 8-18, Robotics 13-17, Biology 10-16,
--   Drawing 6-18, Volleyball 12-17, Choir (no bounds)
-- With a limit of 9, none qualify. Add two that do.
insert into public.classes
  (id, period_id, semester_id, option_number, name, age_min, age_max, capacity)
values
  ('3bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '21111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-111111111111', 8, 'Little Explorers', 5, 9, 12),
  ('3ccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111', 8, 'Nursery', 0, 3, 8);

select pg_temp.check('default limit is 9',
  (select volunteer_max_class_age::text from public.settings), '9');

-- =============================================================================
-- A qualifying class is accepted.
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb, 'family', false, '{}',
  '{"51111111-1111-1111-1111-111111111111":
      {"wants": true,
       "slots": [{"period_id":"21111111-1111-1111-1111-111111111111",
                  "class_id":"3bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}]}}'::jsonb);

select pg_temp.check('a class for ages 5-9 is accepted',
  (select count(*)::text from public.volunteer_interest_slot vs
    join public.volunteer_interest vi on vi.id = vs.interest_id
   where vi.child_id = :emma::uuid
     and vs.class_id = '3bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), '1');

-- =============================================================================
-- Classes above the limit are silently dropped, not stored.
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb, 'family', false, '{}',
  '{"51111111-1111-1111-1111-111111111111":
      {"wants": true,
       "slots": [{"period_id":"21111111-1111-1111-1111-111111111111",
                  "class_id":"31111111-1111-1111-1111-111111111111"},
                 {"period_id":"21111111-1111-1111-1111-111111111111",
                  "class_id":"32222222-2222-2222-2222-222222222222"},
                 {"period_id":"23333333-3333-3333-3333-333333333333",
                  "class_id":"37777777-7777-7777-7777-777777777777"}]}}'::jsonb);

select pg_temp.check('ages 11-14 refused',
  (select count(*)::text from public.volunteer_interest_slot
    where class_id = '31111111-1111-1111-1111-111111111111'), '0');

select pg_temp.check('ages 8-18 refused (upper bound too high)',
  (select count(*)::text from public.volunteer_interest_slot
    where class_id = '32222222-2222-2222-2222-222222222222'), '0');

select pg_temp.check('a class with no upper bound refused',
  (select count(*)::text from public.volunteer_interest_slot
    where class_id = '37777777-7777-7777-7777-777777777777'), '0');

select pg_temp.check('...and the submission still succeeded',
  (select wants_to_volunteer::text from public.volunteer_interest
    where child_id = :emma::uuid), 'true');

-- =============================================================================
-- "Any class in this period" follows the same rule.
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb, 'family', false, '{}',
  '{"51111111-1111-1111-1111-111111111111":
      {"wants": true,
       "slots": [{"period_id":"21111111-1111-1111-1111-111111111111","class_id":null},
                 {"period_id":"23333333-3333-3333-3333-333333333333","class_id":null}]}}'::jsonb);

select pg_temp.check('whole-period offer accepted where the period has a qualifying class',
  (select count(*)::text from public.volunteer_interest_slot
    where period_id = '21111111-1111-1111-1111-111111111111' and class_id is null), '1');

select pg_temp.check('whole-period offer refused where the period has none',
  (select count(*)::text from public.volunteer_interest_slot
    where period_id = '23333333-3333-3333-3333-333333333333' and class_id is null), '0');

-- =============================================================================
-- The threshold is a setting, not a constant.
-- =============================================================================
update public.settings set volunteer_max_class_age = 14;

select public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb, 'family', false, '{}',
  '{"51111111-1111-1111-1111-111111111111":
      {"wants": true,
       "slots": [{"period_id":"21111111-1111-1111-1111-111111111111",
                  "class_id":"31111111-1111-1111-1111-111111111111"}]}}'::jsonb);

select pg_temp.check('raising the limit to 14 admits the 11-14 class',
  (select count(*)::text from public.volunteer_interest_slot
    where class_id = '31111111-1111-1111-1111-111111111111'), '1');

update public.settings set volunteer_max_class_age = null;

select public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb, 'family', false, '{}',
  '{"51111111-1111-1111-1111-111111111111":
      {"wants": true,
       "slots": [{"period_id":"23333333-3333-3333-3333-333333333333",
                  "class_id":"37777777-7777-7777-7777-777777777777"}]}}'::jsonb);

select pg_temp.check('clearing the limit admits an unbounded class',
  (select count(*)::text from public.volunteer_interest_slot
    where class_id = '37777777-7777-7777-7777-777777777777'), '1');

update public.settings set volunteer_max_class_age = 9;

-- =============================================================================
-- The page is told the limit, so it can offer the same set.
-- =============================================================================
select pg_temp.check('the payload carries the limit',
  (public.family_registration_payload(:fam::uuid, :sem::uuid) ->> 'volunteer_max_class_age'), '9');
