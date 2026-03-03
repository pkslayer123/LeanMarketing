-- Audience definitions
create table if not exists audience_definitions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  job_roles text[] not null default '{}',
  company_types text[] not null default '{}',
  inclusion_rules text[] not null default '{}',
  exclusion_rules text[] not null default '{}',
  quality_gate_passed boolean,
  quality_gate_feedback jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique(project_id, user_id)
);

alter table audience_definitions enable row level security;

create policy "Users can manage their own audience definitions"
  on audience_definitions for all
  using (auth.uid() = user_id);

-- Leads
create type lead_status as enum ('new', 'contacted', 'replied', 'opted_out', 'converted');

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  email text not null,
  company text,
  job_role text,
  fit_reason text not null,
  status lead_status not null default 'new',
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table leads enable row level security;

create policy "Users can manage their own leads"
  on leads for all
  using (auth.uid() = user_id);

-- Message templates (A/B versions)
create table if not exists message_templates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  version text not null check (version in ('A', 'B')),
  subject text not null,
  body text not null,
  has_cta boolean not null default false,
  has_opt_out boolean not null default false,
  cta_count integer not null default 0,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique(project_id, user_id, version)
);

alter table message_templates enable row level security;

create policy "Users can manage their own message templates"
  on message_templates for all
  using (auth.uid() = user_id);

-- Outreach campaigns
create type campaign_status as enum ('draft', 'active', 'paused', 'stopped');

create table if not exists outreach_campaigns (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  rate_limit_per_day integer not null default 20,
  daily_cap integer not null default 50,
  stop_on_reply boolean not null default true,
  status campaign_status not null default 'draft',
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table outreach_campaigns enable row level security;

create policy "Users can manage their own outreach campaigns"
  on outreach_campaigns for all
  using (auth.uid() = user_id);

-- Mock sends (provider-neutral)
create type send_status as enum ('queued', 'sent', 'bounced', 'replied');

create table if not exists outreach_sends (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references outreach_campaigns(id) on delete cascade not null,
  lead_id uuid references leads(id) on delete cascade not null,
  template_version text not null check (template_version in ('A', 'B')),
  status send_status not null default 'queued',
  sent_at timestamptz,
  created_at timestamptz default now() not null
);

alter table outreach_sends enable row level security;

create policy "Users can manage their own outreach sends"
  on outreach_sends for all
  using (
    exists (
      select 1 from outreach_campaigns
      where outreach_campaigns.id = outreach_sends.campaign_id
        and outreach_campaigns.user_id = auth.uid()
    )
  );
