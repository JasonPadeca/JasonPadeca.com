-- =============================================================================
-- 0029_site_images.sql
-- Changing the photograph on the front page, without a developer.
--
-- The group photo gets replaced about once a year. Until now that meant sending
-- Ben a file, which is exactly the dependency the Website section was built to
-- remove for text.
--
-- HOW IT TRAVELS. An administrator uploads to Supabase Storage; the scheduled
-- publishing job pulls it down, shrinks it, writes it into the repository
-- beside the other site assets, and points the page at it.
--
-- It would be simpler to leave the image in Storage and link straight to it,
-- and that was the first design. It is wrong here: the public pages are static
-- files with NO runtime dependency on Supabase, deliberately — and this project
-- already runs a keepalive workflow because a free-tier project pauses when
-- idle. Linking the front page's main photograph to Storage would make the most
-- visited page in the co-op depend on the one service most likely to be asleep.
--
-- So Storage is the letterbox, not the shelf.
-- =============================================================================

select public.migration_guard('0029', '0028');

create table if not exists public.site_images (
  id            uuid primary key default gen_random_uuid(),

  page          text not null,        -- "index.html"
  img_key       text not null,        -- written into the HTML as data-img

  -- Where the page pointed when it was imported. What "put the old one back"
  -- restores, and never edited.
  original_src  text not null,
  alt           text,
  bytes         integer,

  -- The object in Storage an administrator has uploaded. NULL means the page is
  -- still showing the original.
  --
  -- Not cleared once published: the publishing job is idempotent — it makes the
  -- file on disk match this and rewrites the tag, and when both already match
  -- there is nothing to commit. Clearing it would need the job to write to the
  -- database, which would mean giving a scheduled task a key that can.
  upload_path   text,

  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.admins(id) on delete set null,

  unique (page, img_key)
);

alter table public.site_images enable row level security;

create policy admin_all on public.site_images
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

-- Readable without a session, for the same reason site_content is: the
-- publishing job reads it with the publishable key the site already carries,
-- and its contents are the address of a photograph on a public web page.
grant select on public.site_images to anon, authenticated;
grant all on public.site_images to service_role;

create policy anyone_reads on public.site_images
  for select to anon, authenticated using (true);

-- =============================================================================
-- The bucket.
--
-- Public read, because the publishing job fetches from it with no session and
-- the contents are bound for a public page anyway. Writing is administrators
-- only, checked against the admins table rather than a bare "authenticated" —
-- every parent has a session too.
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-images', 'site-images', true, 15728640,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 15728640,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists site_images_write on storage.objects;
create policy site_images_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'site-images' and public.is_active_admin());

drop policy if exists site_images_update on storage.objects;
create policy site_images_update on storage.objects
  for update to authenticated
  using (bucket_id = 'site-images' and public.is_active_admin());

drop policy if exists site_images_delete on storage.objects;
create policy site_images_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'site-images' and public.is_active_admin());

-- =============================================================================
-- Recording an upload, and undoing one.
-- =============================================================================
create or replace function public.set_site_image(
  p_page        text,
  p_img_key     text,
  p_upload_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select id into v_id from public.site_images
   where page = p_page and img_key = p_img_key;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'no_such_image');
  end if;

  update public.site_images
     set upload_path = nullif(trim(coalesce(p_upload_path, '')), ''),
         updated_by  = public.current_admin_id(),
         updated_at  = now()
   where id = v_id;

  perform public.write_audit('site_image_changed', 'page', null,
    jsonb_build_object('page', p_page, 'image', p_img_key,
                       'reverted', nullif(trim(coalesce(p_upload_path, '')), '') is null));

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.set_site_image(text, text, text) from public, anon;
grant execute on function public.set_site_image(text, text, text) to authenticated;

select public.record_migration('0029');
