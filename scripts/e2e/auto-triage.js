#!/usr/bin/env node

/**
 * auto-triage.js -- Autonomous finding + error triage
 *
 * Replaces the old generate-persona-questions.js flow with autonomous triage:
 * - Auto-resolves known noise patterns (network errors, hydration, transient)
 * - Auto-classifies findings by severity/confidence
 * - Only surfaces HIGH CRITICALITY items for human decision (security, data isolation, permission leaks)
 * - Everything else is auto-resolved with notes
 *
 * Design principle: Nothing blocks automated changes unless an analyst identifies
 * low confidence in an acceptable change. Only high-criticality items accumulate
 * for human decision.
 *
 * Usage:
 *   node scripts/e2e/auto-triage.js                  # Full auto-triage
 *   node scripts/e2e/auto-triage.js --dry-run        # Preview only
 *   node scripts/e2e/auto-triage.js --include-errors  # Also triage error_logs
 *
 * @see scripts/e2e/guardrails.js (question store)
 * @see scripts/e2e/apply-answer-to-errors.js (error resolution)
 */

try {
  require("dotenv").config({ path: ".env.local", quiet: true });
} catch {
  // dotenv not installed
}

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
let supabaseRetry;
try {
  supabaseRetry = require("./lib/supabase-retry");
} catch {
  // supabase-retry not available — use direct calls
}

const ROOT = path.resolve(__dirname, "..", "..");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const GUARDRAILS_FILE = path.join(ROOT, "e2e", "state", "guardrails.json");
const FALSE_POSITIVES_FILE = path.join(ROOT, "e2e", "oracle", "false-positives.json");
const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const ORACLE_FEEDBACK_PATH = path.join(ROOT, "e2e", "state", "oracle-feedback.jsonl");

// Pipeline accuracy tracking
let pipelineMetrics;
try {
  pipelineMetrics = require("./lib/pipeline-metrics");
} catch { /* pipeline-metrics not available */ }

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const includeErrors = args.includes("--include-errors");
const errorsOnly = args.includes("--errors-only");

// ---------------------------------------------------------------------------
// Failure classification — categorize WHY a test failed
// ---------------------------------------------------------------------------
const FAILURE_TYPES = {
  STALE_SELECTOR: "stale_selector",       // UI element moved/renamed
  PERMISSION_CHANGED: "permission_changed", // Permission grant/deny flipped
  API_ROUTE_MOVED: "api_route_moved",      // API endpoint 404
  REAL_BUG: "real_bug",                    // Actual app regression (500, crash, data)
  TRANSIENT: "transient",                  // Network drop, timeout, hydration
  UI_REFACTOR: "ui_refactor",             // Page structure changed (text, heading, layout)
  TEST_EXPECTATION: "test_expectation",   // Test assertion wrong (not app bug)
  VISION_DEFECT: "vision_defect",         // Visual QA issue found by screenshot oracle
};

function classifyFailureType(finding) {
  const desc = (finding.description ?? finding.summary ?? "").toLowerCase();
  const page = (finding.page ?? "").toLowerCase();

  // Transient (network, timeout, hydration)
  if (/network\s*(error|offline|failed\s*to\s*fetch)/i.test(desc)) return FAILURE_TYPES.TRANSIENT;
  if (/abort(ed)?.*signal|timed?\s*out|timeout/i.test(desc)) return FAILURE_TYPES.TRANSIENT;
  if (/hydration.*mismatch|NEXT_REDIRECT/i.test(desc)) return FAILURE_TYPES.TRANSIENT;
  if (/long\s*task/i.test(desc)) return FAILURE_TYPES.TRANSIENT;

  // Stale selector (element not found, locator failed)
  if (/locator\.(click|fill|check|press|type|select)/i.test(desc) && /timeout|not found|no element/i.test(desc)) return FAILURE_TYPES.STALE_SELECTOR;
  if (/waiting for (locator|selector)/i.test(desc) && /timeout/i.test(desc)) return FAILURE_TYPES.STALE_SELECTOR;
  if (/expect\(locator\).*to(Be|Have)/i.test(desc) && /timeout/i.test(desc)) return FAILURE_TYPES.STALE_SELECTOR;
  if (/element.*not.*found|no.*element.*matching/i.test(desc)) return FAILURE_TYPES.STALE_SELECTOR;

  // Permission changed
  if (/permission.*should\s*be\s*(granted|denied)\s*but\s*was/i.test(desc)) return FAILURE_TYPES.PERMISSION_CHANGED;
  if (/expected\s*403.*got\s*200|expected\s*200.*got\s*403/i.test(desc)) return FAILURE_TYPES.PERMISSION_CHANGED;
  if (/\[OrgPerms\]|\[Oracle\/Permissions\]/i.test(desc)) return FAILURE_TYPES.PERMISSION_CHANGED;

  // API route moved (404 on API endpoints)
  if (page.startsWith("/api/") && /404|not\s*found/i.test(desc)) return FAILURE_TYPES.API_ROUTE_MOVED;
  if (/\/api\/.*404/i.test(desc)) return FAILURE_TYPES.API_ROUTE_MOVED;
  if (page.startsWith("/api/") && /405/i.test(desc)) return FAILURE_TYPES.API_ROUTE_MOVED;

  // Real bug (500 errors, crashes, data issues)
  if (/500|internal\s*server\s*error/i.test(desc)) return FAILURE_TYPES.REAL_BUG;
  if (/crash|fatal|unhandled|exception/i.test(desc)) return FAILURE_TYPES.REAL_BUG;
  if (/data\s*(leak|isolation|exposure)|BOLA|cross.org/i.test(desc)) return FAILURE_TYPES.REAL_BUG;
  if (/RLS.*bypass|SQL.*injection|XSS|CSRF/i.test(desc)) return FAILURE_TYPES.REAL_BUG;
  if (/sensitive\s*data|PII|credential/i.test(desc)) return FAILURE_TYPES.REAL_BUG;

  // UI refactor (text changed, heading missing, layout shift)
  if (/text.*content.*changed|heading.*missing|layout.*shift/i.test(desc)) return FAILURE_TYPES.UI_REFACTOR;
  if (/expected.*text|toContainText|toHaveText/i.test(desc) && /received/i.test(desc)) return FAILURE_TYPES.UI_REFACTOR;

  // Test expectation (super_admin/developer access patterns)
  if (/super_admin.*admin.*page|developer.*admin/i.test(desc)) return FAILURE_TYPES.TEST_EXPECTATION;
  if (/empty\s*state.*no\s*(mocs?|reviews?)/i.test(desc)) return FAILURE_TYPES.TEST_EXPECTATION;
  if (/got\s*405\s*instead\s*of\s*403/i.test(desc)) return FAILURE_TYPES.TEST_EXPECTATION;

  // Vision defect (screenshot oracle findings)
  if (/\[Vision\]/i.test(desc)) return FAILURE_TYPES.VISION_DEFECT;
  if (finding.failureType === "vision_defect") return FAILURE_TYPES.VISION_DEFECT;

  // Default: classify by severity
  const severity = (finding.severity ?? "").toLowerCase();
  if (severity === "security") return FAILURE_TYPES.REAL_BUG;
  if (severity === "bug") return FAILURE_TYPES.REAL_BUG;
  if (severity === "product") return FAILURE_TYPES.REAL_BUG;
  if (severity === "ux" || severity === "inconsistency") return FAILURE_TYPES.UI_REFACTOR;
  return FAILURE_TYPES.TEST_EXPECTATION;
}

// ---------------------------------------------------------------------------
// Known noise patterns -- findings matching these are auto-resolved
// ---------------------------------------------------------------------------
const NOISE_PATTERNS = [
  // Network/transient
  { pattern: /network\s*(error|offline|failed\s*to\s*fetch)/i, reason: "Transient network error" },
  { pattern: /abort(ed)?.*signal/i, reason: "Request aborted (navigation)" },
  { pattern: /timeout|timed?\s*out/i, reason: "Timeout (transient)" },
  { pattern: /hydration.*mismatch/i, reason: "React hydration noise" },
  { pattern: /NEXT_REDIRECT/i, reason: "Next.js redirect mechanism" },
  { pattern: /long\s*task/i, reason: "Performance long task warning" },
  // Permission noise for privileged roles
  { pattern: /super_admin.*admin.*page.*visible/i, reason: "Super admins have admin access" },
  { pattern: /developer.*admin.*visible/i, reason: "Developers have full access" },
  { pattern: /got\s*405\s*instead\s*of\s*403/i, reason: "405 = method not allowed (correct)" },
  // UI noise
  { pattern: /empty\s*state.*no\s*(mocs?|reviews?|items?)/i, reason: "Empty state is valid for new/test users" },
  { pattern: /loading\s*(skeleton|spinner).*visible/i, reason: "Loading states are expected" },
];

// Error log noise patterns for auto-resolve
const ERROR_NOISE_PATTERNS = [
  { pattern: /TypeError:\s*Failed\s*to\s*fetch/i, reason: "Client network drop" },
  { pattern: /AbortError/i, reason: "Request aborted by navigation" },
  { pattern: /Network\s*(error|offline)/i, reason: "Client offline" },
  { pattern: /React.*#?419/i, reason: "React hydration mismatch (noise)" },
  { pattern: /NEXT_REDIRECT/i, reason: "Next.js redirect mechanism" },
  { pattern: /Long\s*Task/i, reason: "Browser long task warning" },
  { pattern: /ResizeObserver/i, reason: "ResizeObserver loop (browser noise)" },
  { pattern: /refresh_token_not_found/i, reason: "Session expired (handled by auth)" },
  { pattern: /bad_jwt/i, reason: "Expired JWT (handled by auth)" },
  { pattern: /signal\s*aborted/i, reason: "Aborted signal (navigation)" },
];

// High-criticality patterns -- these always surface for human review
const CRITICAL_PATTERNS = [
  { pattern: /security/i, reason: "Security finding" },
  { pattern: /BOLA|cross.org|data\s*isolation|unauthorized\s*access/i, reason: "Data isolation / BOLA" },
  { pattern: /permission.*leak|permission.*bypass/i, reason: "Permission enforcement failure" },
  { pattern: /sensitive\s*data|PII|credential|secret/i, reason: "Sensitive data exposure" },
  { pattern: /SQL\s*injection|XSS|CSRF/i, reason: "Injection vulnerability" },
  { pattern: /RLS.*policy.*missing|RLS.*bypass/i, reason: "Row-level security gap" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFalsePositives() {
  if (!fs.existsSync(FALSE_POSITIVES_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(FALSE_POSITIVES_FILE, "utf-8"));
    return (data.patterns ?? []).map((p) => ({
      regex: new RegExp(p.pattern, "i"),
      reason: p.reason,
    }));
  } catch {
    return [];
  }
}

function loadGuardrails() {
  if (!fs.existsSync(GUARDRAILS_FILE)) return { questions: [] };
  try {
    return JSON.parse(fs.readFileSync(GUARDRAILS_FILE, "utf-8"));
  } catch {
    return { questions: [] };
  }
}

function saveGuardrails(data) {
  const dir = path.dirname(GUARDRAILS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GUARDRAILS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function nowCentral() {
  return new Date()
    .toLocaleString("sv-SE", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replace(" ", "T") + "-06:00";
}

function classifyFinding(finding, falsePositives) {
  const desc = finding.description ?? finding.summary ?? "";
  const severity = (finding.severity ?? "").toLowerCase();

  // Check critical patterns first -- always surface for human review
  for (const { pattern, reason } of CRITICAL_PATTERNS) {
    if (pattern.test(desc) || severity === "security") {
      return { action: "escalate", reason };
    }
  }

  // Check oracle false positives
  for (const { regex, reason } of falsePositives) {
    if (regex.test(desc)) {
      return { action: "auto_resolve", reason: `False positive: ${reason}` };
    }
  }

  // Check noise patterns
  for (const { pattern, reason } of NOISE_PATTERNS) {
    if (pattern.test(desc)) {
      return { action: "auto_resolve", reason };
    }
  }

  // Vision findings are actionable — analyst should fix these (dark mode, layout, a11y)
  if (desc.startsWith("[Vision]") || finding.failureType === "vision_defect") {
    return { action: "analyst_fix", reason: "Vision defect -- needs code fix" };
  }

  // Product quality findings — tiered by grade and effort
  if (severity === "product") {
    const grade = finding.productGrade ?? "";
    const effort = finding.productEffort ?? "";

    // Strategic effort → escalate for human review (direction matters)
    if (effort === "strategic") {
      return { action: "escalate", reason: `Product quality (grade ${grade || "?"}, strategic) -- needs human review` };
    }

    // C/D/F grades → always analyst fix regardless of effort
    if (grade === "C" || grade === "D" || grade === "F") {
      return { action: "analyst_fix", reason: `Product quality (grade ${grade}, ${effort || "?"}) -- analyst fix` };
    }

    // A/B with explicit actionable effort → analyst fix (oracle flagged something worth doing)
    if (effort === "quick_win" || effort === "medium") {
      return { action: "analyst_fix", reason: `Product quality (grade ${grade || "?"}, ${effort}) -- analyst fix` };
    }

    // A/B with no actionable effort → auto-resolve (page is good, nothing specific to fix)
    return { action: "auto_resolve", reason: `Product quality (grade ${grade || "?"}) -- already good, logged for learning` };
  }

  // UX and suggestion findings are actionable product feedback → analyst fix
  if (severity === "ux" || severity === "suggestion") {
    return { action: "analyst_fix", reason: `${severity} finding -- analyst fix` };
  }

  // Bug findings → analyst fix (all bugs are actionable, not just 500s)
  if (severity === "bug") {
    return { action: "analyst_fix", reason: "Bug finding -- analyst fix" };
  }

  // Inconsistency findings → analyst fix
  if (severity === "inconsistency") {
    return { action: "analyst_fix", reason: "Inconsistency finding -- analyst fix" };
  }

  // Default: analyst fix (unknown severities should be reviewed, not silently dropped)
  return { action: "analyst_fix", reason: `Unclassified finding (${severity || "no severity"}) -- analyst fix` };
}

function classifyError(error) {
  const msg = (error.message ?? "") + " " + (error.error_type ?? "");

  for (const { pattern, reason } of ERROR_NOISE_PATTERNS) {
    if (pattern.test(msg)) {
      return { action: "auto_resolve", reason };
    }
  }

  // High severity errors always escalate
  if (error.level === "fatal" || error.level === "critical") {
    return { action: "escalate", reason: `${error.level} error requires review` };
  }

  // Errors with many occurrences that aren't noise might be real
  if (error.count && error.count >= 10) {
    return { action: "escalate", reason: `High-frequency error (${error.count} occurrences)` };
  }

  return { action: "auto_resolve", reason: "Non-critical error auto-triaged" };
}

// ---------------------------------------------------------------------------
// Change-intent integration — classify UI/selector failures as intentional or regression
// ---------------------------------------------------------------------------

let analyzeIntentFn = null;
try {
  const changeIntent = require("./change-intent.js");
  if (changeIntent && typeof changeIntent.analyzeIntent === "function") {
    analyzeIntentFn = changeIntent.analyzeIntent;
  }
} catch {
  // change-intent.js not available — skip intent analysis
}

/**
 * For UI_REFACTOR, STALE_SELECTOR, and TEST_EXPECTATION failures:
 * Ask change-intent if the failure was caused by an intentional code change.
 * If intentional with high confidence → auto-resolve.
 * Returns null if intent analysis is unavailable or inconclusive.
 */
async function tryIntentAnalysis(finding, failureType) {
  if (!analyzeIntentFn) {
    return null;
  }

  // Only analyze repairable failure types
  const REPAIRABLE = [
    FAILURE_TYPES.UI_REFACTOR,
    FAILURE_TYPES.STALE_SELECTOR,
    FAILURE_TYPES.TEST_EXPECTATION,
  ];
  if (!REPAIRABLE.includes(failureType)) {
    return null;
  }

  try {
    const result = await analyzeIntentFn({
      testFile: finding.testFile ?? finding.specFile ?? "",
      errorMessage: finding.description ?? finding.summary ?? "",
      codeAreas: finding.codeAreas ?? (finding.page ? [finding.page] : []),
    });

    if (result && result.intent === "intentional" && result.confidence >= 0.7) {
      return {
        action: "auto_resolve",
        reason: `Intentional change (${result.confidence * 100}% confidence): ${result.reasoning?.slice(0, 100) ?? "UI/code change detected"}`,
      };
    }
    return null; // Not clearly intentional — use default triage
  } catch {
    return null; // Intent analysis failed — fall through
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const falsePositives = loadFalsePositives();
  const stats = { autoResolved: 0, escalated: 0, analystFix: 0, skipped: 0, failureTypes: {} };

  // ----- Triage findings -----
  // Skip findings triage when --errors-only (findings are handled by findings-to-mocs.js)
  if (!errorsOnly && fs.existsSync(FINDINGS_FILE)) {
    let findings = [];
    try {
      findings = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
    } catch {
      // ignore
    }

    if (Array.isArray(findings) && findings.length > 0) {
      console.log(`[auto-triage] Processing ${findings.length} findings...`);

      // Update persona-learning with triage results
      let learning = { personas: {} };
      if (fs.existsSync(LEARNING_FILE)) {
        try {
          learning = JSON.parse(fs.readFileSync(LEARNING_FILE, "utf-8"));
        } catch {
          // ignore
        }
      }

      const guardrails = loadGuardrails();
      const escalatedFindings = [];
      const analystFixFindings = [];

      // Failure type stats for reporting
      const failureTypeStats = {};

      // Skip findings that are already triaged to avoid re-processing 3000+ items
      const SKIP_STATUSES = new Set(["noise", "resolved", "in_moc", "in_moc_archived", "noise_resolved"]);
      const MAX_INTENT_ANALYSES = 20; // Cap LLM calls per run to avoid timeout
      let intentAnalysisCount = 0;

      for (let fi = 0; fi < findings.length; fi++) {
        const finding = findings[fi];

        // Skip already-triaged findings
        if (SKIP_STATUSES.has(finding.status)) {
          stats.skipped++;
          continue;
        }

        // Progress logging every 500 findings
        if (fi > 0 && fi % 500 === 0) {
          console.log(`[auto-triage] Progress: ${fi}/${findings.length} (${stats.autoResolved} resolved, ${stats.analystFix} analyst_fix, ${stats.escalated} escalated)`);
        }

        let result = classifyFinding(finding, falsePositives);
        const failureType = classifyFailureType(finding);

        // Track failure type classification
        finding.failureType = failureType;
        failureTypeStats[failureType] = (failureTypeStats[failureType] ?? 0) + 1;

        // Change-intent analysis: if the finding would escalate or need analyst fix,
        // check if a recent code change explains the failure (intentional UI change).
        // Capped per run to avoid spawning hundreds of Claude CLI processes.
        if ((result.action === "escalate" || result.action === "analyst_fix") && intentAnalysisCount < MAX_INTENT_ANALYSES) {
          const intentOverride = await tryIntentAnalysis(finding, failureType);
          intentAnalysisCount++;
          if (intentOverride) {
            result = intentOverride;
            finding.intentAnalysis = "intentional";
          }
        }

        // Error-finding correlation boost: findings with linked server errors
        // get promoted from transient/auto-resolve to real bug status
        if (finding.errorContext && finding.errorContext.count > 0) {
          const hasServerError = (finding.errorContext.statusCodes || []).some(
            (sc) => String(sc).startsWith("5") || sc === "500"
          );
          const hasPermissionError = (finding.errorContext.statusCodes || []).some(
            (sc) => sc === "401" || sc === "403"
          );

          if (hasServerError && result.action === "auto_resolve" && failureType === FAILURE_TYPES.TRANSIENT) {
            // Transient finding + 500 error → promote to analyst_fix
            result = { action: "analyst_fix", reason: `Transient promoted to bug: correlated with ${finding.errorContext.count} server 500 error(s)` };
            finding.failureType = FAILURE_TYPES.REAL_BUG;
            finding.confidence = Math.max(finding.confidence ?? 0, 0.8);
          } else if (hasPermissionError && result.action !== "escalate") {
            // Finding + 401/403 → classify as permission_changed
            finding.failureType = FAILURE_TYPES.PERMISSION_CHANGED;
            if (result.action === "auto_resolve") {
              result = { action: "analyst_fix", reason: `Permission error correlated: ${finding.errorContext.count} 401/403 error(s)` };
            }
          }
        }

        // Record triage decision for pipeline accuracy tracking
        if (pipelineMetrics && !dryRun) {
          try {
            pipelineMetrics.recordDecision("triage", {
              findingId: finding.id ?? fi,
              severity: finding.severity ?? "unknown",
              failureType,
            }, {
              action: result.action,
              reason: result.reason,
            });
          } catch { /* non-fatal */ }
        }

        if (result.action === "escalate") {
          escalatedFindings.push({ finding, reason: result.reason, failureType });
          stats.escalated++;
          // Mark finding as open (needs human review)
          finding.status = finding.status ?? "open";
        } else if (result.action === "analyst_fix") {
          analystFixFindings.push({ finding, reason: result.reason, failureType });
          stats.analystFix++;
          // Mark as pending_fix — not resolved, needs code change
          finding.status = "pending_fix";
          finding.triageAction = "analyst_fix";
          finding.triageReason = result.reason;
          finding.triagedAt = nowCentral();
          // Feed TRUE POSITIVE back to oracle so it reinforces correct detections
          if (!dryRun) {
            try {
              const tpEntry = JSON.stringify({
                type: "confirmed_positive",
                persona: finding.persona ?? "?",
                page: finding.page ?? "?",
                severity: finding.severity ?? "unknown",
                textSnippet: (finding.description ?? finding.text ?? "").slice(0, 200),
                reason: result.reason,
                at: new Date().toISOString(),
              });
              fs.appendFileSync(ORACLE_FEEDBACK_PATH, tpEntry + "\n");
            } catch { /* non-fatal */ }
          }
        } else {
          stats.autoResolved++;
          finding.status = "noise";
          finding.resolvedAt = nowCentral();
          finding.resolvedBy = "auto-triage";
          // Feed noise pattern back to oracle so it learns to avoid flagging these
          if (!dryRun) {
            try {
              const entry = JSON.stringify({
                persona: finding.persona ?? "?",
                page: finding.page ?? "?",
                textSnippet: (finding.description ?? finding.text ?? "").slice(0, 200),
                reason: result.reason,
                at: new Date().toISOString(),
              });
              fs.appendFileSync(ORACLE_FEEDBACK_PATH, entry + "\n");
            } catch { /* non-fatal */ }
          }
        }

        // Record triage result in persona learning
        const personaId = (finding.persona ?? "unknown").toLowerCase().replace(/\s+/g, "-").replace(/\./g, "");
        if (!learning.personas[personaId]) {
          learning.personas[personaId] = {};
        }
        if (!learning.personas[personaId].triageHistory) {
          learning.personas[personaId].triageHistory = [];
        }
        learning.personas[personaId].triageHistory.push({
          page: finding.page,
          severity: finding.severity,
          failureType,
          action: result.action,
          reason: result.reason,
          timestamp: nowCentral(),
        });
        // Keep last 100 triage entries per persona (was 20 — too few for trend detection)
        if (learning.personas[personaId].triageHistory.length > 100) {
          learning.personas[personaId].triageHistory = learning.personas[personaId].triageHistory.slice(-100);
        }
      }

      // Aggregate failure type stats
      stats.failureTypes = failureTypeStats;

      // Only create guardrail questions for escalated (critical) findings
      for (const { finding, reason } of escalatedFindings) {
        const desc = finding.description ?? finding.summary ?? "";
        const question = `[CRITICAL] ${reason}: ${desc.slice(0, 150)}`;
        const context = [
          `Persona: ${finding.persona ?? "unknown"}`,
          `Page: ${finding.page ?? "/"}`,
          `Severity: ${finding.severity ?? "unknown"}`,
          finding.permissionKey ? `Permission: ${finding.permissionKey}` : null,
          finding.apiEndpoint ? `API: ${finding.apiEndpoint}` : null,
          `Auto-triage recommends: human review required`,
        ]
          .filter(Boolean)
          .join(" | ");

        // Check for duplicate
        const fp = question.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
        const isDup = guardrails.questions.some((q) => {
          const efp = (q.question ?? "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
          return efp === fp || (efp.length >= 40 && fp.length >= 40 && efp.slice(0, 50) === fp.slice(0, 50));
        });

        if (!isDup && !dryRun) {
          guardrails.questions.push({
            id: `at-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            iteration: 0,
            timestamp: nowCentral(),
            category: "needs_approval",
            question,
            context,
            status: "pending",
            answer: null,
            answeredAt: null,
            persona: finding.persona ?? null,
            page: finding.page ?? null,
          });
        } else if (isDup) {
          stats.skipped++;
          stats.escalated--;
        }
      }

      if (!dryRun) {
        saveGuardrails(guardrails);
        fs.writeFileSync(LEARNING_FILE, JSON.stringify(learning, null, 2) + "\n", "utf-8");
        // Write findings back with updated status fields
        fs.writeFileSync(FINDINGS_FILE, JSON.stringify(findings, null, 2), "utf-8");
      }
    }
  }

  // ----- Triage error_logs -----
  if (includeErrors || errorsOnly) {
    try {
      const { createClient } = require("@supabase/supabase-js");
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (url && key) {
        const supabase = createClient(url, key, {
          auth: { autoRefreshToken: false, persistSession: false },
        });

        const since = new Date(Date.now() - 7 * 86400000).toISOString();
        const queryFn = () => supabase
          .from("error_logs")
          .select("id, level, message, error_type, endpoint, created_at")
          .eq("resolved", false)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(100);
        const { data: errors } = supabaseRetry
          ? await supabaseRetry.withRetry(queryFn, { label: "auto-triage-errors", log: (m) => console.log(m) })
          : await queryFn();

        if (errors && errors.length > 0) {
          console.log(`[auto-triage] Processing ${errors.length} unresolved errors...`);

          // Cluster by error_type + message prefix
          const clusters = new Map();
          for (const err of errors) {
            const k = `${err.error_type}::${(err.message || "").slice(0, 80)}`;
            const existing = clusters.get(k);
            if (existing) {
              existing.count++;
              existing.ids.push(err.id);
            } else {
              clusters.set(k, {
                error_type: err.error_type,
                message: (err.message || "").slice(0, 200),
                level: err.level,
                count: 1,
                ids: [err.id],
                endpoints: err.endpoint ? [err.endpoint] : [],
              });
            }
          }

          for (const [, cluster] of clusters) {
            const result = classifyError(cluster);

            if (result.action === "auto_resolve" && !dryRun) {
              // Auto-resolve noise errors in DB
              const note = `[auto-triage] ${result.reason}`;
              for (const id of cluster.ids) {
                const updateFn = () => supabase
                  .from("error_logs")
                  .update({
                    resolved: true,
                    resolved_at: new Date().toISOString(),
                    resolution_notes: note,
                  })
                  .eq("id", id);
                if (supabaseRetry) {
                  await supabaseRetry.withRetry(updateFn, { label: `resolve-error-${id}` });
                } else {
                  await updateFn();
                }
              }
              stats.autoResolved += cluster.ids.length;
            } else if (result.action === "escalate") {
              stats.escalated++;
              // Add to guardrails for human review
              const guardrails = loadGuardrails();
              const question = `[CRITICAL ERROR] ${cluster.error_type}: "${cluster.message.slice(0, 100)}" -- ${cluster.count} occurrences. ${result.reason}`;
              if (!dryRun) {
                guardrails.questions.push({
                  id: `ate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                  iteration: 0,
                  timestamp: nowCentral(),
                  category: "needs_approval",
                  question,
                  context: `error_ids: ${JSON.stringify(cluster.ids)}`,
                  status: "pending",
                  answer: null,
                  answeredAt: null,
                  persona: null,
                  page: cluster.endpoints[0] ?? null,
                });
                saveGuardrails(guardrails);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[auto-triage] Error triage failed: ${e.message}`);
    }
  }

  // ----- Auto-resolve old pending persona questions -----
  // Questions older than 48 hours that aren't critical get auto-skipped
  const guardrails = loadGuardrails();
  const cutoff = Date.now() - 48 * 3600000;
  let autoSkipped = 0;
  for (const q of guardrails.questions) {
    if (q.status !== "pending") continue;
    // Only auto-skip persona_question and unclear categories
    if (!["persona_question", "unclear", "persona_hiring"].includes(q.category)) continue;
    const ts = new Date(q.timestamp).getTime();
    if (ts < cutoff) {
      q.status = "skipped";
      q.answer = "[auto-triage] Auto-skipped after 48h -- not critical";
      q.answeredAt = nowCentral();
      autoSkipped++;
    }
  }
  if (autoSkipped > 0 && !dryRun) {
    saveGuardrails(guardrails);
    stats.autoResolved += autoSkipped;
  }

  // ----- Write triage results for downstream consumption -----
  if (!dryRun) {
    try {
      const triageResultsPath = path.join(ROOT, "e2e", "state", "auto-triage-results.json");
      const triageResults = {
        at: new Date().toISOString(),
        autoResolved: stats.autoResolved,
        escalated: stats.escalated,
        analystFix: stats.analystFix,
        skipped: stats.skipped,
        staleSkipped: autoSkipped,
        failureTypes: stats.failureTypes,
        results: [],
        personas: {},
      };

      // Build per-persona aggregation from findings
      if (fs.existsSync(FINDINGS_FILE)) {
        try {
          const findingsData = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
          const findings = findingsData.findings ?? findingsData;
          if (Array.isArray(findings)) {
            for (const f of findings) {
              const persona = f.persona ?? "unknown";
              if (!triageResults.personas[persona]) {
                triageResults.personas[persona] = { total: 0, resolved: 0, falsePositives: 0, escalated: 0 };
              }
              triageResults.personas[persona].total++;
              if (f.status === "resolved") { triageResults.personas[persona].resolved++; }
              if (f._classification === "false_positive") { triageResults.personas[persona].falsePositives++; }
              if (f._classification === "needs_approval") { triageResults.personas[persona].escalated++; }

              triageResults.results.push({
                id: f.id ?? f._id,
                persona,
                classification: f._classification ?? f.status,
                page: f.page ?? f.url,
              });
            }
          }
        } catch { /* non-fatal */ }
      }

      fs.writeFileSync(triageResultsPath, JSON.stringify(triageResults, null, 2) + "\n");
    } catch { /* non-fatal */ }
  }

  // ----- Summary -----
  console.log(`[auto-triage] Done:`);
  console.log(`  Auto-resolved: ${stats.autoResolved}`);
  console.log(`  Escalated for human review: ${stats.escalated}`);
  if (stats.analystFix > 0) console.log(`  Pending analyst fix (vision/code): ${stats.analystFix}`);
  if (stats.skipped > 0) console.log(`  Duplicates skipped: ${stats.skipped}`);
  if (autoSkipped > 0) console.log(`  Stale questions auto-skipped: ${autoSkipped}`);

  // Failure type breakdown
  if (stats.failureTypes && Object.keys(stats.failureTypes).length > 0) {
    console.log(`  Failure type breakdown:`);
    for (const [type, count] of Object.entries(stats.failureTypes).sort(([,a], [,b]) => b - a)) {
      console.log(`    ${type}: ${count}`);
    }
  }
}

// Export for use by other scripts
if (typeof module !== "undefined") {
  module.exports = { FAILURE_TYPES, classifyFailureType, classifyFinding };
}

// Guard main() so it doesn't run on require/import
if (require.main === module) {
  main().catch((e) => {
    console.error("[auto-triage]", e);
    process.exit(1);
  });
}
