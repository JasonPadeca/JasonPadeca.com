-- =============================================================================
-- 0031_family_sets_sex.sql
-- Let a family record their child's sex.
--
-- children.sex has been there since the first migration and an administrator
-- has always been able to set it. The family setup page never offered it, so a
-- parent could correct their child's date of birth, allergies and phone number
-- but not this.
--
-- Not cosmetic. A class may carry a sex_requirement, and eligibility refuses a
-- child with nothing recorded — "This class is restricted and no sex is
-- recorded". So a family could be shut out of a class by a blank field they
-- had no way to fill in, and the only remedy was emailing the registrar, which
-- is the errand this whole page exists to remove.
--
-- Blank remains a legitimate answer: the column has always allowed NULL, and a
-- family who would rather not say should not be made to. It only matters where
-- a class restricts, which is rare, and the page says so rather than implying
-- the co-op needs it for its own sake.
-- =============================================================================

select public.migration_guard('0031', '0030');

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
                   'birth_date', c.birth_date, 'sex', c.sex,
                   'email', c.email, 'phone', c.phone,
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
-- Only the two values the column allows are accepted; anything else becomes
-- NULL rather than raising, so a hand-made payload cannot break a save that is
-- otherwise fine. The check constraint is still the final word.
-- =============================================================================
create or replace function public.clean_sex(p_value text)
returns text
language sql
immutable
as $$
  select case lower(nullif(trim(coalesce(p_value, '')), ''))
           when 'female' then 'female'
           when 'male'   then 'male'
           else null
         end;
$$;

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

  update public.families
     set primary_email = coalesce(nullif(trim(coalesce(p_payload ->> 'primary_email', '')), ''),
                                  primary_email),
         primary_phone = nullif(trim(coalesce(p_payload ->> 'primary_phone', '')), '')
   where id = v_fam_id;

  for v_row in select * from jsonb_array_elements(coalesce(p_payload -> 'parents', '[]'::jsonb))
  loop
    v_id := (v_row ->> 'id')::uuid;
    if v_id is null then
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
      update public.parents
         set first_name = coalesce(nullif(trim(coalesce(v_row ->> 'first_name', '')), ''), first_name),
             last_name  = nullif(trim(coalesce(v_row ->> 'last_name', '')), ''),
             email      = nullif(trim(coalesce(v_row ->> 'email', '')), ''),
             phone      = nullif(trim(coalesce(v_row ->> 'phone', '')), '')
       where id = v_id and family_id = v_fam_id;
      if found then v_changed := v_changed + 1; end if;
    end if;
  end loop;

  for v_row in select * from jsonb_array_elements(coalesce(p_payload -> 'children', '[]'::jsonb))
  loop
    v_id := (v_row ->> 'id')::uuid;

    if v_id is null then
      if nullif(trim(coalesce(v_row ->> 'first_name', '')), '') is not null then
        insert into public.children (family_id, first_name, last_name, birth_date,
                                     sex, email, phone, allergies, medical_notes)
        values (v_fam_id,
                trim(v_row ->> 'first_name'),
                nullif(trim(coalesce(v_row ->> 'last_name', '')), ''),
                (nullif(trim(coalesce(v_row ->> 'birth_date', '')), ''))::date,
                public.clean_sex(v_row ->> 'sex'),
                nullif(trim(coalesce(v_row ->> 'email', '')), ''),
                nullif(trim(coalesce(v_row ->> 'phone', '')), ''),
                nullif(trim(coalesce(v_row ->> 'allergies', '')), ''),
                nullif(trim(coalesce(v_row ->> 'medical_notes', '')), ''));
        v_added := v_added + 1;
      end if;
    else
      select * into v_old from public.children
       where id = v_id and family_id = v_fam_id;

      if v_old.id is null then
        continue;
      end if;

      update public.children
         set first_name    = coalesce(nullif(trim(coalesce(v_row ->> 'first_name', '')), ''), first_name),
             last_name     = nullif(trim(coalesce(v_row ->> 'last_name', '')), ''),
             birth_date    = coalesce((nullif(trim(coalesce(v_row ->> 'birth_date', '')), ''))::date,
                                      birth_date),
             sex           = public.clean_sex(v_row ->> 'sex'),
             email         = nullif(trim(coalesce(v_row ->> 'email', '')), ''),
             phone         = nullif(trim(coalesce(v_row ->> 'phone', '')), ''),
             allergies     = nullif(trim(coalesce(v_row ->> 'allergies', '')), ''),
             medical_notes = nullif(trim(coalesce(v_row ->> 'medical_notes', '')), '')
       where id = v_id and family_id = v_fam_id;
      v_changed := v_changed + 1;

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

select public.record_migration('0031');
