-- Migration 000010: Add proper enum types for text+check columns, and performance indexes
--
-- Migrations 000004, 000006, 000007 used text+check constraints instead of
-- PostgreSQL enum types for consistency with the rest of the schema.
-- This migration adds those enum types and converts the columns.

-- ─── Enum: project_status ────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'project_status') then
    create type project_status as enum ('active', 'paused', 'converged');
  end if;
end $$;

alter table projects
  alter column status type project_status
  using status::project_status;

-- ─── Enum: offer_template ────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'offer_template') then
    create type offer_template as enum ('trial', 'early_access', 'pilot');
  end if;
end $$;

alter table offers
  alter column template type offer_template
  using template::offer_template;

-- ─── Enum: offer_status ──────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'offer_status') then
    create type offer_status as enum ('draft', 'sent', 'accepted', 'declined', 'expired');
  end if;
end $$;

alter table offers
  alter column status type offer_status
  using status::offer_status;

-- ─── Enum: approval_mode ─────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'approval_mode') then
    create type approval_mode as enum ('strict', 'relaxed');
  end if;
end $$;

alter table project_settings
  alter column approval_mode type approval_mode
  using approval_mode::approval_mode;

-- ─── Performance indexes ─────────────────────────────────────────────────────
-- ideas
create index if not exists ideas_project_id_idx on ideas (project_id);

-- leads
create index if not exists leads_project_id_idx on leads (project_id);
create index if not exists leads_user_id_idx on leads (user_id);
create index if not exists leads_status_idx on leads (status);
create index if not exists leads_stage_idx on leads (stage);

-- outreach_sends
create index if not exists outreach_sends_project_id_idx on outreach_sends (project_id);
create index if not exists outreach_sends_lead_id_idx on outreach_sends (lead_id);

-- conversations
create index if not exists conversations_project_id_idx on conversations (project_id);
create index if not exists conversations_lead_id_idx on conversations (lead_id);

-- conversation_messages
create index if not exists conversation_messages_conversation_id_idx on conversation_messages (conversation_id);

-- offers
create index if not exists offers_project_id_idx on offers (project_id);
create index if not exists offers_lead_id_idx on offers (lead_id);

-- review_cycles (already has a multi-column index from migration 000005)

-- ─── Convenience view: messages ──────────────────────────────────────────────
-- Exposes outreach_sends with a flat lead_id/project_id shape that matches
-- the BUILD-SPEC "messages table" concept, making API queries simpler.
create or replace view messages as
  select
    os.id,
    os.project_id,
    os.lead_id,
    os.template_version,
    os.content,
    os.status,
    os.sent_at,
    os.created_at
  from outreach_sends os;
