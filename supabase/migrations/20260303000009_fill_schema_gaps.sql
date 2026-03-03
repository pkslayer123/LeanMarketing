-- Fill missing columns identified in the database-schema spec

-- leads: add stage (denormalised conversation stage for easy querying)
alter table leads
  add column if not exists stage conversation_stage not null default 'not_relevant';

-- outreach_sends: add project_id shortcut and content snapshot
alter table outreach_sends
  add column if not exists project_id uuid references projects(id) on delete cascade,
  add column if not exists content text;

-- Back-fill project_id from the parent campaign
update outreach_sends os
set project_id = oc.project_id
from outreach_campaigns oc
where os.campaign_id = oc.id
  and os.project_id is null;

-- Make project_id non-nullable now that it is populated
alter table outreach_sends
  alter column project_id set not null;

-- offers: add lead_id to link an offer to a specific lead
alter table offers
  add column if not exists lead_id uuid references leads(id) on delete set null;
