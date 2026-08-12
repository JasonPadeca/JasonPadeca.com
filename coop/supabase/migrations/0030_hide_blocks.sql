-- =============================================================================
-- 0030_hide_blocks.sql
-- Taking a paragraph off the page.
--
-- Emptying a text box was already meaningful: it means "undo my edit", and the
-- original wording comes back. That is a good behaviour and it stays.
--
-- But it is not the behaviour somebody is looking for when they mean "we do not
-- do the potluck any more, take that line off". They clear the box, press Save,
-- and the sentence they were trying to remove reappears — which reads as the
-- software refusing them. There was no way to do the thing they wanted at all.
--
-- So hiding is its own action, separate from wording.
--
-- HOW IT IS DONE MATTERS. The block is not deleted from the page; it is marked
-- hidden, which browsers render as display:none — no text, and no gap where the
-- text used to be. Deleting the element outright would leave nothing carrying
-- its data-k, and the block could then never be brought back, because the
-- publishing job finds blocks by that attribute. Hidden is reversible. Deleted
-- is not.
-- =============================================================================

select public.migration_guard('0030', '0029');

alter table public.site_content
  add column if not exists hidden boolean not null default false;

comment on column public.site_content.hidden is
  'Taken off the page. The element stays in the HTML carrying its data-k so it '
  'can be put back; browsers give a hidden element no space.';

create or replace function public.set_site_visible(
  p_page      text,
  p_block_key text,
  p_visible   boolean
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

  select id into v_id from public.site_content
   where page = p_page and block_key = p_block_key;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'no_such_block');
  end if;

  update public.site_content
     set hidden = not coalesce(p_visible, true),
         updated_by = public.current_admin_id()
   where id = v_id;

  perform public.write_audit('site_block_visibility', 'page', null,
    jsonb_build_object('page', p_page, 'block', p_block_key,
                       'hidden', not coalesce(p_visible, true)));

  return jsonb_build_object('ok', true, 'hidden', not coalesce(p_visible, true));
end;
$$;

revoke execute on function public.set_site_visible(text, text, boolean) from public, anon;
grant execute on function public.set_site_visible(text, text, boolean) to authenticated;

select public.record_migration('0030');
