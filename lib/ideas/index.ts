export interface Idea {
  id: string;
  project_id: string;
  user_id: string;
  description: string;
  audience: string;
  problem: string;
  payment_assumption: string;
  next_step: string;
  quality_gate_passed: boolean | null;
  quality_gate_feedback: QualityGateFeedback | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaInput {
  project_id: string;
  description: string;
  audience: string;
  problem: string;
  payment_assumption: string;
  next_step: string;
}

export interface QualityGateCheck {
  label: string;
  passed: boolean;
  feedback: string;
}

export interface QualityGateFeedback {
  checks: QualityGateCheck[];
  overall_passed: boolean;
}

export function runQualityGate(
  input: Omit<IdeaInput, "project_id">
): QualityGateFeedback {
  const checks: QualityGateCheck[] = [];

  // Clarity: description should be a single sentence, 5–30 words
  const descWords = input.description.trim().split(/\s+/).length;
  const clarityPassed =
    descWords >= 5 && descWords <= 30 && !input.description.includes("\n");
  checks.push({
    label: "Clarity",
    passed: clarityPassed,
    feedback: clarityPassed
      ? "Description is clear and concise."
      : "Keep the description to a single sentence (5–30 words).",
  });

  // Specificity: problem should be at least 8 words
  const problemWords = input.problem.trim().split(/\s+/).length;
  const specificityPassed = problemWords >= 8;
  checks.push({
    label: "Specificity",
    passed: specificityPassed,
    feedback: specificityPassed
      ? "Problem is specific enough."
      : "Describe the problem in more detail (at least 8 words).",
  });

  // Audience: should name who specifically, at least 3 words
  const audienceWords = input.audience.trim().split(/\s+/).length;
  const audiencePassed = audienceWords >= 3;
  checks.push({
    label: "Audience",
    passed: audiencePassed,
    feedback: audiencePassed
      ? "Audience is well-defined."
      : "Be more specific about your target audience (at least 3 words).",
  });

  // Next Step: should be actionable, at least 5 words
  const nextStepWords = input.next_step.trim().split(/\s+/).length;
  const nextStepPassed = nextStepWords >= 5;
  checks.push({
    label: "Next Step",
    passed: nextStepPassed,
    feedback: nextStepPassed
      ? "Next step is actionable."
      : "Describe a concrete next step (at least 5 words).",
  });

  return {
    checks,
    overall_passed: checks.every((c) => c.passed),
  };
}
