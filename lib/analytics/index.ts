// Types and logic for Layer 6 — Review and Adjustment

export interface FunnelStage {
  label: string;
  count: number;
}

export interface AnalyticsReport {
  project_id: string;
  messages_sent: number;
  replies: number;
  stage_advances: number;
  converted: number;
  funnel: FunnelStage[];
  bottleneck: string;
  bottleneck_drop_count: number;
  bottleneck_drop_pct: number;
}

export interface ReviewCycle {
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
  quality_gate_feedback: QualityGate6Feedback | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewCycleInput {
  project_id: string;
  variable_changed: string;
  hypothesis: string;
}

export interface QualityGate6Check {
  label: string;
  passed: boolean;
  feedback: string;
}

export interface QualityGate6Feedback {
  checks: QualityGate6Check[];
  overall_passed: boolean;
}

export function identifyBottleneck(funnel: FunnelStage[]): {
  label: string;
  drop_count: number;
  drop_pct: number;
} {
  if (funnel.length < 2) {
    return { label: 'Not enough data', drop_count: 0, drop_pct: 0 };
  }

  let maxDropCount = 0;
  let maxDropPct = 0;
  let bottleneckLabel = '';

  for (let i = 1; i < funnel.length; i++) {
    const prev = funnel[i - 1];
    const curr = funnel[i];
    if (prev.count === 0) continue;
    const drop = prev.count - curr.count;
    const pct = Math.round((drop / prev.count) * 100);
    if (drop > maxDropCount || (drop === maxDropCount && pct > maxDropPct)) {
      maxDropCount = drop;
      maxDropPct = pct;
      bottleneckLabel = `${prev.label} → ${curr.label}`;
    }
  }

  return {
    label: bottleneckLabel || 'No bottleneck identified',
    drop_count: maxDropCount,
    drop_pct: maxDropPct,
  };
}

export function runQualityGate6(params: {
  messages_sent: number;
  bottleneck: string;
  variable_changed: string;
  hypothesis: string;
}): QualityGate6Feedback {
  const { messages_sent, bottleneck, variable_changed, hypothesis } = params;
  const checks: QualityGate6Check[] = [];

  // 1. At least 30 outreach attempts
  const attemptsPassed = messages_sent >= 30;
  checks.push({
    label: '30+ outreach attempts',
    passed: attemptsPassed,
    feedback: attemptsPassed
      ? `${messages_sent} messages sent this cycle.`
      : `Only ${messages_sent} messages sent. Reach at least 30, or document why volume is lower.`,
  });

  // 2. Bottleneck identified using actual stage counts
  const bottleneckPassed =
    !!bottleneck &&
    bottleneck.trim().length > 0 &&
    bottleneck !== 'No bottleneck identified' &&
    bottleneck !== 'Not enough data';
  checks.push({
    label: 'Bottleneck identified',
    passed: bottleneckPassed,
    feedback: bottleneckPassed
      ? `Bottleneck: ${bottleneck}`
      : 'Send enough messages to identify where the biggest drop-off occurs.',
  });

  // 3. Only one variable selected for change
  const variableWords = variable_changed.trim().split(/\s+/).filter(Boolean).length;
  const variablePassed = variableWords >= 3 && variableWords <= 20;
  checks.push({
    label: 'One variable selected',
    passed: variablePassed,
    feedback: variablePassed
      ? `Testing: ${variable_changed}`
      : 'Describe the single variable you are changing in 3–20 words.',
  });

  // 4. Hypothesis written in one sentence
  const hypothesisWords = hypothesis.trim().split(/\s+/).filter(Boolean).length;
  const hasPeriodOrEnd = /[.!?]$/.test(hypothesis.trim());
  const hypothesisPassed = hypothesisWords >= 8 && hypothesisWords <= 60 && hasPeriodOrEnd;
  checks.push({
    label: 'Hypothesis written',
    passed: hypothesisPassed,
    feedback: hypothesisPassed
      ? `Hypothesis: "${hypothesis}"`
      : 'Write a one-sentence hypothesis (8–60 words, ending with punctuation). Example: "Changing the subject line to a question will increase reply rate by 10%."',
  });

  return {
    checks,
    overall_passed: checks.every((c) => c.passed),
  };
}
