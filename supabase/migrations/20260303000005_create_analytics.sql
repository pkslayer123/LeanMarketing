-- Migration 000005: Layer 6 — Review and Adjustment
-- Creates review_cycles: one row per experiment cycle per project.
-- Implements the lean "change one variable at a time" principle with a full
-- metrics snapshot so progress across cycles can be compared over time.

create table if not exists review_cycles (
  id uuid primary key default gen_random_uuid(),

  -- Ownership
  project_id uuid references projects(id) on delete cascade not null,
  user_id    uuid references auth.users(id) on delete cascade not null,

  -- Monotonically increasing cycle counter (starts at 1)
  cycle_number integer not null default 1 check (cycle_number > 0),

  -- ── Funnel metrics snapshot at review time ──────────────────────────────
  messages_sent   integer not null default 0 check (messages_sent >= 0),
  replies         integer not null default 0 check (replies >= 0),
  stage_advances  integer not null default 0 check (stage_advances >= 0),
  offers_sent     integer not null default 0 check (offers_sent >= 0),
  offers_accepted integer not null default 0 check (offers_accepted >= 0),

  -- The key bottleneck identified this cycle (e.g. "low reply rate")
  bottleneck text not null default '',

  -- ── Lean single-variable experiment tracking ────────────────────────────
  variable_changed text not null default '',   -- what the founder changed
  hypothesis       text not null default '',   -- expected outcome
  outcome          text,                       -- actual result (filled after cycle)

  -- ── Quality gate ────────────────────────────────────────────────────────
  quality_gate_passed   boolean,
  quality_gate_feedback jsonb,

  -- ── Computed rate columns (stored, maintained by Postgres) ──────────────
  -- reply_rate   = replies / messages_sent  (0–1 ratio, NULL when no messages)
  reply_rate numeric(7, 4) generated always as (
    case when messages_sent > 0
      then round(replies::numeric / messages_sent, 4)
      else null
    end
  ) stored,

  -- advance_rate = stage_advances / replies  (0–1 ratio, NULL when no replies)
  advance_rate numeric(7, 4) generated always as (
    case when replies > 0
      then round(stage_advances::numeric / replies, 4)
      else null
    end
  ) stored,

  -- conversion_rate = offers_accepted / offers_sent
  conversion_rate numeric(7, 4) generated always as (
    case when offers_sent > 0
      then round(offers_accepted::numeric / offers_sent, 4)
      else null
    end
  ) stored,

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,

  -- Enforce one row per cycle per project per user
  unique (project_id, user_id, cycle_number)
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
-- Primary query: all cycles for a project, newest first
create index on review_cycles (project_id, cycle_number desc);

-- User-scoped listing (dashboard feed)
create index on review_cycles (user_id, created_at desc);

-- Composite covering index used by the analytics summary query
create index on review_cycles (project_id, user_id, cycle_number);

-- ─── Row-level security ───────────────────────────────────────────────────────
alter table review_cycles enable row level security;

create policy "Users can manage their own review cycles"
  on review_cycles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
