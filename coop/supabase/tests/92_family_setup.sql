-- =============================================================================
-- Family setup: a family editing its own record.
--
-- Parents can now write to tables they previously only read, which makes one
-- question worth most of this file: can a family edit somebody else's people.
-- The page only ever shows their own — but "the page only shows it" is a habit,
-- not a boundary, and a crafted payload does not go through the page.
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

\set johnson  '''41111111-1111-1111-1111-111111111111'''
\set smith    '''42222222-2222-2222-2222-222222222222'''
\set emma     '''51111111-1111-1111-1111-111111111111'''
\set billy    '''53333333-3333-3333-3333-333333333333'''

\set u_mary   '''00000000-0000-0000-0000-0000000000c1'''
\set u_becca  '''00000000-0000-0000-0000-0000000000c2'''

insert into auth.users (id) values (:u_mary::uuid), (:u_becca::uuid)
on conflict do nothing;

insert into public.family_users (auth_user_id, family_id, email) values
  (:u_mary::uuid,  :johnson::uuid, 'mary@example.com'),
  (:u_becca::uuid, :smith::uuid,   'rebecca@example.com')
on conflict do nothing;

select id as mary_parent from public.parents
 where family_id = :johnson::uuid and first_name = 'Mary' \gset

-- =============================================================================
-- A family sees itself, and only itself
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.com');

select pg_temp.check('the page shows the family',
  (public.family_setup() -> 'families' -> 0 ->> 'display_name' is not null)::text,
  'true');

select pg_temp.check('and exactly one family, not the whole co-op',
  jsonb_array_length(public.family_setup() -> 'families')::text,
  '1');

select pg_temp.check('with the children on it',
  (jsonb_array_length(public.family_setup() -> 'families' -> 0 -> 'children') > 0)::text,
  'true');

-- The registrar's private notes are not a family's to read. They are not in the
-- payload at all, so there is nothing to accidentally render.
select pg_temp.check('the registrar''s own notes are not exposed',
  case when (public.family_setup() -> 'families' -> 0 -> 'children' -> 0)
            -> 'notes' is null then 'absent' else 'EXPOSED' end,
  'absent');

-- =============================================================================
-- Editing what is theirs
-- =============================================================================
select pg_temp.check('a family can update its own child',
  public.update_family_setup(jsonb_build_object(
    'family_id', :johnson,
    'children', jsonb_build_array(jsonb_build_object(
      'id', :emma, 'first_name', 'Emma', 'allergies', 'Peanuts',
      'phone', '602-555-0199'))
  )) ->> 'ok',
  'true');

select pg_temp.check('the allergy is stored',
  (select allergies from public.children where id = :emma::uuid),
  'Peanuts');

select pg_temp.check('and the phone number',
  (select phone from public.children where id = :emma::uuid),
  '602-555-0199');

select pg_temp.check('a family can add a child',
  (public.update_family_setup(jsonb_build_object(
    'family_id', :johnson,
    'children', jsonb_build_array(jsonb_build_object(
      'first_name', 'Baby', 'last_name', 'Johnson', 'birth_date', '2021-04-01'))
  )) ->> 'added'),
  '1');

select pg_temp.check('the new child belongs to the right family',
  (select family_id::text from public.children
    where first_name = 'Baby' and last_name = 'Johnson'),
  :johnson);

select pg_temp.check('a family can update its own parent',
  (select 'ok' from (select public.update_family_setup(jsonb_build_object(
     'family_id', :johnson,
     'parents', jsonb_build_array(jsonb_build_object(
       'id', :'mary_parent', 'first_name', 'Mary', 'phone', '602-555-0100'))
   ))) t),
  'ok');

select pg_temp.check('the parent phone is stored',
  (select phone from public.parents where id = :'mary_parent'::uuid),
  '602-555-0100');

-- =============================================================================
-- The boundary
--
-- Everything below is a payload the page cannot produce. Each one has to fail
-- quietly and change nothing.
-- =============================================================================
select pg_temp.be(:u_becca, 'rebecca@example.com');

select pg_temp.check('a family cannot claim another family''s id',
  public.update_family_setup(jsonb_build_object(
    'family_id', :johnson,
    'children', jsonb_build_array(jsonb_build_object('id', :emma, 'allergies', 'FORGED'))
  )) ->> 'error',
  'not_your_family');

-- Read as superuser: RLS hides Emma from Becca, and "hidden" and "unchanged"
-- both come back NULL. Only one of those means the boundary held.
reset role;
select pg_temp.check('...and nothing was written',
  (select allergies from public.children where id = :emma::uuid),
  'Peanuts');
select pg_temp.be(:u_becca, 'rebecca@example.com');

-- The subtler attack: a legitimate family_id, with somebody else's child
-- smuggled into the list.
select pg_temp.check('a child from another family, sent under a valid family id, is ignored',
  public.update_family_setup(jsonb_build_object(
    'family_id', :smith,
    'children', jsonb_build_array(
      jsonb_build_object('id', :billy, 'allergies', 'Bees'),
      jsonb_build_object('id', :emma,  'allergies', 'FORGED'))
  )) ->> 'ok',
  'true');

reset role;
select pg_temp.check('...their own child was updated',
  (select allergies from public.children where id = :billy::uuid),
  'Bees');

select pg_temp.check('...and the other family''s child was not',
  (select allergies from public.children where id = :emma::uuid),
  'Peanuts');
select pg_temp.be(:u_becca, 'rebecca@example.com');

-- Same again for parents.
select public.update_family_setup(jsonb_build_object(
  'family_id', :smith,
  'parents', jsonb_build_array(jsonb_build_object(
    'id', :'mary_parent', 'first_name', 'FORGED', 'phone', '000'))
));

reset role;
select pg_temp.check('another family''s parent cannot be rewritten',
  (select first_name from public.parents where id = :'mary_parent'::uuid),
  'Mary');

select pg_temp.check('nor their phone number',
  (select phone from public.parents where id = :'mary_parent'::uuid),
  '602-555-0100');
select pg_temp.be(:u_becca, 'rebecca@example.com');

-- A child added under a stolen family_id would be the worst outcome: a real row
-- in somebody else's family.
select public.update_family_setup(jsonb_build_object(
  'family_id', :smith,
  'children', jsonb_build_array(jsonb_build_object(
    'first_name', 'Intruder', 'birth_date', '2015-01-01'))
));

reset role;
select pg_temp.check('a child added lands in the caller''s family, never elsewhere',
  (select family_id::text from public.children where first_name = 'Intruder'),
  :smith);

-- =============================================================================
-- Birth dates are audited
--
-- Allowed, deliberately — the parents are the only people who know. But a birth
-- date decides which classes a child may join, so a change leaves a trail with
-- both values rather than vanishing into a count.
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.com');

select public.update_family_setup(jsonb_build_object(
  'family_id', :johnson,
  'children', jsonb_build_array(jsonb_build_object(
    'id', :emma, 'birth_date', '2016-03-12'))
));

reset role;
select pg_temp.check('a birth date change is recorded on its own',
  (select count(*)::text from public.audit_log
    where action = 'child_birth_date_changed' and entity_id = :emma::uuid),
  '1');

select pg_temp.check('...with the value it moved from',
  (select details ->> 'from' from public.audit_log
    where action = 'child_birth_date_changed' and entity_id = :emma::uuid),
  '2015-03-12');

-- =============================================================================
-- Nobody signed in
-- =============================================================================
select set_config('test.uid', '', false);
select set_config('test.jwt', '{}', false);

select pg_temp.check('a stranger gets nothing',
  public.family_setup() ->> 'error',
  'no_family');

select pg_temp.check('and can write nothing',
  public.update_family_setup(jsonb_build_object('family_id', :johnson)) ->> 'error',
  'no_family');

reset role;
