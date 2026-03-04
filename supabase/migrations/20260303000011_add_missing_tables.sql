-- Migration 000011: Add missing tables that app code references
-- Adds user_profiles, and creates views/aliases for name mismatches

-- ─── user_profiles ─────────────────────────────────────────────────────────
create table if not exists user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  role text default 'member' check (role in ('admin', 'member', 'viewer')),
  organization_id uuid,
  onboarding_complete boolean default false,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table user_profiles enable row level security;

create policy "Users can read their own profile"
  on user_profiles for select
  using (auth.uid() = id);

create policy "Users can update their own profile"
  on user_profiles for update
  using (auth.uid() = id);

create policy "Users can insert their own profile"
  on user_profiles for insert
  with check (auth.uid() = id);

-- Auto-create profile on signup via trigger
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into user_profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$ language plpgsql security definer;

-- Drop if exists to avoid duplicate trigger errors
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ─── Convenience views for code that references alternate table names ──────

-- proof_items → proofs
create or replace view proof_items as select * from proofs;

-- analytics_events → review_cycles
create or replace view analytics_events as select * from review_cycles;

-- outreach_messages → outreach_sends
create or replace view outreach_messages as select * from outreach_sends;
