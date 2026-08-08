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

-- Two households, and a stranger.
\set johnson '''41111111-1111-1111-1111-111111111111'''
\set smith   '''42222222-2222-2222-2222-222222222222'''

\set u_mary    '''00000000-0000-0000-0000-00000000aa01'''
\set u_becca   '''00000000-0000-0000-0000-00000000aa02'''
\set u_nobody  '''00000000-0000-0000-0000-00000000aa03'''
\set u_owner   '''00000000-0000-0000-0000-00000000aa04'''

insert into auth.users (id) values
  (:u_mary::uuid), (:u_becca::uuid), (:u_nobody::uuid), (:u_owner::uuid)
on conflict do nothing;

-- Mary is on the Johnson family record; Rebecca only on a Smith parent row,
-- which is the case that would break if only primary_email were checked.
update public.families set primary_email = 'mary@example.org' where id = :johnson::uuid;
update public.families set primary_email = 'household@smith.example' where id = :smith::uuid;
update public.parents  set email = 'becca@example.org'
 where family_id = :smith::uuid
   and id = (select id from public.parents where family_id = :smith::uuid order by sort_order limit 1);

create or replace function pg_temp.be(uid text, email text)
returns void language sql as $$
  select set_config('test.uid', uid, false),
         set_config('test.jwt', json_build_object('email', email)::text, false);
  select set_config('role', 'authenticated', false);
$$;

-- =============================================================================
-- Claiming membership
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.org');
select pg_temp.check('Mary is recognised via the family email',
  (public.establish_session() ->> 'recognised'), 'true');
select pg_temp.check('...and is linked to exactly one family',
  jsonb_array_length(public.establish_session() -> 'families')::text, '1');
select pg_temp.check('...the Johnson family',
  (public.establish_session() -> 'families' -> 0 ->> 'display_name'), 'Johnson Family');
select pg_temp.check('...and is not an administrator',
  (public.establish_session() ->> 'is_admin'), 'false');

select pg_temp.be(:u_becca, 'becca@example.org');
select pg_temp.check('Rebecca is recognised via a PARENT email',
  (public.establish_session() -> 'families' -> 0 ->> 'display_name'), 'Smith Family');

select pg_temp.be(:u_nobody, 'stranger@nowhere.example');
select pg_temp.check('an unknown address is not recognised',
  (public.establish_session() ->> 'recognised'), 'false');
select pg_temp.check('...and gets no families',
  jsonb_array_length(public.establish_session() -> 'families')::text, '0');

select pg_temp.be(:u_mary, 'mary@example.org');
select public.establish_session();
select public.establish_session();
select pg_temp.check('claiming twice does not duplicate the link',
  (select count(*)::text from public.family_users), '1');

-- =============================================================================
-- THE BOUNDARY. Everything below is a leak if it fails.
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.org');
select public.establish_session();

select pg_temp.check('Mary sees only her own family',
  (select count(*)::text from public.families), '1');

-- Three: Emma, Caleb, and an aged-out sibling. A family SHOULD see its own
-- inactive child — that is their record, and hiding it would make a historical
-- registration look like it belonged to nobody.
select pg_temp.check('Mary sees her own children, including the inactive one',
  (select count(*)::text from public.children), '3');

select pg_temp.check('...all of them Johnsons',
  (select count(*)::text from public.children where last_name <> 'Johnson'), '0');

select pg_temp.check('...and she sees none of the other 3 families'' children',
  (select count(*)::text from public.children
    where id in ('53333333-3333-3333-3333-333333333333',
                 '54444444-4444-4444-4444-444444444444',
                 '55555555-5555-5555-5555-555555555555')), '0');

select pg_temp.check('...and none of them are Smiths',
  (select count(*)::text from public.children where last_name = 'Smith'), '0');

select pg_temp.check('Mary cannot read another family''s birth dates',
  (select count(*)::text from public.children
    where id = '53333333-3333-3333-3333-333333333333'), '0');

select pg_temp.check('Mary sees only her own parents rows',
  (select count(*)::text from public.parents
    where family_id <> :johnson::uuid), '0');

select pg_temp.check('Mary sees only her own registrations',
  (select count(*)::text from public.registrations
    where child_id not in (select id from public.children)), '0');

select pg_temp.check('Mary cannot read the admins table',
  (select count(*)::text from public.admins), '0');

select pg_temp.check('Mary cannot read invitation tokens',
  (select count(*)::text from public.registration_invites), '0');

select pg_temp.check('Mary cannot read the audit log',
  (select count(*)::text from public.audit_log), '0');

select pg_temp.check('Mary cannot read another user''s membership row',
  (select count(*)::text from public.family_users
    where auth_user_id <> :u_mary::uuid), '0');

-- The catalogue is readable, because she needs it.
select pg_temp.check('Mary can read the class catalogue',
  (select case when count(*) > 0 then 'yes' else 'no' end from public.classes), 'yes');

-- =============================================================================
-- Another family's registration stays invisible even once it exists.
--
-- Seat counts are NOT checked here: class_seats stays admin-only for now. See
-- the note at the foot of 0012 for why opening it is a trap in both directions.
-- =============================================================================
select set_config('role', 'postgres', false);
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select public.admin_place_child('53333333-3333-3333-3333-333333333333'::uuid,
                                '31111111-1111-1111-1111-111111111111'::uuid);

select pg_temp.be(:u_mary, 'mary@example.org');
select pg_temp.check('a Smith registration is invisible to Mary',
  (select count(*)::text from public.registrations
    where child_id = '53333333-3333-3333-3333-333333333333'), '0');

do $$
begin
  begin
    perform count(*) from public.class_seats;
    raise warning 'FAIL  Mary could read the class_seats view directly';
  exception when others then
    raise notice 'PASS  Mary cannot read the class_seats view directly';
  end;
end;
$$;

-- But she CAN get correct counts through the gated function, and the count
-- includes the Smith registration she is not allowed to see individually.
-- That combination is the whole point.
select pg_temp.check('the gated function gives Mary TRUE counts',
  (select registered_count::text from public.class_seat_counts()
    where class_id = '31111111-1111-1111-1111-111111111111'), '1');

select pg_temp.be(:u_nobody, 'stranger@nowhere.example');
select pg_temp.check('a signed-in stranger gets no counts from the function',
  (select count(*)::text from public.class_seat_counts()), '0');

-- =============================================================================
-- Families get SELECT and nothing else.
-- =============================================================================
do $$
begin
  begin
    update public.children set first_name = 'Hacked'
     where family_id = '41111111-1111-1111-1111-111111111111';
    if found then
      raise warning 'FAIL  a family could UPDATE its own child directly';
    else
      raise notice 'PASS  a family cannot UPDATE even its own child directly';
    end if;
  exception when insufficient_privilege or others then
    raise notice 'PASS  a family cannot UPDATE even its own child directly';
  end;
end;
$$;

do $$
begin
  begin
    delete from public.registrations;
    if found then
      raise warning 'FAIL  a family could DELETE registrations';
    else
      raise notice 'PASS  a family cannot DELETE registrations';
    end if;
  exception when insufficient_privilege or others then
    raise notice 'PASS  a family cannot DELETE registrations';
  end;
end;
$$;

do $$
begin
  begin
    insert into public.family_users (auth_user_id, family_id, email)
    values ('00000000-0000-0000-0000-00000000aa01',
            '42222222-2222-2222-2222-222222222222', 'mary@example.org');
    raise warning 'FAIL  a family could grant itself another household';
  exception when others then
    raise notice 'PASS  a family cannot grant itself another household';
  end;
end;
$$;

-- =============================================================================
-- An administrator who is also a parent gets both, not one or the other.
-- =============================================================================
select set_config('role', 'postgres', false);
update public.admins set email = 'mary@example.org' where role = 'owner';

select pg_temp.be(:u_mary, 'mary@example.org');
select pg_temp.check('Mary is now recognised as an administrator too',
  (public.establish_session() ->> 'is_admin'), 'true');
select pg_temp.check('...and still as a family',
  jsonb_array_length(public.establish_session() -> 'families')::text, '1');
select pg_temp.check('...and the admin policy widens what she sees',
  (select case when count(*) > 1 then 'all families' else 'only her own' end
     from public.families), 'all families');

select set_config('role', 'postgres', false);
