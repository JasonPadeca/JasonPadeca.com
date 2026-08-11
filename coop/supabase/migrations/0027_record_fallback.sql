-- =============================================================================
-- 0027_record_fallback.sql
-- A record with no snapshot should still show you the family.
--
-- Registrations submitted before 0025 have no snapshot, because nothing was
-- keeping one. The reader said so honestly and then showed nothing else — which
-- is accurate and useless. The question an administrator is asking is "who is
-- in this family and how old are they", and that is answerable whether or not
-- a snapshot exists; it is only the AS AT that differs.
--
-- So the record now always carries the family as it stands today, alongside the
-- snapshot when there is one. The reader shows the snapshot where it has one
-- and today's details where it does not, saying plainly which it is looking at.
-- An old registration is no longer a blank page.
-- =============================================================================

select public.migration_guard('0027', '0026');

create or replace function public.registration_record(
  p_family_id   uuid,
  p_semester_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_reg   public.semester_registrations;
  v_snap  jsonb;
  v_drift jsonb;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_reg from public.semester_registrations
   where family_id = p_family_id and semester_id = p_semester_id;

  if v_reg.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_registration');
  end if;

  v_snap := v_reg.form_data -> 'snapshot';

  if v_snap is null then
    v_drift := null;
  else
    select coalesce(jsonb_agg(d), '[]'::jsonb) into v_drift
      from (
        select jsonb_build_object(
                 'child', (snap ->> 'first_name') || ' ' || coalesce(snap ->> 'last_name', ''),
                 'field', 'date of birth',
                 'was', snap ->> 'birth_date',
                 'now', c.birth_date::text
               ) as d
          from jsonb_array_elements(v_snap -> 'children') snap
          join public.children c on c.id = (snap ->> 'id')::uuid
         where (snap ->> 'birth_date') is distinct from c.birth_date::text
      ) t;
  end if;

  return jsonb_build_object(
    'ok', true,
    'family_id', p_family_id,
    'semester_id', p_semester_id,
    'status', v_reg.status,
    'submitted_at', v_reg.form_submitted_at,
    'agreed_conduct_at', v_reg.agreed_conduct_at,
    'reviewed_at', v_reg.reviewed_at,
    'payment_received_at', v_reg.payment_received_at,
    'payment_note', v_reg.payment_note,
    'registered_at', v_reg.registered_at,
    'outstanding_at_registration', v_reg.outstanding_at_registration,
    'answers', v_reg.form_data - 'snapshot',
    'snapshot', v_snap,
    -- The family as it stands right now. Always present, so a record without a
    -- snapshot still answers who is in this family.
    'current', public.build_registration_snapshot(p_family_id, p_semester_id),
    'drift', v_drift
  );
end;
$$;

revoke execute on function public.registration_record(uuid, uuid) from public, anon;
grant execute on function public.registration_record(uuid, uuid) to authenticated;

select public.record_migration('0027');
