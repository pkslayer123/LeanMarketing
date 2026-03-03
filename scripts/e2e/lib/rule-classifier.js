/**
 * Expanded Rule-Based Classifier
 *
 * Deterministic pattern matching for findings, errors, and MOC classification
 * that doesn't need LLM. Replaces LLM calls for obvious, well-known patterns.
 *
 * Categories:
 * - Finding severity classification
 * - Finding-to-theme mapping (extends consolidate-themes.js 15 patterns)
 * - MOC tier classification (auto_fix / auto_approve / needs_approval)
 * - Error noise vs real-bug classification
 * - Permission error categorization
 *
 * Usage:
 *   const { classifyFinding, classifyError, classifyMocTier, matchTheme } = require("./lib/rule-classifier");
 *   const result = classifyFinding(finding);
 *   if (result.confident) { /* skip LLM * / }
 */

// ---------------------------------------------------------------------------
// Finding Severity Rules
// ---------------------------------------------------------------------------

const SEVERITY_RULES = [
  // Security — always critical
  { pattern: /BOLA|cross[_-]?org|data[_-]?isolation|data[_-]?leak/i, severity: "security", confidence: 0.95 },
  { pattern: /SQL[_-]?injection|XSS|CSRF|injection/i, severity: "security", confidence: 0.95 },
  { pattern: /PII[_-]?exposure|credential|sensitive[_-]?data/i, severity: "security", confidence: 0.9 },
  { pattern: /RLS[_-]?bypass|permission[_-]?leak|unauthorized[_-]?access/i, severity: "security", confidence: 0.9 },
  { pattern: /privilege[_-]?escalation|role[_-]?bypass/i, severity: "security", confidence: 0.9 },

  // Bugs — clear code errors
  { pattern: /500|internal[_-]?server[_-]?error/i, severity: "bug", confidence: 0.85 },
  { pattern: /cannot read prop|TypeError|undefined is not/i, severity: "bug", confidence: 0.85 },
  { pattern: /null[_-]?pointer|null[_-]?reference|\.single\(\)/i, severity: "bug", confidence: 0.8 },
  { pattern: /crash|fatal|unhandled[_-]?exception/i, severity: "bug", confidence: 0.85 },
  { pattern: /broken[_-]?link|404[_-]?not[_-]?found/i, severity: "bug", confidence: 0.7 },
  { pattern: /infinite[_-]?loop|memory[_-]?leak|stack[_-]?overflow/i, severity: "bug", confidence: 0.9 },

  // UX — user experience issues
  { pattern: /dark[_-]?mode|contrast|theme[_-]?missing/i, severity: "ux", confidence: 0.8 },
  { pattern: /loading[_-]?state|skeleton|spinner[_-]?missing/i, severity: "ux", confidence: 0.75 },
  { pattern: /accessibility|aria|wcag|screen[_-]?reader/i, severity: "ux", confidence: 0.8 },
  { pattern: /responsive|overflow|mobile[_-]?layout/i, severity: "ux", confidence: 0.7 },
  { pattern: /empty[_-]?state|no[_-]?data[_-]?message/i, severity: "ux", confidence: 0.7 },

  // Suggestions — nice-to-have improvements
  { pattern: /could[_-]?improve|might[_-]?consider|suggestion/i, severity: "suggestion", confidence: 0.7 },
  { pattern: /best[_-]?practice|optimization|performance[_-]?hint/i, severity: "suggestion", confidence: 0.65 },
];

// ---------------------------------------------------------------------------
// Error Noise Rules (deterministic noise vs real)
// ---------------------------------------------------------------------------

const NOISE_RULES = [
  { pattern: /failed to fetch$/i, classification: "noise", reason: "transient network drop" },
  { pattern: /network\s*error/i, classification: "noise", reason: "transient network" },
  { pattern: /abort(ed)?.*signal/i, classification: "noise", reason: "request aborted" },
  { pattern: /hydration.*mismatch|react.*#419/i, classification: "noise", reason: "React hydration" },
  { pattern: /ResizeObserver loop/i, classification: "noise", reason: "browser ResizeObserver" },
  { pattern: /long\s*task/i, classification: "noise", reason: "performance observer" },
  { pattern: /RefreshTokenNotFound|refresh_token_not_found/i, classification: "noise", reason: "expired session" },
  { pattern: /bad_jwt|invalid.*jwt/i, classification: "noise", reason: "expired JWT" },
  { pattern: /chunk.*load|loading.*chunk/i, classification: "noise", reason: "chunk load failure" },
  { pattern: /NEXT_REDIRECT/i, classification: "noise", reason: "Next.js redirect" },
  { pattern: /cancelled|AbortError/i, classification: "noise", reason: "request cancelled" },
  { pattern: /ERR_CONNECTION_REFUSED.*localhost/i, classification: "noise", reason: "local server down" },
];

const CRITICAL_ERROR_RULES = [
  { pattern: /BOLA|cross[_-]?org|data[_-]?leak/i, classification: "critical", reason: "data isolation violation" },
  { pattern: /permission[_-]?leak|unauthorized.*admin/i, classification: "critical", reason: "permission escalation" },
  { pattern: /SQL.*injection|XSS.*stored/i, classification: "critical", reason: "injection vulnerability" },
  { pattern: /PII.*exposed|credential.*leak/i, classification: "critical", reason: "data exposure" },
  { pattern: /RLS.*bypass/i, classification: "critical", reason: "RLS bypass" },
];

// ---------------------------------------------------------------------------
// MOC Tier Classification (extends auto-triage tier logic)
// ---------------------------------------------------------------------------

const MOC_TIER_RULES = [
  // needs_approval — human required
  { pattern: /BOLA|injection|PII|cross[_-]?org/i, tier: "needs_approval", confidence: 0.95 },
  { pattern: /spec.*conflict|protected.*section/i, tier: "needs_approval", confidence: 0.85 },
  { pattern: /new.*feature|architecture.*change/i, tier: "needs_approval", confidence: 0.8 },
  { pattern: /migration.*destructive|drop.*table|column.*rename/i, tier: "needs_approval", confidence: 0.9 },
  { pattern: /security.*critical|privilege.*escalation/i, tier: "needs_approval", confidence: 0.9 },

  // auto_fix — cosmetic, low-risk
  { pattern: /dark[_-]?mode.*missing|missing.*dark:/i, tier: "auto_fix", confidence: 0.85 },
  { pattern: /typo|spelling|whitespace/i, tier: "auto_fix", confidence: 0.8 },
  { pattern: /lint.*error|eslint|unused.*import/i, tier: "auto_fix", confidence: 0.85 },
  { pattern: /missing.*null.*check|\.single\(\).*maybeSingle/i, tier: "auto_fix", confidence: 0.8 },
  { pattern: /loading.*state|skeleton.*missing/i, tier: "auto_fix", confidence: 0.75 },

  // auto_approve — everything else that's clearly a bug but not security
  { pattern: /500.*error|server.*error/i, tier: "auto_approve", confidence: 0.8 },
  { pattern: /broken.*link|404.*page/i, tier: "auto_approve", confidence: 0.75 },
  { pattern: /empty.*state|missing.*fallback/i, tier: "auto_approve", confidence: 0.7 },
  { pattern: /permission.*denied.*should.*allow/i, tier: "auto_approve", confidence: 0.75 },
];

// ---------------------------------------------------------------------------
// Theme Matching (extends consolidate-themes.js 15 keyword patterns)
// ---------------------------------------------------------------------------

const THEME_RULES = [
  { id: "dark-mode", keywords: ["dark", "contrast", "bg-gray", "theme", "dark:"], minKeywords: 2 },
  { id: "loading-states", keywords: ["loading", "skeleton", "spinner", "shimmer", "flicker"], minKeywords: 2 },
  { id: "null-safety", keywords: ["null", "undefined", "missing", "empty state", "cannot read"], minKeywords: 2 },
  { id: "permission-access", keywords: ["permission", "unauthorized", "403", "forbidden", "role"], minKeywords: 2 },
  { id: "error-handling", keywords: ["error", "catch", "500", "failed", "crash"], minKeywords: 2 },
  { id: "form-validation", keywords: ["validation", "required", "invalid", "form", "field"], minKeywords: 2 },
  { id: "accessibility", keywords: ["aria", "screen reader", "focus", "wcag", "a11y"], minKeywords: 2 },
  { id: "spec-completeness", keywords: ["grade", "spec", "not implemented", "incomplete"], minKeywords: 2 },
  { id: "layout-responsive", keywords: ["layout", "overflow", "responsive", "mobile", "breakpoint"], minKeywords: 2 },
  { id: "navigation-routing", keywords: ["navigation", "route", "redirect", "404", "breadcrumb"], minKeywords: 2 },
  { id: "data-display", keywords: ["display", "format", "date", "currency", "stale"], minKeywords: 2 },
  { id: "api-integration", keywords: ["api", "fetch", "endpoint", "timeout", "cors"], minKeywords: 2 },
  { id: "notification-feedback", keywords: ["notification", "toast", "success", "message", "status"], minKeywords: 2 },
  { id: "workflow-stages", keywords: ["stage", "workflow", "approve", "decision", "closeout"], minKeywords: 2 },
  { id: "search-filter", keywords: ["search", "filter", "sort", "pagination"], minKeywords: 2 },
  // Extended patterns
  { id: "session-auth", keywords: ["session", "login", "auth", "cookie", "refresh token"], minKeywords: 2 },
  { id: "rate-limiting", keywords: ["rate limit", "429", "throttle", "too many"], minKeywords: 2 },
  { id: "data-integrity", keywords: ["duplicate", "orphan", "constraint", "foreign key"], minKeywords: 2 },
];

// ---------------------------------------------------------------------------
// Learned Dynamic Rules (auto-promoted from triage patterns)
// ---------------------------------------------------------------------------

const LEARNED_RULES_PATH = require("path").join(__dirname, "..", "..", "..", "e2e", "state", "learned-rules.json");

let _learnedRulesCache = null;
let _learnedRulesCacheTime = 0;

function loadLearnedRules() {
  const now = Date.now();
  if (_learnedRulesCache && now - _learnedRulesCacheTime < 300000) { return _learnedRulesCache; }
  try {
    const fs = require("fs");
    if (fs.existsSync(LEARNED_RULES_PATH)) {
      _learnedRulesCache = JSON.parse(fs.readFileSync(LEARNED_RULES_PATH, "utf-8"));
      _learnedRulesCacheTime = now;
      return _learnedRulesCache;
    }
  } catch { /* non-fatal */ }
  _learnedRulesCache = { noiseRules: [], severityRules: [] };
  _learnedRulesCacheTime = now;
  return _learnedRulesCache;
}

/**
 * Promote a triage pattern to a learned rule.
 * Called when auto-triage resolves 50+ findings matching the same pattern.
 * @param {string} patternText — Regex string to match
 * @param {"noise"|"severity"} ruleType — What kind of rule
 * @param {object} meta — { classification, reason, severity, confidence, seenCount }
 */
function promoteRule(patternText, ruleType, meta) {
  const fs = require("fs");
  const learned = loadLearnedRules();

  const target = ruleType === "noise" ? learned.noiseRules : learned.severityRules;
  // Dedup by pattern text
  if (target.some((r) => r.pattern === patternText)) { return; }

  target.push({
    pattern: patternText,
    ...meta,
    promotedAt: new Date().toISOString(),
    misclassifications: 0,
    active: true,
  });

  try {
    learned.updatedAt = new Date().toISOString();
    fs.writeFileSync(LEARNED_RULES_PATH, JSON.stringify(learned, null, 2) + "\n");
    _learnedRulesCache = learned;
    _learnedRulesCacheTime = Date.now();
  } catch { /* non-fatal */ }
}

/**
 * Record a misclassification for a learned rule. Auto-demotes after 3 misclassifications.
 * @param {string} patternText
 */
function recordMisclassification(patternText) {
  const fs = require("fs");
  const learned = loadLearnedRules();

  for (const list of [learned.noiseRules, learned.severityRules]) {
    const rule = list.find((r) => r.pattern === patternText);
    if (rule) {
      rule.misclassifications = (rule.misclassifications ?? 0) + 1;
      if (rule.misclassifications >= 3) {
        rule.active = false;
        rule.demotedAt = new Date().toISOString();
        rule.demotedReason = `${rule.misclassifications} misclassifications`;
      }
      break;
    }
  }

  try {
    learned.updatedAt = new Date().toISOString();
    fs.writeFileSync(LEARNED_RULES_PATH, JSON.stringify(learned, null, 2) + "\n");
    _learnedRulesCache = learned;
    _learnedRulesCacheTime = Date.now();
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a finding's severity using deterministic rules.
 * @param {{ description: string, evidence?: string }} finding
 * @returns {{ severity?: string, confidence: number, confident: boolean, rule?: string }}
 */
function classifyFinding(finding) {
  const text = `${finding.description ?? ""} ${finding.evidence ?? ""}`;
  for (const rule of SEVERITY_RULES) {
    if (rule.pattern.test(text)) {
      return { severity: rule.severity, confidence: rule.confidence, confident: rule.confidence >= 0.7, rule: rule.pattern.source };
    }
  }
  return { confidence: 0, confident: false };
}

/**
 * Classify an error as noise, critical, or unknown.
 * @param {{ message: string, endpoint?: string }} error
 * @returns {{ classification: "noise"|"critical"|"unknown", reason: string, confident: boolean }}
 */
function classifyError(error) {
  const text = `${error.message ?? ""} ${error.endpoint ?? ""}`;

  // Critical errors always take priority
  for (const rule of CRITICAL_ERROR_RULES) {
    if (rule.pattern.test(text)) {
      return { classification: rule.classification, reason: rule.reason, confident: true };
    }
  }

  // Noise patterns
  for (const rule of NOISE_RULES) {
    if (rule.pattern.test(text)) {
      return { classification: rule.classification, reason: rule.reason, confident: true };
    }
  }

  // Learned dynamic noise rules (auto-promoted from triage)
  const learned = loadLearnedRules();
  for (const rule of (learned.noiseRules ?? [])) {
    if (!rule.active) { continue; }
    try {
      if (new RegExp(rule.pattern, "i").test(text)) {
        return { classification: rule.classification ?? "noise", reason: rule.reason ?? "learned rule", confident: true, learned: true };
      }
    } catch { /* invalid regex */ }
  }

  return { classification: "unknown", reason: "no matching rule", confident: false };
}

/**
 * Classify a MOC's approval tier.
 * @param {{ title: string, description: string, severity?: string }} moc
 * @returns {{ tier?: string, confidence: number, confident: boolean }}
 */
function classifyMocTier(moc) {
  const text = `${moc.title ?? ""} ${moc.description ?? ""} ${moc.severity ?? ""}`;
  for (const rule of MOC_TIER_RULES) {
    if (rule.pattern.test(text)) {
      return { tier: rule.tier, confidence: rule.confidence, confident: rule.confidence >= 0.7 };
    }
  }
  return { confidence: 0, confident: false };
}

/**
 * Match a finding to a theme without LLM.
 * @param {{ description: string, title?: string }} finding
 * @returns {{ themeId?: string, confident: boolean }}
 */
function matchTheme(finding) {
  const text = `${finding.title ?? ""} ${finding.description ?? ""}`.toLowerCase();
  for (const theme of THEME_RULES) {
    const matches = theme.keywords.filter((kw) => text.includes(kw.toLowerCase()));
    if (matches.length >= theme.minKeywords) {
      return { themeId: theme.id, confident: true, matchedKeywords: matches };
    }
  }
  return { confident: false };
}

/**
 * Batch-classify multiple findings. Returns which ones were confidently classified
 * (can skip LLM) and which need LLM.
 */
function batchClassify(findings) {
  const classified = [];
  const needsLlm = [];

  for (const finding of findings) {
    const severity = classifyFinding(finding);
    const theme = matchTheme(finding);
    if (severity.confident || theme.confident) {
      classified.push({
        ...finding,
        _ruleSeverity: severity.severity,
        _ruleTheme: theme.themeId,
        _ruleConfidence: Math.max(severity.confidence, theme.confident ? 0.75 : 0),
      });
    } else {
      needsLlm.push(finding);
    }
  }

  return { classified, needsLlm };
}

module.exports = {
  classifyFinding,
  classifyError,
  classifyMocTier,
  matchTheme,
  batchClassify,
  promoteRule,
  recordMisclassification,
  loadLearnedRules,
  SEVERITY_RULES,
  NOISE_RULES,
  THEME_RULES,
  MOC_TIER_RULES,
};
