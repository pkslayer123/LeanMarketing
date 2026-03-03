-- Migration 000007: Add project lifecycle tracking columns and activity propagation
--
-- status           — where the project sits in the lean validation funnel
--                    ('active', 'paused', 'converged'); converted to a proper
--                    PostgreSQL enum type in migration 000010.
-- last_activity_at — timestamp of the last meaningful funnel action (send,
--                    reply, stage advance).  Used for "recently active" ordering
--                    and stale-project detection.
-- paused_at        — recorded automatically when status transitions to 'paused'.
-- converged_at     — recorded automatically when status transitions to 'converged'.
-- funnel_stage     — highest funnel layer with confirmed activity; used by the
--                    dashboard for at-a-glance progress indicators.
--
-- Trigger: propagate_project_last_activity
--   Fires AFTER INSERT OR UPDATE on: leads, conversations, offers.
--   Sets projects.last_activity_at = now() so the application never has to
--   manage this value directly.
--
-- Trigger: record_project_status_change
--   Fires BEFORE UPDATE OF status on projects.
--   Stamps paused_at / converged_at when the status first transitions.
--
-- All changes are idempotent (IF NOT EXISTS / CREATE OR REPLACE) so this
-- migration is safe to re-run on a database that partially applied it.

-- ─── Lifecycle columns ─────────────────────────────────────────────────────────
alter table projects
  add column if not exists status text not null default 'active'
    check (status in ('active', 'paused', 'converged')),
  add column if not exists last_activity_at timestamptz,
  add column if not exists paused_at        timestamptz,
  add column if not exists converged_at     timestamptz,
  add column if not exists funnel_stage     text not null default 'idea'
    check (funnel_stage in (
      'idea', 'audience', 'outreach',
      'conversation', 'proof', 'paid_conversion', 'review'
    ));

-- ─── Activity propagation: trigger function ────────────────────────────────────
-- Reads project_id from the NEW (or OLD on delete) row and bumps
-- projects.last_activity_at to now().  CREATE OR REPLACE is idempotent and safe
-- to re-run even if the function already exists from a previous attempt.
create or replace function propagate_project_last_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
begin
  -- Prefer the NEW row's project_id; fall back to OLD on DELETE triggers.
  v_project_id := coalesce(
    (new).project_id,
    (old).project_id
  );

  if v_project_id is not null then
    update projects
       set last_activity_at = now()
     where id = v_project_id;
  end if;

  -- AFTER triggers must return the trigger row unchanged.
  return coalesce(new, old);
end;
$$;

-- Attach to leads: any lead insert or status update counts as funnel activity.
do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'propagate_last_activity_leads'
  ) then
    create trigger propagate_last_activity_leads
      after insert or update on leads
      for each row execute function propagate_project_last_activity();
  end if;
end $$;

-- Attach to conversations: stage advances are the core activity signal.
do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'propagate_last_activity_conversations'
  ) then
    create trigger propagate_last_activity_conversations
      after insert or update on conversations
      for each row execute function propagate_project_last_activity();
  end if;
end $$;

-- Attach to offers: sending or accepting an offer is a high-value activity.
-- (outreach_sends will have project_id added in migration 000009 and its own
-- trigger can be attached there once the column exists.)
do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'propagate_last_activity_offers'
  ) then
    create trigger propagate_last_activity_offers
      after insert or update on offers
      for each row execute function propagate_project_last_activity();
  end if;
end $$;

-- ─── Status audit: trigger function ───────────────────────────────────────────
-- Stamps paused_at / converged_at the FIRST time the status transitions to that
-- value.  Subsequent transitions to the same value do not overwrite the original
-- timestamp, so the columns reflect when the project first reached each state.
create or replace function record_project_status_change()
returns trigger
language plpgsql
as $$
begin
  -- Record when the project is first paused.
  if new.status = 'paused' and (old.status is distinct from 'paused') then
    new.paused_at := now();
  end if;

  -- Record when the project first converges (milestone date for reporting).
  if new.status = 'converged' and (old.status is distinct from 'converged') then
    new.converged_at := now();
  end if;

  return new;
end;
$$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'record_project_status_change'
  ) then
    -- BEFORE trigger so we can mutate the NEW row (set paused_at / converged_at).
    create trigger record_project_status_change
      before update of status on projects
      for each row execute function record_project_status_change();
  end if;
end $$;

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Partial index: active-only project list — the most common dashboard query.
-- Keeping this partial reduces the index size and speeds up the common case.
create index if not exists projects_status_idx
  on projects (user_id, status)
  where status = 'active';

-- Sort projects by most recently active (dashboard default ordering).
create index if not exists projects_last_activity_idx
  on projects (user_id, last_activity_at desc nulls last);

-- Funnel stage filter — used by the per-layer progress views.
create index if not exists projects_funnel_stage_idx
  on projects (user_id, funnel_stage);

-- Convergence reporting — quickly enumerate all converged projects per user.
create index if not exists projects_converged_at_idx
  on projects (user_id, converged_at)
  where converged_at is not null;
