-- =============================================================================
-- 0017_teachers.sql
-- Teachers as people, not as a string.
--
-- classes.teacher_name has always been free text — "Jane Smith & Bob Jones" —
-- and you cannot grant permissions to a string. It stays, because it is what
-- prints on a roster and reads properly when two people share a class. This
-- adds identity beside it: the label and the login are different jobs.
--
-- Teachers stand alone rather than hanging off a family record. Most of them
-- are co-op parents, but not all — a grandfather teaching the automotive class
-- has no child in the program, and a model that assumed otherwise would have no
-- place to put him. A parent who teaches simply has the same address on two
-- records, which is already how an administrator who is also a parent works.
--
-- What a teacher can see is bounded by what they teach: their own classes, the
-- students registered in them, and those students' families. Not the roster of
-- the class across the hall, not the co-op's family list, not the audit log.
-- =============================================================================

select public.migration_guard('0017', '0016');

create table public.teachers (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  email        text not null,
  display_name text,
  active       boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Email is the join key before a teacher has ever signed in: an administrator
-- adds them by address, and auth_user_id binds on first login. Same pattern as
-- admins, for the same reason.
create unique index teachers_email_key on public.teachers (lower(email));

create trigger teachers_touch before update on public.teachers
  for each row execute function public.touch_updated_at();

create table public.class_teachers (
  id         uuid primary key default gen_random_uuid(),
  class_id   uuid not null references public.classes(id) on delete cascade,
  teacher_id uuid not null references public.teachers(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (class_id, teacher_id)
);

create index class_teachers_class_idx on public.class_teachers (class_id);
create index class_teachers_teacher_idx on public.class_teachers (teacher_id);

alter table public.teachers       enable row level security;
alter table public.class_teachers enable row level security;

-- =============================================================================
-- Who am I, and what do I teach?
--
-- SECURITY DEFINER for the same reason current_family_ids() is: these read the
-- very tables the policies that call them protect, and invoker rights would
-- recurse.
-- =============================================================================
create or replace function public.current_teacher_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.id from public.teachers t
   where t.active
     and (t.auth_user_id = auth.uid()
          or lower(t.email) = lower(coalesce(auth.jwt() ->> 'email', '')))
   limit 1;
$$;

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_teacher_id() is not null;
$$;

/** Classes the signed-in teacher teaches. Empty for everybody else. */
create or replace function public.current_taught_class_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(ct.class_id), '{}'::uuid[])
    from public.class_teachers ct
   where ct.teacher_id = public.current_teacher_id();
$$;

/**
 * Children registered in those classes.
 *
 * Confirmed registrations and waitlists both, because a teacher chasing a
 * waitlist needs to know who is on it. Cancelled and withdrawn are excluded:
 * a child who dropped the class in week one is no longer the teacher's to see.
 */
create or replace function public.current_taught_child_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct r.child_id), '{}'::uuid[])
    from public.registrations r
   where r.class_id = any(public.current_taught_class_ids())
     and r.status in ('registered', 'waitlisted');
$$;

/**
 * Anybody who belongs here at all — parent, teacher, or administrator.
 *
 * Used for the things that are not sensitive and that every one of them needs:
 * the class catalogue, the calendar, the program's name. A teacher with no
 * child in the co-op is not a family member, and gating those on
 * is_family_member() alone would leave them looking at an empty page.
 */
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_family_member()
      or public.is_teacher()
      or public.is_active_admin();
$$;

grant execute on function public.current_teacher_id()       to authenticated;
grant execute on function public.is_teacher()               to authenticated;
grant execute on function public.current_taught_class_ids() to authenticated;
grant execute on function public.current_taught_child_ids() to authenticated;
grant execute on function public.is_member()                to authenticated;

revoke execute on function public.current_teacher_id()       from public, anon;
revoke execute on function public.is_teacher()               from public, anon;
revoke execute on function public.current_taught_class_ids() from public, anon;
revoke execute on function public.current_taught_child_ids() from public, anon;
revoke execute on function public.is_member()                from public, anon;

-- =============================================================================
-- Policies
-- =============================================================================
create policy admin_all on public.teachers
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

create policy teacher_reads_self on public.teachers
  for select to authenticated
  using (id = public.current_teacher_id());

create policy admin_all on public.class_teachers
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

create policy teacher_reads_own on public.class_teachers
  for select to authenticated
  using (teacher_id = public.current_teacher_id());

-- --- What a teacher can see of the co-op ------------------------------------
create policy teacher_reads_taught on public.classes
  for select to authenticated
  using (id = any(public.current_taught_class_ids()));

create policy teacher_reads_students on public.children
  for select to authenticated
  using (id = any(public.current_taught_child_ids()));

create policy teacher_reads_student_families on public.families
  for select to authenticated
  using (id in (
    select ch.family_id from public.children ch
     where ch.id = any(public.current_taught_child_ids())));

create policy teacher_reads_student_parents on public.parents
  for select to authenticated
  using (family_id in (
    select ch.family_id from public.children ch
     where ch.id = any(public.current_taught_child_ids())));

create policy teacher_reads_own_registrations on public.registrations
  for select to authenticated
  using (class_id = any(public.current_taught_class_ids()));

-- Absences of their own students. This is the point of collecting them.
create policy teacher_reads_student_absences on public.absences
  for select to authenticated
  using (child_id = any(public.current_taught_child_ids()));

create policy teacher_reads_student_absence_periods on public.absence_periods
  for select to authenticated
  using (absence_id in (
    select id from public.absences
     where child_id = any(public.current_taught_child_ids())));

create policy teacher_reads_own_volunteers on public.class_volunteers
  for select to authenticated
  using (class_id = any(public.current_taught_class_ids()));

-- --- The shared, non-sensitive furniture -------------------------------------
-- Widened from is_family_member() to is_member(), so a teacher who is not a
-- parent can still see the timetable they teach inside.
drop policy if exists member_reads_catalogue on public.semesters;
create policy member_reads_catalogue on public.semesters
  for select to authenticated using (public.is_member());

drop policy if exists member_reads_catalogue on public.periods;
create policy member_reads_catalogue on public.periods
  for select to authenticated using (public.is_member());

drop policy if exists member_reads_settings on public.settings;
create policy member_reads_settings on public.settings
  for select to authenticated using (public.is_member());

drop policy if exists member_reads on public.meeting_dates;
create policy member_reads on public.meeting_dates
  for select to authenticated using (public.is_member());

-- Seat counts likewise: a teacher needs to know their own class is full.
create or replace function public.class_seat_counts()
returns table (
  class_id         uuid,
  capacity         integer,
  registered_count bigint,
  waitlisted_count bigint,
  seats_open       integer,
  is_full          boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select cs.class_id, cs.capacity, cs.registered_count, cs.waitlisted_count,
         cs.seats_open, cs.is_full
    from public.class_seats cs
   where public.is_member();
$$;

revoke execute on function public.class_seat_counts() from public, anon;
grant execute on function public.class_seat_counts() to authenticated;

revoke all on public.teachers, public.class_teachers from anon;
grant select on public.teachers, public.class_teachers to authenticated;
grant all on public.teachers, public.class_teachers to service_role;

-- =============================================================================
-- establish_session, now answering "what am I?"
--
-- One call after sign-in decides where a person lands. A parent goes to their
-- family page and finds Teacher and Administration buttons if they are also
-- those things. Somebody who only teaches goes straight to the teacher page and
-- never learns that family pages exist.
-- =============================================================================
create or replace function public.establish_session()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text := lower(nullif(trim(coalesce(auth.jwt() ->> 'email', '')), ''));
  v_admin   public.admins;
  v_teacher public.teachers;
  v_fams    jsonb;
  v_teaches jsonb;
begin
  if v_uid is null or v_email is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  -- --- administrator --------------------------------------------------------
  select * into v_admin from public.admins
   where lower(email) = v_email and active;

  if v_admin.id is not null and v_admin.auth_user_id is distinct from v_uid then
    update public.admins set auth_user_id = v_uid where id = v_admin.id;
  end if;

  -- --- teacher --------------------------------------------------------------
  select * into v_teacher from public.teachers
   where lower(email) = v_email and active;

  if v_teacher.id is not null and v_teacher.auth_user_id is distinct from v_uid then
    update public.teachers set auth_user_id = v_uid where id = v_teacher.id;
  end if;

  -- --- family membership, claimed from the verified address -----------------
  insert into public.family_users (auth_user_id, family_id, email)
  select v_uid, f.id, v_email
    from public.families f
   where f.active and f.archived_at is null
     and lower(f.primary_email) = v_email
  on conflict (auth_user_id, family_id) do nothing;

  insert into public.family_users (auth_user_id, family_id, email)
  select v_uid, p.family_id, v_email
    from public.parents p
    join public.families f on f.id = p.family_id
   where f.active and f.archived_at is null
     and lower(p.email) = v_email
  on conflict (auth_user_id, family_id) do nothing;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'display_name', f.display_name)), '[]'::jsonb)
    into v_fams
    from public.families f
   where f.id = any(public.current_family_ids());

  -- Classes this person teaches, in timetable order.
  select coalesce(jsonb_agg(jsonb_build_object(
           'class_id', c.id,
           'class_name', c.name,
           'semester_id', c.semester_id,
           'semester_name', s.name,
           'period_number', p.period_number,
           'period_name', coalesce(p.display_name, 'Period ' || p.period_number)
         ) order by s.class_start_date desc nulls last, p.period_number), '[]'::jsonb)
    into v_teaches
    from public.class_teachers ct
    join public.classes c on c.id = ct.class_id
    join public.periods p on p.id = c.period_id
    join public.semesters s on s.id = c.semester_id
   where ct.teacher_id = v_teacher.id
     and c.archived_at is null
     and s.archived_at is null;

  return jsonb_build_object(
    'ok', true,
    'email', v_email,
    'is_admin', v_admin.id is not null,
    'admin_role', v_admin.role,
    'is_teacher', v_teacher.id is not null,
    'teacher_name', v_teacher.display_name,
    'teaches', coalesce(v_teaches, '[]'::jsonb),
    'families', v_fams,
    'recognised', v_admin.id is not null
                  or v_teacher.id is not null
                  or jsonb_array_length(v_fams) > 0);
end;
$$;

revoke execute on function public.establish_session() from public, anon;
grant execute on function public.establish_session() to authenticated;

-- =============================================================================
-- One class as its teacher sees it: the roster, with what they need to teach
-- safely, and who is away on a given day.
--
-- A separate function rather than the admin roster with a flag. The admin view
-- returns everything; this returns what a teacher is entitled to. A flag on one
-- query is one mistake away from handing somebody another family's medical
-- notes, and that is the failure this system most needs never to have.
-- =============================================================================
create or replace function public.teacher_class_view(
  p_class_id uuid,
  p_meeting_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_class public.classes;
  v_admin boolean := public.is_active_admin();
begin
  if not v_admin and not (p_class_id = any(public.current_taught_class_ids())) then
    raise exception 'Not authorized';
  end if;

  select * into v_class from public.classes where id = p_class_id;
  if v_class.id is null then
    raise exception 'Class not found';
  end if;

  return jsonb_build_object(
    'ok', true,
    'class', jsonb_build_object(
      'id', v_class.id, 'name', v_class.name, 'description', v_class.description,
      'teacher_name', v_class.teacher_name, 'location', v_class.location,
      'age_min', v_class.age_min, 'age_max', v_class.age_max,
      'sex_requirement', v_class.sex_requirement, 'capacity', v_class.capacity),
    'period', (select jsonb_build_object(
        'id', p.id, 'number', p.period_number,
        'name', coalesce(p.display_name, 'Period ' || p.period_number),
        'start_time', p.start_time, 'end_time', p.end_time)
      from public.periods p where p.id = v_class.period_id),
    'semester', (select jsonb_build_object(
        'id', s.id, 'name', s.name,
        'class_start_date', s.class_start_date, 'class_end_date', s.class_end_date)
      from public.semesters s where s.id = v_class.semester_id),
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
               'child_id', ch.id,
               'name', trim(ch.first_name || ' ' || coalesce(ch.last_name, '')),
               'age', public.age_at(ch.birth_date, (
                 select class_start_date from public.semesters where id = v_class.semester_id)),
               'email', ch.email,
               'allergies', ch.allergies,
               'medical_notes', ch.medical_notes,
               'family_name', f.display_name,
               'family_email', f.primary_email,
               'family_phone', coalesce(f.primary_phone, (
                 select p2.phone from public.parents p2
                  where p2.family_id = f.id and p2.phone is not null
                  order by p2.sort_order limit 1)),
               'status', r.status,
               -- Away on the meeting being looked at, if one was named.
               'absent', p_meeting_id is not null and exists (
                 select 1 from public.absences a
                  where a.child_id = ch.id and a.meeting_id = p_meeting_id
                    and (a.whole_day or exists (
                      select 1 from public.absence_periods ap
                       where ap.absence_id = a.id and ap.period_id = v_class.period_id))),
               'absence_reason', (
                 select a.reason from public.absences a
                  where a.child_id = ch.id and a.meeting_id = p_meeting_id)
             ) order by ch.last_name nulls last, ch.first_name)
        from public.registrations r
        join public.children ch on ch.id = r.child_id
        join public.families f on f.id = ch.family_id
       where r.class_id = p_class_id and r.status = 'registered'), '[]'::jsonb),
    'waitlist', coalesce((
      select jsonb_agg(jsonb_build_object(
               'child_id', ch.id,
               'name', trim(ch.first_name || ' ' || coalesce(ch.last_name, '')),
               'family_name', f.display_name) order by r.waitlisted_at)
        from public.registrations r
        join public.children ch on ch.id = r.child_id
        join public.families f on f.id = ch.family_id
       where r.class_id = p_class_id and r.status = 'waitlisted'), '[]'::jsonb),
    'helpers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', trim(ch.first_name || ' ' || coalesce(ch.last_name, '')),
               'note', v.note))
        from public.class_volunteers v
        join public.children ch on ch.id = v.child_id
       where v.class_id = p_class_id), '[]'::jsonb));
end;
$$;

revoke execute on function public.teacher_class_view(uuid, uuid) from public, anon;
grant execute on function public.teacher_class_view(uuid, uuid) to authenticated;

select public.record_migration('0017');
