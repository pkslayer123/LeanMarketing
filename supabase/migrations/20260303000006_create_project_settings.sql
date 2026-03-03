-- Project settings for approval mode (per project, per user)
create table if not exists project_settings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  approval_mode text not null default 'strict' check (approval_mode in ('strict', 'relaxed')),
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique (project_id, user_id)
);

alter table project_settings enable row level security;

create policy "Users can manage their own project settings"
  on project_settings for all
  using (auth.uid() = user_id);

create index on project_settings (user_id);
