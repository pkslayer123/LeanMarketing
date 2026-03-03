-- Projects table
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table projects enable row level security;

create policy "Users can manage their own projects"
  on projects for all
  using (auth.uid() = user_id);

-- Ideas table
create table if not exists ideas (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  description text not null,
  audience text not null,
  problem text not null,
  payment_assumption text not null,
  next_step text not null,
  quality_gate_passed boolean,
  quality_gate_feedback jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table ideas enable row level security;

create policy "Users can manage their own ideas"
  on ideas for all
  using (auth.uid() = user_id);
