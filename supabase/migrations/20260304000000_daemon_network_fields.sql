-- Migration 20260304000000: Daemon network fields
-- Adds daemon network integration columns to projects and creates a sync log
-- Allows the dashboard to detect and display persona-engine projects from the
-- daemon network coordinated via ChangePilot.

-- ─── Daemon fields on projects ───────────────────────────────────────────────

alter table projects
  add column if not exists daemon_project_name   text,
  add column if not exists daemon_node_id        text,
  add column if not exists is_network_project    boolean      default false,
  add column if not exists daemon_status         text         default 'unknown'
    check (daemon_status in ('unknown', 'running', 'paused', 'converged', 'error')),
  add column if not exists daemon_convergence_score real      default 0
    check (daemon_convergence_score >= 0 and daemon_convergence_score <= 1),
  add column if not exists daemon_build_phase    text         default null
    check (daemon_build_phase in ('BUILD', 'STABILIZE', 'POLISH', 'CONVERGED') or daemon_build_phase is null),
  add column if not exists daemon_claw_cycle     integer      default 0,
  add column if not exists daemon_moc_count      integer      default 0,
  add column if not exists last_synced_at        timestamptz;

comment on column projects.daemon_project_name    is 'Canonical project name registered in the daemon network';
comment on column projects.daemon_node_id         is 'Unique node ID assigned by the daemon network (used for dedup)';
comment on column projects.is_network_project     is 'True when this project is managed by a persona-engine daemon';
comment on column projects.daemon_status          is 'Last known daemon runtime status';
comment on column projects.daemon_convergence_score is 'Compliance score 0–1 from the last spec-compliance report';
comment on column projects.daemon_build_phase     is 'Current convergence phase: BUILD → STABILIZE → POLISH → CONVERGED';
comment on column projects.daemon_claw_cycle      is 'Total claw cycles completed (monotonically increasing)';
comment on column projects.daemon_moc_count       is 'Number of open MOCs in the daemon queue';
comment on column projects.last_synced_at         is 'When the daemon last pushed a status update';

-- ─── Indexes ─────────────────────────────────────────────────────────────────

-- Fast filter for the network projects dashboard widget
create index if not exists idx_projects_network
  on projects (is_network_project)
  where is_network_project = true;

-- Dedup: only one row per daemon node
create unique index if not exists idx_projects_daemon_node
  on projects (daemon_node_id)
  where daemon_node_id is not null;

-- Sort by convergence score for leaderboard views
create index if not exists idx_projects_convergence
  on projects (daemon_convergence_score desc nulls last)
  where is_network_project = true;

-- ─── Daemon sync log ─────────────────────────────────────────────────────────
-- Append-only log of every daemon status push. Enables sparklines and history.

create table if not exists daemon_sync_log (
  id                    uuid        primary key default gen_random_uuid(),
  project_id            uuid        not null references projects(id) on delete cascade,
  daemon_status         text        not null
    check (daemon_status in ('unknown', 'running', 'paused', 'converged', 'error')),
  convergence_score     real        not null default 0
    check (convergence_score >= 0 and convergence_score <= 1),
  build_phase           text
    check (build_phase in ('BUILD', 'STABILIZE', 'POLISH', 'CONVERGED') or build_phase is null),
  claw_cycle            integer     not null default 0,
  moc_count             integer     not null default 0,
  -- Claw-level health snapshot (JSON object keyed by claw name)
  claw_health           jsonb,
  -- Any error detail from the daemon
  error_detail          text,
  synced_at             timestamptz not null default now()
);

comment on table daemon_sync_log is
  'Append-only history of daemon status syncs for trend analysis and sparklines.';

alter table daemon_sync_log enable row level security;

-- Users can read sync log for their own projects
create policy "Users can read daemon sync log for their projects"
  on daemon_sync_log for select
  using (
    exists (
      select 1 from projects p
      where p.id = daemon_sync_log.project_id
        and p.user_id = auth.uid()
    )
  );

-- Service role (daemon sync API) can insert
create policy "Service role can insert daemon sync log"
  on daemon_sync_log for insert
  with check (
    exists (
      select 1 from projects p
      where p.id = daemon_sync_log.project_id
        and p.user_id = auth.uid()
    )
  );

-- Index: recent history per project (most common query pattern)
create index if not exists idx_daemon_sync_log_project_time
  on daemon_sync_log (project_id, synced_at desc);

-- Index: recent global syncs for admin overview
create index if not exists idx_daemon_sync_log_time
  on daemon_sync_log (synced_at desc);

-- ─── Atomic sync function ────────────────────────────────────────────────────
-- Called by the daemon network API to update project status + write history in
-- a single transaction so reads are never inconsistent.

create or replace function sync_daemon_project(
  p_project_id          uuid,
  p_daemon_node_id      text,
  p_daemon_project_name text,
  p_status              text,
  p_convergence_score   real,
  p_build_phase         text  default null,
  p_claw_cycle          integer default 0,
  p_moc_count           integer default 0,
  p_claw_health         jsonb  default null,
  p_error_detail        text   default null
)
returns void
language plpgsql
security definer
as $$
begin
  -- Update the project row
  update projects set
    daemon_node_id          = p_daemon_node_id,
    daemon_project_name     = p_daemon_project_name,
    is_network_project      = true,
    daemon_status           = p_status,
    daemon_convergence_score = p_convergence_score,
    daemon_build_phase      = p_build_phase,
    daemon_claw_cycle       = p_claw_cycle,
    daemon_moc_count        = p_moc_count,
    last_synced_at          = now(),
    updated_at              = now()
  where id = p_project_id;

  if not found then
    raise exception 'project not found: %', p_project_id;
  end if;

  -- Append to history
  insert into daemon_sync_log (
    project_id,
    daemon_status,
    convergence_score,
    build_phase,
    claw_cycle,
    moc_count,
    claw_health,
    error_detail,
    synced_at
  ) values (
    p_project_id,
    p_status,
    p_convergence_score,
    p_build_phase,
    p_claw_cycle,
    p_moc_count,
    p_claw_health,
    p_error_detail,
    now()
  );
end;
$$;

comment on function sync_daemon_project is
  'Atomically updates daemon fields on a project and appends a sync log entry. '
  'Called by the daemon network sync API route.';

-- ─── Convenience view ────────────────────────────────────────────────────────
-- Joins latest sync log entry with project for dashboard consumption.

create or replace view daemon_network_projects as
select
  p.id,
  p.user_id,
  p.name,
  p.status,
  p.daemon_project_name,
  p.daemon_node_id,
  p.daemon_status,
  p.daemon_convergence_score,
  p.daemon_build_phase,
  p.daemon_claw_cycle,
  p.daemon_moc_count,
  p.last_synced_at,
  p.created_at,
  p.updated_at,
  -- Seconds since last sync (null if never synced)
  extract(epoch from (now() - p.last_synced_at))::integer as seconds_since_sync,
  -- Stale if no sync in the last 10 minutes
  (p.last_synced_at < now() - interval '10 minutes') as is_stale
from projects p
where p.is_network_project = true;

comment on view daemon_network_projects is
  'All projects managed by a persona-engine daemon, with staleness indicator.';
