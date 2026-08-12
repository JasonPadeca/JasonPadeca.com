-- =============================================================================
-- Volunteering, as a family sees it.
--
-- The offer is made during class sign-up and the placement is made by an
-- administrator; this reader is the only way a family learns either. So the
-- questions are: does it show a family its own children, does it show where
-- they were actually placed, and does it show anybody else's.
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

\set sem     '''11111111-1111-1111-1111-111111111111'''
\set johnson '''41111111-1111-1111-1111-111111111111'''
\set smith   '''42222222-2222-2222-2222-222222222222'''
\set emma    '''51111111-1111-1111-1111-111111111111'''
\set u_mary  '''00000000-0000-0000-0000-0000000000e1'''
\set u_becca '''00000000-0000-0000-0000-0000000000e2'''

insert into auth.users (id) values (:u_mary::uuid), (:u_becca::uuid) on conflict do nothing;
insert into public.family_users (auth_user_id, family_id, email) values
  (:u_mary::uuid, :johnson::uuid, 'mary@example.com'),
  (:u_becca::uuid, :smith::uuid, 'rebecca@example.com') on conflict do nothing;

-- Emma offers to help.
reset role;
insert into public.volunteer_interest (child_id, semester_id, wants_to_volunteer, note)
values (:emma::uuid, :sem::uuid, true, 'Good with the little ones')
on conflict (child_id, semester_id) do update
  set wants_to_volunteer = true, note = 'Good with the little ones';

select pg_temp.be(:u_mary, 'mary@example.com');

select pg_temp.check('a family sees its own children',
  (jsonb_array_length(public.family_volunteering(:sem::uuid) -> 'children') > 0)::text,
  'true');

select pg_temp.check('and that Emma offered',
  (select c ->> 'offered' from
     jsonb_array_elements(public.family_volunteering(:sem::uuid) -> 'children') c
    where c ->> 'child_id' = :emma),
  'true');

select pg_temp.check('with the note she left',
  (select c ->> 'note' from
     jsonb_array_elements(public.family_volunteering(:sem::uuid) -> 'children') c
    where c ->> 'child_id' = :emma),
  'Good with the little ones');

select pg_temp.check('and nowhere placed yet',
  (select jsonb_array_length(c -> 'assigned_to')::text from
     jsonb_array_elements(public.family_volunteering(:sem::uuid) -> 'children') c
    where c ->> 'child_id' = :emma),
  '0');

-- An administrator places her. This is the fact a family had no way of learning.
reset role;
insert into public.class_volunteers (child_id, class_id, period_id, semester_id)
select :emma::uuid, id, period_id, semester_id
  from public.classes where semester_id = :sem::uuid limit 1
on conflict do nothing;

select pg_temp.be(:u_mary, 'mary@example.com');

select pg_temp.check('once placed, the family can see where',
  (select jsonb_array_length(c -> 'assigned_to')::text from
     jsonb_array_elements(public.family_volunteering(:sem::uuid) -> 'children') c
    where c ->> 'child_id' = :emma),
  '1');

select pg_temp.check('...naming the class',
  (select (c -> 'assigned_to' -> 0 ->> 'class') is not null from
     jsonb_array_elements(public.family_volunteering(:sem::uuid) -> 'children') c
    where c ->> 'child_id' = :emma)::text,
  'true');

-- The boundary.
select pg_temp.be(:u_becca, 'rebecca@example.com');

select pg_temp.check('another family does not see Emma at all',
  (select count(*)::text from
     jsonb_array_elements(public.family_volunteering(:sem::uuid) -> 'children') c
    where c ->> 'child_id' = :emma),
  '0');

-- Nobody signed in.
select set_config('test.uid', '', false);
select set_config('test.jwt', '{}', false);

select pg_temp.check('a stranger sees no children',
  jsonb_array_length(public.family_volunteering(:sem::uuid) -> 'children')::text,
  '0');

reset role;

\echo 'SUITE-REACHED-THE-END'
