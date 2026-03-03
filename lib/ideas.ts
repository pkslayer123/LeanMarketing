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
  overall_passed: boolean;
  checks: QualityGateCheck[];
}

export interface Idea {
  id: string;
  project_id: string;
  user_id: string;
  description: string;
  audience: string;
  problem: string;
  payment_assumption: string;
  next_step: string;
  quality_gate_passed: boolean;
  quality_gate_feedback: QualityGateFeedback;
  created_at: string;
  updated_at: string;
}

type QualityGateInput = Omit<IdeaInput, "project_id">;

export function runQualityGate(input: QualityGateInput): QualityGateFeedback {
  const checks: QualityGateCheck[] = [
    {
      label: "Description",
      passed: input.description.trim().length >= 20,
      feedback:
        input.description.trim().length >= 20
          ? "Clear and descriptive."
          : "Must be at least 20 characters.",
    },
    {
      label: "Audience",
      passed: input.audience.trim().length >= 10,
      feedback:
        input.audience.trim().length >= 10
          ? "Audience is defined."
          : "Must be at least 10 characters.",
    },
    {
      label: "Problem",
      passed: input.problem.trim().length >= 10,
      feedback:
        input.problem.trim().length >= 10
          ? "Problem is articulated."
          : "Must be at least 10 characters.",
    },
    {
      label: "Payment assumption",
      passed: input.payment_assumption.trim().length >= 5,
      feedback:
        input.payment_assumption.trim().length >= 5
          ? "Payment assumption provided."
          : "Must be at least 5 characters.",
    },
    {
      label: "Next step",
      passed: input.next_step.trim().length >= 5,
      feedback:
        input.next_step.trim().length >= 5
          ? "Next step is defined."
          : "Must be at least 5 characters.",
    },
  ];

  return {
    overall_passed: checks.every((c) => c.passed),
    checks,
  };
}
