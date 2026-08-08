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
\set p1    '''21111111-1111-1111-1111-111111111111'''
\set p2    '''22222222-2222-2222-2222-222222222222'''

\set u_mary '''00000000-0000-0000-0000-00000000bb01'''
insert into auth.users (id) values (:u_mary::uuid) on conflict do nothing;
update public.families set primary_email = 'mary@example.org'
 where id = '41111111-1111-1111-1111-111111111111';

-- A date inside the seeded term.
-- Both are Fridays, which is when the seeded term meets.
\set d1 '''2027-09-17'''
\set d2 '''2027-09-24'''

create or replace function pg_temp.be(uid text, email text)
returns void language sql as $$
  select set_config('test.uid', uid, false),
         set_config('test.jwt', json_build_object('email', email)::text, false);
  select set_config('role', 'authenticated', false);
$$;

-- =============================================================================
-- A parent reporting for their own child
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.org');
select public.establish_session();

select pg_temp.check('a whole day can be reported',
  (public.report_absence(:emma::uuid, :d1::date) ->> 'ok'), 'true');

select pg_temp.check('...and is stored as a whole day',
  (select whole_day::text from public.absences
    where child_id = :emma::uuid and meeting_id = (select id from meeting_dates where meets_on = :d1::date)), 'true');

select pg_temp.check('...with no periods attached',
  (select count(*)::text from public.absence_periods ap
    join public.absences a on a.id = ap.absence_id
   where a.child_id = :emma::uuid), '0');

-- =============================================================================
-- Part of a day
-- =============================================================================
select pg_temp.check('specific periods can be reported',
  (public.report_absence(:emma::uuid, :d2::date, false,
     array[:p1::uuid, :p2::uuid], 'Dentist') ->> 'ok'), 'true');

select pg_temp.check('...stored as a partial day',
  (select whole_day::text from public.absences
    where child_id = :emma::uuid and meeting_id = (select id from meeting_dates where meets_on = :d2::date)), 'false');

select pg_temp.check('...with both periods recorded',
  (select count(*)::text from public.absence_periods ap
    join public.absences a on a.id = ap.absence_id
   where a.child_id = :emma::uuid
     and a.meeting_id = (select id from meeting_dates where meets_on = :d2::date)), '2');

select pg_temp.check('...and the reason kept',
  (select reason from public.absences
    where child_id = :emma::uuid and meeting_id = (select id from meeting_dates where meets_on = :d2::date)), 'Dentist');

-- =============================================================================
-- Re-reporting the same day corrects it rather than adding a second
-- =============================================================================
select public.report_absence(:emma::uuid, :d2::date, false, array[:p1::uuid], 'Back for lunch');

select pg_temp.check('a second report for the same day does not duplicate',
  (select count(*)::text from public.absences
    where child_id = :emma::uuid and meeting_id = (select id from meeting_dates where meets_on = :d2::date)), '1');

select pg_temp.check('...and the period list is REPLACED, not merged',
  (select count(*)::text from public.absence_periods ap
    join public.absences a on a.id = ap.absence_id
   where a.meeting_id = (select id from meeting_dates where meets_on = :d2::date) and a.child_id = :emma::uuid), '1');

select pg_temp.check('...the remaining period being the one just named',
  (select ap.period_id::text from public.absence_periods ap
    join public.absences a on a.id = ap.absence_id
   where a.meeting_id = (select id from meeting_dates where meets_on = :d2::date) and a.child_id = :emma::uuid),
  '21111111-1111-1111-1111-111111111111');

-- Whole day again clears the periods.
select public.report_absence(:emma::uuid, :d2::date, true);
select pg_temp.check('switching back to a whole day clears the periods',
  (select count(*)::text from public.absence_periods ap
    join public.absences a on a.id = ap.absence_id
   where a.meeting_id = (select id from meeting_dates where meets_on = :d2::date) and a.child_id = :emma::uuid), '0');

-- =============================================================================
-- Nonsense is refused
-- =============================================================================
select pg_temp.check('a partial day with no periods is refused',
  (public.report_absence(:emma::uuid, :d1::date, false, '{}') ->> 'error'), 'no_periods');

select pg_temp.check('a date outside any term is refused',
  (public.report_absence(:emma::uuid, '2035-01-01'::date) ->> 'error'), 'not_a_class_day');

-- The case the old free-date version accepted without complaint.
select pg_temp.check('a weekday the co-op does not meet is refused',
  (public.report_absence(:emma::uuid, '2027-09-15'::date) ->> 'error'), 'not_a_class_day');

select pg_temp.check('...and the message names real class days',
  ((public.report_absence(:emma::uuid, '2027-09-15'::date) ->> 'message')
    like '%class days%')::text, 'true');

-- =============================================================================
-- THE BOUNDARY: a parent cannot speak for someone else's child
-- =============================================================================
select pg_temp.check('a parent cannot report for another family''s child',
  (public.report_absence(:billy::uuid, :d1::date) ->> 'error'), 'not_your_child');

select pg_temp.check('...and nothing was written',
  (select count(*)::text from public.absences where child_id = :billy::uuid), '0');

-- =============================================================================
-- Reading is scoped too
-- =============================================================================
select set_config('role', 'postgres', false);
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select public.report_absence(:billy::uuid, :d1::date, true, '{}', 'Family holiday');

-- Capture the id while still privileged. Asking Mary to look it up would test
-- nothing: she cannot see the row, so the lookup returns null and the function
-- answers "not found" — which is the boundary working, but not the boundary
-- being tested. Handing her the id proves it refuses even when she knows it.
select id as billy_absence from public.absences where child_id = :billy::uuid \gset

select pg_temp.be(:u_mary, 'mary@example.org');
select pg_temp.check('a parent sees only their own children''s absences',
  (select count(*)::text from public.absences where child_id <> :emma::uuid), '0');

select pg_temp.check('...and cannot cancel another family''s, even knowing its id',
  (public.cancel_absence(:'billy_absence'::uuid) ->> 'error'), 'not_your_child');

select set_config('role', 'postgres', false);
select pg_temp.check('...and that absence is still there',
  (select count(*)::text from public.absences where id = :'billy_absence'::uuid), '1');

-- =============================================================================
-- Cancelling your own
-- =============================================================================
select pg_temp.check('a parent can withdraw their own',
  (public.cancel_absence(
     (select id from public.absences where child_id = :emma::uuid
       and meeting_id = (select id from meeting_dates where meets_on = :d1::date))) ->> 'ok'), 'true');

select pg_temp.check('...and it is gone',
  (select count(*)::text from public.absences
    where child_id = :emma::uuid and meeting_id = (select id from meeting_dates where meets_on = :d1::date)), '0');

-- =============================================================================
-- The administrator's view
-- =============================================================================
select set_config('role', 'postgres', false);
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select pg_temp.check('the report lists absences',
  (select jsonb_array_length(public.absence_report(:sem::uuid))::text), '2');

select pg_temp.check('...naming the child',
  (select r ->> 'child_name' from
     jsonb_array_elements(public.absence_report(:sem::uuid)) r
    where r ->> 'child_name' like 'Billy%'), 'Billy Smith');

select pg_temp.check('...and the reason',
  (select r ->> 'reason' from
     jsonb_array_elements(public.absence_report(:sem::uuid)) r
    where r ->> 'child_name' like 'Billy%'), 'Family holiday');

-- A registered child's classes come along, so a teacher can be told.
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select public.admin_place_child(:emma::uuid, '31111111-1111-1111-1111-111111111111'::uuid);
select public.report_absence(:emma::uuid, :d1::date);

select pg_temp.check('a whole-day absence lists the classes being missed',
  (select jsonb_array_length(r -> 'classes')::text from
     jsonb_array_elements(public.absence_report(:sem::uuid)) r
    where r ->> 'child_name' like 'Emma%' and r ->> 'date' = :d1), '1');

-- A partial absence lists only the affected class.
select public.report_absence(:emma::uuid, :d1::date, false, array[:p2::uuid]);
select pg_temp.check('a partial absence lists only the affected classes',
  (select jsonb_array_length(r -> 'classes')::text from
     jsonb_array_elements(public.absence_report(:sem::uuid)) r
    where r ->> 'child_name' like 'Emma%' and r ->> 'date' = :d1), '0');

-- =============================================================================
-- Authorisation
-- =============================================================================
select set_config('test.jwt', '{"email":"stranger@gmail.com"}', false);
select set_config('test.uid', '', false);

do $$
begin
  begin
    perform public.absence_report('11111111-1111-1111-1111-111111111111');
    raise warning 'FAIL  a non-admin could read the absence report';
  exception when others then
    raise notice 'PASS  a non-admin cannot read the absence report';
  end;
end;
$$;

select set_config('role', 'postgres', false);
