export interface AudienceDefinition {
  id: string;
  project_id: string;
  user_id: string;
  job_roles: string[];
  company_types: string[];
  inclusion_rules: string[];
  exclusion_rules: string[];
  quality_gate_passed: boolean | null;
  quality_gate_feedback: QualityGate2Feedback | null;
  created_at: string;
  updated_at: string;
}

export interface AudienceInput {
  project_id: string;
  job_roles: string[];
  company_types: string[];
  inclusion_rules: string[];
  exclusion_rules: string[];
}

export type LeadStatus = 'new' | 'contacted' | 'replied' | 'opted_out' | 'converted';

export interface Lead {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  email: string;
  company: string | null;
  job_role: string | null;
  fit_reason: string;
  status: LeadStatus;
  created_at: string;
  updated_at: string;
}

export interface LeadInput {
  project_id: string;
  name: string;
  email: string;
  company?: string;
  job_role?: string;
  fit_reason: string;
}

export interface MessageTemplate {
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

export interface MessageTemplateInput {
  project_id: string;
  version: 'A' | 'B';
  subject: string;
  body: string;
}

export interface OutreachCampaign {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  rate_limit_per_day: number;
  daily_cap: number;
  stop_on_reply: boolean;
  status: 'draft' | 'active' | 'paused' | 'stopped';
  created_at: string;
  updated_at: string;
}

export interface CampaignInput {
  project_id: string;
  name: string;
  rate_limit_per_day: number;
  daily_cap: number;
  stop_on_reply: boolean;
}

export interface QualityGate2Check {
  passed: boolean;
  label: string;
  detail: string;
}

export interface QualityGate2Feedback {
  overall_passed: boolean;
  checks: {
    audience_defined: QualityGate2Check;
    lead_fit_documented: QualityGate2Check;
    single_cta: QualityGate2Check;
    opt_out_enabled: QualityGate2Check;
  };
}

export interface QualityGate2Input {
  audience: AudienceDefinition | null;
  leads: Lead[];
  templates: MessageTemplate[];
}

/** Count hyperlinks and reply CTAs in a message body */
function countCTAs(body: string): number {
  const urls = body.match(/https?:\/\/[^\s<>"')]+/g) ?? [];
  const replyPhrases = body.match(/reply\s+to\s+(this\s+)?email/gi) ?? [];
  return urls.length + replyPhrases.length;
}

/** Detect if message body contains an opt-out phrase */
function hasOptOut(body: string): boolean {
  return /unsubscribe|opt.?out|remove me|stop receiving/i.test(body);
}

/** Analyse a message body and return template metadata */
export function analyseTemplate(body: string): {
  cta_count: number;
  has_cta: boolean;
  has_opt_out: boolean;
} {
  const cta_count = countCTAs(body);
  return { cta_count, has_cta: cta_count > 0, has_opt_out: hasOptOut(body) };
}

/** Run Quality Gate 2 checks */
export function runQualityGate2(input: QualityGate2Input): QualityGate2Feedback {
  const { audience, leads, templates } = input;

  const audienceDefined =
    !!audience &&
    (audience.job_roles.length > 0 || audience.company_types.length > 0);

  const leadFitDocumented =
    leads.length > 0 &&
    leads.every((l) => l.fit_reason && l.fit_reason.trim().length > 0);

  const allTemplatesHaveSingleCTA =
    templates.length > 0 && templates.every((t) => t.cta_count === 1);

  const allTemplatesHaveOptOut =
    templates.length > 0 && templates.every((t) => t.has_opt_out);

  const checks: QualityGate2Feedback['checks'] = {
    audience_defined: {
      passed: audienceDefined,
      label: 'Audience defined',
      detail: audienceDefined
        ? 'Job roles or company types specified.'
        : 'Add at least one job role or company type.',
    },
    lead_fit_documented: {
      passed: leadFitDocumented,
      label: 'Lead fit documented',
      detail: leadFitDocumented
        ? `${leads.length} lead(s) with fit reasons.`
        : leads.length === 0
        ? 'Add at least one lead with a fit reason.'
        : 'All leads must have a fit reason.',
    },
    single_cta: {
      passed: allTemplatesHaveSingleCTA,
      label: 'Single CTA per message',
      detail: allTemplatesHaveSingleCTA
        ? 'Each message version has exactly one CTA.'
        : templates.length === 0
        ? 'Create message templates (versions A and B).'
        : 'Each message version must have exactly one call-to-action.',
    },
    opt_out_enabled: {
      passed: allTemplatesHaveOptOut,
      label: 'Opt-out enabled',
      detail: allTemplatesHaveOptOut
        ? 'All message versions include an opt-out.'
        : templates.length === 0
        ? 'Create message templates with opt-out language.'
        : 'All message versions must include unsubscribe / opt-out text.',
    },
  };

  return { overall_passed: Object.values(checks).every((c) => c.passed), checks };
}
