-- =============================================================================
-- 0007_roster_details.sql
-- The fields a teacher actually needs on a class roster.
--
-- A printed roster is what a teacher carries into a room with other people's
-- children in it. Four of the things that belong on it had nowhere to live:
--
--   * Allergies and medical needs were being written into children.notes as
--     free text by the roster importer. Fine for a note; wrong for something
--     you might need to read in a hurry. They become real columns here, and
--     the existing notes are unpacked into them.
--   * A child's own email address had no column at all.
--   * Neither did a phone number for the family, though individual parents had
--     one — so "who do I call" had no single answer.
--   * Classes had no location, so a roster could not say where to go.
--
-- Splitting allergies from medical notes is deliberate. "Peanuts" and "Type 1
-- diabetic, carries insulin" are different questions a teacher asks at
-- different moments, and collapsing them buries one inside the other.
-- =============================================================================

alter table public.classes
  add column if not exists location text;

alter table public.children
  add column if not exists email         text,
  add column if not exists allergies     text,
  add column if not exists medical_notes text;

alter table public.families
  add column if not exists primary_phone text;

comment on column public.children.allergies is
  'Allergies only. Medication and conditions belong in medical_notes.';
comment on column public.children.medical_notes is
  'Medication, conditions, and anything a teacher may need to act on.';
comment on column public.classes.location is
  'Free text — "Fellowship Hall", "Room 3", "Outside, field". Shown on rosters.';

-- -----------------------------------------------------------------------------
-- Unpack what the importer wrote into notes.
--
-- The roster import wrote "Allergies/medications: <text>" as one segment of a
-- semicolon-separated note. Lift that text into the new column and take the
-- segment out of notes, so the same information does not sit in two places
-- disagreeing with itself later.
--
-- Everything else in notes — grade, joining term, administrative remarks — is
-- left exactly as it was.
-- -----------------------------------------------------------------------------
update public.children
   set allergies = nullif(trim(substring(notes from 'Allergies/medications:\s*([^;]*)')), '')
 where allergies is null
   and notes is not null
   and notes like '%Allergies/medications:%';

update public.children
   set notes = nullif(trim(both '; ' from
                 regexp_replace(notes, 'Allergies/medications:[^;]*;?\s*', '', 'g')), '')
 where notes is not null
   and notes like '%Allergies/medications:%';

-- "none" and its friends are noise on a roster; a blank cell reads faster.
update public.children
   set allergies = null
 where allergies is not null
   and lower(trim(allergies)) in ('none', 'n/a', 'na', '-', '--', 'no', 'nil');

-- -----------------------------------------------------------------------------
-- A single phone number for the family.
--
-- Seeded from the first parent who has one, so existing records are not left
-- blank. Administrators can override it per family afterwards.
-- -----------------------------------------------------------------------------
update public.families f
   set primary_phone = p.phone
  from (
    select distinct on (family_id) family_id, phone
      from public.parents
     where phone is not null and trim(phone) <> ''
     order by family_id, sort_order, created_at
  ) p
 where p.family_id = f.id
   and f.primary_phone is null;
