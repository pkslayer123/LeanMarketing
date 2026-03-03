-- Add status and last_activity_at to projects
alter table projects
  add column if not exists status text not null default 'active'
    check (status in ('active', 'paused', 'converged')),
  add column if not exists last_activity_at timestamptz;
