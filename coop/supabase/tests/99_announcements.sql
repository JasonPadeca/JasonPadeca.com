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

\set sem   '''11111111-1111-1111-1111-111111111111'''
\set chem  '''31111111-1111-1111-1111-111111111111'''
\set art   '''32222222-2222-2222-2222-222222222222'''
\set emma  '''51111111-1111-1111-1111-111111111111'''
\set billy '''53333333-3333-3333-3333-333333333333'''
\set carol '''54444444-4444-4444-4444-444444444444'''
-- Dana is in nothing, so placing her needs no period override.
\set dana  '''55555555-5555-5555-5555-555555555555'''

\set u_grandpa '''00000000-0000-0000-0000-00000000dd01'''
\set u_mary    '''00000000-0000-0000-0000-00000000dd02'''
\set u_becca   '''00000000-0000-0000-0000-00000000dd03'''
insert into auth.users (id) values (:u_grandpa::uuid), (:u_mary::uuid), (:u_becca::uuid)
on conflict do nothing;

update public.families set primary_email = 'mary@example.org'
 where id = '41111111-1111-1111-1111-111111111111';
update public.families set primary_email = 'becca@example.org'
 where id = '42222222-2222-2222-2222-222222222222';

insert into public.teachers (email, display_name) values ('grandpa@example.org', 'Walter Otis');
insert into public.class_teachers (class_id, teacher_id)
select :chem::uuid, id from public.teachers where email = 'grandpa@example.org';

-- Emma (Johnson) in Chemistry. Billy (Smith) in Art. Carol in Art.
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select public.admin_place_child(:emma::uuid,  :chem::uuid);
select public.admin_place_child(:billy::uuid, :art::uuid);
select public.admin_place_child(:carol::uuid, :art::uuid);

select id as m1 from public.meeting_dates order by meets_on limit 1 \gset

create or replace function pg_temp.be(uid text, email text)
returns void language sql as $$
  select set_config('test.uid', uid, false),
         set_config('test.jwt', json_build_object('email', email)::text, false);
  select set_config('role', 'authenticated', false);
$$;

-- =============================================================================
-- A teacher posting to their own class
-- =============================================================================
select pg_temp.be(:u_grandpa, 'grandpa@example.org');
select public.establish_session();

insert into public.announcements
  (semester_id, class_id, meeting_id, title, body, posted_by_name)
values (:sem::uuid, :chem::uuid, :'m1'::uuid,
        'Worksheet for this week', 'Please print it before Friday.', 'Walter Otis');

select pg_temp.check('a teacher can post to their own class',
  (select count(*)::text from public.announcements where class_id = :chem::uuid), '1');

-- =============================================================================
-- ...and to nobody else's
-- =============================================================================
do $$
begin
  begin
    insert into public.announcements (semester_id, class_id, title, body)
    values ('11111111-1111-1111-1111-111111111111',
            '32222222-2222-2222-2222-222222222222', 'Sneaky', 'Not my class');
    raise warning 'FAIL  a teacher could post to a class they do not teach';
  exception when others then
    raise notice 'PASS  a teacher cannot post to a class they do not teach';
  end;
end;
$$;

do $$
begin
  begin
    insert into public.announcements (semester_id, class_id, title, body)
    values ('11111111-1111-1111-1111-111111111111', null,
            'Everyone listen', 'Co-op wide');
    raise warning 'FAIL  a teacher could post a co-op-wide notice';
  exception when others then
    raise notice 'PASS  a teacher cannot post a co-op-wide notice';
  end;
end;
$$;

-- =============================================================================
-- An administrator posting to everybody
-- =============================================================================
select set_config('role', 'postgres', false);
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
insert into public.announcements (semester_id, class_id, title, body, posted_by_name)
values (:sem::uuid, null, 'Picture day', 'Wear your co-op shirt.', 'The office');

-- =============================================================================
-- THE BOUNDARY: who can read what
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.org');       -- Emma is in Chemistry
select public.establish_session();

select pg_temp.check('a parent sees the notice for their child''s class',
  (select count(*)::text from public.announcements where class_id = :chem::uuid), '1');

select pg_temp.check('...and the co-op-wide one',
  (select count(*)::text from public.announcements where class_id is null), '1');

select pg_temp.be(:u_becca, 'becca@example.org');     -- Billy is in Art, not Chemistry
select public.establish_session();

select pg_temp.check('a parent does NOT see a class their child is not in',
  (select count(*)::text from public.announcements where class_id = :chem::uuid), '0');

select pg_temp.check('...but does see the co-op-wide one',
  (select count(*)::text from public.announcements where class_id is null), '1');

select pg_temp.check('...so two notices exist and she sees one',
  (select count(*)::text from public.announcements), '1');

-- =============================================================================
-- The class as a parent sees it
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.org');

select pg_temp.check('a parent can open their child''s class',
  (public.family_class_view(:chem::uuid) ->> 'ok'), 'true');

select pg_temp.check('...seeing the class name',
  (public.family_class_view(:chem::uuid) -> 'class' ->> 'name'), 'Beginning Chemistry');

select pg_temp.check('...and who else is in it',
  jsonb_array_length(public.family_class_view(:chem::uuid) -> 'students')::text, '1');

select pg_temp.check('...by name',
  (public.family_class_view(:chem::uuid) -> 'students' -> 0 ->> 'name'), 'Emma Johnson');

-- The guarantee. Two keys, name and absent, and no way to widen it.
select pg_temp.check('...and NOTHING else about them — no email, medical, or birth date',
  (select count(*)::text from jsonb_object_keys(
     public.family_class_view(:chem::uuid) -> 'students' -> 0)), '2');

select pg_temp.check('...the keys being exactly name and absent',
  (select string_agg(k, ',' order by k) from jsonb_object_keys(
     public.family_class_view(:chem::uuid) -> 'students' -> 0) k), 'absent,name');

select pg_temp.check('...and this week''s posts come with it',
  jsonb_array_length(public.family_class_view(:chem::uuid, :'m1'::uuid) -> 'posts')::text, '1');

do $$
begin
  begin
    perform public.family_class_view('32222222-2222-2222-2222-222222222222');
    raise warning 'FAIL  a parent could open a class their child is not in';
  exception when others then
    raise notice 'PASS  a parent cannot open a class their child is not in';
  end;
end;
$$;

-- =============================================================================
-- Another child being away shows, but not why.
--
-- A child in that room on Thursday can see who is missing. The reason is often
-- medical and is nobody else's business.
-- =============================================================================
select set_config('role', 'postgres', false);
select set_config('test.jwt', '{"email":"owner@example.org"}', false);
select public.admin_place_child(:dana::uuid, :chem::uuid);
select public.report_absence(:dana::uuid,
  (select meets_on from public.meeting_dates where id = :'m1'::uuid),
  true, '{}', 'Chickenpox');

select pg_temp.be(:u_mary, 'mary@example.org');

select pg_temp.check('another family''s child shows as away',
  (select s ->> 'absent' from jsonb_array_elements(
     public.family_class_view(:chem::uuid, :'m1'::uuid) -> 'students') s
    where s ->> 'name' = 'Dana Green'), 'true');

select pg_temp.check('...and Emma, who is there, does not',
  (select s ->> 'absent' from jsonb_array_elements(
     public.family_class_view(:chem::uuid, :'m1'::uuid) -> 'students') s
    where s ->> 'name' = 'Emma Johnson'), 'false');

select pg_temp.check('...and the REASON is nowhere in the payload',
  (public.family_class_view(:chem::uuid, :'m1'::uuid)::text like '%Chickenpox%')::text, 'false');

select pg_temp.check('...nor is the absence readable directly',
  (select count(*)::text from public.absences where child_id = :carol::uuid), '0');

-- With no week named, nobody is marked away — absence is a property of a day.
select pg_temp.check('with no week in view, nobody is marked away',
  (select count(*)::text from jsonb_array_elements(
     public.family_class_view(:chem::uuid) -> 'students') s
    where (s ->> 'absent')::boolean), '0');

-- =============================================================================
-- Handout folders
-- =============================================================================
select pg_temp.check('a parent may read their own class''s handout folder',
  public.handout_folder_readable(:chem)::text, 'true');

select pg_temp.check('...and not another class''s',
  public.handout_folder_readable(:art)::text, 'false');

select pg_temp.check('...and may not upload to their own class either',
  public.handout_folder_writable(:chem)::text, 'false');

select pg_temp.check('a parent may read the co-op-wide folder',
  public.handout_folder_readable('general')::text, 'true');

select pg_temp.be(:u_grandpa, 'grandpa@example.org');
select pg_temp.check('a teacher may upload to their own class',
  public.handout_folder_writable(:chem)::text, 'true');
select pg_temp.check('...and not to another',
  public.handout_folder_writable(:art)::text, 'false');

select pg_temp.check('a nonsense folder name does not raise, it just refuses',
  public.handout_folder_readable('not-a-uuid')::text, 'false');

-- =============================================================================
-- A parent's week
-- =============================================================================
select pg_temp.be(:u_mary, 'mary@example.org');

select pg_temp.check('the week lists their own children',
  jsonb_array_length(public.family_week(:'m1'::uuid) -> 'children')::text, '2');

select pg_temp.check('...with Emma''s class on it',
  (select ch -> 'classes' -> 0 ->> 'class_name' from
     jsonb_array_elements(public.family_week(:'m1'::uuid) -> 'children') ch
    where ch ->> 'name' = 'Emma Johnson'), 'Beginning Chemistry');

select pg_temp.check('...and both posts they are entitled to',
  jsonb_array_length(public.family_week(:'m1'::uuid) -> 'posts')::text, '2');

-- Reporting an absence shows up against the class on that day.
select public.report_absence(:emma::uuid,
  (select meets_on from public.meeting_dates where id = :'m1'::uuid));

select pg_temp.check('an absence marks the class as being missed',
  (select ch -> 'classes' -> 0 ->> 'missing' from
     jsonb_array_elements(public.family_week(:'m1'::uuid) -> 'children') ch
    where ch ->> 'name' = 'Emma Johnson'), 'true');

select set_config('role', 'postgres', false);
