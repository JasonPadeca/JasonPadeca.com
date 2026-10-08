-- =============================================================================
-- 0035_helper_email_text.sql
-- The helper request email, in the co-op's own words.
--
-- The wording was mine, baked into the function. That is wrong for a message
-- signed by this group and sent to people who know them: "could you tell us
-- which ones you would be willing to take" is a reasonable sentence written by
-- a stranger, and Val will want to say something warmer, or shorter, or
-- mention the potluck.
--
-- Stored as a default so nobody retypes it every term, and editable on the
-- send screen so a particular send can differ without changing the default.
--
-- Placeholders, kept to three. More would need a key, and a key is a thing
-- nobody reads before writing an email.
-- =============================================================================

select public.migration_guard('0035', '0034');

alter table public.settings
  add column if not exists helper_email_subject text,
  add column if not exists helper_email_body    text;

comment on column public.settings.helper_email_body is
  'Plain text. {parent} {semester} {link} are replaced when sending. Blank '
  'falls back to the wording built into the function.';

-- Seed the stored default with the existing wording, so the box opens with
-- something sensible in it rather than empty — an empty box reads as "you must
-- write this yourself", which is the opposite of the intent.
update public.settings
   set helper_email_subject = coalesce(helper_email_subject,
         'Can you help with a class this {semester}?'),
       helper_email_body = coalesce(helper_email_body,
'{parent},

Every class at our co-op runs on parents helping out. Could you tell us which
ones you would be willing to take this {semester}?

It takes a minute — tick anything you would be happy to help with:

{link}

Ticking a class is not signing up for it. We work out who goes where and let
you know.

Thank you!')
 where id = 1;

select public.record_migration('0035');
