export type OfferTemplate = "trial" | "early_access" | "pilot";
export type OfferStatus = "draft" | "sent" | "accepted" | "declined" | "expired";

export interface Offer {
  id: string;
  project_id: string;
  user_id: string;
  template: OfferTemplate;
  scope: string;
  duration_days: number;
  price_cents: number;
  success_definition: string;
  status: OfferStatus;
  sent_to: string | null;
  quality_gate_passed: boolean | null;
  quality_gate_feedback: QualityGateFeedback | null;
  created_at: string;
  updated_at: string;
}

export interface OfferInput {
  project_id: string;
  template: OfferTemplate;
  scope: string;
  duration_days: number;
  price_cents: number;
  success_definition: string;
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

export const TEMPLATE_LABELS: Record<OfferTemplate, string> = {
  trial: "Trial",
  early_access: "Early Access",
  pilot: "Pilot Agreement",
};

export const TEMPLATE_DEFAULTS: Record<
  OfferTemplate,
  { duration_days: number; price_cents: number; scope: string }
> = {
  trial: {
    duration_days: 14,
    price_cents: 0,
    scope:
      "Full access to core features with onboarding support included. No credit card required to start.",
  },
  early_access: {
    duration_days: 90,
    price_cents: 9900,
    scope:
      "Early access to the product at a discounted rate. Includes priority support and direct feedback sessions with the team.",
  },
  pilot: {
    duration_days: 30,
    price_cents: 50000,
    scope:
      "Custom pilot engagement with defined deliverables, dedicated support, and a joint success review at the end.",
  },
};

export function formatPrice(cents: number): string {
  if (cents === 0) return "Free";
  return `$${(cents / 100).toFixed(2)}`;
}

export function runQualityGate(
  input: Omit<OfferInput, "project_id">
): QualityGateFeedback {
  const checks: QualityGateCheck[] = [];

  // Scope: at least 10 words
  const scopeWords = input.scope.trim().split(/\s+/).filter(Boolean).length;
  const scopePassed = scopeWords >= 10;
  checks.push({
    label: "Scope defined",
    passed: scopePassed,
    feedback: scopePassed
      ? "Scope is clearly described."
      : "Describe the scope in at least 10 words so the prospect knows what's included.",
  });

  // Duration: 1–365 days
  const durationPassed = input.duration_days >= 1 && input.duration_days <= 365;
  checks.push({
    label: "Duration set",
    passed: durationPassed,
    feedback: durationPassed
      ? `Duration is ${input.duration_days} day${input.duration_days !== 1 ? "s" : ""}.`
      : "Set a duration between 1 and 365 days.",
  });

  // Price: non-negative (0 is allowed for trials)
  const pricePassed = input.price_cents >= 0;
  checks.push({
    label: "Price set",
    passed: pricePassed,
    feedback: pricePassed
      ? `Price is ${formatPrice(input.price_cents)}.`
      : "Enter a valid price (0 or more).",
  });

  // Success definition: at least 10 words and contains a measurable indicator
  const successWords = input.success_definition
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const hasMeasurable = /\d+|%|revenue|conversion|signups?|customers?|mrr|arr|churn|retention|nps|csat/i.test(
    input.success_definition
  );
  const successPassed = successWords >= 10 && hasMeasurable;
  checks.push({
    label: "Measurable success definition",
    passed: successPassed,
    feedback: successPassed
      ? "Success is defined with a measurable outcome."
      : "Describe success in at least 10 words with a specific metric (e.g., a number, %, or named KPI).",
  });

  return {
    checks,
    overall_passed: checks.every((c) => c.passed),
  };
}
