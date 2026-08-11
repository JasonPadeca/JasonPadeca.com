-- =============================================================================
-- 0024_family_setup.sql
-- Letting a family keep its own details right.
--
-- Everything about a family — a new phone number, a child's email address, an
-- allergy discovered in March — has until now gone through the registrar. She
-- is not the person who knows any of it. The parents are, and they were being
-- made to send an email and wait so that somebody else could type it in.
--
-- So parents may now edit what is theirs: their own contact details, and their
-- children's. The boundary is the family, enforced here rather than assumed
-- from the page that calls it.
--
-- What parents may NOT touch, deliberately:
--
--   * children.notes — the registrar's own notes about a child. Parents cannot
--     read those today and should not be able to rewrite them.
--   * active / archived_at — who is still in the co-op is the co-op's call.
--   * deleting anybody. A child who has left is marked, not erased, because
--     they are on last term's rosters and those must not develop holes.
--
-- On birth dates: parents CAN change them, and that is a real decision rather
-- than an oversight. Ages drive class eligibility, so in principle a parent
-- refused a class could edit their way in. Set against that, the parents are
-- the only people who actually know, the alternative is the registrar retyping
-- dates she is being told over email anyway, and every change lands in the
-- audit log with the old and new value. For a church co-op of sixty families
-- that trade is worth making. If it ever stops being worth making, the guard
-- goes in update_family_setup and nothing else needs to change.
-- =============================================================================

select public.migration_guard('0024', '0023');

-- =============================================================================
-- Everything the family setup page shows.
--
-- Deliberately not the same shape as family_registration_form: that one is a
-- semester's paperwork, this one is the standing record. Sharing a payload
-- between them would tie a page about allergies to a form about fees.
-- =============================================================================
create or replace function public.family_setup()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fams uuid[] := public.current_family_ids();
begin
  if array_length(v_fams, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no_family');
  end if;

  return jsonb_build_object(
    'ok', true,
    'families', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id,
        'display_name', f.display_name,
        'primary_email', f.primary_email,
        'primary_phone', f.primary_phone,
        'parents', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
                   'email', p.email, 'phone', p.phone)
                 order by p.sort_order, p.first_name)
            from public.parents p where p.family_id = f.id), '[]'::jsonb),
        'children', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name,
                   'birth_date', c.birth_date, 'email', c.email, 'phone', c.phone,
                   'allergies', c.allergies, 'medical_notes', c.medical_notes)
                 order by c.birth_date nulls last, c.first_name)
            from public.children c
           where c.family_id = f.id and c.active and c.archived_at is null), '[]'::jsonb)
      ) order by f.display_name)
      from public.families f where f.id = any(v_fams)), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.family_setup() from public, anon;
grant execute on function public.family_setup() to authenticated;

-- =============================================================================
-- Saving it.
--
-- One call for the whole page, because a parent pressing Save once expects one
-- outcome. Every id is checked against the caller's own family before anything
-- is written — the page only ever offers their own people, but "the page only
-- offers it" is not a boundary, it is a habit.
-- =============================================================================
create or replace function public.update_family_setup(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fams    uuid[] := public.current_family_ids();
  v_fam_id  uuid;
  v_row     jsonb;
  v_id      uuid;
  v_changed int := 0;
  v_added   int := 0;
  v_old     public.children;
begin
  if array_length(v_fams, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no_family');
  end if;

  v_fam_id := (p_payload ->> 'family_id')::uuid;
  if v_fam_id is null or not (v_fam_id = any(v_fams)) then
    return jsonb_build_object('ok', false, 'error', 'not_your_family');
  end if;

  -- --- the family itself -----------------------------------------------------
  update public.families
     set primary_email = coalesce(nullif(trim(coalesce(p_payload ->> 'primary_email', '')), ''),
                                  primary_email),
         primary_phone = nullif(trim(coalesce(p_payload ->> 'primary_phone', '')), '')
   where id = v_fam_id;

  -- --- parents ---------------------------------------------------------------
  for v_row in select * from jsonb_array_elements(coalesce(p_payload -> 'parents', '[]'::jsonb))
  loop
    v_id := (v_row ->> 'id')::uuid;

    if v_id is null then
      -- A parent being added.
      if nullif(trim(coalesce(v_row ->> 'first_name', '')), '') is not null then
        insert into public.parents (family_id, first_name, last_name, email, phone)
        values (v_fam_id,
                trim(v_row ->> 'first_name'),
                nullif(trim(coalesce(v_row ->> 'last_name', '')), ''),
                nullif(trim(coalesce(v_row ->> 'email', '')), ''),
                nullif(trim(coalesce(v_row ->> 'phone', '')), ''));
        v_added := v_added + 1;
      end if;
    else
      -- An existing parent. The family_id in the WHERE clause is the boundary:
      -- an id belonging to somebody else simply matches no row.
      update public.parents
         set first_name = coalesce(nullif(trim(coalesce(v_row ->> 'first_name', '')), ''), first_name),
             last_name  = nullif(trim(coalesce(v_row ->> 'last_name', '')), ''),
             email      = nullif(trim(coalesce(v_row ->> 'email', '')), ''),
             phone      = nullif(trim(coalesce(v_row ->> 'phone', '')), '')
       where id = v_id and family_id = v_fam_id;
      if found then v_changed := v_changed + 1; end if;
    end if;
  end loop;

  -- --- children --------------------------------------------------------------
  for v_row in select * from jsonb_array_elements(coalesce(p_payload -> 'children', '[]'::jsonb))
  loop
    v_id := (v_row ->> 'id')::uuid;

    if v_id is null then
      if nullif(trim(coalesce(v_row ->> 'first_name', '')), '') is not null then
        insert into public.children (family_id, first_name, last_name, birth_date,
                                     email, phone, allergies, medical_notes)
        values (v_fam_id,
                trim(v_row ->> 'first_name'),
                nullif(trim(coalesce(v_row ->> 'last_name', '')), ''),
                (nullif(trim(coalesce(v_row ->> 'birth_date', '')), ''))::date,
                nullif(trim(coalesce(v_row ->> 'email', '')), ''),
                nullif(trim(coalesce(v_row ->> 'phone', '')), ''),
                nullif(trim(coalesce(v_row ->> 'allergies', '')), ''),
                nullif(trim(coalesce(v_row ->> 'medical_notes', '')), ''));
        v_added := v_added + 1;
      end if;
    else
      select * into v_old from public.children
       where id = v_id and family_id = v_fam_id;

      -- Not theirs: skip it silently rather than failing the whole save. The
      -- page cannot produce this, so anybody who does has crafted it by hand.
      if v_old.id is null then
        continue;
      end if;

      update public.children
         set first_name    = coalesce(nullif(trim(coalesce(v_row ->> 'first_name', '')), ''), first_name),
             last_name     = nullif(trim(coalesce(v_row ->> 'last_name', '')), ''),
             birth_date    = coalesce((nullif(trim(coalesce(v_row ->> 'birth_date', '')), ''))::date,
                                      birth_date),
             email         = nullif(trim(coalesce(v_row ->> 'email', '')), ''),
             phone         = nullif(trim(coalesce(v_row ->> 'phone', '')), ''),
             allergies     = nullif(trim(coalesce(v_row ->> 'allergies', '')), ''),
             medical_notes = nullif(trim(coalesce(v_row ->> 'medical_notes', '')), '')
       where id = v_id and family_id = v_fam_id;
      v_changed := v_changed + 1;

      -- A birth date moving is the one edit here that changes what a child is
      -- allowed to do, so it gets its own audit entry with both values rather
      -- than disappearing into a count of "details updated".
      if (nullif(trim(coalesce(v_row ->> 'birth_date', '')), ''))::date
         is distinct from v_old.birth_date
         and (v_row ->> 'birth_date') is not null then
        perform public.write_audit('child_birth_date_changed', 'child', v_id,
          jsonb_build_object('from', v_old.birth_date,
                             'to', (v_row ->> 'birth_date')::date,
                             'by', 'family'));
      end if;
    end if;
  end loop;

  perform public.write_audit('family_details_updated', 'family', v_fam_id,
    jsonb_build_object('changed', v_changed, 'added', v_added, 'by', 'family'));

  return jsonb_build_object('ok', true, 'changed', v_changed, 'added', v_added);
end;
$$;

revoke execute on function public.update_family_setup(jsonb) from public, anon;
grant execute on function public.update_family_setup(jsonb) to authenticated;

select public.record_migration('0024');
