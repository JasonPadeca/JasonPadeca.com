-- =============================================================================
-- 0032_proposal_proposer.sql
-- Say who made the proposal.
--
-- The admin screens read a proposal straight off the table, which carries
-- parent_id and child_id but no names — so every proposal was headed "A
-- student's proposal" with no indication of WHICH student, and the printed
-- sheet fell back to the same. The person reading it has to know whose idea
-- this was; that is most of what makes it a proposal rather than a suggestion.
--
-- The portal already builds a proposer name for the family's own list. The
-- admin views were written as though the same field arrived here. It did not,
-- and because the fallback read sensibly, nothing looked broken.
--
-- Done as a function rather than by embedding the related tables in the query,
-- because PostgREST embedding has already caught this project out once — a
-- view with no foreign key produced "Could not find a relationship" at runtime,
-- long after it looked fine.
-- =============================================================================

select public.migration_guard('0032', '0031');

create or replace function public.admin_proposals(p_archived boolean default false)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(cp)
         || jsonb_build_object(
              'proposer', case
                when cp.kind = 'student' then
                  (select trim(ch.first_name || ' ' || coalesce(ch.last_name, ''))
                     from public.children ch where ch.id = cp.child_id)
                else
                  (select trim(pa.first_name || ' ' || coalesce(pa.last_name, ''))
                     from public.parents pa where pa.id = cp.parent_id)
              end,
              'family_name',
                (select f.display_name from public.families f where f.id = cp.family_id),
              -- A student proposal is a child asking for a class; whoever reads
              -- it will want to reach the parent, not the nine-year-old.
              'family_email',
                (select f.primary_email from public.families f where f.id = cp.family_id),
              'semester_name',
                (select s.name from public.semesters s where s.id = cp.semester_id))
    from public.class_proposals cp
   where cp.status = case when p_archived then 'archived' else 'submitted' end
     and public.is_active_admin()
   order by cp.submitted_at desc;
$$;

revoke execute on function public.admin_proposals(boolean) from public, anon;
grant execute on function public.admin_proposals(boolean) to authenticated;

-- =============================================================================
-- A proposer who is no longer on file.
--
-- Found while testing the above. Both proposer columns are ON DELETE SET NULL,
-- but the constraint required them to be non-null for their kind — so deleting
-- a child who had ever proposed a class failed outright:
--
--   ERROR: new row for relation "class_proposals" violates check constraint
--          "proposer_matches_kind"
--   CONTEXT: UPDATE ONLY "class_proposals" SET "child_id" = NULL
--
-- The two rules contradicted each other. SET NULL says "keep the proposal, lose
-- the name"; the check said the name may never be lost. Nothing in the app
-- deletes a child — they are archived — so it has never fired in use, and it
-- would have surfaced as a baffling error during some future tidy-up.
--
-- The check still does its real job: a proposal cannot claim to be from a
-- parent AND a child, and a new one must name somebody, because the function
-- that creates them requires it. What it no longer does is prevent a name from
-- being forgotten after the fact.
-- =============================================================================
alter table public.class_proposals
  drop constraint if exists proposer_matches_kind;

alter table public.class_proposals
  add constraint proposer_matches_kind check (
    (kind = 'parent'  and child_id  is null) or
    (kind = 'student' and parent_id is null)
  );

select public.record_migration('0032');
