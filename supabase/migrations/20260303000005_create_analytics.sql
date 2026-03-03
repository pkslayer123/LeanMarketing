-- Review cycles for Layer 6 — Review and Adjustment
create table if not exists review_cycles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  cycle_number integer not null default 1,
  -- Metrics snapshot at time of review
  messages_sent integer not null default 0,
  replies integer not null default 0,
  stage_advances integer not null default 0,
  bottleneck text not null default '',
  -- Single-variable tracking
  variable_changed text not null default '',
  hypothesis text not null default '',
  -- Quality gate
  quality_gate_passed boolean,
  quality_gate_feedback jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table review_cycles enable row level security;

create policy "Users can manage their own review cycles"
  on review_cycles for all
  using (auth.uid() = user_id);

create index on review_cycles (project_id, user_id, cycle_number);
