export type ApprovalMode = "strict" | "relaxed";

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

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  strict: "All classifications and next actions require approval",
  relaxed: "Low-risk actions auto-advance; high-risk actions require approval",
};

export function requiresApproval(mode: ApprovalMode, action: string): boolean {
  if (mode === "strict") return true;
  const HIGH_RISK_KEYWORDS = ["delete", "remove", "cancel", "publish", "send", "charge", "deploy"];
  return HIGH_RISK_KEYWORDS.some((kw) => action.toLowerCase().includes(kw));
}
