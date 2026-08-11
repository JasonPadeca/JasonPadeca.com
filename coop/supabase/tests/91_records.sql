-- =============================================================================
-- Records: what the co-op held, and whether it still holds it.
--
-- Parents can edit their children's dates of birth, which is right — they are
-- the only people who know. This file is about the other half of that: the
-- co-op keeping its own account of what it agreed to, taken by the database
-- rather than sent by the browser, and noticing when the two stop matching.
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
\set emma    '''51111111-1111-1111-1111-111111111111'''
\set u_mary  '''00000000-0000-0000-0000-0000000000d1'''

insert into auth.users (id) values (:u_mary::uuid) on conflict do nothing;
insert into public.family_users (auth_user_id, family_id, email)
values (:u_mary::uuid, :johnson::uuid, 'mary@example.com') on conflict do nothing;

update public.semesters
   set registration_form_opens_at  = now() - interval '1 day',
       registration_form_closes_at = now() + interval '30 days'
 where id = :sem::uuid;

-- =============================================================================
-- The snapshot is taken by the database, not sent by the browser
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.com');

select public.submit_registration_form(jsonb_build_object(
  'semester_id', :sem, 'agreed_conduct', true, 'comments', 'Away on the 12th'));

reset role;

select pg_temp.check('a snapshot is stored with the form',
  (select (form_data -> 'snapshot') is not null from public.semester_registrations
    where family_id = :johnson::uuid and semester_id = :sem::uuid)::text,
  'true');

select pg_temp.check('it records the children the co-op held',
  (select jsonb_array_length(form_data -> 'snapshot' -> 'children')::text
     from public.semester_registrations
    where family_id = :johnson::uuid and semester_id = :sem::uuid),
  (select count(*)::text from public.children
    where family_id = :johnson::uuid and active and archived_at is null));

select pg_temp.check('with Emma''s date of birth as it stood',
  (select snap ->> 'birth_date'
     from public.semester_registrations r,
          jsonb_array_elements(r.form_data -> 'snapshot' -> 'children') snap
    where r.family_id = :johnson::uuid and r.semester_id = :sem::uuid
      and (snap ->> 'id')::uuid = :emma::uuid),
  '2015-03-12');

-- The age is frozen, not recalculated. A record that recomputes tells you how
-- old she is today; this has to say how old the co-op believed she was.
select pg_temp.check('and her age at the start of the semester, frozen',
  (select (snap ->> 'age_at_start')
     from public.semester_registrations r,
          jsonb_array_elements(r.form_data -> 'snapshot' -> 'children') snap
    where r.family_id = :johnson::uuid and r.semester_id = :sem::uuid
      and (snap ->> 'id')::uuid = :emma::uuid),
  (select public.age_at('2015-03-12'::date, class_start_date)::text
     from public.semesters where id = :sem::uuid));

-- A browser claiming its own snapshot must not be believed.
select pg_temp.be(:u_mary, 'mary@example.com');
select public.submit_registration_form(jsonb_build_object(
  'semester_id', :sem, 'agreed_conduct', true,
  'snapshot', jsonb_build_object('children', jsonb_build_array(
    jsonb_build_object('id', :emma, 'birth_date', '2009-01-01')))));
reset role;

select pg_temp.check('a snapshot sent by the browser is overwritten, not trusted',
  (select snap ->> 'birth_date'
     from public.semester_registrations r,
          jsonb_array_elements(r.form_data -> 'snapshot' -> 'children') snap
    where r.family_id = :johnson::uuid and r.semester_id = :sem::uuid
      and (snap ->> 'id')::uuid = :emma::uuid),
  '2015-03-12');

-- =============================================================================
-- Drift
-- =============================================================================
set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select pg_temp.check('nothing has changed yet',
  jsonb_array_length(public.registration_record(:johnson::uuid, :sem::uuid) -> 'drift')::text,
  '0');

-- Mary edits Emma's date of birth, making her older.
select pg_temp.be(:u_mary, 'mary@example.com');
select public.update_family_setup(jsonb_build_object(
  'family_id', :johnson,
  'children', jsonb_build_array(jsonb_build_object('id', :emma, 'birth_date', '2009-01-01'))));

set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select pg_temp.check('the change is noticed',
  jsonb_array_length(public.registration_record(:johnson::uuid, :sem::uuid) -> 'drift')::text,
  '1');

select pg_temp.check('...naming what it was',
  public.registration_record(:johnson::uuid, :sem::uuid) -> 'drift' -> 0 ->> 'was',
  '2015-03-12');

select pg_temp.check('...and what it is now',
  public.registration_record(:johnson::uuid, :sem::uuid) -> 'drift' -> 0 ->> 'now',
  '2009-01-01');

select pg_temp.check('and the desk sees it too, not only the printout',
  (select drift_count::text from public.semester_registration_report(:sem::uuid)
    where family_id = :johnson::uuid),
  '1');

-- The snapshot itself must not have moved. If editing a child rewrote the
-- record of what was agreed, the record would be worthless.
select pg_temp.check('the snapshot still says what it always said',
  (select snap ->> 'birth_date'
     from public.semester_registrations r,
          jsonb_array_elements(r.form_data -> 'snapshot' -> 'children') snap
    where r.family_id = :johnson::uuid and r.semester_id = :sem::uuid
      and (snap ->> 'id')::uuid = :emma::uuid),
  '2015-03-12');

-- =============================================================================
-- Who may read a record
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.com');


-- psql does not substitute :variables inside a $$ ... $$ block, so "does this
-- raise?" is asked through a function that takes the ids as arguments instead.
create or replace function pg_temp.refused(p_what text, p_a uuid, p_b uuid)
returns text language plpgsql as $$
begin
  case p_what
    when 'register_family'     then perform public.register_family(p_a, p_b);
    when 'registration_record' then perform public.registration_record(p_a, p_b);
  end case;
  return 'allowed through';
exception when others then
  return 'refused';
end;
$$;

select pg_temp.check('a parent cannot read the record of their own registration',
  pg_temp.refused('registration_record', :johnson::uuid, :sem::uuid),
  'refused');

reset role;

-- The runner checks for this line. ON_ERROR_STOP means a bad assertion halts
-- the file, and a halted file silently skips every test below it — which is
-- exactly what a broken cast did here once, hiding two thirds of this suite
-- while the run still reported green.
\echo 'SUITE-REACHED-THE-END'
