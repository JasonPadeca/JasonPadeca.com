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

\set fam   '''41111111-1111-1111-1111-111111111111'''
\set sem   '''11111111-1111-1111-1111-111111111111'''
\set emma  '''51111111-1111-1111-1111-111111111111'''
\set chem  '''31111111-1111-1111-1111-111111111111'''
\set art   '''32222222-2222-2222-2222-222222222222'''
\set p1    '''21111111-1111-1111-1111-111111111111'''
\set choir '''37777777-7777-7777-7777-777777777777'''

-- =============================================================================
-- Second choices: both are recorded, whichever one is used.
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid,
  '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111","rank":1},
    {"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222","rank":2}]'::jsonb);

select pg_temp.check('first choice is taken when it has room',
  (select c.name from public.registrations r join public.classes c on c.id = r.class_id
    where r.child_id = :emma::uuid and r.status = 'registered'), 'Beginning Chemistry');

select pg_temp.check('the first choice is recorded as rank 1',
  (select class_id::text from public.class_preferences
    where child_id = :emma::uuid and period_id = :p1::uuid and rank = 1), :chem);

select pg_temp.check('the second choice is recorded even though it was not needed',
  (select class_id::text from public.class_preferences
    where child_id = :emma::uuid and period_id = :p1::uuid and rank = 2), :art);

-- -----------------------------------------------------------------------------
-- Fill Chemistry, then resubmit: the second choice should be used.
-- -----------------------------------------------------------------------------
update public.classes set capacity = 1 where id = :chem::uuid;

-- Give the single seat to somebody else.
select public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb);
insert into public.registrations (child_id, class_id, status, source)
values ('54444444-4444-4444-4444-444444444444', :chem::uuid, 'registered', 'admin');

select pg_temp.check('a full first choice falls back to the second',
  (select r ->> 'class_id' from
     jsonb_array_elements(public.submit_family_registration(:fam::uuid, :sem::uuid,
       '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111","rank":1},
         {"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222","rank":2}]'::jsonb
     ) -> 'results') r
    where r ->> 'outcome' = 'registered'), :art);

select pg_temp.check('...and the family is told why',
  (select r ->> 'used_second_choice' from
     jsonb_array_elements(public.submit_family_registration(:fam::uuid, :sem::uuid,
       '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111","rank":1},
         {"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222","rank":2}]'::jsonb
     ) -> 'results') r
    where r ->> 'outcome' = 'registered'), 'true');

select pg_temp.check('...and the full first choice is still reported',
  (select count(*)::text from
     jsonb_array_elements(public.submit_family_registration(:fam::uuid, :sem::uuid,
       '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111","rank":1},
         {"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222","rank":2}]'::jsonb
     ) -> 'results') r
    where r ->> 'outcome' = 'full'), '1');

select pg_temp.check('Emma holds exactly one period-1 seat',
  (select count(*)::text from public.registrations
    where child_id = :emma::uuid and period_id = :p1::uuid and status = 'registered'), '1');

select pg_temp.check('the admin can still see the first choice was Chemistry',
  (select class_id::text from public.class_preferences
    where child_id = :emma::uuid and period_id = :p1::uuid and rank = 1), :chem);

-- Both full: nothing is taken, and both are reported.
update public.classes set capacity = 0 where id = :art::uuid;

select pg_temp.check('when both choices are full, no seat is taken',
  (select count(*)::text from
     jsonb_array_elements(public.submit_family_registration(:fam::uuid, :sem::uuid,
       '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111","rank":1},
         {"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222","rank":2}]'::jsonb
     ) -> 'results') r
    where r ->> 'outcome' = 'registered'), '0');

select pg_temp.check('...and both are reported as full',
  (select count(*)::text from
     jsonb_array_elements(public.submit_family_registration(:fam::uuid, :sem::uuid,
       '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111","rank":1},
         {"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222","rank":2}]'::jsonb
     ) -> 'results') r
    where r ->> 'outcome' = 'full'), '2');

update public.classes set capacity = 10 where id = :chem::uuid;
update public.classes set capacity = 8  where id = :art::uuid;
delete from public.registrations where child_id = '54444444-4444-4444-4444-444444444444';

-- Preferences are replaced, not accumulated, when a family resubmits.
select public.submit_family_registration(:fam::uuid, :sem::uuid,
  '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222","rank":1}]'::jsonb);

select pg_temp.check('resubmitting replaces the old preferences',
  (select count(*)::text from public.class_preferences
    where child_id = :emma::uuid and period_id = :p1::uuid), '1');

-- =============================================================================
-- Volunteering
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid,
  '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb,
  'family', false, '{}',
  '{"51111111-1111-1111-1111-111111111111":
      {"wants": true, "note": "Happy to help with younger children",
       "slots": [{"period_id":"23333333-3333-3333-3333-333333333333","class_id":null},
                 {"period_id":"21111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222"}]}}'::jsonb);

select pg_temp.check('volunteering is recorded',
  (select wants_to_volunteer::text from public.volunteer_interest
    where child_id = :emma::uuid and semester_id = :sem::uuid), 'true');

select pg_temp.check('the note is kept',
  (select note from public.volunteer_interest
    where child_id = :emma::uuid and semester_id = :sem::uuid),
  'Happy to help with younger children');

select pg_temp.check('both slots are recorded',
  (select count(*)::text from public.volunteer_interest_slot vs
    join public.volunteer_interest vi on vi.id = vs.interest_id
   where vi.child_id = :emma::uuid), '2');

select pg_temp.check('a whole-period offer stores no class',
  (select count(*)::text from public.volunteer_interest_slot vs
    join public.volunteer_interest vi on vi.id = vs.interest_id
   where vi.child_id = :emma::uuid and vs.class_id is null), '1');

-- Withdrawing the offer clears the slots.
select public.submit_family_registration(:fam::uuid, :sem::uuid,
  '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb,
  'family', false, '{}',
  '{"51111111-1111-1111-1111-111111111111": {"wants": false, "slots": []}}'::jsonb);

select pg_temp.check('withdrawing the offer clears the slots',
  (select count(*)::text from public.volunteer_interest_slot vs
    join public.volunteer_interest vi on vi.id = vs.interest_id
   where vi.child_id = :emma::uuid), '0');

select pg_temp.check('...and the flag is cleared too',
  (select wants_to_volunteer::text from public.volunteer_interest
    where child_id = :emma::uuid), 'false');

-- A family may only speak for its own children (§19).
select public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb, 'family', false, '{}',
  '{"53333333-3333-3333-3333-333333333333": {"wants": true, "slots": []}}'::jsonb);

select pg_temp.check('cannot volunteer another family''s child',
  (select count(*)::text from public.volunteer_interest
    where child_id = '53333333-3333-3333-3333-333333333333'), '0');

-- =============================================================================
-- Admin report
-- =============================================================================
select public.submit_family_registration(:fam::uuid, :sem::uuid, '[]'::jsonb, 'family', false, '{}',
  '{"51111111-1111-1111-1111-111111111111":
      {"wants": true, "note": "Weekdays only",
       "slots": [{"period_id":"23333333-3333-3333-3333-333333333333","class_id":null}]}}'::jsonb);

select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select pg_temp.check('the volunteer report lists Emma',
  (select r ->> 'child_name' from
     jsonb_array_elements(public.volunteer_report(:sem::uuid)) r), 'Emma Johnson');

select pg_temp.check('the report names the period offered',
  (select r -> 'slots' -> 0 ->> 'period_name' from
     jsonb_array_elements(public.volunteer_report(:sem::uuid)) r), 'Third Hour');

select pg_temp.check('the report carries the family contact',
  (select r ->> 'family_email' from
     jsonb_array_elements(public.volunteer_report(:sem::uuid)) r), 'mary@example.com');

select pg_temp.check('children who declined are not in the report',
  (select jsonb_array_length(public.volunteer_report(:sem::uuid))::text), '1');
