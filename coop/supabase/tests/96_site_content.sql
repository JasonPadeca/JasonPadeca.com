-- =============================================================================
-- Website text: the one table anonymous callers may read.
--
-- Every other table in this schema is closed to anon, and that decision is
-- tested. This one is deliberately open, which makes it the single place where
-- a mistake would not look like a mistake — a policy that accidentally allowed
-- writes here would let anyone on the internet reword the front page, and
-- nothing else in the suite would notice.
--
-- So the boundary is pinned from both sides: anon must be able to read it, and
-- anon must not be able to touch it.
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

-- Two blocks standing in for a page.
insert into public.site_content (page, block_key, original, sort_order, tag) values
  ('index.html', '1', 'Koinonia Homeschool Group', 1, 'h1'),
  ('index.html', '2', 'A Christ-centred homeschool community.', 2, 'p');

-- -----------------------------------------------------------------------------
-- Anonymous: reads yes, writes no.
-- -----------------------------------------------------------------------------
-- Checked before the behaviour, because the two are not the same thing.
-- Supabase's default privileges hand anon INSERT/UPDATE/DELETE on every new
-- table, so it is entirely possible for the writes below to be refused by a
-- policy while the privilege is still sitting there waiting for somebody to add
-- a permissive one. On the site's only public table, hold the privilege itself.
select pg_temp.check('anon holds SELECT on the website text',
  has_table_privilege('anon', 'public.site_content', 'select')::text, 'true');
select pg_temp.check('anon holds no INSERT on the website text',
  has_table_privilege('anon', 'public.site_content', 'insert')::text, 'false');
select pg_temp.check('anon holds no UPDATE on the website text',
  has_table_privilege('anon', 'public.site_content', 'update')::text, 'false');
select pg_temp.check('anon holds no DELETE on the website text',
  has_table_privilege('anon', 'public.site_content', 'delete')::text, 'false');

set role anon;

select pg_temp.check('anon can read the website text',
  (select count(*)::text from public.site_content), '2');

do $$
begin
  insert into public.site_content (page, block_key, original)
  values ('index.html', 'x', 'Free real estate');
  raise warning 'FAIL  anon cannot insert website text  (the insert succeeded)';
exception when insufficient_privilege or others then
  raise notice 'PASS  anon cannot insert website text (%)', sqlerrm;
end $$;

do $$
begin
  update public.site_content set text = 'Defaced' where block_key = '1';
  if found then
    raise warning 'FAIL  anon cannot reword the front page  (the update applied)';
  else
    raise notice 'PASS  anon cannot reword the front page (0 rows)';
  end if;
exception when insufficient_privilege or others then
  raise notice 'PASS  anon cannot reword the front page (%)', sqlerrm;
end $$;

do $$
begin
  perform public.set_site_text('index.html', '1', 'Defaced');
  raise warning 'FAIL  anon cannot call set_site_text  (it ran)';
exception when insufficient_privilege or others then
  raise notice 'PASS  anon cannot call set_site_text (%)', sqlerrm;
end $$;

reset role;

-- -----------------------------------------------------------------------------
-- A signed-in stranger is not an administrator.
-- -----------------------------------------------------------------------------
set role authenticated;
select set_config('test.jwt', '{"email":"stranger@gmail.com"}', false);

do $$
begin
  perform public.set_site_text('index.html', '1', 'Defaced');
  raise warning 'FAIL  a signed-in stranger cannot edit the website  (it ran)';
exception when others then
  raise notice 'PASS  a signed-in stranger cannot edit the website (%)', sqlerrm;
end $$;

reset role;

-- -----------------------------------------------------------------------------
-- An administrator can edit, and can put it back.
-- -----------------------------------------------------------------------------
set role authenticated;
select set_config('test.jwt', '{"email":"owner@example.org"}', false);

select pg_temp.check('admin can reword a block',
  (public.set_site_text('index.html', '1', 'Koinonia Homeschool Group of Phoenix'))->>'ok',
  'true');

select pg_temp.check('the new wording is stored',
  (select text from public.site_content where block_key = '1'),
  'Koinonia Homeschool Group of Phoenix');

select pg_temp.check('the original is untouched',
  (select original from public.site_content where block_key = '1'),
  'Koinonia Homeschool Group');

-- Blank means "undo", not "publish an empty paragraph". A page with a
-- mysteriously empty space is harder to diagnose than one that did not change.
select pg_temp.check('blank reverts rather than emptying the block',
  (public.set_site_text('index.html', '1', '  '))->>'reverted', 'true');

select pg_temp.check('...and the override is cleared',
  (select coalesce(text, '<null>') from public.site_content where block_key = '1'),
  '<null>');

-- Saving the original wording verbatim is not an edit. Storing it would make
-- "unchanged" indistinguishable from "changed back", and the page list counts
-- on that difference.
select pg_temp.check('re-saving the original counts as unchanged',
  (public.set_site_text('index.html', '2', 'A Christ-centred homeschool community.'))->>'reverted',
  'true');

select pg_temp.check('editing an unknown block is refused, not created',
  (public.set_site_text('index.html', 'no-such-key', 'Hello'))->>'error',
  'no_such_block');

select pg_temp.check('...and no row was invented for it',
  (select count(*)::text from public.site_content), '2');

-- The edit is recorded like every other administrative change. Three, not four:
-- the refused edit above wrote nothing, which is right — a rejected request is
-- not a change to the website, and logging it as one would make the audit trail
-- read as though somebody had edited a block that does not exist.
select pg_temp.check('edits are written to the audit log',
  (select count(*)::text from public.audit_log where action = 'site_text_edited'),
  '3');

reset role;

-- -----------------------------------------------------------------------------
-- One row per block per page, so a re-import cannot quietly double the site.
-- -----------------------------------------------------------------------------
do $$
begin
  insert into public.site_content (page, block_key, original)
  values ('index.html', '1', 'A second copy');
  raise warning 'FAIL  a page cannot hold two blocks with the same key  (it inserted)';
exception when unique_violation then
  raise notice 'PASS  a page cannot hold two blocks with the same key';
end $$;

-- The seed file re-imports with ON CONFLICT DO UPDATE, refreshing the original
-- while leaving an administrator's wording alone. If that ever stopped being
-- true, re-running the mirror would silently discard their work.
update public.site_content set text = 'Ben''s edit' where block_key = '2';

insert into public.site_content (page, block_key, original, sort_order, tag) values
  ('index.html', '2', 'Reworded upstream.', 2, 'p')
on conflict (page, block_key) do update set original = excluded.original,
  sort_order = excluded.sort_order, tag = excluded.tag;

select pg_temp.check('a re-import refreshes the original',
  (select original from public.site_content where block_key = '2'),
  'Reworded upstream.');

select pg_temp.check('...and keeps the administrator''s wording',
  (select text from public.site_content where block_key = '2'),
  'Ben''s edit');

\echo 'SUITE-REACHED-THE-END'
