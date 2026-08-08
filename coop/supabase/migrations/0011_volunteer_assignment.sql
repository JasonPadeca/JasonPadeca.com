-- =============================================================================
-- 0011_volunteer_assignment.sql
-- Actually putting volunteers in classes.
--
-- Until now volunteering was only interest: a student said they would help, and
-- an administrator read the list. Nothing recorded who was helping where, so the
-- printed roster a teacher carried had no idea an extra pair of hands was coming.
--
-- A volunteer occupies a person, not a seat:
--
--   * They do not count against capacity. class_seats counts registrations, and
--     a volunteer is not one, so this falls out for free.
--   * They cannot be in two places at once. One volunteer role per period, and
--     assigning one withdraws whatever class they were attending as a STUDENT
--     that hour — which also gives that seat back to the co-op.
--   * Class age limits do not apply. A sixteen-year-old helping with five-year-
--     olds is the entire point; eligibility is about who may attend.
--
-- The displacement is the part worth being careful about, because it silently
-- costs a child a class they chose. Nothing here moves anybody without an
-- administrator being shown exactly what will be given up and saying yes.
-- =============================================================================

create table public.class_volunteers (
  id           uuid primary key default gen_random_uuid(),
  child_id     uuid not null references public.children(id) on delete cascade,
  class_id     uuid not null references public.classes(id) on delete cascade,
  period_id    uuid not null references public.periods(id) on delete cascade,
  semester_id  uuid not null references public.semesters(id) on delete cascade,
  note         text,
  assigned_by  uuid references public.admins(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Derived from the class, exactly as registrations does it, so a volunteer row
-- cannot disagree with the class it points at.
create or replace function public.class_volunteers_sync_parents()
returns trigger
language plpgsql
as $$
begin
  select c.period_id, c.semester_id into new.period_id, new.semester_id
    from public.classes c where c.id = new.class_id;
  if new.period_id is null then
    raise exception 'Class % does not exist', new.class_id;
  end if;
  return new;
end;
$$;

create trigger class_volunteers_sync_parents_trg
  before insert or update of class_id on public.class_volunteers
  for each row execute function public.class_volunteers_sync_parents();

create trigger class_volunteers_touch before update on public.class_volunteers
  for each row execute function public.touch_updated_at();

-- One helper cannot be in two rooms at the same hour.
create unique index class_volunteers_one_per_period
  on public.class_volunteers (child_id, period_id);

create index class_volunteers_class_idx on public.class_volunteers (class_id);
create index class_volunteers_semester_idx on public.class_volunteers (semester_id);

alter table public.class_volunteers enable row level security;
create policy admin_all on public.class_volunteers
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());
revoke all on public.class_volunteers from anon;
grant all on public.class_volunteers to service_role;

-- =============================================================================
-- What would this assignment cost? Asked before doing anything.
-- =============================================================================
create or replace function public.check_volunteer_assignment(
  p_child_id uuid,
  p_class_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_class    public.classes;
  v_child    public.children;
  v_warnings jsonb := '[]'::jsonb;
  v_name     text;
  v_other    text;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_class from public.classes where id = p_class_id;
  select * into v_child from public.children where id = p_child_id;
  if v_class.id is null or v_child.id is null then
    raise exception 'Class or child not found';
  end if;

  v_name := v_child.first_name;

  -- The one that actually costs something: they are attending a class this hour.
  select c.name into v_other
    from public.registrations r
    join public.classes c on c.id = r.class_id
   where r.child_id = p_child_id
     and r.period_id = v_class.period_id
     and r.status = 'registered';

  if v_other is not null then
    v_warnings := v_warnings || jsonb_build_object(
      'kind', 'displaces_student',
      'message', format(
        '%s is currently taking %s during this period. Making them a volunteer here will withdraw them from it, and that seat will go back to the co-op.',
        v_name, v_other));
  end if;

  -- Already helping somewhere else this hour.
  select c.name into v_other
    from public.class_volunteers v
    join public.classes c on c.id = v.class_id
   where v.child_id = p_child_id
     and v.period_id = v_class.period_id
     and v.class_id <> p_class_id;

  if v_other is not null then
    v_warnings := v_warnings || jsonb_build_object(
      'kind', 'displaces_volunteer',
      'message', format('%s is already volunteering in %s during this period. They will be moved.',
                        v_name, v_other));
  end if;

  if not v_child.active or v_child.archived_at is not null then
    v_warnings := v_warnings || jsonb_build_object(
      'kind', 'inactive',
      'message', format('%s is not currently an active member of the program.', v_name));
  end if;

  if exists (
    select 1 from public.semester_participation sp
     where sp.child_id = p_child_id and sp.semester_id = v_class.semester_id
       and not sp.participating
  ) then
    v_warnings := v_warnings || jsonb_build_object(
      'kind', 'sitting_out',
      'message', format('%s is marked as sitting this semester out.', v_name));
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_warnings) = 0,
    'warnings', v_warnings);
end;
$$;

-- =============================================================================
-- Make it so.
--
-- p_confirm must be explicitly true to proceed past any warning, so the
-- displacement can never happen as a side effect of a stray click.
-- =============================================================================
create or replace function public.admin_assign_volunteer(
  p_child_id uuid,
  p_class_id uuid,
  p_note     text default null,
  p_confirm  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class   public.classes;
  v_check   jsonb;
  v_id      uuid;
  v_dropped text;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_class from public.classes where id = p_class_id for update;
  if v_class.id is null then
    raise exception 'Class not found';
  end if;

  v_check := public.check_volunteer_assignment(p_child_id, p_class_id);
  if not (v_check ->> 'ok')::boolean and not p_confirm then
    return jsonb_build_object('ok', false, 'needs_confirmation', true,
                              'warnings', v_check -> 'warnings');
  end if;

  -- Withdraw the class they were attending this hour, freeing the seat. Recorded
  -- as withdrawn rather than cancelled: this was an administrative decision, not
  -- the family changing their mind.
  select c.name into v_dropped
    from public.registrations r join public.classes c on c.id = r.class_id
   where r.child_id = p_child_id and r.period_id = v_class.period_id
     and r.status = 'registered';

  update public.registrations
     set status = 'withdrawn', cancelled_at = now(), waitlisted_at = null
   where child_id = p_child_id
     and period_id = v_class.period_id
     and status = 'registered';

  -- And move them off any other class they were helping with this hour.
  delete from public.class_volunteers
   where child_id = p_child_id and period_id = v_class.period_id;

  insert into public.class_volunteers (child_id, class_id, note, assigned_by)
  values (p_child_id, p_class_id, nullif(trim(coalesce(p_note, '')), ''),
          public.current_admin_id())
  returning id into v_id;

  perform public.write_audit('volunteer_assigned', 'class', p_class_id,
    jsonb_build_object('child_id', p_child_id, 'class_id', p_class_id,
                       'withdrew_from', v_dropped, 'note', p_note,
                       'warnings', v_check -> 'warnings'));

  return jsonb_build_object('ok', true, 'volunteer_id', v_id,
                            'withdrew_from', v_dropped);
end;
$$;

create or replace function public.admin_remove_volunteer(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.class_volunteers;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_row from public.class_volunteers where id = p_id;
  if v_row.id is null then
    raise exception 'Volunteer assignment not found';
  end if;

  delete from public.class_volunteers where id = p_id;

  -- Deliberately does NOT put them back into whatever they were withdrawn from.
  -- That seat may well have gone to somebody else by now, and quietly
  -- re-enrolling them could overfill the class.
  perform public.write_audit('volunteer_removed', 'class', v_row.class_id,
    jsonb_build_object('child_id', v_row.child_id));

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.check_volunteer_assignment(uuid, uuid) to authenticated;
grant execute on function public.admin_assign_volunteer(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.admin_remove_volunteer(uuid) to authenticated;
revoke execute on function public.check_volunteer_assignment(uuid, uuid) from public, anon;
revoke execute on function public.admin_assign_volunteer(uuid, uuid, text, boolean) from public, anon;
revoke execute on function public.admin_remove_volunteer(uuid) from public, anon;

-- =============================================================================
-- Who offered, and where they ended up — one query for the Volunteers tab.
-- =============================================================================
create or replace function public.volunteer_report(p_semester_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select coalesce(jsonb_agg(row_data order by family_name, child_name), '[]'::jsonb)
    into v
  from (
    select f.display_name as family_name,
           (ch.first_name || ' ' || coalesce(ch.last_name, '')) as child_name,
           jsonb_build_object(
             'child_id', ch.id,
             'child_name', trim(ch.first_name || ' ' || coalesce(ch.last_name, '')),
             'family_id', f.id,
             'family_name', f.display_name,
             'family_email', f.primary_email,
             'age', public.age_at(ch.birth_date,
                      coalesce((select class_start_date from public.semesters
                                 where id = p_semester_id), current_date)),
             'note', vi.note,
             'slots', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'period_id', p.id,
                        'period_name', coalesce(p.display_name, 'Period ' || p.period_number),
                        'period_number', p.period_number,
                        'class_id', c.id,
                        'class_name', c.name) order by p.period_number, c.name)
                 from public.volunteer_interest_slot vs
                 join public.periods p on p.id = vs.period_id
                 left join public.classes c on c.id = vs.class_id
                where vs.interest_id = vi.id), '[]'::jsonb),
             -- Where they have actually been placed.
             'assignments', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', v2.id,
                        'class_id', c2.id,
                        'class_name', c2.name,
                        'period_id', p2.id,
                        'period_name', coalesce(p2.display_name, 'Period ' || p2.period_number),
                        'period_number', p2.period_number) order by p2.period_number)
                 from public.class_volunteers v2
                 join public.classes c2 on c2.id = v2.class_id
                 join public.periods p2 on p2.id = v2.period_id
                where v2.child_id = ch.id and v2.semester_id = p_semester_id), '[]'::jsonb)
           ) as row_data
      from public.volunteer_interest vi
      join public.children ch on ch.id = vi.child_id
      join public.families f on f.id = ch.family_id
     where vi.semester_id = p_semester_id
       and vi.wants_to_volunteer
       and ch.active and ch.archived_at is null
  ) s;

  return v;
end;
$$;

revoke execute on function public.volunteer_report(uuid) from public, anon;
grant execute on function public.volunteer_report(uuid) to authenticated, service_role;
