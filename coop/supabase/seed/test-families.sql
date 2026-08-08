-- =============================================================================
-- Test roster — four invented families.
--
-- Everything here is fictional. Every address is one of the two test inboxes,
-- so opening registration and sending invitations mails nobody but you.
--
-- Running this DELETES the existing roster: families, parents, children,
-- registrations, waitlists, participation, and invitations. It leaves
-- semesters, periods, classes, administrators, and settings alone.
--
-- To put the real co-op back afterwards, run the roster import kept outside
-- this repository at ~/Documents/coop-private/coop-roster-import.sql. That file
-- is deliberately not committed: this repo is public and the roster is
-- children's names and birth dates.
--
-- The families are shaped to exercise the awkward cases rather than the happy
-- one: a single-child family (no child tabs), a large family, children either
-- side of a typical age cutoff, an all-girls family for sex-restricted classes,
-- a child with no sex recorded, and one who has aged out.
--
-- Birth dates are chosen against a semester starting around September 2026.
-- =============================================================================

begin;

-- Cascades through parents, children, registrations, semester_participation,
-- and registration_invites.
delete from public.families;

-- ---- Ashford: five children, ages 5 to 17 -----------------------------------
insert into public.families (id, display_name, last_name, primary_email, notes) values
  ('aaaa0001-0000-4000-8000-000000000001', 'Ashford Family', 'Ashford',
   'bendenny@gmail.com', 'Test family. Joined Fall 2021.');

insert into public.parents (family_id, first_name, last_name, email, sort_order) values
  ('aaaa0001-0000-4000-8000-000000000001', 'Marcus', 'Ashford', 'bendenny@gmail.com', 0),
  ('aaaa0001-0000-4000-8000-000000000001', 'Ruth',   'Ashford', 'bendenny@gmail.com', 1);

insert into public.children (id, family_id, first_name, last_name, birth_date, sex, notes) values
  ('aaaa0001-0000-4000-8000-0000000000c1', 'aaaa0001-0000-4000-8000-000000000001', 'Tabitha', 'Ashford', '2009-04-18', 'female', 'Allergies/medications: none'),
  ('aaaa0001-0000-4000-8000-0000000000c2', 'aaaa0001-0000-4000-8000-000000000001', 'Nathaniel', 'Ashford', '2011-09-02', 'male', null),
  ('aaaa0001-0000-4000-8000-0000000000c3', 'aaaa0001-0000-4000-8000-000000000001', 'Perpetua', 'Ashford', '2013-12-30', 'female', 'Allergies/medications: peanuts (carries an EpiPen)'),
  ('aaaa0001-0000-4000-8000-0000000000c4', 'aaaa0001-0000-4000-8000-000000000001', 'Silas', 'Ashford', '2017-06-11', 'male', null),
  ('aaaa0001-0000-4000-8000-0000000000c5', 'aaaa0001-0000-4000-8000-000000000001', 'Winnifred', 'Ashford', '2021-02-25', 'female', 'Nursery age');

-- ---- Beckett: one child, so the page shows no child tabs --------------------
insert into public.families (id, display_name, last_name, primary_email, notes) values
  ('bbbb0002-0000-4000-8000-000000000002', 'Beckett Family', 'Beckett',
   'vallynnharris@gmail.com', 'Test family. Single child — exercises the no-tabs layout.');

insert into public.parents (family_id, first_name, last_name, email, sort_order) values
  ('bbbb0002-0000-4000-8000-000000000002', 'Imogen', 'Beckett', 'vallynnharris@gmail.com', 0);

insert into public.children (id, family_id, first_name, last_name, birth_date, sex) values
  ('bbbb0002-0000-4000-8000-0000000000c1', 'bbbb0002-0000-4000-8000-000000000002', 'Rufus', 'Beckett', '2012-08-08', 'male');

-- ---- Calloway: an aged-out sibling, and one with no sex recorded ------------
insert into public.families (id, display_name, last_name, primary_email, notes) values
  ('cccc0003-0000-4000-8000-000000000003', 'Calloway Family', 'Calloway',
   'bendenny@gmail.com', 'Test family. Has an inactive child and one with no sex on file.');

insert into public.parents (family_id, first_name, last_name, email, sort_order) values
  ('cccc0003-0000-4000-8000-000000000003', 'Desmond', 'Calloway', 'bendenny@gmail.com', 0),
  ('cccc0003-0000-4000-8000-000000000003', 'Odette',  'Calloway', 'bendenny@gmail.com', 1);

insert into public.children (id, family_id, first_name, last_name, birth_date, sex, active, inactive_reason) values
  ('cccc0003-0000-4000-8000-0000000000c1', 'cccc0003-0000-4000-8000-000000000003', 'Barnaby', 'Calloway', '2007-03-14', 'male', false, 'Aged out of the program'),
  ('cccc0003-0000-4000-8000-0000000000c2', 'cccc0003-0000-4000-8000-000000000003', 'Rosalind', 'Calloway', '2010-11-22', 'female', true, null),
  ('cccc0003-0000-4000-8000-0000000000c3', 'cccc0003-0000-4000-8000-000000000003', 'Wilder', 'Calloway', '2014-07-05', null, true, null);

-- ---- Dunmore: all girls, for sex-restricted classes -------------------------
insert into public.families (id, display_name, last_name, primary_email, notes) values
  ('dddd0004-0000-4000-8000-000000000004', 'Dunmore Family', 'Dunmore',
   'vallynnharris@gmail.com', 'Test family. All girls — exercises girls-only classes.');

insert into public.parents (family_id, first_name, last_name, email, sort_order) values
  ('dddd0004-0000-4000-8000-000000000004', 'Cordelia', 'Dunmore', 'vallynnharris@gmail.com', 0);

insert into public.children (id, family_id, first_name, last_name, birth_date, sex) values
  ('dddd0004-0000-4000-8000-0000000000c1', 'dddd0004-0000-4000-8000-000000000004', 'Genevieve', 'Dunmore', '2010-01-30', 'female'),
  ('dddd0004-0000-4000-8000-0000000000c2', 'dddd0004-0000-4000-8000-000000000004', 'Clementine', 'Dunmore', '2013-05-19', 'female'),
  ('dddd0004-0000-4000-8000-0000000000c3', 'dddd0004-0000-4000-8000-000000000004', 'Marigold', 'Dunmore', '2016-10-03', 'female');

commit;

-- Check:
--   select display_name, primary_email from families order by display_name;
--   select count(*) from children where active;   -- expect 12
--
-- Every address must be bendenny@ or vallynnharris@ — expect zero rows:
--   select display_name, primary_email from families
--    where primary_email not in ('bendenny@gmail.com','vallynnharris@gmail.com');
