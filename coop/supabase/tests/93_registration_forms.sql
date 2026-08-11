-- =============================================================================
-- The registration form, the desk, and the gate.
--
-- Most of the effort here goes on the gate, because it is the only part that
-- can silently let somebody through a door the co-op meant to keep shut. The
-- form and the toggles are records; the gate is a rule.
--
-- The second concern is the form writing to the family's own records. It
-- creates parents and children, which is a family being trusted to describe
-- itself — so the tests check it cannot describe somebody else's.
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

\set u_mary   '''00000000-0000-0000-0000-0000000000b1'''
\set u_becca  '''00000000-0000-0000-0000-0000000000b2'''

insert into auth.users (id) values (:u_mary::uuid), (:u_becca::uuid)
on conflict do nothing;

insert into public.family_users (auth_user_id, family_id, email) values
  (:u_mary::uuid,  :johnson::uuid, 'mary@example.com'),
  (:u_becca::uuid, :smith::uuid,   'rebecca@example.com')
on conflict do nothing;

-- =============================================================================
-- The gate on class sign-up
--
-- This is the consequential change: registration now decides whether a family
-- may choose classes at all.
-- =============================================================================
reset role;
update public.semesters set status = 'registration_open' where id = :sem::uuid;
delete from public.semester_registrations where semester_id = :sem::uuid;

select pg_temp.check('an unregistered family cannot sign up for classes',
  public.submit_family_registration(:johnson::uuid, :sem::uuid, '[]'::jsonb) ->> 'error',
  'not_registered');

-- The message has to be usable by a parent, not just a code for the console.
select pg_temp.check('and is told why in words',
  (public.submit_family_registration(:johnson::uuid, :sem::uuid, '[]'::jsonb) ->> 'message')
    like '%not registered%',
  'true');

set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select pg_temp.check('registering records what was outstanding at the time',
  public.register_family(:johnson::uuid, :sem::uuid) -> 'outstanding' #>> '{}',
  '["form", "review", "payment"]');

reset role;
select pg_temp.check('a registered family gets through',
  coalesce(public.submit_family_registration(:johnson::uuid, :sem::uuid, '[]'::jsonb) ->> 'error',
           'allowed'),
  'allowed');

select pg_temp.check('a different family is still refused',
  public.submit_family_registration(:smith::uuid, :sem::uuid, '[]'::jsonb) ->> 'error',
  'not_registered');

-- "Resolved" means registered. A family that has told the co-op it is not
-- coming has resolved its registration and is equally not choosing classes.
set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select public.set_family_registration(:smith::uuid, :sem::uuid, 'not_attending', null);
reset role;

select pg_temp.check('"not attending" does not open the gate either',
  public.submit_family_registration(:smith::uuid, :sem::uuid, '[]'::jsonb) ->> 'error',
  'not_registered');

-- The escape hatch. An administrator placing a child deliberately is exactly
-- the corner case the co-op said it would handle by hand.
select pg_temp.check('an administrator override still works',
  coalesce(public.submit_family_registration(
    :smith::uuid, :sem::uuid, '[]'::jsonb, 'admin', true) ->> 'error', 'allowed'),
  'allowed');

-- =============================================================================
-- The form
-- =============================================================================
reset role;
update public.semesters
   set registration_form_opens_at  = now() - interval '1 day',
       registration_form_closes_at = now() + interval '30 days'
 where id = :sem::uuid;

select pg_temp.be(:u_mary, 'mary@example.com');

select pg_temp.check('the form knows which semester is open',
  (public.family_registration_form() -> 'semester' ->> 'name' is not null)::text,
  'true');

select pg_temp.check('and arrives with the children already on file',
  (jsonb_array_length(public.family_registration_form() -> 'children') > 0)::text,
  'true');

select pg_temp.check('a family with children on file is not a first semester',
  public.family_registration_form() ->> 'first_semester',
  'false');

-- Agreeing to the Code of Conduct is not optional, and saying so on the page is
-- not the same as enforcing it.
select pg_temp.check('a form without the conduct agreement is refused',
  public.submit_registration_form(jsonb_build_object(
    'semester_id', :sem, 'agreed_conduct', false)) ->> 'error',
  'conduct_required');

select pg_temp.check('a complete form is accepted',
  public.submit_registration_form(jsonb_build_object(
    'semester_id', :sem,
    'agreed_conduct', true,
    'primary_phone', '602-555-0101',
    'comments', 'Away on the 12th of September',
    'grades', jsonb_build_array(jsonb_build_object('child_id', :emma, 'grade', '7th'))
  )) ->> 'ok',
  'true');

select pg_temp.check('the grade is filed against the child for that semester',
  (select grade from public.semester_participation
    where child_id = :emma::uuid and semester_id = :sem::uuid),
  '7th');

select pg_temp.check('and what they wrote is kept verbatim',
  (select form_data ->> 'comments' from public.semester_registrations
    where family_id = :johnson::uuid and semester_id = :sem::uuid),
  'Away on the 12th of September');

-- Submitting is not registering. The form lands on a desk; a person acts on it.
select pg_temp.check('submitting a form does not register anybody',
  (select status from public.semester_registrations
    where family_id = :smith::uuid and semester_id = :sem::uuid),
  'not_attending');

-- --- a family may only describe itself ---------------------------------------
--
-- The page offers no way to set another family's grades. That is not the same
-- as it being impossible, which is what this checks.
select pg_temp.be(:u_becca, 'rebecca@example.com');

select public.submit_registration_form(jsonb_build_object(
  'semester_id', :sem,
  'agreed_conduct', true,
  'grades', jsonb_build_array(jsonb_build_object('child_id', :emma, 'grade', 'FORGED'))
));

select pg_temp.check('one family cannot set another family''s grades',
  (select grade from public.semester_participation
    where child_id = :emma::uuid and semester_id = :sem::uuid),
  '7th');

-- A closed window is enforced in the database, not only by hiding the page: a
-- form left open in a tab overnight must not be a way past it.
reset role;
update public.semesters set registration_form_closes_at = now() - interval '1 day'
 where id = :sem::uuid;

select pg_temp.be(:u_mary, 'mary@example.com');
select pg_temp.check('a closed window refuses a late submission',
  public.submit_registration_form(jsonb_build_object(
    'semester_id', :sem, 'agreed_conduct', true)) ->> 'error',
  'registration_closed');

reset role;
update public.semesters set registration_form_closes_at = now() + interval '30 days'
 where id = :sem::uuid;

-- =============================================================================
-- The desk
-- =============================================================================
set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select public.set_registration_review(:johnson::uuid, :sem::uuid, true);
select public.set_registration_payment(:johnson::uuid, :sem::uuid, true, 'Cash in August');

select pg_temp.check('the desk records a review',
  (select (reviewed_at is not null)::text from public.semester_registrations
    where family_id = :johnson::uuid and semester_id = :sem::uuid),
  'true');

select pg_temp.check('and a payment, with its note',
  (select payment_note from public.semester_registrations
    where family_id = :johnson::uuid and semester_id = :sem::uuid),
  'Cash in August');

select pg_temp.check('registering with everything in hand records nothing outstanding',
  public.register_family(:johnson::uuid, :sem::uuid) -> 'outstanding' #>> '{}',
  '[]');

select pg_temp.check('a toggle can be undone',
  (select (payment_received_at is null)::text from (
     select public.set_registration_payment(:johnson::uuid, :sem::uuid, false, null)) x,
   lateral (select payment_received_at from public.semester_registrations
             where family_id = :johnson::uuid and semester_id = :sem::uuid) y),
  'true');

-- The report is the screen's whole source of truth, so it must show families
-- nobody has touched — "who have we not heard from" is the question being asked.
select pg_temp.check('the report covers every unarchived family',
  (select count(*)::text from public.semester_registration_report(:sem::uuid)),
  (select count(*)::text from public.families where archived_at is null));

-- --- authorization -----------------------------------------------------------
select pg_temp.be(:u_mary, 'mary@example.com');

select pg_temp.check('a parent cannot register their own family',
  (select 'refused' from (
     select public.register_family(:johnson::uuid, :sem::uuid)) t),
  null);
\echo '(the line above raising "Not authorized" is the pass)'

reset role;
