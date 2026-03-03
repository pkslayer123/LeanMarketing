-- Migration 000004: Layer 5 — Paid Conversion
-- Creates the offers table linking projects and leads to trial/pilot proposals.
-- lead_id is included here so migration 000009 add-column is a safe no-op.

create table if not exists offers (
  id uuid primary key default gen_random_uuid(),

  -- Ownership
  project_id uuid references projects(id) on delete cascade not null,
  user_id    uuid references auth.users(id) on delete cascade not null,

  -- The specific lead this offer targets (nullable: offer may be drafted before assigning)
  lead_id uuid references leads(id) on delete set null,

  -- Offer structure
  template text not null
    check (template in ('trial', 'early_access', 'pilot')),
  scope              text    not null,
  duration_days      integer not null check (duration_days > 0),
  price_cents        integer not null check (price_cents >= 0),
  success_definition text    not null,

  -- Lifecycle
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),
  sent_to   text,
  sent_at   timestamptz,

  -- Quality gate result from the LLM oracle
  quality_gate_passed   boolean,
  quality_gate_feedback jsonb,

  -- Free-form notes for the founder
  notes text,

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
-- Primary list queries: all offers for a project
create index on offers (project_id);

-- Ownership index (used by RLS scan + user-scoped API calls)
create index on offers (user_id);

-- Lead-based lookups (has offer been sent to this lead?)
create index on offers (lead_id) where lead_id is not null;

-- Status filtering (e.g. "show all accepted offers")
create index on offers (status);

-- Combined: active offer pipeline view per project
create index on offers (project_id, status);

-- ─── Row-level security ───────────────────────────────────────────────────────
alter table offers enable row level security;

-- Users can only see and mutate their own rows.
-- WITH CHECK ensures inserts/updates cannot claim a different user_id.
create policy "Users can manage their own offers"
  on offers for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
