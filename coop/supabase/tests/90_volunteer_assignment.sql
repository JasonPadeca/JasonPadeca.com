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

\set sem   '''11111111-1111-1111-1111-111111111111'''
\set emma  '''51111111-1111-1111-1111-111111111111'''
\set billy '''53333333-3333-3333-3333-333333333333'''
\set chem  '''31111111-1111-1111-1111-111111111111'''
\set art   '''32222222-2222-2222-2222-222222222222'''
\set bio   '''34444444-4444-4444-4444-444444444444'''
\set choir '''37777777-7777-7777-7777-777777777777'''

select set_config('test.jwt', '{"email":"owner@example.org"}', false);

-- =============================================================================
-- A clean assignment: nothing to displace.
-- =============================================================================
select pg_temp.check('assigning a free student needs no confirmation',
  (public.admin_assign_volunteer(:emma::uuid, :chem::uuid) ->> 'ok'), 'true');

select pg_temp.check('the assignment is recorded',
  (select c.name from public.class_volunteers v join public.classes c on c.id = v.class_id
    where v.child_id = :emma::uuid), 'Beginning Chemistry');

select pg_temp.check('period and semester are derived from the class',
  (select (v.period_id = '21111111-1111-1111-1111-111111111111')::text
     from public.class_volunteers v where v.child_id = :emma::uuid), 'true');

-- =============================================================================
-- A volunteer does not consume a seat.
-- =============================================================================
select pg_temp.check('the class still shows nobody enrolled',
  (select registered_count::text from public.class_seats where class_id = :chem::uuid), '0');

select pg_temp.check('...and its seats are all still open',
  (select seats_open::text from public.class_seats where class_id = :chem::uuid), '10');

-- =============================================================================
-- Displacement: Billy is taking a class in the period he would help in.
-- =============================================================================
select public.admin_place_child(:billy::uuid, :art::uuid);   -- Art, period 1

select pg_temp.check('Billy is registered for Art',
  (select status from public.registrations
    where child_id = :billy::uuid and class_id = :art::uuid), 'registered');

select pg_temp.check('assigning him elsewhere in that period asks first',
  (public.admin_assign_volunteer(:billy::uuid, :chem::uuid) ->> 'needs_confirmation'), 'true');

select pg_temp.check('...and says what it will cost',
  (select w ->> 'kind' from
     jsonb_array_elements(public.admin_assign_volunteer(:billy::uuid, :chem::uuid) -> 'warnings') w
    where w ->> 'kind' = 'displaces_student'), 'displaces_student');

select pg_temp.check('...naming the class by name',
  (select (w ->> 'message') like '%Art%' from
     jsonb_array_elements(public.admin_assign_volunteer(:billy::uuid, :chem::uuid) -> 'warnings') w
    where w ->> 'kind' = 'displaces_student')::text, 'true');

select pg_temp.check('nothing happened without confirmation',
  (select status from public.registrations
    where child_id = :billy::uuid and class_id = :art::uuid), 'registered');

-- Confirm it.
select pg_temp.check('confirming reports what was given up',
  (public.admin_assign_volunteer(:billy::uuid, :chem::uuid, 'Good with the little ones', true)
   ->> 'withdrew_from'), 'Art');

select pg_temp.check('Billy was withdrawn from Art',
  (select status from public.registrations
    where child_id = :billy::uuid and class_id = :art::uuid), 'withdrawn');

select pg_temp.check('...and the Art seat went back to the co-op',
  (select registered_count::text from public.class_seats where class_id = :art::uuid), '0');

select pg_temp.check('...and he is now a volunteer in Chemistry',
  (select count(*)::text from public.class_volunteers
    where child_id = :billy::uuid and class_id = :chem::uuid), '1');

select pg_temp.check('the note is kept',
  (select note from public.class_volunteers where child_id = :billy::uuid),
  'Good with the little ones');

-- =============================================================================
-- One role per period: moving a volunteer does not leave a duplicate.
-- =============================================================================
select public.admin_assign_volunteer(:billy::uuid, :art::uuid, null, true);  -- also period 1

select pg_temp.check('a volunteer holds only one class per period',
  (select count(*)::text from public.class_volunteers
    where child_id = :billy::uuid
      and period_id = '21111111-1111-1111-1111-111111111111'), '1');

select pg_temp.check('...and it is the new one',
  (select c.name from public.class_volunteers v join public.classes c on c.id = v.class_id
    where v.child_id = :billy::uuid), 'Art');

-- A different period is fine.
select public.admin_assign_volunteer(:billy::uuid, :bio::uuid, null, true);  -- period 2

select pg_temp.check('helping in two different periods is allowed',
  (select count(*)::text from public.class_volunteers where child_id = :billy::uuid), '2');

-- =============================================================================
-- Age limits do not apply to volunteers — helping is not attending.
-- =============================================================================
select pg_temp.check('a 13-year-old may help with a class he is too old to take',
  (public.admin_assign_volunteer(:billy::uuid, :choir::uuid, null, true) ->> 'ok'), 'true');

-- =============================================================================
-- Removal
-- =============================================================================
select pg_temp.check('a volunteer can be removed',
  (public.admin_remove_volunteer(
     (select id from public.class_volunteers where child_id = :emma::uuid)) ->> 'ok'), 'true');

select pg_temp.check('...and is gone',
  (select count(*)::text from public.class_volunteers where child_id = :emma::uuid), '0');

select pg_temp.check('removal does not silently re-enrol them as a student',
  (select count(*)::text from public.registrations
    where child_id = :emma::uuid and status = 'registered'), '0');

-- =============================================================================
-- Audit
-- =============================================================================
select pg_temp.check('assignments are audited',
  (select case when count(*) > 0 then 'yes' else 'no' end from public.audit_log
    where action = 'volunteer_assigned'), 'yes');

select pg_temp.check('the displacement is recorded in the log',
  (select case when count(*) > 0 then 'yes' else 'no' end from public.audit_log
    where action = 'volunteer_assigned' and details ->> 'withdrew_from' = 'Art'), 'yes');

-- =============================================================================
-- Authorisation
-- =============================================================================
select set_config('test.jwt', '{"email":"stranger@gmail.com"}', false);

do $$
begin
  begin
    perform public.admin_assign_volunteer(
      '51111111-1111-1111-1111-111111111111','31111111-1111-1111-1111-111111111111', null, true);
    raise warning 'FAIL  a non-admin could assign a volunteer';
  exception when others then
    raise notice 'PASS  a non-admin cannot assign a volunteer';
  end;
end;
$$;

-- The runner checks for this line. ON_ERROR_STOP means a bad assertion halts
-- the file, and a halted file silently skips every test below it — which is
-- exactly what a broken cast did here once, hiding two thirds of this suite
-- while the run still reported green.
\echo 'SUITE-REACHED-THE-END'
