-- Test fixture: one semester, three periods, a handful of classes with
-- deliberately awkward eligibility rules, and four families.

insert into public.admins (email, display_name, role)
values ('owner@example.org', 'Owner Person', 'owner'),
       ('helper@example.org', 'Helper Person', 'admin');

insert into public.semesters
  (id, name, class_start_date, class_end_date, status,
   registration_open_at, registration_close_at)
values ('11111111-1111-1111-1111-111111111111', 'Fall 2027',
        '2027-09-03', '2027-12-10', 'registration_open',
        now() - interval '1 day', now() + interval '30 days');

-- 3 September 2027 is a Friday, so the term meets on Fridays. The calendar is
-- seeded explicitly rather than generated, because generate_meeting_dates is
-- admin-gated and the seed runs before anybody is signed in.
update public.semesters set meeting_weekday = 5
 where id = '11111111-1111-1111-1111-111111111111';

insert into public.meeting_dates (semester_id, meets_on) values
  ('11111111-1111-1111-1111-111111111111', '2027-09-03'),
  ('11111111-1111-1111-1111-111111111111', '2027-09-10'),
  ('11111111-1111-1111-1111-111111111111', '2027-09-17'),
  ('11111111-1111-1111-1111-111111111111', '2027-09-24'),
  ('11111111-1111-1111-1111-111111111111', '2027-10-01'),
  ('11111111-1111-1111-1111-111111111111', '2027-10-08'),
  ('11111111-1111-1111-1111-111111111111', '2027-10-15'),
  ('11111111-1111-1111-1111-111111111111', '2027-10-22'),
  ('11111111-1111-1111-1111-111111111111', '2027-10-29'),
  ('11111111-1111-1111-1111-111111111111', '2027-11-05'),
  ('11111111-1111-1111-1111-111111111111', '2027-11-12'),
  ('11111111-1111-1111-1111-111111111111', '2027-11-19'),
  ('11111111-1111-1111-1111-111111111111', '2027-11-26'),
  ('11111111-1111-1111-1111-111111111111', '2027-12-03'),
  ('11111111-1111-1111-1111-111111111111', '2027-12-10');

insert into public.periods (id, semester_id, period_number, display_name, start_time, end_time, sort_order)
values ('21111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 1, 'First Hour',  '09:00', '09:55', 1),
       ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 2, 'Second Hour', '10:00', '10:55', 2),
       ('23333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 3, 'Third Hour',  '11:00', '11:55', 3);

insert into public.classes
  (id, period_id, semester_id, option_number, name, teacher_name, age_min, age_max, sex_requirement, capacity)
values
  -- Period 1
  ('31111111-1111-1111-1111-111111111111', '21111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 1, 'Beginning Chemistry', 'Jane Smith', 11, 14, 'any',    10),
  ('32222222-2222-2222-2222-222222222222', '21111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 2, 'Art',                 'Bob Jones',  8, 18, 'any',     8),
  ('33333333-3333-3333-3333-333333333333', '21111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 3, 'Robotics',            'Ann Lee',   13, 17, 'any',     1),
  -- Period 2
  ('34444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 1, 'Biology',             'Jane Smith', 10, 16, 'any',    12),
  ('35555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 2, 'Drawing',             'Bob Jones',   6, 18, 'any',    null),
  -- Period 3
  ('36666666-6666-6666-6666-666666666666', '23333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 1, 'Girls'' Volleyball',  'Sarah Jones', 12, 17, 'female', 12),
  ('37777777-7777-7777-7777-777777777777', '23333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 2, 'Choir',               'Mary Poe',  null, null, 'any',   20);

insert into public.families (id, display_name, last_name, primary_email)
values ('41111111-1111-1111-1111-111111111111', 'Johnson Family', 'Johnson', 'mary@example.com'),
       ('42222222-2222-2222-2222-222222222222', 'Smith Family',   'Smith',   'rebecca@example.com'),
       ('43333333-3333-3333-3333-333333333333', 'Brown Family',   'Brown',   'brown@example.com'),
       ('44444444-4444-4444-4444-444444444444', 'Green Family',   'Green',   null);

insert into public.parents (family_id, first_name, last_name)
values ('41111111-1111-1111-1111-111111111111', 'Mary',    'Johnson'),
       ('41111111-1111-1111-1111-111111111111', 'David',   'Johnson'),
       ('42222222-2222-2222-2222-222222222222', 'Rebecca', 'Smith');

-- Ages are as of the 2027-09-03 semester start.
insert into public.children (id, family_id, first_name, last_name, birth_date, sex, active)
values
  ('51111111-1111-1111-1111-111111111111', '41111111-1111-1111-1111-111111111111', 'Emma',  'Johnson', '2015-03-12', 'female', true), -- 12
  ('52222222-2222-2222-2222-222222222222', '41111111-1111-1111-1111-111111111111', 'Caleb', 'Johnson', '2018-07-08', 'male',   true), -- 9
  ('53333333-3333-3333-3333-333333333333', '42222222-2222-2222-2222-222222222222', 'Billy', 'Smith',   '2014-01-20', 'male',   true), -- 13
  ('54444444-4444-4444-4444-444444444444', '43333333-3333-3333-3333-333333333333', 'Carol', 'Brown',   '2013-05-05', 'female', true), -- 14
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'Dana',  'Green',   '2014-11-11', 'female', true), -- 12
  ('56666666-6666-6666-6666-666666666666', '41111111-1111-1111-1111-111111111111', 'Old',   'Johnson', '2004-01-01', 'male',   false); -- aged out, inactive
