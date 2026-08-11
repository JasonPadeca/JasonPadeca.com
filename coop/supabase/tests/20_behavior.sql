\set ON_ERROR_STOP on
\pset pager off

create or replace function pg_temp.check(label text, actual text, expected text)
returns void language plpgsql as $$
begin
  if actual is not distinct from expected then
    raise notice 'PASS  %', label;
  else
    raise warning 'FAIL  %  expected<%>  actual<%>', label, expected, actual;
  end if;
end;
$$;

-- =============================================================================
-- Eligibility (§17)
-- =============================================================================
select pg_temp.check('Emma (12) eligible for Chemistry (11-14)',
  coalesce(array_length(public.eligibility_reasons(
    '51111111-1111-1111-1111-111111111111','31111111-1111-1111-1111-111111111111'),1),0)::text, '0');

select pg_temp.check('Caleb (9) too young for Chemistry',
  (public.eligibility_reasons(
    '52222222-2222-2222-2222-222222222222','31111111-1111-1111-1111-111111111111'))[1],
  'Ages 11 and up (Caleb will be 9)');

select pg_temp.check('Carol (14) too young for Robotics (13-17)? no - eligible',
  coalesce(array_length(public.eligibility_reasons(
    '54444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333333'),1),0)::text, '0');

select pg_temp.check('Billy (male) blocked from Girls Volleyball',
  (public.eligibility_reasons(
    '53333333-3333-3333-3333-333333333333','36666666-6666-6666-6666-666666666666'))[1],
  'Girls only');

select pg_temp.check('Inactive child blocked',
  (public.eligibility_reasons(
    '56666666-6666-6666-6666-666666666666','37777777-7777-7777-7777-777777777777'))[1],
  'Child is not currently active');

select pg_temp.check('Age computed at semester start, not today',
  public.age_at('2015-03-12','2027-09-03')::text, '12');

-- =============================================================================
-- Family submission (§19, §40)
-- =============================================================================
select pg_temp.check('Johnson submit: Emma gets Chemistry',
  (public.submit_family_registration(
    '41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
    '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"31111111-1111-1111-1111-111111111111"},
      {"child_id":"51111111-1111-1111-1111-111111111111","class_id":"34444444-4444-4444-4444-444444444444"},
      {"child_id":"52222222-2222-2222-2222-222222222222","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb
  ) -> 'results' -> 0 ->> 'outcome'), 'registered');

select pg_temp.check('Johnson now holds 3 confirmed seats',
  (select count(*)::text from public.registrations
    where semester_id='11111111-1111-1111-1111-111111111111' and status='registered'), '3');

-- Ineligible selection is refused, and does not poison the rest of the submission.
select pg_temp.check('Ineligible selection reported, not fatal',
  (public.submit_family_registration(
    '42222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
    '[{"child_id":"53333333-3333-3333-3333-333333333333","class_id":"36666666-6666-6666-6666-666666666666"},
      {"child_id":"53333333-3333-3333-3333-333333333333","class_id":"37777777-7777-7777-7777-777777777777"}]'::jsonb
  ) -> 'results' -> 0 ->> 'outcome'), 'ineligible');

select pg_temp.check('...and the eligible one in the same submission went through',
  (select status from public.registrations
    where child_id='53333333-3333-3333-3333-333333333333'
      and class_id='37777777-7777-7777-7777-777777777777'), 'registered');

-- A family may not register someone else's child (§19).
select pg_temp.check('Cross-family registration rejected',
  (public.submit_family_registration(
    '42222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
    '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb
  ) -> 'results' -> 0 ->> 'outcome'), 'rejected');

-- Two classes named for one period are alternatives, not a conflict: the first
-- that is available wins and the rest are simply not needed (§0006).
select pg_temp.check('Two classes in one period: the first available wins',
  (select r ->> 'class_id' from
     jsonb_array_elements(public.submit_family_registration(
       '43333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111',
       '[{"child_id":"54444444-4444-4444-4444-444444444444","class_id":"32222222-2222-2222-2222-222222222222","rank":1},
         {"child_id":"54444444-4444-4444-4444-444444444444","class_id":"33333333-3333-3333-3333-333333333333","rank":2}]'::jsonb
     ) -> 'results') r
    where r ->> 'outcome' = 'registered'), '32222222-2222-2222-2222-222222222222');

select pg_temp.check('Carol kept exactly one period-1 seat',
  (select count(*)::text from public.registrations
    where child_id='54444444-4444-4444-4444-444444444444'
      and period_id='21111111-1111-1111-1111-111111111111' and status='registered'), '1');

-- =============================================================================
-- Editing an existing registration (§41)
-- Resubmitting a different schedule swaps the class and drops what was removed.
-- =============================================================================
select public.submit_family_registration(
  '41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
  '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb);

select pg_temp.check('Emma swapped Chemistry -> Art in period 1',
  (select c.name from public.registrations r join public.classes c on c.id=r.class_id
    where r.child_id='51111111-1111-1111-1111-111111111111' and r.status='registered'), 'Art');

select pg_temp.check('Emma''s dropped Biology is cancelled, not deleted',
  (select status from public.registrations
    where child_id='51111111-1111-1111-1111-111111111111'
      and class_id='34444444-4444-4444-4444-444444444444'), 'cancelled');

select pg_temp.check('Caleb''s Art seat was dropped by the reconcile',
  (select status from public.registrations
    where child_id='52222222-2222-2222-2222-222222222222'
      and class_id='32222222-2222-2222-2222-222222222222'), 'cancelled');

-- Idempotence: submitting the same thing twice changes nothing.
select public.submit_family_registration(
  '41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
  '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb);

select pg_temp.check('Double submit does not duplicate',
  (select count(*)::text from public.registrations
    where child_id='51111111-1111-1111-1111-111111111111' and status='registered'), '1');

-- =============================================================================
-- Waitlists (§21)
-- Robotics is ages 13-17, capacity 1. Carol (14) takes the only seat; Billy
-- (13) is eligible but late. Dana (12) is too young for it either way.
-- =============================================================================
select public.submit_family_registration(
  '43333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111',
  '[{"child_id":"54444444-4444-4444-4444-444444444444","class_id":"33333333-3333-3333-3333-333333333333"}]'::jsonb);

select pg_temp.check('Carol takes the last Robotics seat',
  (select status from public.registrations
    where child_id='54444444-4444-4444-4444-444444444444'
      and class_id='33333333-3333-3333-3333-333333333333'), 'registered');

select pg_temp.check('Robotics now reads as full',
  (select is_full::text from public.class_seats
    where class_id='33333333-3333-3333-3333-333333333333'), 'true');

-- Results are looked up by class rather than by position: confirmed seats and
-- waitlist entries are resolved in separate passes, so their order in the array
-- is an implementation detail.
select pg_temp.check('Billy waitlists for full Robotics',
  (select r ->> 'outcome' from
     jsonb_array_elements(public.submit_family_registration(
       '42222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
       '[{"child_id":"53333333-3333-3333-3333-333333333333","class_id":"33333333-3333-3333-3333-333333333333","intent":"waitlist"},
         {"child_id":"53333333-3333-3333-3333-333333333333","class_id":"37777777-7777-7777-7777-777777777777"}]'::jsonb
     ) -> 'results') r
    where r ->> 'class_id' = '33333333-3333-3333-3333-333333333333'), 'waitlisted');

select pg_temp.check('Billy is reported at waitlist position 1',
  (select r ->> 'waitlist_position' from
     jsonb_array_elements(public.submit_family_registration(
       '42222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
       '[{"child_id":"53333333-3333-3333-3333-333333333333","class_id":"33333333-3333-3333-3333-333333333333","intent":"waitlist"},
         {"child_id":"53333333-3333-3333-3333-333333333333","class_id":"37777777-7777-7777-7777-777777777777"}]'::jsonb
     ) -> 'results') r
    where r ->> 'class_id' = '33333333-3333-3333-3333-333333333333'), '1');

select pg_temp.check('Requesting a seat in a full class reports "full"',
  (public.submit_family_registration(
    '44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111',
    '[{"child_id":"55555555-5555-5555-5555-555555555555","class_id":"33333333-3333-3333-3333-333333333333"}]'::jsonb
  ) -> 'results' -> 0 ->> 'outcome'), 'ineligible');  -- Dana is 12; age fails first

select pg_temp.check('Uncapped class never reads as full',
  (select is_full::text from public.class_seats
    where class_id='35555555-5555-5555-5555-555555555555'), 'false');

-- A confirmed seat and a waitlist entry may coexist in one period (§51 Q3):
-- Billy holds Art in period 1 while still waiting for Robotics in period 1.
select public.submit_family_registration(
  '42222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
  '[{"child_id":"53333333-3333-3333-3333-333333333333","class_id":"33333333-3333-3333-3333-333333333333","intent":"waitlist"},
    {"child_id":"53333333-3333-3333-3333-333333333333","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb);

select pg_temp.check('Billy holds Art AND a Robotics waitlist spot in period 1',
  (select count(*)::text from public.registrations
    where child_id='53333333-3333-3333-3333-333333333333'
      and period_id='21111111-1111-1111-1111-111111111111'
      and status in ('registered','waitlisted')), '2');

-- =============================================================================
-- Waitlist promotion (§21) and admin overrides (§22)
-- =============================================================================
-- From here on, act as a signed-in owner. is_local=false so it outlives the
-- implicit transaction around each statement.
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

-- Carol leaves Robotics, freeing the seat.
select public.admin_set_registration_status(
  (select id from public.registrations
    where child_id='54444444-4444-4444-4444-444444444444'
      and class_id='33333333-3333-3333-3333-333333333333'), 'withdrawn');

select pg_temp.check('Waitlisted Billy can be promoted into the freed seat',
  (public.promote_waitlist_entry(
    (select id from public.registrations
      where child_id='53333333-3333-3333-3333-333333333333'
        and class_id='33333333-3333-3333-3333-333333333333'
        and status='waitlisted')) ->> 'ok'), 'true');

select pg_temp.check('Promotion withdrew Billy''s conflicting Art seat',
  (select status from public.registrations
    where child_id='53333333-3333-3333-3333-333333333333'
      and class_id='32222222-2222-2222-2222-222222222222'), 'withdrawn');

-- Robotics is full again (Billy has it). An admin adding Dana must override,
-- and must be told both reasons.
select pg_temp.check('Overfilling requires an explicit override',
  (public.admin_place_child(
    '55555555-5555-5555-5555-555555555555','33333333-3333-3333-3333-333333333333')
   ->> 'needs_override'), 'true');

select pg_temp.check('Admin is warned about capacity and eligibility both',
  (select count(*)::text from jsonb_array_elements(
     (public.check_placement('55555555-5555-5555-5555-555555555555',
                             '33333333-3333-3333-3333-333333333333')) -> 'warnings')), '2');

select pg_temp.check('Override succeeds when asked for explicitly',
  (public.admin_place_child(
    '55555555-5555-5555-5555-555555555555','33333333-3333-3333-3333-333333333333',
    'registered', true, 'Parent teaches the class') ->> 'ok'), 'true');

select pg_temp.check('Robotics is now deliberately over capacity',
  (select registered_count::text from public.class_seats
    where class_id='33333333-3333-3333-3333-333333333333'), '2');

select pg_temp.check('The override recorded its reason on the registration',
  (select override_reason from public.registrations
    where child_id='55555555-5555-5555-5555-555555555555'
      and class_id='33333333-3333-3333-3333-333333333333'), 'Parent teaches the class');

select pg_temp.check('The override is in the audit log',
  (select count(*)::text from public.audit_log
    where action='admin_placed_child_with_override'), '1');

select pg_temp.check('The audit log names the admin who did it',
  (select actor_label from public.audit_log
    where action='admin_placed_child_with_override'), 'Owner Person');

-- =============================================================================
-- Registration window (§19)
-- =============================================================================
update public.semesters set status='registration_closed'
  where id='11111111-1111-1111-1111-111111111111';

select pg_temp.check('Submission refused when registration is closed',
  (public.submit_family_registration(
    '41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
    '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"37777777-7777-7777-7777-777777777777"}]'::jsonb
  ) ->> 'error'), 'registration_closed');

select pg_temp.check('Admin may still act with p_allow_closed',
  (public.submit_family_registration(
    '41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
    '[{"child_id":"51111111-1111-1111-1111-111111111111","class_id":"32222222-2222-2222-2222-222222222222"}]'::jsonb,
    'admin', true) ->> 'ok'), 'true');

update public.semesters set status='registration_open'
  where id='11111111-1111-1111-1111-111111111111';

-- =============================================================================
-- Invitations (§15)
-- =============================================================================
\gset
select (public.issue_family_invite(
  '41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111') ->> 'token') as tok
\gset

select pg_temp.check('Raw token is not stored anywhere',
  (select count(*)::text from public.registration_invites where token_hash = :'tok'), '0');

select pg_temp.check('Token resolves to the right family',
  (public.resolve_invite_token(:'tok') ->> 'family_id'),
  '41111111-1111-1111-1111-111111111111');

select pg_temp.check('Garbage token rejected',
  (public.resolve_invite_token('not-a-real-token') ->> 'error'), 'invalid');

-- Re-issuing supersedes the previous invitation.
select (public.issue_family_invite(
  '41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111') ->> 'token') as tok2
\gset

select pg_temp.check('Superseded token stops working',
  (public.resolve_invite_token(:'tok') ->> 'error'), 'revoked');

select pg_temp.check('Replacement token works',
  (public.resolve_invite_token(:'tok2') ->> 'ok'), 'true');

select pg_temp.check('Exactly one live invite per family/semester',
  (select count(*)::text from public.registration_invites
    where family_id='41111111-1111-1111-1111-111111111111' and revoked_at is null), '1');

-- =============================================================================
-- Data integrity guards (§42)
-- =============================================================================
do $$
begin
  begin
    insert into public.classes (period_id, semester_id, name, age_min, age_max)
    values ('21111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','Bad', 15, 10);
    raise warning 'FAIL  age_min <= age_max not enforced';
  exception when check_violation then
    raise notice 'PASS  age_min <= age_max enforced';
  end;

  begin
    insert into public.periods (semester_id, period_number)
    values ('11111111-1111-1111-1111-111111111111', 1);
    raise warning 'FAIL  duplicate period number allowed';
  exception when unique_violation then
    raise notice 'PASS  period number unique within semester';
  end;

  begin
    insert into public.classes (period_id, semester_id, name, capacity)
    values ('21111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','Bad', -1);
    raise warning 'FAIL  negative capacity allowed';
  exception when check_violation then
    raise notice 'PASS  capacity must be nonnegative';
  end;
end;
$$;

-- A class inserted with a mismatched semester_id gets corrected, not trusted.
insert into public.classes (id, period_id, semester_id, name)
values ('39999999-9999-9999-9999-999999999999',
        '21111111-1111-1111-1111-111111111111',
        '00000000-0000-0000-0000-000000000000', 'Derived Semester Test');

select pg_temp.check('class.semester_id derived from its period',
  (select semester_id::text from public.classes
    where id='39999999-9999-9999-9999-999999999999'),
  '11111111-1111-1111-1111-111111111111');

-- =============================================================================
-- Audit log (§5.11)
-- =============================================================================
select pg_temp.check('Family submissions are audited',
  (select case when count(*) > 0 then 'yes' else 'no' end from public.audit_log
    where action='family_registration_submitted'), 'yes');

-- The runner checks for this line. ON_ERROR_STOP means a bad assertion halts
-- the file, and a halted file silently skips every test below it — which is
-- exactly what a broken cast did here once, hiding two thirds of this suite
-- while the run still reported green.
\echo 'SUITE-REACHED-THE-END'
