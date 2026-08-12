-- =============================================================================
-- Archiving a family.
--
-- The point of this file is one distinction: a family that leaves must come off
-- everything CURRENT, and must stay on everything PAST. A freed seat matters
-- because somebody is waiting for it; a past roster matters because somebody
-- will ask next year who was in that class, and the answer must not depend on
-- whether the family stayed in the co-op.
-- =============================================================================

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

\set sem     '''11111111-1111-1111-1111-111111111111'''
\set past    '''99999999-9999-9999-9999-999999999999'''
\set johnson '''41111111-1111-1111-1111-111111111111'''
\set emma    '''51111111-1111-1111-1111-111111111111'''
\set caleb   '''52222222-2222-2222-2222-222222222222'''
\set carol   '''54444444-4444-4444-4444-444444444444'''

-- A semester that is over and archived.
insert into public.semesters (id, name, status, archived_at, class_start_date)
values (:past::uuid, 'Spring 2026', 'archived', now(), '2026-01-15');
insert into public.periods (id, semester_id, period_number, display_name, start_time, end_time)
values ('99999999-0000-0000-0000-000000000001', :past::uuid, 1, 'First', '09:00', '10:00');
insert into public.classes (id, period_id, semester_id, option_number, name, capacity)
values ('99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-000000000001',
        :past::uuid, 1, 'Last Term Pottery', 10);
insert into public.registrations (child_id, class_id, semester_id, status)
values (:emma::uuid, '99999999-0000-0000-0000-000000000002', :past::uuid, 'registered');

-- ...and everything they are tangled in now.
insert into public.registrations (child_id, class_id, semester_id, status)
select :emma::uuid, id, semester_id, 'registered'
  from public.classes where semester_id = :sem::uuid limit 1;

insert into public.class_volunteers (child_id, class_id, period_id, semester_id)
select :caleb::uuid, id, period_id, semester_id
  from public.classes where semester_id = :sem::uuid limit 1;

insert into public.volunteer_interest (child_id, semester_id, wants_to_volunteer)
values (:caleb::uuid, :sem::uuid, true) on conflict (child_id, semester_id)
do update set wants_to_volunteer = true;

-- Somebody waiting for the seat Emma is about to vacate.
insert into public.registrations (child_id, class_id, semester_id, status, waitlisted_at)
select :carol::uuid, class_id, semester_id, 'waitlisted', now()
  from public.registrations
 where child_id = :emma::uuid and semester_id = :sem::uuid limit 1;

set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select public.archive_family(:johnson::uuid, 'Moved away') as r \gset
reset role;

-- =============================================================================
-- Out of everything current
-- =============================================================================
select pg_temp.check('the children are archived',
  (select count(*)::text from public.children
    where family_id = :johnson::uuid and active),
  '0');

select pg_temp.check('their live class places are gone',
  (select count(*)::text from public.registrations r
     join public.children c on c.id = r.child_id
     join public.semesters s on s.id = r.semester_id
    where c.family_id = :johnson::uuid and r.status = 'registered'
      and s.archived_at is null),
  '0');

select pg_temp.check('their volunteer assignments are gone',
  (select count(*)::text from public.class_volunteers cv
     join public.children c on c.id = cv.child_id
    where c.family_id = :johnson::uuid),
  '0');

select pg_temp.check('their offer to volunteer is withdrawn',
  (select coalesce(bool_or(wants_to_volunteer), false)::text
     from public.volunteer_interest vi
     join public.children c on c.id = vi.child_id
    where c.family_id = :johnson::uuid and vi.semester_id = :sem::uuid),
  'false');

select pg_temp.check('and the family reads as not attending',
  (select status from public.semester_registrations
    where family_id = :johnson::uuid and semester_id = :sem::uuid),
  'not_attending');

-- =============================================================================
-- Still on everything past
--
-- The assertion this file exists for. A first attempt at it silently proved
-- nothing, because the fixture building the past semester had failed and there
-- was no past registration to preserve — a count of zero looked like a pass.
-- =============================================================================
select pg_temp.check('LAST TERM''S place is untouched',
  (select count(*)::text from public.registrations r
     join public.semesters s on s.id = r.semester_id
    where r.child_id = :emma::uuid and s.archived_at is not null
      and r.status = 'registered'),
  '1');

select pg_temp.check('...and last term''s roster still names her',
  (select count(*)::text from public.registrations r
     join public.classes cl on cl.id = r.class_id
    where cl.name = 'Last Term Pottery' and r.status = 'registered'),
  '1');

-- =============================================================================
-- What it reports, and what it refuses to decide
-- =============================================================================
select pg_temp.check('it reports the seat it freed',
  ((:'r'::jsonb) ->> 'class_places_freed'),
  '1');

select pg_temp.check('it names a class somebody is waiting for',
  ((:'r'::jsonb) -> 'classes_with_room' -> 0 ->> 'waiting'),
  '1');

-- Promoting somebody is an email to a real family. The software reports the
-- room and leaves the decision alone.
select pg_temp.check('nobody was promoted off the waiting list',
  (select status from public.registrations where child_id = :carol::uuid),
  'waitlisted');

-- =============================================================================
-- Restoring
-- =============================================================================
set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select public.restore_family(:johnson::uuid);
reset role;

select pg_temp.check('the children come back',
  (select count(*)::text from public.children
    where family_id = :johnson::uuid and active),
  '3');

select pg_temp.check('the family is active again',
  (select (archived_at is null)::text from public.families where id = :johnson::uuid),
  'true');

-- Their seats went to somebody else in the meantime, or might have. Putting a
-- child back into a class silently would overrule a decision a person made.
select pg_temp.check('but their class places do NOT come back',
  (select count(*)::text from public.registrations r
     join public.children c on c.id = r.child_id
     join public.semesters s on s.id = r.semester_id
    where c.family_id = :johnson::uuid and r.status = 'registered'
      and s.archived_at is null),
  '0');

\echo 'SUITE-REACHED-THE-END'
