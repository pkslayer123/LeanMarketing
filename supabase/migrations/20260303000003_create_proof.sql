-- proof_type enum: the three supported proof formats
create type proof_type as enum ('summary', 'demo', 'trial');

-- One proof artifact per project; tracks type, quality gate, and decision request
create table if not exists proofs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  proof_type proof_type not null default 'summary',
  title text not null,
  outcome_description text not null,
  proof_url text,
  content text,
  consumption_time_minutes integer not null default 5,
  decision_request text not null,
  quality_gate_passed boolean not null default false,
  quality_gate_feedback jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique(project_id, user_id)
);

alter table proofs enable row level security;

create policy "Users can manage their own proofs"
  on proofs for all
  using (auth.uid() = user_id);

-- Simple landing page per project: problem, outcome, single CTA
create table if not exists landing_pages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  problem_statement text not null,
  outcome_description text not null,
  call_to_action text not null,
  proof_id uuid references proofs(id) on delete set null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique(project_id, user_id)
);

alter table landing_pages enable row level security;

create policy "Users can manage their own landing_pages"
  on landing_pages for all
  using (auth.uid() = user_id);
