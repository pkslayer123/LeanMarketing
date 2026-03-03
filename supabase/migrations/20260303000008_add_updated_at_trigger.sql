-- Migration 000008: Add a reusable set_updated_at() trigger function
-- and attach it to all tables that have an updated_at column.
--
-- This ensures updated_at is always kept in sync without relying on
-- application-layer timestamps being passed correctly on every write.

-- ─── Trigger function ─────────────────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─── Helper macro: attach trigger if not already present ─────────────────────
-- We use a DO block per table to be idempotent (safe to re-run).

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_projects'
  ) then
    create trigger set_updated_at_projects
      before update on projects
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_ideas'
  ) then
    create trigger set_updated_at_ideas
      before update on ideas
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_audience_definitions'
  ) then
    create trigger set_updated_at_audience_definitions
      before update on audience_definitions
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_leads'
  ) then
    create trigger set_updated_at_leads
      before update on leads
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_message_templates'
  ) then
    create trigger set_updated_at_message_templates
      before update on message_templates
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_outreach_campaigns'
  ) then
    create trigger set_updated_at_outreach_campaigns
      before update on outreach_campaigns
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_conversations'
  ) then
    create trigger set_updated_at_conversations
      before update on conversations
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_proofs'
  ) then
    create trigger set_updated_at_proofs
      before update on proofs
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_landing_pages'
  ) then
    create trigger set_updated_at_landing_pages
      before update on landing_pages
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_offers'
  ) then
    create trigger set_updated_at_offers
      before update on offers
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_review_cycles'
  ) then
    create trigger set_updated_at_review_cycles
      before update on review_cycles
      for each row execute function set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_updated_at_project_settings'
  ) then
    create trigger set_updated_at_project_settings
      before update on project_settings
      for each row execute function set_updated_at();
  end if;
end $$;
