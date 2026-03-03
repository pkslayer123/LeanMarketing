/**
 * lib/database/index.ts
 *
 * Central database schema types for use with the typed Supabase client.
 * Mirrors the migration files in supabase/migrations/.
 *
 * Usage:
 *   import type { Database } from '@/lib/database'
 *   const client = createBrowserClient<Database>(url, key)
 */

// ─── Enum types ──────────────────────────────────────────────────────────────

export type LeadStatus = 'new' | 'contacted' | 'replied' | 'opted_out' | 'converted';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'stopped';
export type SendStatus = 'queued' | 'sent' | 'bounced' | 'replied';
export type ConversationStage = 'not_relevant' | 'curious' | 'interested' | 'ready_to_evaluate';
export type MessageDirection = 'outbound' | 'inbound';
export type ProofType = 'summary' | 'demo' | 'trial';
export type OfferStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
export type OfferTemplate = 'trial' | 'early_access' | 'pilot';
export type ProjectStatus = 'active' | 'paused' | 'converged';
export type ApprovalMode = 'strict' | 'relaxed';

// ─── Row types (match DB columns exactly) ────────────────────────────────────

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  status: ProjectStatus;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaRow {
  id: string;
  project_id: string;
  user_id: string;
  description: string;
  audience: string;
  problem: string;
  payment_assumption: string;
  next_step: string;
  quality_gate_passed: boolean | null;
  quality_gate_feedback: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface AudienceDefinitionRow {
  id: string;
  project_id: string;
  user_id: string;
  job_roles: string[];
  company_types: string[];
  inclusion_rules: string[];
  exclusion_rules: string[];
  quality_gate_passed: boolean | null;
  quality_gate_feedback: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface LeadRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  email: string;
  company: string | null;
  job_role: string | null;
  fit_reason: string;
  status: LeadStatus;
  stage: ConversationStage;
  created_at: string;
  updated_at: string;
}

export interface MessageTemplateRow {
  id: string;
  project_id: string;
  user_id: string;
  version: 'A' | 'B';
  subject: string;
  body: string;
  has_cta: boolean;
  has_opt_out: boolean;
  cta_count: number;
  created_at: string;
  updated_at: string;
}

export interface OutreachCampaignRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  rate_limit_per_day: number;
  daily_cap: number;
  stop_on_reply: boolean;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
}

export interface OutreachSendRow {
  id: string;
  campaign_id: string;
  project_id: string;
  lead_id: string;
  template_version: 'A' | 'B';
  content: string | null;
  status: SendStatus;
  sent_at: string | null;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  project_id: string;
  lead_id: string;
  user_id: string;
  stage: ConversationStage;
  next_action: string | null;
  quality_gate_passed: boolean;
  quality_gate_feedback: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  direction: MessageDirection;
  content: string;
  classified_stage: ConversationStage | null;
  created_at: string;
}

export interface ProofRow {
  id: string;
  project_id: string;
  user_id: string;
  proof_type: ProofType;
  title: string;
  outcome_description: string;
  proof_url: string | null;
  content: string | null;
  consumption_time_minutes: number;
  decision_request: string;
  quality_gate_passed: boolean;
  quality_gate_feedback: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface LandingPageRow {
  id: string;
  project_id: string;
  user_id: string;
  problem_statement: string;
  outcome_description: string;
  call_to_action: string;
  proof_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OfferRow {
  id: string;
  project_id: string;
  lead_id: string | null;
  user_id: string;
  template: OfferTemplate;
  scope: string;
  duration_days: number;
  price_cents: number;
  success_definition: string;
  status: OfferStatus;
  sent_to: string | null;
  quality_gate_passed: boolean | null;
  quality_gate_feedback: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewCycleRow {
  id: string;
  project_id: string;
  user_id: string;
  cycle_number: number;
  messages_sent: number;
  replies: number;
  stage_advances: number;
  bottleneck: string;
  variable_changed: string;
  hypothesis: string;
  quality_gate_passed: boolean | null;
  quality_gate_feedback: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectSettingsRow {
  id: string;
  project_id: string;
  user_id: string;
  approval_mode: ApprovalMode;
  created_at: string;
  updated_at: string;
}

// ─── View types ───────────────────────────────────────────────────────────────

/** Flat shape exposed by the `messages` view (mirrors outreach_sends columns). */
export interface MessageView {
  id: string;
  project_id: string;
  lead_id: string;
  template_version: 'A' | 'B';
  content: string | null;
  status: SendStatus;
  sent_at: string | null;
  created_at: string;
}

// ─── Supabase Database type ───────────────────────────────────────────────────
// Pass this to createBrowserClient<Database> / createServerClient<Database>
// for fully typed query results.

type TableDef<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
};

export interface Database {
  public: {
    Tables: {
      projects: TableDef<ProjectRow>;
      ideas: TableDef<IdeaRow>;
      audience_definitions: TableDef<AudienceDefinitionRow>;
      leads: TableDef<LeadRow>;
      message_templates: TableDef<MessageTemplateRow>;
      outreach_campaigns: TableDef<OutreachCampaignRow>;
      outreach_sends: TableDef<OutreachSendRow>;
      conversations: TableDef<ConversationRow>;
      conversation_messages: TableDef<ConversationMessageRow>;
      proofs: TableDef<ProofRow>;
      landing_pages: TableDef<LandingPageRow>;
      offers: TableDef<OfferRow>;
      review_cycles: TableDef<ReviewCycleRow>;
      project_settings: TableDef<ProjectSettingsRow>;
    };
    Views: {
      messages: { Row: MessageView };
    };
    Functions: Record<string, never>;
    Enums: {
      lead_status: LeadStatus;
      campaign_status: CampaignStatus;
      send_status: SendStatus;
      conversation_stage: ConversationStage;
      message_direction: MessageDirection;
      proof_type: ProofType;
      offer_status: OfferStatus;
      offer_template: OfferTemplate;
      project_status: ProjectStatus;
      approval_mode: ApprovalMode;
    };
  };
}
