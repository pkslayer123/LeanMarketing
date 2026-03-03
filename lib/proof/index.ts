export type ProofType = 'summary' | 'demo' | 'trial';

export const PROOF_TYPE_LABELS: Record<ProofType, string> = {
  summary: 'Written Summary',
  demo: 'Walkthrough Demo',
  trial: 'Real-Use Trial',
};

export const PROOF_TYPE_DESCRIPTIONS: Record<ProofType, string> = {
  summary: 'A concise written explanation of what your solution does and the outcome it delivers.',
  demo: 'A short walkthrough (under 10 min) showing the outcome before the features.',
  trial: 'A hands-on trial where prospects can experience the outcome themselves.',
};

export interface QualityGateCheck {
  label: string;
  passed: boolean;
  feedback: string;
}

export interface QualityGateFeedback {
  checks: QualityGateCheck[];
  overall_passed: boolean;
}

export interface Proof {
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
  quality_gate_feedback: QualityGateFeedback | null;
  created_at: string;
  updated_at: string;
}

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

export interface LandingPage {
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

export interface LandingPageInput {
  project_id: string;
  problem_statement: string;
  outcome_description: string;
  call_to_action: string;
  proof_id?: string;
}

export function runQualityGate(input: Omit<ProofInput, 'project_id'>): QualityGateFeedback {
  const checks: QualityGateCheck[] = [];

  // Check 1: Outcome-focused, not feature-focused
  const outcomeLower = input.outcome_description.toLowerCase();
  const featureWords = ['feature', 'function', 'capability', 'button', 'interface', 'dashboard', 'module'];
  const outcomeWords = ['result', 'save', 'reduce', 'increase', 'earn', 'achieve', 'get', 'outcome', 'benefit', 'value', 'impact', 'help', 'allows', 'enables'];
  const hasFeatureOnly = featureWords.some(w => outcomeLower.includes(w)) && !outcomeWords.some(w => outcomeLower.includes(w));
  const outcomePassed = !hasFeatureOnly;
  checks.push({
    label: 'Outcome-focused',
    passed: outcomePassed,
    feedback: outcomePassed
      ? 'Description focuses on the outcome.'
      : 'Describe what the prospect achieves, not the features of your product.',
  });

  // Check 2: Under 10 minutes
  const timePassed = input.consumption_time_minutes >= 1 && input.consumption_time_minutes <= 10;
  checks.push({
    label: 'Under 10 minutes',
    passed: timePassed,
    feedback: timePassed
      ? `Estimated time is ${input.consumption_time_minutes} min — within the 10-minute limit.`
      : `${input.consumption_time_minutes} min exceeds the 10-minute maximum. Trim your proof to keep prospects engaged.`,
  });

  // Check 3: Clear decision request
  const decisionWords = ['decide', 'ready', 'start', 'move forward', 'next step', 'schedule', 'book', 'sign up', 'try', 'commit', 'join', 'yes', 'proceed'];
  const decisionLower = input.decision_request.toLowerCase();
  const decisionPassed = input.decision_request.trim().length >= 10 && decisionWords.some(w => decisionLower.includes(w));
  checks.push({
    label: 'Clear decision request',
    passed: decisionPassed,
    feedback: decisionPassed
      ? 'Decision request is clear and action-oriented.'
      : 'End with one direct ask — e.g., "Are you ready to move forward?" or "Schedule a call to get started."',
  });

  // Check 4: No new complexity (avoid jargon)
  const jargonWords = ['ecosystem', 'synergy', 'leverage', 'paradigm', 'scalable', 'blockchain', 'next-generation', 'disruptive', 'revolutionary', 'cutting-edge'];
  const titleLower = input.title.toLowerCase();
  const noJargon = !jargonWords.some(w => titleLower.includes(w) || outcomeLower.includes(w));
  checks.push({
    label: 'No new complexity',
    passed: noJargon,
    feedback: noJargon
      ? 'Language is clear and jargon-free.'
      : 'Avoid technical jargon. Use plain language your prospect already uses.',
  });

  return {
    checks,
    overall_passed: checks.every(c => c.passed),
  };
}
