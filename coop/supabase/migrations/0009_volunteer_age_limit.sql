-- =============================================================================
-- 0009_volunteer_age_limit.sql
-- Volunteering is for the younger children's classes.
--
-- A teenager offering to help is offering to help with the little ones. Showing
-- them the whole catalogue invites offers nobody wants to take up, and buries
-- the ones they do.
--
-- "Nine and under" means a class aimed at that age — age_max <= 9. A 5-9 class
-- qualifies; a 6-12 class does not, because half of it is older children; and a
-- class with no upper bound does not, because it is not a younger children's
-- class at all.
--
-- The threshold is a setting rather than a constant. Nine is what the co-op
-- asked for today, and moving it should not need a developer.
-- =============================================================================

alter table public.settings
  add column if not exists volunteer_max_class_age integer default 9;

comment on column public.settings.volunteer_max_class_age is
  'Students may only offer to volunteer in classes whose age_max is at or below '
  'this. NULL removes the restriction entirely.';

-- -----------------------------------------------------------------------------
-- Enforced by trigger rather than inside submit_family_registration.
--
-- A guard on the table holds for every caller — the family page, a future admin
-- screen, a hand-written fix at three in the morning — and it does not require
-- reissuing a two-hundred-line function every time the rule is touched.
--
-- Returning NULL from a BEFORE INSERT row trigger drops the row silently, which
-- is the right behaviour here: an offer for an ineligible class is noise from a
-- stale tab, not something worth failing an entire registration over.
-- -----------------------------------------------------------------------------
create or replace function public.volunteer_slot_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
begin
  select volunteer_max_class_age into v_limit from public.settings where id = 1;

  -- No limit configured: accept anything.
  if v_limit is null then
    return new;
  end if;

  if new.class_id is not null then
    -- A specific class must itself be a younger children's class.
    if not exists (
      select 1 from public.classes c
       where c.id = new.class_id
         and c.age_max is not null
         and c.age_max <= v_limit
    ) then
      return null;
    end if;
  else
    -- "Any class in this period" is only meaningful where the period actually
    -- contains a qualifying class.
    if not exists (
      select 1 from public.classes c
       where c.period_id = new.period_id
         and c.archived_at is null
         and c.age_max is not null
         and c.age_max <= v_limit
    ) then
      return null;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists volunteer_slot_guard_trg on public.volunteer_interest_slot;
create trigger volunteer_slot_guard_trg
  before insert on public.volunteer_interest_slot
  for each row execute function public.volunteer_slot_guard();

-- Clear out any offers already recorded against classes that no longer qualify.
delete from public.volunteer_interest_slot vs
 using public.settings s
 where s.id = 1
   and s.volunteer_max_class_age is not null
   and vs.class_id is not null
   and not exists (
     select 1 from public.classes c
      where c.id = vs.class_id
        and c.age_max is not null
        and c.age_max <= s.volunteer_max_class_age);
