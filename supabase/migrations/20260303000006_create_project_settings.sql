-- Migration 000006: Project settings
-- One settings row per (project, user) pair.
-- Controls the approval-mode quality gate and outreach behaviour overrides.
-- Migration 000010 will later convert the approval_mode column to an enum type.

create table if not exists project_settings (
  id uuid primary key default gen_random_uuid(),

  -- Ownership (composite unique enforced below)
  project_id uuid references projects(id) on delete cascade not null,
  user_id    uuid references auth.users(id) on delete cascade not null,

  -- ── Quality-gate behaviour ───────────────────────────────────────────────
  -- 'strict'  → block every layer action until the oracle approves
  -- 'relaxed' → show oracle warnings but allow the user to proceed anyway
  approval_mode text not null default 'strict'
    check (approval_mode in ('strict', 'relaxed')),

  -- ── Outreach overrides (NULL = use the campaign-level defaults) ──────────
  -- Max messages to send per day across all active campaigns for this project
  daily_send_cap integer check (daily_send_cap is null or daily_send_cap > 0),
  -- Max sends per lead per day (anti-spam guard)
  rate_limit_per_day integer check (rate_limit_per_day is null or rate_limit_per_day > 0),

  -- ── Notification preferences ────────────────────────────────────────────
  notify_on_reply          boolean not null default true,
  notify_on_stage_advance  boolean not null default true,
  notify_on_offer_response boolean not null default true,

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,

  -- Exactly one settings row per project per user
  unique (project_id, user_id)
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
-- Fetch settings by user (dashboard load)
create index on project_settings (user_id);

-- Fetch settings by project (API middleware check)
create index on project_settings (project_id);

-- ─── Row-level security ───────────────────────────────────────────────────────
alter table project_settings enable row level security;

create policy "Users can manage their own project settings"
  on project_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
