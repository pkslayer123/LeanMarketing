-- Migration 000010: Performance indexes and convenience view
--
-- Note: Enum type conversions removed — text+check constraints from earlier
-- migrations work correctly and avoid trigger/default casting issues.

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
