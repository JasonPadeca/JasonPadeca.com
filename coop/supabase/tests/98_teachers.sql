\set ON_ERROR_STOP on
\pset pager off

create or replace function pg_temp.check(label text, actual text, expected text)
returns void language plpgsql as $$
begin
  if actual is not distinct from expected then raise notice 'PASS  %', label;
  else raise warning 'FAIL  %  expected<%>  actual<%>', label, expected, actual;
  end if;
end;
$$;

\set chem  '''31111111-1111-1111-1111-111111111111'''
\set art   '''32222222-2222-2222-2222-222222222222'''
\set emma  '''51111111-1111-1111-1111-111111111111'''
\set billy '''53333333-3333-3333-3333-333333333333'''
\set carol '''54444444-4444-4444-4444-444444444444'''

-- Grandpa teaches Chemistry and has no child in the co-op. That is the whole
-- point of teachers standing alone.
\set u_grandpa '''00000000-0000-0000-0000-00000000cc01'''
\set u_mary    '''00000000-0000-0000-0000-00000000cc02'''
insert into auth.users (id) values (:u_grandpa::uuid), (:u_mary::uuid) on conflict do nothing;

update public.families set primary_email = 'mary@example.org'
 where id = '41111111-1111-1111-1111-111111111111';

insert into public.teachers (email, display_name) values
  ('grandpa@example.org', 'Walter Otis');

insert into public.class_teachers (class_id, teacher_id)
select :chem::uuid, id from public.teachers where email = 'grandpa@example.org';

-- Emma and Billy are in Chemistry; Carol is in Art, which grandpa does not teach.
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select public.admin_place_child(:emma::uuid,  :chem::uuid);
select public.admin_place_child(:billy::uuid, :chem::uuid);
select public.admin_place_child(:carol::uuid, :art::uuid);

update public.children set allergies = 'Peanuts', medical_notes = 'Inhaler'
 where id = :emma::uuid;
update public.children set allergies = 'Bee stings' where id = :carol::uuid;

create or replace function pg_temp.be(uid text, email text)
returns void language sql as $$
  select set_config('test.uid', uid, false),
         set_config('test.jwt', json_build_object('email', email)::text, false);
  select set_config('role', 'authenticated', false);
$$;

-- =============================================================================
-- A teacher who is not a parent
-- =============================================================================
select pg_temp.be(:u_grandpa, 'grandpa@example.org');

select pg_temp.check('grandpa is recognised',
  (public.establish_session() ->> 'recognised'), 'true');
select pg_temp.check('...as a teacher',
  (public.establish_session() ->> 'is_teacher'), 'true');
select pg_temp.check('...not an administrator',
  (public.establish_session() ->> 'is_admin'), 'false');
select pg_temp.check('...and belongs to no family at all',
  jsonb_array_length(public.establish_session() -> 'families')::text, '0');
select pg_temp.check('...teaching one class',
  jsonb_array_length(public.establish_session() -> 'teaches')::text, '1');
select pg_temp.check('...which is Chemistry',
  (public.establish_session() -> 'teaches' -> 0 ->> 'class_name'), 'Beginning Chemistry');

-- =============================================================================
-- THE BOUNDARY. A teacher sees their own room and no further.
-- =============================================================================
select pg_temp.check('grandpa sees only the class he teaches',
  (select count(*)::text from public.classes), '1');

select pg_temp.check('grandpa sees only his own students',
  (select count(*)::text from public.children), '2');

select pg_temp.check('...and not a child from the class across the hall',
  (select count(*)::text from public.children where id = :carol::uuid), '0');

select pg_temp.check('...nor her allergies',
  (select count(*)::text from public.children where allergies = 'Bee stings'), '0');

select pg_temp.check('grandpa CAN see his own student''s medical notes',
  (select medical_notes from public.children where id = :emma::uuid), 'Inhaler');

select pg_temp.check('grandpa sees only his students'' families',
  (select count(*)::text from public.families), '2');

select pg_temp.check('grandpa cannot read the admins table',
  (select count(*)::text from public.admins), '0');

select pg_temp.check('grandpa cannot read the audit log',
  (select count(*)::text from public.audit_log), '0');

select pg_temp.check('grandpa cannot read invitation tokens',
  (select count(*)::text from public.registration_invites), '0');

select pg_temp.check('grandpa cannot read other teachers'' assignments',
  (select count(*)::text from public.class_teachers
    where class_id <> :chem::uuid), '0');

-- He is not a family member, but the timetable still has to work for him.
select pg_temp.check('grandpa can read the calendar',
  (select case when count(*) > 0 then 'yes' else 'no' end
     from public.meeting_dates), 'yes');

select pg_temp.check('...and the periods he teaches inside',
  (select case when count(*) > 0 then 'yes' else 'no' end from public.periods), 'yes');

select pg_temp.check('...and seat counts for his own class',
  (select registered_count::text from public.class_seat_counts()
    where class_id = :chem::uuid), '2');

-- =============================================================================
-- Teachers get SELECT and nothing else
-- =============================================================================
do $$
begin
  begin
    update public.children set first_name = 'Edited' where first_name = 'Emma';
    if found then raise warning 'FAIL  a teacher could edit a student';
    else raise notice 'PASS  a teacher cannot edit a student'; end if;
  exception when others then
    raise notice 'PASS  a teacher cannot edit a student';
  end;
end;
$$;

do $$
begin
  begin
    insert into public.class_teachers (class_id, teacher_id)
    values ('32222222-2222-2222-2222-222222222222',
            (select id from public.teachers limit 1));
    raise warning 'FAIL  a teacher could assign themselves another class';
  exception when others then
    raise notice 'PASS  a teacher cannot assign themselves another class';
  end;
end;
$$;

-- =============================================================================
-- The class view
-- =============================================================================
select pg_temp.check('the class view lists his students',
  jsonb_array_length(public.teacher_class_view(:chem::uuid) -> 'students')::text, '2');

select pg_temp.check('...with allergies, which is why they are there',
  (select s ->> 'allergies' from
     jsonb_array_elements(public.teacher_class_view(:chem::uuid) -> 'students') s
    where s ->> 'name' like 'Emma%'), 'Peanuts');

select pg_temp.check('...and a phone number to ring',
  (select case when (s ? 'family_phone') then 'present' else 'missing' end from
     jsonb_array_elements(public.teacher_class_view(:chem::uuid) -> 'students') s
    limit 1), 'present');

do $$
begin
  begin
    perform public.teacher_class_view('32222222-2222-2222-2222-222222222222');
    raise warning 'FAIL  a teacher could open a class they do not teach';
  exception when others then
    raise notice 'PASS  a teacher cannot open a class they do not teach';
  end;
end;
$$;

-- =============================================================================
-- Absences show up where the teacher will see them
-- =============================================================================
select set_config('role', 'postgres', false);
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select id as m1 from public.meeting_dates order by meets_on limit 1 \gset
select public.report_absence(:emma::uuid,
  (select meets_on from public.meeting_dates where id = :'m1'::uuid), true, '{}', 'Chickenpox');

select pg_temp.be(:u_grandpa, 'grandpa@example.org');

select pg_temp.check('a teacher sees their own student''s absence',
  (select count(*)::text from public.absences), '1');

select pg_temp.check('...flagged on the class view for that day',
  (select s ->> 'absent' from
     jsonb_array_elements(public.teacher_class_view(:chem::uuid, :'m1'::uuid) -> 'students') s
    where s ->> 'name' like 'Emma%'), 'true');

select pg_temp.check('...with the reason',
  (select s ->> 'absence_reason' from
     jsonb_array_elements(public.teacher_class_view(:chem::uuid, :'m1'::uuid) -> 'students') s
    where s ->> 'name' like 'Emma%'), 'Chickenpox');

select pg_temp.check('...and nobody else marked absent',
  (select count(*)::text from
     jsonb_array_elements(public.teacher_class_view(:chem::uuid, :'m1'::uuid) -> 'students') s
    where (s ->> 'absent')::boolean), '1');

-- =============================================================================
-- A parent who also teaches is both, not one or the other
-- =============================================================================
select set_config('role', 'postgres', false);
insert into public.teachers (email, display_name) values ('mary@example.org', 'Mary Johnson');
insert into public.class_teachers (class_id, teacher_id)
select :art::uuid, id from public.teachers where email = 'mary@example.org';

select pg_temp.be(:u_mary, 'mary@example.org');
select pg_temp.check('Mary is a parent',
  jsonb_array_length(public.establish_session() -> 'families')::text, '1');
select pg_temp.check('...and a teacher',
  (public.establish_session() ->> 'is_teacher'), 'true');
-- Her own two, plus Carol from the Art class she teaches. The union of both
-- roles rather than whichever one was checked first.
select pg_temp.check('...seeing her own children AND her students',
  (select (count(*) > 2)::text from public.children), 'true');

select pg_temp.check('...including a student who is not hers',
  (select count(*)::text from public.children
    where id = '54444444-4444-4444-4444-444444444444'), '1');

select set_config('role', 'postgres', false);
