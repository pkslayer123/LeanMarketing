/**
 * lib/proof.ts
 *
 * Input types and pure helper functions for the proof and landing-page layer.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProofType = 'summary' | 'demo' | 'trial';

export interface Proof extends ProofInput {
  id: string;
  created_at: string;
  updated_at: string;
  quality_gate_feedback?: QualityGateFeedback | null;
}

export const PROOF_TYPE_LABELS: Record<ProofType, string> = {
  summary: 'Written Summary',
  demo: 'Walkthrough Demo',
  trial: 'Trial / Pilot',
};

export const PROOF_TYPE_DESCRIPTIONS: Record<ProofType, string> = {
  summary: 'A concise written document showing the outcome.',
  demo: 'A live or recorded walkthrough of the product.',
  trial: 'A time-limited trial or pilot agreement.',
};

export interface ProofInput {
  project_id: string;
  proof_type: ProofType;
  title: string;
  outcome_description: string;
  proof_url?: string;
  content?: string;
  consumption_time_minutes: number;
  decision_request: string;
}

export interface LandingPageInput {
  project_id: string;
  problem_statement: string;
  outcome_description: string;
  call_to_action: string;
  proof_id?: string;
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

// ─── Quality gate (Proof) ─────────────────────────────────────────────────────

type ProofGateInput = Omit<ProofInput, 'project_id'>;

export function runQualityGate(input: ProofGateInput): QualityGateFeedback {
  const checks: QualityGateCheck[] = [
    {
      label: 'Title',
      passed: input.title.trim().length >= 5,
      feedback:
        input.title.trim().length >= 5
          ? 'Title is descriptive.'
          : 'Title must be at least 5 characters.',
    },
    {
      label: 'Outcome description',
      passed: input.outcome_description.trim().length >= 20,
      feedback:
        input.outcome_description.trim().length >= 20
          ? 'Outcome is clearly described.'
          : 'Describe the outcome in at least 20 characters.',
    },
    {
      label: 'Consumption time',
      passed: input.consumption_time_minutes > 0 && input.consumption_time_minutes <= 30,
      feedback:
        input.consumption_time_minutes > 0 && input.consumption_time_minutes <= 30
          ? `${input.consumption_time_minutes} min — within the recommended range.`
          : 'Consumption time should be between 1 and 30 minutes.',
    },
    {
      label: 'Decision request',
      passed: input.decision_request.trim().length >= 10,
      feedback:
        input.decision_request.trim().length >= 10
          ? 'Decision request is clearly stated.'
          : 'State a clear decision request (at least 10 characters).',
    },
    {
      label: 'Proof content or URL',
      passed: !!(input.proof_url?.trim() || input.content?.trim()),
      feedback:
        input.proof_url?.trim() || input.content?.trim()
          ? 'Proof content or URL is provided.'
          : 'Provide either a proof URL or content body.',
    },
  ];

  return {
    overall_passed: checks.every((c) => c.passed),
    checks,
  };
}
