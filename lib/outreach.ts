/**
 * lib/outreach.ts
 *
 * Input types and pure helper functions for the outreach layer
 * (leads, audience definitions, message templates, campaigns).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type LeadStatus = 'new' | 'contacted' | 'replied' | 'opted_out' | 'converted';

export interface LeadInput {
  project_id: string;
  name: string;
  email: string;
  company?: string;
  job_role?: string;
  fit_reason: string;
}

export interface AudienceInput {
  project_id: string;
  job_roles?: string[];
  company_types?: string[];
  inclusion_rules?: string[];
  exclusion_rules?: string[];
}

export interface CampaignInput {
  project_id: string;
  name: string;
  rate_limit_per_day?: number;
  daily_cap?: number;
  stop_on_reply?: boolean;
}

export interface MessageTemplateInput {
  project_id: string;
  version: 'A' | 'B';
  subject: string;
  body: string;
}

// ─── Row types (database records) ────────────────────────────────────────────

export interface Lead extends LeadInput {
  id: string;
  status: LeadStatus;
  stage?: string;
  created_at: string;
}

export interface AudienceDefinition extends AudienceInput {
  id: string;
  created_at: string;
}

export interface MessageTemplate extends MessageTemplateInput {
  id: string;
  created_at: string;
}

export interface OutreachCampaign extends CampaignInput {
  id: string;
  status: string;
  created_at: string;
}

// ─── Quality gate types ───────────────────────────────────────────────────────

export interface QualityGateCheck {
  label: string;
  passed: boolean;
  feedback: string;
}

export interface QualityGateFeedback {
  overall_passed: boolean;
  checks: QualityGateCheck[];
}

// ─── Template analysis ────────────────────────────────────────────────────────

export interface TemplateAnalysis {
  has_cta: boolean;
  has_opt_out: boolean;
  cta_count: number;
}

const CTA_PATTERNS = [
  /\bschedule\b/i,
  /\bbook\b/i,
  /\breply\b/i,
  /\bclick here\b/i,
  /\bsign up\b/i,
  /\bjoin\b/i,
  /\bget started\b/i,
  /\blearn more\b/i,
];

const OPT_OUT_PATTERN = /\bunsubscribe\b|\bopt.?out\b|\bno longer\b/i;

export function analyseTemplate(body: string): TemplateAnalysis {
  const cta_count = CTA_PATTERNS.filter((p) => p.test(body)).length;
  return {
    has_cta: cta_count > 0,
    has_opt_out: OPT_OUT_PATTERN.test(body),
    cta_count,
  };
}

// ─── Quality gate 2 (Audience + Outreach) ────────────────────────────────────

interface AudienceRecord {
  job_roles: string[];
  company_types: string[];
  inclusion_rules: string[];
  exclusion_rules: string[];
}

interface LeadRecord {
  name: string;
  email: string;
  fit_reason: string;
}

interface TemplateRecord {
  has_cta: boolean;
  has_opt_out: boolean;
}

export function runQualityGate2({
  audience,
  leads,
  templates,
}: {
  audience: AudienceRecord;
  leads: LeadRecord[];
  templates: TemplateRecord[];
}): QualityGateFeedback {
  const checks: QualityGateCheck[] = [
    {
      label: 'Audience defined',
      passed: audience.job_roles.length > 0 || audience.company_types.length > 0,
      feedback:
        audience.job_roles.length > 0 || audience.company_types.length > 0
          ? 'At least one job role or company type is defined.'
          : 'Define at least one job role or company type.',
    },
    {
      label: 'Leads uploaded',
      passed: leads.length > 0,
      feedback:
        leads.length > 0
          ? `${leads.length} lead(s) available.`
          : 'Upload at least one lead before launching.',
    },
    {
      label: 'Templates have CTA',
      passed: templates.length > 0 && templates.every((t) => t.has_cta),
      feedback:
        templates.length === 0
          ? 'Create at least one message template with a call-to-action.'
          : templates.every((t) => t.has_cta)
          ? 'All templates include a call-to-action.'
          : 'Some templates are missing a call-to-action.',
    },
    {
      label: 'Opt-out language present',
      passed: templates.length > 0 && templates.some((t) => t.has_opt_out),
      feedback:
        templates.some((t) => t.has_opt_out)
          ? 'Opt-out language found in at least one template.'
          : 'Add unsubscribe / opt-out language to at least one template.',
    },
  ];

  return {
    overall_passed: checks.every((c) => c.passed),
    checks,
  };
}
