-- =============================================================================
-- Family registration, and class proposals.
--
-- The interesting boundary here is the proposer. The browser sends "this
-- proposal is from Emma", chosen from a dropdown, and a dropdown is a
-- suggestion rather than a credential — so the tests below spend most of their
-- effort on one question: can a family put somebody else's name on a proposal.
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

create or replace function pg_temp.be(uid text, email text)
returns void language sql as $$
  select set_config('test.uid', uid, false),
         set_config('test.jwt', json_build_object('email', email)::text, false);
  select set_config('role', 'authenticated', false);
$$;

\set sem      '''11111111-1111-1111-1111-111111111111'''
\set johnson  '''41111111-1111-1111-1111-111111111111'''
\set smith    '''42222222-2222-2222-2222-222222222222'''
\set emma     '''51111111-1111-1111-1111-111111111111'''
\set billy    '''53333333-3333-3333-3333-333333333333'''

\set u_mary   '''00000000-0000-0000-0000-0000000000a1'''
\set u_becca  '''00000000-0000-0000-0000-0000000000a2'''
\set u_none   '''00000000-0000-0000-0000-0000000000a3'''

insert into auth.users (id) values (:u_mary::uuid), (:u_becca::uuid), (:u_none::uuid)
on conflict do nothing;

insert into public.family_users (auth_user_id, family_id, email) values
  (:u_mary::uuid,  :johnson::uuid, 'mary@example.com'),
  (:u_becca::uuid, :smith::uuid,   'rebecca@example.com');

select id as mary_parent from public.parents
 where family_id = :johnson::uuid and first_name = 'Mary' \gset
select id as becca_parent from public.parents
 where family_id = :smith::uuid and first_name = 'Rebecca' \gset

-- =============================================================================
-- Registration
-- =============================================================================
set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

-- Nobody has been marked yet, so everybody reads as not started. A family that
-- has not been heard from must still appear — that is the whole question the
-- registrar is asking.
select pg_temp.check('every family appears before anybody is marked',
  (select count(*)::text from public.semester_registration_report(:sem::uuid)), '4');

select pg_temp.check('...and they all read as not started',
  (select count(*)::text from public.semester_registration_report(:sem::uuid)
    where status = 'not_started'), '4');

select pg_temp.check('admin can mark a family registered',
  (public.set_family_registration(:johnson::uuid, :sem::uuid, 'registered', 'Paid in August'))->>'ok',
  'true');

select pg_temp.check('the status is reported back',
  (select status from public.semester_registration_report(:sem::uuid)
    where family_id = :johnson::uuid), 'registered');

select pg_temp.check('the note comes with it',
  (select note from public.semester_registration_report(:sem::uuid)
    where family_id = :johnson::uuid), 'Paid in August');

-- Setting it twice must move the family, not add a second row. Otherwise a
-- registrar correcting a mistake creates a contradiction.
select public.set_family_registration(:johnson::uuid, :sem::uuid, 'not_attending', 'Moving away');
select pg_temp.check('changing it updates rather than duplicating',
  (select count(*)::text from public.semester_registrations
    where family_id = :johnson::uuid and semester_id = :sem::uuid), '1');
select pg_temp.check('...and holds the new status',
  (select status from public.semester_registrations
    where family_id = :johnson::uuid and semester_id = :sem::uuid), 'not_attending');

select pg_temp.check('a nonsense status is refused',
  (public.set_family_registration(:smith::uuid, :sem::uuid, 'maybe'))->>'error', 'bad_status');

reset role;

-- A family sees its own standing and no one else's.
select pg_temp.be(:u_becca, 'rebecca@example.com');
do $$
begin
  perform public.set_family_registration(
    '42222222-2222-2222-2222-222222222222'::uuid,
    '11111111-1111-1111-1111-111111111111'::uuid, 'registered');
  raise warning 'FAIL  a parent cannot register their own family  (it ran)';
exception when others then
  raise notice 'PASS  a parent cannot register their own family (%)', sqlerrm;
end $$;

select pg_temp.be(:u_mary, 'mary@example.com');
select pg_temp.check('a family reads its own registration',
  (select count(*)::text from public.semester_registrations), '1');
select pg_temp.check('...and it is theirs',
  (select family_id::text from public.semester_registrations), :johnson);

select set_config('role', 'postgres', false);

-- =============================================================================
-- Proposals: the proposer must be your own
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.com');

select pg_temp.check('a parent can propose a class',
  (public.submit_class_proposal(jsonb_build_object(
     'parent_id', :'mary_parent',
     'semester_id', :sem,
     'title', 'Beginning Latin',
     'age_range', '9-12',
     'description', 'Roots, and enough grammar to be dangerous.',
     'homework', 'Light',
     'teacher_name', 'Mary Johnson',
     'contact_email', 'mary@example.com',
     'needs_helper', 'Yes',
     'prep_hour', 'It would be nice, but not necessary'
   )))->>'ok', 'true');

select pg_temp.check('...filed as a parent proposal',
  (select kind from public.class_proposals where title = 'Beginning Latin'), 'parent');

select pg_temp.check('a student can propose a class',
  (public.submit_class_proposal(jsonb_build_object(
     'child_id', :emma,
     'title', 'Rocketry',
     'age_range', '12+',
     'description', 'Model rockets, and the maths to aim them.',
     'homework', 'None',
     'other_students', 'Billy Smith, Carol Brown',
     'parent_email', 'mary@example.com'
   )))->>'ok', 'true');

select pg_temp.check('...filed as a student proposal',
  (select kind from public.class_proposals where title = 'Rocketry'), 'student');

-- The point of the whole exercise.
select pg_temp.check('a parent cannot propose as another family''s parent',
  (public.submit_class_proposal(jsonb_build_object(
     'parent_id', :'becca_parent', 'title', 'Forgery', 'age_range', '12+',
     'description', 'x', 'homework', 'None')))->>'error',
  'not_your_family');

select pg_temp.check('a parent cannot propose as another family''s child',
  (public.submit_class_proposal(jsonb_build_object(
     'child_id', :billy, 'title', 'Forgery II', 'age_range', '12+',
     'description', 'x', 'homework', 'None')))->>'error',
  'not_your_family');

select pg_temp.check('...and neither forgery was stored',
  (select count(*)::text from public.class_proposals where title like 'Forgery%'), '0');

select pg_temp.check('a proposal with no proposer is refused',
  (public.submit_class_proposal(jsonb_build_object(
     'title', 'Nobody''s idea', 'age_range', '12+',
     'description', 'x', 'homework', 'None')))->>'error',
  'no_proposer');

select pg_temp.check('a proposal with no title is refused',
  (public.submit_class_proposal(jsonb_build_object(
     'parent_id', :'mary_parent', 'age_range', '12+',
     'description', 'x', 'homework', 'None')))->>'error',
  'title_required');

-- A family reads its own proposals, and only its own.
select pg_temp.check('a family sees its own proposals',
  (select count(*)::text from public.class_proposals), '2');

select pg_temp.be(:u_becca, 'rebecca@example.com');
select pg_temp.check('another family sees none of them',
  (select count(*)::text from public.class_proposals), '0');

-- The payload the proposal page draws itself from.
select pg_temp.be(:u_mary, 'mary@example.com');
select pg_temp.check('the payload offers this family''s parents',
  jsonb_array_length((public.family_proposal_payload())->'parents')::text, '2');
-- Two, not three: the Johnsons have an aged-out child in the seed, and somebody
-- who has left the co-op should not be offered as a person who might propose a
-- class for next term.
select pg_temp.check('the payload offers this family''s children, minus the aged-out one',
  jsonb_array_length((public.family_proposal_payload())->'children')::text, '2');
select pg_temp.check('the payload carries their own proposals',
  jsonb_array_length((public.family_proposal_payload())->'mine')::text, '2');
select pg_temp.check('the payload carries their registration standing',
  ((public.family_proposal_payload())->'registration'->0)->>'status', 'not_attending');

select set_config('role', 'postgres', false);

-- =============================================================================
-- Archiving
-- =============================================================================
set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select id as latin from public.class_proposals where title = 'Beginning Latin' \gset

select pg_temp.check('an administrator sees every proposal',
  (select count(*)::text from public.class_proposals), '2');

select pg_temp.check('a proposal can be archived as accepted',
  (public.archive_proposal(:'latin'::uuid, 'accepted', 'Running it in the spring'))->>'ok', 'true');

select pg_temp.check('...and reads as archived',
  (select status || '/' || outcome from public.class_proposals where id = :'latin'::uuid),
  'archived/accepted');

select pg_temp.check('a nonsense outcome is refused',
  (public.archive_proposal(:'latin'::uuid, 'maybe'))->>'error', 'bad_outcome');

select pg_temp.check('it can be reopened',
  (public.reopen_proposal(:'latin'::uuid))->>'ok', 'true');

select pg_temp.check('...and the outcome is cleared with it',
  (select status || '/' || coalesce(outcome, 'none') from public.class_proposals
    where id = :'latin'::uuid), 'submitted/none');

select pg_temp.check('archiving something that is not there says so',
  (public.archive_proposal('00000000-0000-0000-0000-0000000000ff'::uuid))->>'error', 'not_found');

reset role;

-- =============================================================================
-- The kind and the proposer cannot drift apart
-- =============================================================================
do $$
begin
  insert into public.class_proposals (kind, family_id, child_id, title, age_range, description, homework)
  values ('parent', '41111111-1111-1111-1111-111111111111',
          '51111111-1111-1111-1111-111111111111', 'Mislabelled', '12+', 'x', 'None');
  raise warning 'FAIL  a parent proposal cannot come from a child  (it inserted)';
exception when check_violation then
  raise notice 'PASS  a parent proposal cannot come from a child';
end $$;

do $$
begin
  insert into public.class_proposals (kind, family_id, parent_id, child_id, title, age_range, description, homework)
  select 'parent', '41111111-1111-1111-1111-111111111111', p.id,
         '51111111-1111-1111-1111-111111111111', 'Both', '12+', 'x', 'None'
    from public.parents p where p.family_id = '41111111-1111-1111-1111-111111111111' limit 1;
  raise warning 'FAIL  a proposal cannot name both a parent and a child  (it inserted)';
exception when check_violation then
  raise notice 'PASS  a proposal cannot name both a parent and a child';
end $$;

-- =============================================================================
-- Anonymous callers get nothing
-- =============================================================================
select pg_temp.check('anon holds no SELECT on proposals',
  has_table_privilege('anon', 'public.class_proposals', 'select')::text, 'false');
select pg_temp.check('anon holds no SELECT on registrations',
  has_table_privilege('anon', 'public.semester_registrations', 'select')::text, 'false');

set role anon;
do $$
begin
  perform public.submit_class_proposal('{}'::jsonb);
  raise warning 'FAIL  anon cannot submit a proposal  (it ran)';
exception when insufficient_privilege or others then
  raise notice 'PASS  anon cannot submit a proposal (%)', sqlerrm;
end $$;

do $$
begin
  perform public.semester_registration_report('11111111-1111-1111-1111-111111111111'::uuid);
  raise warning 'FAIL  anon cannot read the registration report  (it ran)';
exception when insufficient_privilege or others then
  raise notice 'PASS  anon cannot read the registration report (%)', sqlerrm;
end $$;
reset role;
