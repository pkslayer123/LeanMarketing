-- Migration 000007: Add lifecycle columns to projects
-- status        — where the project sits in the lean validation funnel
-- last_activity_at — timestamp of the last meaningful action (send, reply, stage advance)
--                   used for "recently active" ordering and stale-project detection
-- Migration 000010 will convert the status column to a project_status enum type.

alter table projects
  add column if not exists status text not null default 'active'
    check (status in ('active', 'paused', 'converged')),
  add column if not exists last_activity_at timestamptz;

-- ─── Indexes ──────────────────────────────────────────────────────────────────
-- Filter to active projects only (the most common list query)
create index if not exists projects_status_idx
  on projects (user_id, status)
  where status = 'active';

-- Sort projects by most recently active (dashboard default ordering)
create index if not exists projects_last_activity_idx
  on projects (user_id, last_activity_at desc nulls last);
