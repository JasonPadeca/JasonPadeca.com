-- =============================================================================
-- Adult helpers: parents working in classes.
--
-- Three things worth holding down. A parent can only speak for their own
-- family. A class cannot be given more helpers than somebody asked for. And a
-- person cannot be in two rooms at the same hour.
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
\set u_mary  '''00000000-0000-0000-0000-0000000000f1'''
\set u_becca '''00000000-0000-0000-0000-0000000000f2'''

insert into auth.users (id) values (:u_mary::uuid), (:u_becca::uuid) on conflict do nothing;
insert into public.family_users (auth_user_id, family_id, email) values
  (:u_mary::uuid, :johnson::uuid, 'mary@example.com'),
  (:u_becca::uuid, :smith::uuid, 'rebecca@example.com') on conflict do nothing;

select id as mary from public.parents where first_name = 'Mary' \gset
select id as becca from public.parents where first_name = 'Rebecca' \gset
select id as art  from public.classes where name = 'Art' \gset
select id as chem from public.classes where name = 'Beginning Chemistry' \gset
select id as choir from public.classes where name = 'Choir' \gset

-- =============================================================================
-- A parent says what they would do
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.com');

select pg_temp.check('the form offers every class, grouped by period',
  (jsonb_array_length(public.helper_form(:sem::uuid) -> 'periods') > 0)::text,
  'true');

select pg_temp.check('submitting is accepted',
  public.submit_helper_interest(jsonb_build_object(
    'parent_id', :'mary', 'semester_id', :sem,
    'class_ids', jsonb_build_array(:'art', :'choir'),
    'note', 'Mornings are easier')) ->> 'ok',
  'true');

reset role;
select pg_temp.check('both classes are recorded',
  (select count(*)::text from public.helper_interest
    where parent_id = :'mary'::uuid and semester_id = :sem::uuid),
  '2');

select pg_temp.check('and the note with them',
  (select note from public.helper_note
    where parent_id = :'mary'::uuid and semester_id = :sem::uuid),
  'Mornings are easier');

-- Sending again replaces rather than accumulates: the page shows every class
-- with a tick box, so what arrives IS the whole answer.
select pg_temp.be(:u_mary, 'mary@example.com');
select public.submit_helper_interest(jsonb_build_object(
  'parent_id', :'mary', 'semester_id', :sem,
  'class_ids', jsonb_build_array(:'art')));
reset role;

select pg_temp.check('sending again replaces the previous answer',
  (select count(*)::text from public.helper_interest
    where parent_id = :'mary'::uuid and semester_id = :sem::uuid),
  '1');

-- --- the boundary ------------------------------------------------------------
select pg_temp.be(:u_becca, 'rebecca@example.com');

select pg_temp.check('a parent cannot answer for another family''s parent',
  public.submit_helper_interest(jsonb_build_object(
    'parent_id', :'mary', 'semester_id', :sem,
    'class_ids', jsonb_build_array(:'chem'))) ->> 'error',
  'not_your_family');

reset role;
select pg_temp.check('...and nothing of Mary''s changed',
  (select count(*)::text from public.helper_interest
    where parent_id = :'mary'::uuid and semester_id = :sem::uuid),
  '1');

-- =============================================================================
-- Placing them
-- =============================================================================
set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select pg_temp.check('an administrator places a parent',
  public.assign_adult_helper(:'mary'::uuid, :'art'::uuid) ->> 'ok', 'true');

-- Art and Chemistry share a period in the seed. Choosing the second is a
-- correction, not a second job.
select public.assign_adult_helper(:'mary'::uuid, :'chem'::uuid);

reset role;
select pg_temp.check('a second class in the same period replaces the first',
  (select string_agg(c.name, ',') from public.class_adult_helpers ah
     join public.classes c on c.id = ah.class_id
    where ah.parent_id = :'mary'::uuid),
  'Beginning Chemistry');

-- --- the limit ---------------------------------------------------------------
update public.classes set adult_helper_limit = 1 where id = :'choir'::uuid;

set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select public.assign_adult_helper(:'mary'::uuid, :'choir'::uuid);

select pg_temp.check('a class refuses more helpers than it wants',
  public.assign_adult_helper(:'becca'::uuid, :'choir'::uuid) ->> 'error',
  'class_full');

select pg_temp.check('...and says what the limit is, so it can be raised',
  public.assign_adult_helper(:'becca'::uuid, :'choir'::uuid) ->> 'wanted',
  '1');

-- --- the board ---------------------------------------------------------------
select pg_temp.check('the board lists every parent, not only those who replied',
  jsonb_array_length(public.helper_board(:sem::uuid) -> 'parents')::text,
  (select count(*)::text from public.parents p
     join public.families f on f.id = p.family_id where f.archived_at is null));

select pg_temp.check('it reports the target that turns a rectangle green',
  public.helper_board(:sem::uuid) ->> 'target', '2');

select pg_temp.check('the reference pane counts helpers per class',
  (select x ->> 'helpers_have' from
     jsonb_array_elements(public.helper_board(:sem::uuid) -> 'classes') x
    where x ->> 'name' = 'Choir'),
  '1');

select pg_temp.check('and student places alongside them',
  (select (x ? 'students_taken')::text from
     jsonb_array_elements(public.helper_board(:sem::uuid) -> 'classes') x
    where x ->> 'name' = 'Choir'),
  'true');

-- --- removal -----------------------------------------------------------------
select public.remove_adult_helper(:'mary'::uuid,
  (select period_id from public.classes where id = :'choir'::uuid));

select pg_temp.check('removing frees the place',
  (select x ->> 'helpers_have' from
     jsonb_array_elements(public.helper_board(:sem::uuid) -> 'classes') x
    where x ->> 'name' = 'Choir'),
  '0');

-- --- who may do any of this --------------------------------------------------
create or replace function pg_temp.refused(a uuid, b uuid)
returns text language plpgsql as $$
begin
  perform public.assign_adult_helper(a, b);
  return 'allowed through';
exception when others then return 'refused';
end;
$$;

select pg_temp.be(:u_mary, 'mary@example.com');
select pg_temp.check('a parent cannot place anybody',
  pg_temp.refused(:'mary'::uuid, :'art'::uuid), 'refused');

reset role;

\echo 'SUITE-REACHED-THE-END'
