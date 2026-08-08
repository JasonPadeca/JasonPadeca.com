-- =============================================================================
-- 0008_student_phone.sql
-- A phone number for the student.
--
-- 0007 gave a child an email address and the family a phone number, which left
-- an odd gap: a teenager could be emailed but not rung, and the only number on
-- the roster reached a parent. For a sixteen-year-old who drives themselves to
-- co-op, that is the wrong number to have.
--
-- So both sides now carry both: the student has an email and a phone, the
-- family has an email and a phone, and the roster shows whichever exist. Most
-- younger children will have neither, and their rows simply say so.
-- =============================================================================

alter table public.children
  add column if not exists phone text;

comment on column public.children.phone is
  'The student''s own number, where they have one. Older students only; shown on rosters beside their email.';
