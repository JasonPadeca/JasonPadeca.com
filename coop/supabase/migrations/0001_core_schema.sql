-- =============================================================================
-- 0001_core_schema.sql
-- Homeschool Co-op Registration System — core tables, keys, and constraints.
--
-- Spec references: §5 (domain model), §6 (archiving), §42 (data integrity),
-- §44 (time zone).
--
-- Conventions used throughout:
--   * ids are uuid, so nothing in the system is guessable by counting up.
--   * timestamps are timestamptz; dates that are genuinely dates (birth dates,
--     class dates) stay `date`.
--   * status/enum-ish columns are text + CHECK, not Postgres enums, because
--     adding a value later is a one-line ALTER instead of a migration dance.
--   * archived_at IS NULL means "live". Nothing important is ever DELETEd.
-- =============================================================================

-- Supabase keeps extensions out of `public`. digest() and gen_random_bytes()
-- therefore need `extensions` on the search_path of any function that calls
-- them, which is why several functions below say `set search_path = public,
-- extensions` rather than just `public`.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- ADMINISTRATORS  (§5.10)
-- Authentication is Supabase Auth + Google. Authorization is this table.
-- A Google user who is not an active row here gets nothing.
-- =============================================================================
create table public.admins (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users(id) on delete set null,
  email         text not null,
  display_name  text,
  role          text not null default 'admin' check (role in ('owner', 'admin')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Email is the join key before an admin has ever signed in: the owner adds
-- someone by email, and auth_user_id gets bound on their first Google login.
create unique index admins_email_key on public.admins (lower(email));

create trigger admins_touch before update on public.admins
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- FAMILIES  (§5.1)
-- =============================================================================
create table public.families (
  id             uuid primary key default gen_random_uuid(),
  display_name   text not null,
  last_name      text,
  primary_email  text,
  active         boolean not null default true,
  archived_at    timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index families_active_idx on public.families (active, archived_at);
create index families_name_idx on public.families (lower(display_name));

create trigger families_touch before update on public.families
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- PARENTS / GUARDIANS  (§5.2)
-- Deliberately no assumption of exactly two per family.
-- =============================================================================
create table public.parents (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  first_name   text not null,
  last_name    text,
  email        text,
  phone        text,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index parents_family_idx on public.parents (family_id);

create trigger parents_touch before update on public.parents
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- CHILDREN  (§5.3)
-- Age is never stored. It is always computed against a reference date, which
-- for eligibility is the semester's first class date.
-- =============================================================================
create table public.children (
  id               uuid primary key default gen_random_uuid(),
  family_id        uuid not null references public.families(id) on delete cascade,
  first_name       text not null,
  last_name        text,
  birth_date       date,
  sex              text check (sex in ('female', 'male')),
  active           boolean not null default true,
  inactive_reason  text,
  archived_at      timestamptz,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index children_family_idx on public.children (family_id);
create index children_active_idx on public.children (active, archived_at);

create trigger children_touch before update on public.children
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- SEMESTERS  (§5.4)
-- =============================================================================
create table public.semesters (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  description           text,
  class_start_date      date,
  class_end_date        date,
  registration_open_at  timestamptz,
  registration_close_at timestamptz,
  status                text not null default 'draft'
                          check (status in ('draft', 'registration_open',
                                            'registration_closed', 'active',
                                            'completed', 'archived')),
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint semester_dates_ordered
    check (class_end_date is null or class_start_date is null
           or class_end_date >= class_start_date),
  constraint registration_dates_ordered
    check (registration_close_at is null or registration_open_at is null
           or registration_close_at >= registration_open_at)
);

create index semesters_status_idx on public.semesters (status, archived_at);

create trigger semesters_touch before update on public.semesters
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- PERIODS  (§5.5)
-- Three periods is the co-op's habit, not the schema's rule.
-- =============================================================================
create table public.periods (
  id            uuid primary key default gen_random_uuid(),
  semester_id   uuid not null references public.semesters(id) on delete cascade,
  period_number integer not null,
  display_name  text,
  description   text,
  start_time    time,
  end_time      time,
  sort_order    integer not null default 0,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint period_times_ordered
    check (end_time is null or start_time is null or end_time > start_time)
);

create unique index periods_number_per_semester
  on public.periods (semester_id, period_number);
create index periods_semester_idx on public.periods (semester_id, sort_order);

create trigger periods_touch before update on public.periods
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- CLASSES  (§5.6)
-- semester_id is denormalized from period_id for query convenience, and a
-- trigger below keeps it honest rather than trusting the caller.
-- =============================================================================
create table public.classes (
  id              uuid primary key default gen_random_uuid(),
  semester_id     uuid not null references public.semesters(id) on delete cascade,
  period_id       uuid not null references public.periods(id) on delete cascade,
  option_number   integer,
  name            text not null,
  description     text,
  teacher_name    text,
  age_min         integer check (age_min is null or age_min >= 0),
  age_max         integer check (age_max is null or age_max >= 0),
  sex_requirement text not null default 'any'
                    check (sex_requirement in ('any', 'female', 'male')),
  capacity        integer check (capacity is null or capacity >= 0),
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint age_range_ordered
    check (age_min is null or age_max is null or age_min <= age_max)
);

create index classes_period_idx on public.classes (period_id, option_number);
create index classes_semester_idx on public.classes (semester_id);

create trigger classes_touch before update on public.classes
  for each row execute function public.touch_updated_at();

-- A class must belong to the semester its period belongs to. Rather than a
-- composite foreign key (which would force a redundant unique index on
-- periods), derive it.
create or replace function public.classes_sync_semester()
returns trigger
language plpgsql
as $$
begin
  select p.semester_id into new.semester_id
    from public.periods p where p.id = new.period_id;
  if new.semester_id is null then
    raise exception 'Period % does not exist', new.period_id;
  end if;
  return new;
end;
$$;

create trigger classes_sync_semester_trg
  before insert or update of period_id on public.classes
  for each row execute function public.classes_sync_semester();

-- =============================================================================
-- REGISTRATIONS  (§5.7, §5.8)
-- One table holds confirmed seats and waitlist interest alike; `status`
-- distinguishes them. Waitlists live here so a class's full picture is one
-- query, per the spec's preferred v1 approach.
--
-- period_id and semester_id are derived from class_id by trigger. period_id in
-- particular exists so "one confirmed class per period" can be a real unique
-- index instead of a hopeful application check.
-- =============================================================================
create table public.registrations (
  id                uuid primary key default gen_random_uuid(),
  child_id          uuid not null references public.children(id) on delete cascade,
  class_id          uuid not null references public.classes(id) on delete cascade,
  period_id         uuid not null references public.periods(id) on delete cascade,
  semester_id       uuid not null references public.semesters(id) on delete cascade,
  status            text not null default 'registered'
                      check (status in ('registered', 'waitlisted',
                                        'cancelled', 'withdrawn')),
  source            text not null default 'family'
                      check (source in ('family', 'admin', 'waitlist_promotion')),
  waitlisted_at     timestamptz,
  override_reason   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  cancelled_at      timestamptz
);

create index registrations_class_idx on public.registrations (class_id, status);
create index registrations_child_idx on public.registrations (child_id, status);
create index registrations_semester_idx on public.registrations (semester_id, status);

-- A child holds at most one confirmed seat in any given period. Waitlist rows
-- are deliberately excluded: a child may hold a confirmed class in period 2 and
-- still be waitlisted for a different period-2 class they'd rather have.
create unique index registrations_one_confirmed_per_period
  on public.registrations (child_id, period_id)
  where status = 'registered';

-- No duplicate live rows for the same child in the same class, in either state.
create unique index registrations_no_duplicate_live
  on public.registrations (child_id, class_id)
  where status in ('registered', 'waitlisted');

-- Waitlist order is derived from waitlisted_at, so it must be set exactly when
-- the row is waitlisted.
alter table public.registrations add constraint waitlisted_at_present
  check ((status = 'waitlisted') = (waitlisted_at is not null));

create trigger registrations_touch before update on public.registrations
  for each row execute function public.touch_updated_at();

create or replace function public.registrations_sync_parents()
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

create trigger registrations_sync_parents_trg
  before insert or update of class_id on public.registrations
  for each row execute function public.registrations_sync_parents();

-- =============================================================================
-- REGISTRATION INVITATIONS  (§5.9, §15)
-- Only the hash of the token is stored. The raw token exists in exactly one
-- place: the URL in the family's email. If the database leaks, the links in it
-- are not usable.
-- =============================================================================
create table public.registration_invites (
  id                  uuid primary key default gen_random_uuid(),
  family_id           uuid not null references public.families(id) on delete cascade,
  semester_id         uuid not null references public.semesters(id) on delete cascade,
  token_hash          text not null unique,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz,
  revoked_at          timestamptz,
  sent_at             timestamptz,
  send_error          text,
  last_used_at        timestamptz,
  created_by_admin_id uuid references public.admins(id) on delete set null
);

create index invites_family_semester_idx
  on public.registration_invites (family_id, semester_id);

-- At most one live invitation per family per semester. Re-issuing revokes the
-- old one first (see regenerate_family_invite in 0003).
create unique index invites_one_live_per_family_semester
  on public.registration_invites (family_id, semester_id)
  where revoked_at is null;

-- =============================================================================
-- AUDIT LOG  (§5.11)
-- Worth having from day one precisely because admins can override the rules.
-- =============================================================================
create table public.audit_log (
  id           bigserial primary key,
  actor_type   text not null check (actor_type in ('admin', 'family', 'system')),
  actor_id     uuid,
  actor_label  text,
  action       text not null,
  entity_type  text,
  entity_id    uuid,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index audit_log_created_idx on public.audit_log (created_at desc);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);

-- =============================================================================
-- SETTINGS  (§43)
-- One row. Deliberately thin — only what an administrator would actually edit.
-- =============================================================================
create table public.settings (
  id                       integer primary key default 1 check (id = 1),
  program_name             text not null default 'Homeschool Co-op',
  contact_email            text,
  reply_to_email           text,
  from_email               text,
  from_name                text,
  registration_base_url    text,
  normal_program_age_min   integer,
  normal_program_age_max   integer,
  show_ineligible_classes  boolean not null default true,
  allow_family_edits       boolean not null default true,
  timezone                 text not null default 'America/Chicago',
  updated_at               timestamptz not null default now()
);

insert into public.settings (id) values (1);

create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();

-- =============================================================================
-- SYSTEM STATUS  (§31)
-- One row the keepalive job touches, so the maintainer can see the backend is
-- awake from the admin UI instead of guessing.
-- =============================================================================
create table public.system_status (
  id                integer primary key default 1 check (id = 1),
  last_keepalive_at timestamptz
);

insert into public.system_status (id, last_keepalive_at) values (1, now());
