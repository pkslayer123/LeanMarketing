export type ApprovalMode = "strict" | "relaxed";

export type RiskLevel = "low" | "medium" | "high";

export interface ProjectSettings {
  id: string;
  project_id: string;
  user_id: string;
  approval_mode: ApprovalMode;
  created_at: string;
  updated_at: string;
}

export interface ProjectSettingsInput {
  project_id: string;
  approval_mode: ApprovalMode;
}

// Human-readable labels shown in the UI
export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  strict: "All classifications and next actions require approval",
  relaxed: "Low-risk actions auto-advance; high-risk actions require approval",
};

export const APPROVAL_MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  strict:
    "Every AI classification, funnel advancement, and action will pause and wait for your manual review before proceeding. Best for high-stakes campaigns or new users.",
  relaxed:
    "Routine, low-risk actions (tagging, scoring, moving leads forward) happen automatically. High-risk actions like publishing, sending, or deleting always require your approval.",
};

// Keywords that elevate an action to HIGH risk regardless of mode
const HIGH_RISK_KEYWORDS = [
  "delete",
  "remove",
  "cancel",
  "publish",
  "send",
  "charge",
  "deploy",
  "reset",
  "archive",
  "terminate",
  "refund",
  "export",
  "disable",
];

// Keywords that are MEDIUM risk in relaxed mode
const MEDIUM_RISK_KEYWORDS = [
  "update",
  "edit",
  "modify",
  "change",
  "move",
  "transfer",
  "assign",
  "promote",
];

/**
 * Classify the risk level of an action string.
 * Used to decide whether to surface an approval gate.
 */
export function classifyRisk(action: string): RiskLevel {
  const lower = action.toLowerCase();
  if (HIGH_RISK_KEYWORDS.some((kw) => lower.includes(kw))) return "high";
  if (MEDIUM_RISK_KEYWORDS.some((kw) => lower.includes(kw))) return "medium";
  return "low";
}

/**
 * Given the current approval mode and a proposed action string,
 * returns true if the action must wait for explicit user approval.
 *
 * Strict mode: always requires approval.
 * Relaxed mode: only high-risk actions require approval.
 */
export function requiresApproval(mode: ApprovalMode, action: string): boolean {
  if (mode === "strict") return true;
  const risk = classifyRisk(action);
  return risk === "high";
}

/**
 * Same as requiresApproval but accepts a pre-classified RiskLevel.
 * Useful when the caller has already computed risk.
 */
export function requiresApprovalForRisk(
  mode: ApprovalMode,
  risk: RiskLevel
): boolean {
  if (mode === "strict") return true;
  return risk === "high";
}

/**
 * Returns the default ProjectSettings for a given project/user pair
 * before any explicit setting has been stored.
 */
export function defaultSettings(
  projectId: string,
  userId: string
): Omit<ProjectSettings, "id" | "created_at" | "updated_at"> {
  return {
    project_id: projectId,
    user_id: userId,
    approval_mode: "strict",
  };
}

/**
 * Validates a ProjectSettingsInput object.
 * Returns an error string, or null if valid.
 */
export function validateSettingsInput(
  input: unknown
): string | null {
  if (typeof input !== "object" || input === null) {
    return "Request body must be a JSON object.";
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.project_id !== "string" || !obj.project_id.trim()) {
    return "project_id is required and must be a non-empty string.";
  }
  if (!["strict", "relaxed"].includes(obj.approval_mode as string)) {
    return "approval_mode must be 'strict' or 'relaxed'.";
  }
  return null;
}
