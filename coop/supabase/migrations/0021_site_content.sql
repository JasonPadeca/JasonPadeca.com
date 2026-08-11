-- =============================================================================
-- 0021_site_content.sql
-- Letting administrators edit the website.
--
-- The public pages are static HTML. Rather than a content management system,
-- this is the smallest thing that works: every editable paragraph, heading and
-- list item on the site has a row here, holding both what it originally said
-- and what an administrator has changed it to.
--
-- Nothing reads this at page load. A scheduled job bakes the changes into the
-- real HTML files, so a visitor gets a plain static page with the current
-- wording in it — no request, no delay, and no flash of the old text. The cost
-- is that an edit takes a few minutes to appear, which the admin screen says
-- plainly rather than leaving somebody wondering whether the Save worked.
--
-- Text only. Not images, not layout, not new sections. A group that can fix a
-- date or reword an answer without needing a developer is most of the value;
-- letting them move blocks around is how a working page becomes a broken one at
-- eleven at night with nobody to ask.
-- =============================================================================

select public.migration_guard('0021', '0020');

create table public.site_content (
  id         uuid primary key default gen_random_uuid(),

  -- Path of the page as it sits in the repository: "index.html",
  -- "about/index.html".
  page       text not null,

  -- Stable identifier written into the HTML as data-k. Position within the
  -- page's content, assigned once when the pages were imported.
  block_key  text not null,

  -- What the block said when it was imported. Never edited — it is what Revert
  -- goes back to, and what tells an administrator how far they have strayed.
  original   text not null,

  -- The override. NULL means "unchanged", which is why the table can hold every
  -- block on the site without implying every block has been meddled with.
  text       text,

  -- Ordering and grouping for the admin screen, so blocks appear in the order
  -- they do on the page rather than in whatever order the database returns.
  sort_order integer not null default 0,
  tag        text,

  updated_at timestamptz not null default now(),
  updated_by uuid references public.admins(id) on delete set null,

  unique (page, block_key)
);

create index site_content_page_idx on public.site_content (page, sort_order);

create trigger site_content_touch before update on public.site_content
  for each row execute function public.touch_updated_at();

alter table public.site_content enable row level security;

create policy admin_all on public.site_content
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

-- =============================================================================
-- THE ONE ANONYMOUS-READABLE TABLE IN THIS SCHEMA. Read this before adding
-- another.
--
-- Every other table here is closed to anonymous callers, and that is the right
-- default when the data is children's names and medical notes. This one is the
-- exception because its contents are, by definition, the words printed on a
-- public website. There is nothing to protect.
--
-- It is readable so the publishing job can fetch the copy with the same
-- publishable key the site already carries, rather than a service-role secret
-- stored in GitHub. Fewer secrets is worth more than hiding text that is on the
-- front page anyway.
--
-- Reading only. Writing stays with administrators.
--
-- The revoke below is the load-bearing line, not the grant. Supabase ships
-- `alter default privileges in schema public grant all on tables to anon`, so a
-- newly created table arrives with anon already holding INSERT, UPDATE and
-- DELETE; 0002 swept those away for every table that existed then, but this one
-- did not exist yet. Granting SELECT on top of ALL changes nothing. Without the
-- revoke, the only thing standing between the internet and the front page is
-- the absence of a permissive write policy — and this is the one table where
-- somebody adding a policy would not think twice.
-- =============================================================================
revoke all on public.site_content from anon, authenticated;
grant select on public.site_content to anon, authenticated;
grant all on public.site_content to service_role;

create policy anyone_reads on public.site_content
  for select to anon, authenticated
  using (true);

-- =============================================================================
-- Saving an edit.
--
-- Blank goes back to the original rather than publishing an empty paragraph:
-- somebody clearing a box means "undo this", not "make this line disappear",
-- and a page with a mysteriously empty space is harder to diagnose than one
-- that simply did not change.
-- =============================================================================
create or replace function public.set_site_text(
  p_page      text,
  p_block_key text,
  p_text      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.site_content;
  v_new text;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_row from public.site_content
   where page = p_page and block_key = p_block_key;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_such_block');
  end if;

  v_new := nullif(trim(coalesce(p_text, '')), '');

  -- Storing the original as an override would be indistinguishable from an
  -- edit that happens to match. NULL keeps "unchanged" meaningful.
  if v_new is not distinct from v_row.original then
    v_new := null;
  end if;

  update public.site_content
     set text = v_new, updated_by = public.current_admin_id()
   where id = v_row.id;

  perform public.write_audit('site_text_edited', 'page', null,
    jsonb_build_object('page', p_page, 'block', p_block_key,
                       'reverted', v_new is null));

  return jsonb_build_object('ok', true, 'reverted', v_new is null);
end;
$$;

revoke execute on function public.set_site_text(text, text, text) from public, anon;
grant execute on function public.set_site_text(text, text, text) to authenticated;

select public.record_migration('0021');
