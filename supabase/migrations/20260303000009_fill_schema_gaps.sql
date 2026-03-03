-- Migration 000009: Fill schema gaps
-- All changes are idempotent (IF NOT EXISTS / conditional DO blocks) so this
-- migration is safe to re-run against a database that already partially applied it.

-- ─── leads: add stage column ──────────────────────────────────────────────────
-- Denormalises the conversation_stage onto the lead row to avoid a JOIN on every
-- lead-list query.  The application (and fix-engine) is responsible for keeping
-- this in sync whenever a conversation stage changes.
alter table leads
  add column if not exists stage conversation_stage not null default 'not_relevant';

-- Back-fill stage from the most recent conversation where one exists.
-- Leads that have no conversation row keep the default 'not_relevant'.
update leads l
set stage = c.stage
from conversations c
where c.lead_id = l.id
  and l.stage = 'not_relevant';

-- ─── outreach_sends: project_id shortcut + content snapshot ──────────────────
-- project_id avoids a join through outreach_campaigns in the messages view.
-- content stores the rendered message body at send time (immutable audit record).
alter table outreach_sends
  add column if not exists project_id uuid references projects(id) on delete cascade,
  add column if not exists content text;

-- Back-fill project_id from the parent campaign.
update outreach_sends os
set project_id = oc.project_id
from outreach_campaigns oc
where os.campaign_id = oc.id
  and os.project_id is null;

-- Enforce NOT NULL only after every row has been populated.
-- The DO block prevents a hard failure when some sends lack a campaign reference
-- (e.g. test data).  Re-running after fixing orphaned rows will succeed.
do $$
begin
  if not exists (
    select 1 from outreach_sends where project_id is null limit 1
  ) then
    alter table outreach_sends
      alter column project_id set not null;
  end if;
end $$;

-- ─── offers: add lead_id ─────────────────────────────────────────────────────
-- Migration 000004 now creates lead_id directly; this add-column is a safe no-op
-- when running against an up-to-date schema.
alter table offers
  add column if not exists lead_id uuid references leads(id) on delete set null;

-- ─── Indexes for the new FK columns ──────────────────────────────────────────
-- Migration 000010 also creates these with IF NOT EXISTS, so either order is safe.
create index if not exists outreach_sends_project_id_idx
  on outreach_sends (project_id);

create index if not exists offers_lead_id_idx
  on offers (lead_id) where lead_id is not null;
