-- =============================================================================
-- 0034_adult_helpers.sql
-- Parents helping in classes.
--
-- Not to be confused with the volunteer machinery that already exists: that is
-- for STUDENTS, older children helping in the younger children's classes, and
-- it carries an age limit and its own tables. This is adults. A parent says
-- which classes they would be willing to work in, an administrator places them,
-- and the class shows who it has against how many it needs.
--
-- Deliberately separate tables rather than a "kind" column on the existing
-- ones. The two look similar and behave differently: a student volunteer gives
-- up their own class place to help, is limited to the younger ages, and
-- displaces a registration. An adult does none of those things. Sharing a table
-- would mean every query carrying a filter nobody remembers the reason for.
--
-- Two numbers matter and both are set by a person, not inferred:
--
--   classes.adult_helper_limit    how many adults this class wants
--   settings.helper_target        how many classes a parent is expected to take
--
-- The second is what turns an administrator's screen from red to green.
-- =============================================================================

select public.migration_guard('0034', '0033');

alter table public.classes
  add column if not exists adult_helper_limit integer not null default 2
    check (adult_helper_limit >= 0);

comment on column public.classes.adult_helper_limit is
  'How many adult helpers this class wants. Shown as "1/2" on the class page.';

alter table public.settings
  add column if not exists helper_target integer not null default 2
    check (helper_target >= 0);

comment on column public.settings.helper_target is
  'How many classes a parent is expected to help with. A parent with this many '
  'assignments reads as done on the helper board.';

-- =============================================================================
-- What a parent is willing to do.
--
-- One row per class they tick. No period column: a parent saying "I would
-- happily do Art" is expressing willingness, not booking a slot, and the period
-- is a property of the class anyway.
-- =============================================================================
create table if not exists public.helper_interest (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid not null references public.parents(id)   on delete cascade,
  semester_id uuid not null references public.semesters(id) on delete cascade,
  class_id    uuid not null references public.classes(id)   on delete cascade,
  created_at  timestamptz not null default now(),
  unique (parent_id, semester_id, class_id)
);

-- Anything they want to say that a tick box cannot carry: "mornings only",
-- "happy to help but not to lead", "I have a baby with me".
create table if not exists public.helper_note (
  parent_id   uuid not null references public.parents(id)   on delete cascade,
  semester_id uuid not null references public.semesters(id) on delete cascade,
  note        text,
  submitted_at timestamptz not null default now(),
  primary key (parent_id, semester_id)
);

create index if not exists helper_interest_semester_idx
  on public.helper_interest (semester_id, class_id);

-- =============================================================================
-- Where an administrator actually put them.
--
-- One class per period per parent, enforced rather than trusted: a person
-- cannot be in two rooms at the same hour, and a screen that lets you choose it
-- will eventually be used to choose it.
-- =============================================================================
create table if not exists public.class_adult_helpers (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid not null references public.parents(id)   on delete cascade,
  class_id    uuid not null references public.classes(id)   on delete cascade,
  semester_id uuid not null references public.semesters(id) on delete cascade,
  period_id   uuid not null references public.periods(id)   on delete cascade,
  note        text,
  assigned_by uuid references public.admins(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (parent_id, period_id),
  unique (parent_id, class_id)
);

create index if not exists class_adult_helpers_class_idx
  on public.class_adult_helpers (class_id);

alter table public.helper_interest       enable row level security;
alter table public.helper_note           enable row level security;
alter table public.class_adult_helpers   enable row level security;

create policy admin_all on public.helper_interest
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());
create policy admin_all on public.helper_note
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());
create policy admin_all on public.class_adult_helpers
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

-- A parent may see their own, in both tables.
create policy family_reads_own on public.helper_interest
  for select to authenticated
  using (parent_id in (select id from public.parents
                        where family_id = any(public.current_family_ids())));
create policy family_reads_own on public.helper_note
  for select to authenticated
  using (parent_id in (select id from public.parents
                        where family_id = any(public.current_family_ids())));
create policy family_reads_own on public.class_adult_helpers
  for select to authenticated
  using (parent_id in (select id from public.parents
                        where family_id = any(public.current_family_ids())));

grant select on public.helper_interest, public.helper_note,
                public.class_adult_helpers to authenticated;
grant all    on public.helper_interest, public.helper_note,
                public.class_adult_helpers to service_role;


-- =============================================================================
-- The parent's page: every class this semester, and what they said last time.
--
-- Returns every class rather than only the ones they ticked, because the page
-- is a form to fill in, not a receipt. Which parent is asking comes from the
-- session — a page that let you name yourself would let you name somebody else.
-- =============================================================================
create or replace function public.helper_form(p_semester_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fams uuid[] := public.current_family_ids();
  v_sem  public.semesters;
begin
  if array_length(v_fams, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no_family');
  end if;

  select * into v_sem from public.semesters
   where archived_at is null
     and (p_semester_id is null or id = p_semester_id)
   order by class_start_date desc nulls last
   limit 1;

  if v_sem.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_semester');
  end if;

  return jsonb_build_object(
    'ok', true,
    'semester', jsonb_build_object('id', v_sem.id, 'name', v_sem.name),
    -- Everybody on the family's record who could help.
    'parents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pa.id,
               'name', trim(pa.first_name || ' ' || coalesce(pa.last_name, '')),
               'note', (select hn.note from public.helper_note hn
                         where hn.parent_id = pa.id and hn.semester_id = v_sem.id),
               'wants', coalesce((
                 select jsonb_agg(hi.class_id)
                   from public.helper_interest hi
                  where hi.parent_id = pa.id and hi.semester_id = v_sem.id), '[]'::jsonb),
               'assigned', coalesce((
                 select jsonb_agg(jsonb_build_object('class', c.name, 'period', pe.display_name))
                   from public.class_adult_helpers ah
                   join public.classes c  on c.id  = ah.class_id
                   join public.periods pe on pe.id = ah.period_id
                  where ah.parent_id = pa.id and ah.semester_id = v_sem.id), '[]'::jsonb))
             order by pa.sort_order, pa.first_name)
        from public.parents pa where pa.family_id = any(v_fams)), '[]'::jsonb),
    'periods', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pe.id, 'name', pe.display_name,
               'start_time', pe.start_time, 'end_time', pe.end_time,
               'classes', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', c.id, 'name', c.name,
                          'description', c.description,
                          'age_min', c.age_min, 'age_max', c.age_max,
                          'helpers_wanted', c.adult_helper_limit,
                          'helpers_have', (select count(*) from public.class_adult_helpers ah
                                            where ah.class_id = c.id))
                        order by c.option_number, c.name)
                   from public.classes c
                  where c.period_id = pe.id and c.archived_at is null), '[]'::jsonb))
             order by pe.sort_order, pe.period_number)
        from public.periods pe
       where pe.semester_id = v_sem.id and pe.archived_at is null), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.helper_form(uuid) from public, anon;
grant execute on function public.helper_form(uuid) to authenticated;

-- =============================================================================
-- A parent saying what they are willing to do.
--
-- Replaces their whole answer for the semester rather than merging: the page
-- shows every class with a tick box, so what arrives IS the complete answer,
-- and un-ticking something has to mean something.
-- =============================================================================
create or replace function public.submit_helper_interest(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fams   uuid[] := public.current_family_ids();
  v_parent uuid   := (p_payload ->> 'parent_id')::uuid;
  v_sem    uuid   := (p_payload ->> 'semester_id')::uuid;
  v_n      int    := 0;
begin
  if array_length(v_fams, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no_family');
  end if;

  -- The page offers only this family's parents. That is not a boundary.
  if not exists (select 1 from public.parents
                  where id = v_parent and family_id = any(v_fams)) then
    return jsonb_build_object('ok', false, 'error', 'not_your_family');
  end if;

  delete from public.helper_interest
   where parent_id = v_parent and semester_id = v_sem;

  insert into public.helper_interest (parent_id, semester_id, class_id)
  select v_parent, v_sem, (value #>> '{}')::uuid
    from jsonb_array_elements(coalesce(p_payload -> 'class_ids', '[]'::jsonb))
   where exists (select 1 from public.classes c
                  where c.id = (value #>> '{}')::uuid and c.semester_id = v_sem)
  on conflict do nothing;

  get diagnostics v_n = row_count;

  insert into public.helper_note (parent_id, semester_id, note, submitted_at)
  values (v_parent, v_sem, nullif(trim(coalesce(p_payload ->> 'note', '')), ''), now())
  on conflict (parent_id, semester_id)
    do update set note = excluded.note, submitted_at = now();

  perform public.write_audit('helper_interest_submitted', 'parent', v_parent,
    jsonb_build_object('semester_id', v_sem, 'classes', v_n));

  return jsonb_build_object('ok', true, 'classes', v_n);
end;
$$;

revoke execute on function public.submit_helper_interest(jsonb) from public, anon;
grant execute on function public.submit_helper_interest(jsonb) to authenticated;


-- =============================================================================
-- The board: one object per parent.
--
-- Every parent in the co-op, not only the ones who replied — the question the
-- screen answers is "who still needs placing", and a parent who ignored the
-- email is exactly who that means. They arrive with an empty list of wants and
-- no assignments, which is the honest picture.
-- =============================================================================
create or replace function public.helper_board(p_semester_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  return jsonb_build_object(
    'ok', true,
    'target', (select helper_target from public.settings where id = 1),
    'periods', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pe.id, 'name', pe.display_name,
               'classes', coalesce((
                 select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
                        order by c.option_number, c.name)
                   from public.classes c
                  where c.period_id = pe.id and c.archived_at is null), '[]'::jsonb))
             order by pe.sort_order, pe.period_number)
        from public.periods pe
       where pe.semester_id = p_semester_id and pe.archived_at is null), '[]'::jsonb),

    'parents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pa.id,
               'name', trim(pa.first_name || ' ' || coalesce(pa.last_name, '')),
               'family', f.display_name,
               'email', pa.email,
               'replied', exists (select 1 from public.helper_note hn
                                   where hn.parent_id = pa.id and hn.semester_id = p_semester_id),
               'note', (select hn.note from public.helper_note hn
                         where hn.parent_id = pa.id and hn.semester_id = p_semester_id),
               -- What they offered.
               'wants', coalesce((
                 select jsonb_agg(jsonb_build_object('class_id', c.id, 'class', c.name,
                                                     'period_id', c.period_id)
                        order by c.name)
                   from public.helper_interest hi
                   join public.classes c on c.id = hi.class_id
                  where hi.parent_id = pa.id and hi.semester_id = p_semester_id), '[]'::jsonb),
               -- Where they have been put, keyed by period so a dropdown can
               -- show its current value without hunting.
               'assigned', coalesce((
                 select jsonb_object_agg(ah.period_id::text, jsonb_build_object(
                          'id', ah.id, 'class_id', ah.class_id, 'class', c.name))
                   from public.class_adult_helpers ah
                   join public.classes c on c.id = ah.class_id
                  where ah.parent_id = pa.id and ah.semester_id = p_semester_id), '{}'::jsonb))
             order by f.display_name, pa.sort_order, pa.first_name)
        from public.parents pa
        join public.families f on f.id = pa.family_id
       where f.archived_at is null), '[]'::jsonb),

    -- The reference pane: every class, how many helpers it wants, how many it
    -- has, and whether any student places are left. One query, so the two
    -- halves of the screen can never disagree about a number.
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'name', c.name,
               'period', pe.display_name, 'period_id', pe.id,
               'period_sort', coalesce(pe.sort_order, pe.period_number),
               'helpers_wanted', c.adult_helper_limit,
               'helpers_have', (select count(*) from public.class_adult_helpers ah
                                 where ah.class_id = c.id),
               'student_capacity', c.capacity,
               'students_taken', (select count(*) from public.registrations r
                                   where r.class_id = c.id and r.status = 'registered'))
             order by coalesce(pe.sort_order, pe.period_number), c.option_number, c.name)
        from public.classes c
        join public.periods pe on pe.id = c.period_id
       where c.semester_id = p_semester_id and c.archived_at is null), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.helper_board(uuid) from public, anon;
grant execute on function public.helper_board(uuid) to authenticated;

-- =============================================================================
-- Placing a parent, and taking them out again.
--
-- Refuses to overfill a class. The limit is a number somebody chose, and a
-- screen that silently exceeds it makes the number decorative — but the message
-- says what the limit is, so raising it is an obvious next move rather than a
-- mystery.
-- =============================================================================
create or replace function public.assign_adult_helper(
  p_parent_id uuid,
  p_class_id  uuid,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class public.classes;
  v_have  int;
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_class from public.classes where id = p_class_id;
  if v_class.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_such_class');
  end if;

  select count(*) into v_have from public.class_adult_helpers
   where class_id = p_class_id;

  if v_have >= v_class.adult_helper_limit then
    return jsonb_build_object('ok', false, 'error', 'class_full',
      'wanted', v_class.adult_helper_limit, 'have', v_have);
  end if;

  -- One class per period. Replacing rather than refusing: choosing a different
  -- class in the same period is a correction, not a mistake.
  delete from public.class_adult_helpers
   where parent_id = p_parent_id and period_id = v_class.period_id;

  insert into public.class_adult_helpers
    (parent_id, class_id, semester_id, period_id, note, assigned_by)
  values (p_parent_id, p_class_id, v_class.semester_id, v_class.period_id,
          nullif(trim(coalesce(p_note, '')), ''), public.current_admin_id());

  perform public.write_audit('adult_helper_assigned', 'class', p_class_id,
    jsonb_build_object('parent_id', p_parent_id));

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.remove_adult_helper(
  p_parent_id uuid,
  p_period_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  delete from public.class_adult_helpers
   where parent_id = p_parent_id and period_id = p_period_id;

  perform public.write_audit('adult_helper_removed', 'parent', p_parent_id,
    jsonb_build_object('period_id', p_period_id));

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.assign_adult_helper(uuid, uuid, text) from public, anon;
revoke execute on function public.remove_adult_helper(uuid, uuid) from public, anon;
grant execute on function public.assign_adult_helper(uuid, uuid, text) to authenticated;
grant execute on function public.remove_adult_helper(uuid, uuid) to authenticated;

-- =============================================================================
-- Who is helping with one class — for the class page.
-- =============================================================================
create or replace function public.class_adult_helper_list(p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_class public.classes;
begin
  if not (public.is_active_admin() or public.is_teacher()) then
    raise exception 'Not authorized';
  end if;

  select * into v_class from public.classes where id = p_class_id;
  if v_class.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_such_class');
  end if;

  return jsonb_build_object(
    'ok', true,
    'wanted', v_class.adult_helper_limit,
    'helpers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ah.id, 'parent_id', pa.id,
               'name', trim(pa.first_name || ' ' || coalesce(pa.last_name, '')),
               'family', f.display_name,
               'email', pa.email, 'phone', pa.phone,
               'note', ah.note)
             order by pa.first_name)
        from public.class_adult_helpers ah
        join public.parents pa  on pa.id = ah.parent_id
        join public.families f  on f.id  = pa.family_id
       where ah.class_id = p_class_id), '[]'::jsonb));
end;
$$;

revoke execute on function public.class_adult_helper_list(uuid) from public, anon;
grant execute on function public.class_adult_helper_list(uuid) to authenticated;

select public.record_migration('0034');
