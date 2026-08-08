-- =============================================================================
-- 0018_announcements.sql
-- Handouts and notices, attached to a week.
--
-- What a teacher wants to do is put something where the right parents will find
-- it: this week's worksheet, "bring an apron next time", "no class on the 26th".
-- Now that a week is a row, all three hang off one.
--
-- Three shapes, from one table:
--
--   class + meeting  — "Chemistry, 25 September": the worksheet for that week
--   class, no meeting — standing information for the class: the supply list
--   neither          — the whole co-op, from an administrator
--
-- Who may read one follows from what it is attached to. A class announcement
-- reaches the families of children registered in that class, its teachers, and
-- administrators. Nobody else — a parent cannot browse the handouts of a class
-- their child is not in.
--
-- Files live in Supabase Storage under the class id, so the same rule can be
-- expressed on the object as on the row. A handout is only ever as private as
-- the path it sits at, and putting them all in one folder would have meant any
-- signed-in parent could fetch any of them by guessing a name.
-- =============================================================================

select public.migration_guard('0018', '0017');

create table public.announcements (
  id           uuid primary key default gen_random_uuid(),
  semester_id  uuid not null references public.semesters(id) on delete cascade,

  -- NULL means the whole co-op. Only an administrator may post one of those.
  class_id     uuid references public.classes(id) on delete cascade,

  -- NULL means it stands for the term rather than belonging to one week.
  meeting_id   uuid references public.meeting_dates(id) on delete cascade,

  title        text not null,
  body         text,

  -- A link is often the whole handout — a co-op that already lives in Google
  -- Drive should not have to re-upload everything to use this.
  link_url     text,
  link_label   text,

  -- Storage path, when a file was uploaded instead. Kept alongside rather than
  -- instead of link_url: some notices are a file, some a link, some both.
  file_path    text,
  file_name    text,
  file_size    integer,

  posted_by_teacher uuid references public.teachers(id) on delete set null,
  posted_by_admin   uuid references public.admins(id) on delete set null,
  posted_by_name    text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Something has to be said. A title with no body, link, or file is an empty
  -- notice that still generates a row and a "new this week" badge.
  constraint announcement_has_content
    check (body is not null or link_url is not null or file_path is not null)
);

create index announcements_class_idx on public.announcements (class_id, created_at desc);
create index announcements_meeting_idx on public.announcements (meeting_id);
create index announcements_semester_idx on public.announcements (semester_id, created_at desc);

create trigger announcements_touch before update on public.announcements
  for each row execute function public.touch_updated_at();

alter table public.announcements enable row level security;

-- -----------------------------------------------------------------------------
-- Classes the signed-in parent's children are registered in.
--
-- The read rule for a class announcement, and the one a parent's classmate list
-- is checked against too.
-- -----------------------------------------------------------------------------
create or replace function public.current_family_class_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct r.class_id), '{}'::uuid[])
    from public.registrations r
   where r.child_id = any(public.current_child_ids())
     and r.status = 'registered';
$$;

revoke execute on function public.current_family_class_ids() from public, anon;
grant execute on function public.current_family_class_ids() to authenticated;

-- -----------------------------------------------------------------------------
-- Reading
-- -----------------------------------------------------------------------------
create policy admin_all on public.announcements
  for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

create policy member_reads on public.announcements
  for select to authenticated
  using (
    -- Co-op wide.
    class_id is null
    -- A class one of my children is in.
    or class_id = any(public.current_family_class_ids())
    -- A class I teach.
    or class_id = any(public.current_taught_class_ids())
  );

-- Teachers post to their own classes and nowhere else. A NULL class_id would be
-- a co-op-wide notice, which is an administrator's to send.
create policy teacher_posts on public.announcements
  for insert to authenticated
  with check (
    class_id is not null
    and class_id = any(public.current_taught_class_ids())
  );

create policy teacher_edits_own on public.announcements
  for update to authenticated
  using (class_id = any(public.current_taught_class_ids()))
  with check (class_id = any(public.current_taught_class_ids()));

create policy teacher_deletes_own on public.announcements
  for delete to authenticated
  using (class_id = any(public.current_taught_class_ids()));

revoke all on public.announcements from anon;
grant select, insert, update, delete on public.announcements to authenticated;
grant all on public.announcements to service_role;

-- =============================================================================
-- Files.
--
-- A private bucket, with the class id as the first path segment so a storage
-- policy can apply the same rule the row does. Co-op-wide handouts go under
-- "general".
--
-- 10 MB a file. The free plan allows a gigabyte in total, and a co-op that
-- uploads scans rather than PDFs would eat that in a term — a cap now is kinder
-- than a wall in November.
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('handouts', 'handouts', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

-- Compared as text rather than cast to uuid: a path segment that is not a uuid
-- would raise on the cast, and an error inside a policy is a locked door for
-- everybody rather than a denied row for one person.
create or replace function public.handout_folder_readable(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_admin()
      or (p_folder = 'general' and public.is_member())
      or p_folder in (select c::text from unnest(public.current_taught_class_ids()) c)
      or p_folder in (select c::text from unnest(public.current_family_class_ids()) c);
$$;

create or replace function public.handout_folder_writable(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_admin()
      or p_folder in (select c::text from unnest(public.current_taught_class_ids()) c);
$$;

revoke execute on function public.handout_folder_readable(text) from public, anon;
revoke execute on function public.handout_folder_writable(text) from public, anon;
grant execute on function public.handout_folder_readable(text) to authenticated;
grant execute on function public.handout_folder_writable(text) to authenticated;

drop policy if exists handouts_read on storage.objects;
create policy handouts_read on storage.objects
  for select to authenticated
  using (bucket_id = 'handouts'
         and public.handout_folder_readable((storage.foldername(name))[1]));

drop policy if exists handouts_write on storage.objects;
create policy handouts_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'handouts'
              and public.handout_folder_writable((storage.foldername(name))[1]));

drop policy if exists handouts_delete on storage.objects;
create policy handouts_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'handouts'
         and public.handout_folder_writable((storage.foldername(name))[1]));

-- =============================================================================
-- Who else is in my child's class?
--
-- Names, and nothing else. A parent has no need of another family's phone
-- number, and none whatsoever of their child's medical notes.
--
-- A separate function rather than a filtered roster query, because the shape it
-- returns IS the guarantee. There is no argument that widens it, so no future
-- change to a caller can widen it either.
-- =============================================================================
create or replace function public.classmates(p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Only for a class one of your own children is actually in.
  if not (p_class_id = any(public.current_family_class_ids()))
     and not (p_class_id = any(public.current_taught_class_ids()))
     and not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('name', nm) order by nm)
      from (
        select trim(ch.first_name || ' ' || coalesce(ch.last_name, '')) as nm
          from public.registrations r
          join public.children ch on ch.id = r.child_id
         where r.class_id = p_class_id
           and r.status = 'registered'
      ) s
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.classmates(uuid) from public, anon;
grant execute on function public.classmates(uuid) to authenticated;

-- =============================================================================
-- A parent's week: their children's classes on one day, with anything posted.
-- =============================================================================
create or replace function public.family_week(p_meeting_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_meeting public.meeting_dates;
begin
  select * into v_meeting from public.meeting_dates where id = p_meeting_id;
  if v_meeting.id is null then
    raise exception 'No such class day';
  end if;

  return jsonb_build_object(
    'ok', true,
    'meeting', jsonb_build_object(
      'id', v_meeting.id, 'meets_on', v_meeting.meets_on,
      'cancelled', v_meeting.cancelled, 'cancel_reason', v_meeting.cancel_reason,
      'note', v_meeting.note),

    'children', coalesce((
      select jsonb_agg(jsonb_build_object(
               'child_id', ch.id,
               'name', trim(ch.first_name || ' ' || coalesce(ch.last_name, '')),
               'absent', exists (
                 select 1 from public.absences a
                  where a.child_id = ch.id and a.meeting_id = p_meeting_id),
               'absence_whole_day', (
                 select a.whole_day from public.absences a
                  where a.child_id = ch.id and a.meeting_id = p_meeting_id),
               'classes', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'class_id', c.id,
                          'class_name', c.name,
                          'teacher_name', c.teacher_name,
                          'location', c.location,
                          'period_number', p.period_number,
                          'period_name', coalesce(p.display_name, 'Period ' || p.period_number),
                          'start_time', p.start_time,
                          'end_time', p.end_time,
                          'missing', exists (
                            select 1 from public.absences a
                             where a.child_id = ch.id and a.meeting_id = p_meeting_id
                               and (a.whole_day or exists (
                                 select 1 from public.absence_periods ap
                                  where ap.absence_id = a.id and ap.period_id = c.period_id)))
                        ) order by p.period_number)
                   from public.registrations r
                   join public.classes c on c.id = r.class_id
                   join public.periods p on p.id = c.period_id
                  where r.child_id = ch.id
                    and r.semester_id = v_meeting.semester_id
                    and r.status = 'registered'), '[]'::jsonb)
             ) order by ch.birth_date nulls last)
        from public.children ch
       where ch.id = any(public.current_child_ids())
         and ch.active and ch.archived_at is null), '[]'::jsonb),

    -- Anything posted for this week, plus standing notices for their classes.
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id,
               'class_id', a.class_id,
               'class_name', c.name,
               'title', a.title,
               'body', a.body,
               'link_url', a.link_url,
               'link_label', a.link_label,
               'file_path', a.file_path,
               'file_name', a.file_name,
               'posted_by', a.posted_by_name,
               'for_this_week', a.meeting_id is not null,
               'created_at', a.created_at) order by a.created_at desc)
        from public.announcements a
        left join public.classes c on c.id = a.class_id
       where a.semester_id = v_meeting.semester_id
         and (a.meeting_id = p_meeting_id or a.meeting_id is null)
         and (a.class_id is null
              or a.class_id = any(public.current_family_class_ids()))), '[]'::jsonb));
end;
$$;

revoke execute on function public.family_week(uuid) from public, anon;
grant execute on function public.family_week(uuid) to authenticated;

select public.record_migration('0018');
