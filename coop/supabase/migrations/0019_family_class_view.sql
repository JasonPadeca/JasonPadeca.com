-- =============================================================================
-- 0019_family_class_view.sql
-- A class as a parent sees it.
--
-- Replaces classmates(). That function answered exactly one question — who else
-- is in this room — and putting it behind a button labelled "Who else?" made
-- the roster look like the point of the page. It reads as surveillance rather
-- than as a class list, which is a bad way to present information that is
-- perfectly ordinary.
--
-- So the whole class becomes openable, and the other children are one part of
-- it alongside the teacher, the room, the description, and this week's
-- handouts. Same information, no longer pointed at.
--
-- It is the teacher's view minus everything a parent has no business with: no
-- birth dates, no email addresses, no phone numbers, and above all no allergies
-- or medical notes for a child who is not theirs. What is left of another
-- family's child is a name and whether they are in this week.
-- =============================================================================

select public.migration_guard('0019', '0018');

create or replace function public.family_class_view(
  p_class_id   uuid,
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
begin
  -- Only a class one of your own children is actually registered in. Teachers
  -- and administrators are allowed through for their own use of the page.
  if not (p_class_id = any(public.current_family_class_ids()))
     and not (p_class_id = any(public.current_taught_class_ids()))
     and not public.is_active_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_class from public.classes where id = p_class_id;
  if v_class.id is null then
    raise exception 'Class not found';
  end if;

  return jsonb_build_object(
    'ok', true,
    'class', jsonb_build_object(
      'id', v_class.id,
      'name', v_class.name,
      'description', v_class.description,
      'teacher_name', v_class.teacher_name,
      'location', v_class.location,
      'age_min', v_class.age_min,
      'age_max', v_class.age_max,
      'sex_requirement', v_class.sex_requirement),

    'period', (select jsonb_build_object(
        'id', p.id, 'number', p.period_number,
        'name', coalesce(p.display_name, 'Period ' || p.period_number),
        'start_time', p.start_time, 'end_time', p.end_time)
      from public.periods p where p.id = v_class.period_id),

    'semester', (select jsonb_build_object('id', s.id, 'name', s.name)
      from public.semesters s where s.id = v_class.semester_id),

    -- Names, and whether they are here this week. Nothing else exists in this
    -- object to leak — not a birth date, not an address, and emphatically not
    -- another family's medical notes.
    --
    -- The absence flag is deliberate: a child sitting in that room on Thursday
    -- can see who is missing, and a parent asking "is my daughter's friend out
    -- this week too" is not prying. The REASON is not here, because that often
    -- is medical and is nobody else's business.
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', trim(ch.first_name || ' ' || coalesce(ch.last_name, '')),
               'absent', p_meeting_id is not null and exists (
                 select 1 from public.absences a
                  where a.child_id = ch.id
                    and a.meeting_id = p_meeting_id
                    and (a.whole_day or exists (
                      select 1 from public.absence_periods ap
                       where ap.absence_id = a.id
                         and ap.period_id = v_class.period_id)))
             ) order by ch.first_name, ch.last_name)
        from public.registrations r
        join public.children ch on ch.id = r.child_id
       where r.class_id = p_class_id and r.status = 'registered'), '[]'::jsonb),

    -- This week's notes and handouts for this class, plus anything standing.
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id,
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
       where a.class_id = p_class_id
         and (p_meeting_id is null
              or a.meeting_id = p_meeting_id
              or a.meeting_id is null)), '[]'::jsonb));
end;
$$;

revoke execute on function public.family_class_view(uuid, uuid) from public, anon;
grant execute on function public.family_class_view(uuid, uuid) to authenticated;

-- classmates() existed only to feed the button this replaces. Leaving it would
-- be a second, narrower way into the same data with its own set of rules to
-- keep right.
drop function if exists public.classmates(uuid);

select public.record_migration('0019');
