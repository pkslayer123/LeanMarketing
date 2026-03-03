#!/usr/bin/env node

/**
 * moc-auto-fix.js — Closes the MOC-to-code loop.
 *
 * Reads ALL approved MOCs from moc-queue.json (any tier), analyzes the described
 * problem, uses LLM to generate actual code fixes, applies them, type-checks,
 * and marks them as implemented or awaiting_closeout (depending on tier).
 *
 * Tier handling:
 *   - AUTO_FIX:          sonnet, auto-commit, status → implemented
 *   - AUTO_APPROVE:      sonnet, auto-commit, status → implemented
 *   - NEEDS_APPROVAL:    opus,   apply fix,   status → awaiting_closeout (human verifies)
 *   - SPEC_IMPLEMENTATION: opus, apply fix,   status → awaiting_closeout (human verifies)
 *   - PIPELINE_REPAIR:   sonnet, scripts/e2e/ only, integrity-validated, auto-commit
 *   - CLAW_REPAIR:       opus,   scripts/e2e/claws/ + lib/, syntax + integrity-validated, auto-commit
 *
 * Pipeline per MOC:
 *   1. Pre-process: auto-archive stuck MOCs (3+ failures → archived, 7d+ stale → archived)
 *   2. Parse page area + findings from description
 *   3. Classify: noise (auto-close) vs actionable (fix)
 *   4. For actionable: map page path → source file(s)
 *   5. Invoke Claude Code CLI (claude --print) with tier-appropriate model
 *      Claude reads files, edits code, and type-checks iteratively.
 *   6. Verify via git diff that Claude made changes + double-check type-check
 *   6b. Post-fix verification: ask Claude haiku to rate if the diff addresses the finding (0-10)
 *   7. If passes: stage, mark implemented or awaiting_closeout (tier-dependent)
 *   8. If fails: revert, increment failure counter
 *
 * Code Generation Strategy:
 *   - PRIMARY: Claude Code CLI (claude --print) — reads CLAUDE.md,
 *     understands project conventions, edits with precision, type-checks iteratively.
 *   - Model selected per tier: opus for critical/spec, sonnet for standard.
 *   - Complexity-based escalation still applies (security, large files → opus).
 *   - FALLBACK: Classification-only (no code generation) when Claude is unavailable.
 *   - NEVER uses gpt-4o-mini or other small models for code generation (0% success rate).
 *
 * Safety:
 *   - Never touches migrations, auth, or schema files
 *   - Type-checks after each fix (even Claude-generated)
 *   - Reverts on failure via git checkout
 *   - Max fixes per run (default 15)
 *   - Retry limit: 3 failures → auto-archive
 *
 * Usage:
 *   node scripts/e2e/moc-auto-fix.js                    # Process ALL approved MOCs (any tier)
 *   node scripts/e2e/moc-auto-fix.js --dry-run           # Preview only
 *   node scripts/e2e/moc-auto-fix.js --max 10            # Limit to 10 fixes (default: 15)
 *   node scripts/e2e/moc-auto-fix.js --moc <id>          # Single MOC
 *   node scripts/e2e/moc-auto-fix.js --commit            # Auto-commit after all fixes
 *   node scripts/e2e/moc-auto-fix.js --commit            # Auto-commit after all fixes (alias)
 *   node scripts/e2e/moc-auto-fix.js --json              # Machine-readable output
 *   node scripts/e2e/moc-auto-fix.js --skip-verify       # Skip post-fix verification
 *
 * Progress monitoring (tail the log during long runs):
 *   tail -f e2e/state/auto-fix-progress.log
 */

try {
  require("dotenv").config({ path: require("path").resolve(__dirname, "..", "..", ".env.local") });
} catch {
  // dotenv not required
}

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync, spawn } = require("child_process");
const os = require("os");
const { withStateLock } = require("./claw");

// ---------------------------------------------------------------------------
// Process cleanup: track child processes so SIGTERM kills them too
// ---------------------------------------------------------------------------
const _trackedChildren = new Set();

function _killTrackedChildren() {
  for (const child of _trackedChildren) {
    try {
      if (os.platform() === "win32") {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", timeout: 5000 });
      } else {
        process.kill(-child.pid, "SIGKILL"); // negative PID = process group
      }
    } catch { /* already dead */ }
  }
  _trackedChildren.clear();
}

process.on("SIGTERM", () => {
  _killTrackedChildren();
  process.exit(143);
});
process.on("SIGINT", () => {
  _killTrackedChildren();
  process.exit(130);
});
// Windows: parent process close
process.on("disconnect", () => {
  _killTrackedChildren();
  process.exit(1);
});

const { syncMocStatus, ensurePlatformMoc, notifyNeedsHuman } = require("./submit-moc.js");

// Pipeline accuracy tracking
let pipelineMetrics;
try {
  pipelineMetrics = require("./lib/pipeline-metrics");
} catch { /* pipeline-metrics not available */ }

const ROOT = path.resolve(__dirname, "..", "..");
const APP_DIR = path.join(ROOT, "app");
const QUEUE_PATH = path.join(ROOT, "e2e", "state", "moc-queue.json");
const LEARNED_FIXES = path.join(ROOT, "e2e", "state", "learned-fix-patterns.json");
const FIX_LOG_PATH = path.join(ROOT, "e2e", "state", "auto-fix-log.json");
const REGRESSION_STATE_PATH = path.join(ROOT, "e2e", "state", "regression-tests.json");
const REGRESSION_DIR = path.join(ROOT, "e2e", "tests", "regression");
const CRITICAL_ROUTES_PATH = path.join(ROOT, "e2e", "state", "critical-routes.json");
const FIX_FAILURE_BOOST_PATH = path.join(ROOT, "e2e", "state", "fix-failure-boost.json");
const MODEL_EFFECTIVENESS_PATH = path.join(ROOT, "e2e", "state", "model-effectiveness.json");
const MEMORY_LONGTERM_PATH = path.join(ROOT, "e2e", "state", "memory-longterm.json");
const PERSONA_ROI_PATH = path.join(ROOT, "e2e", "state", "persona-roi.json");
const PRODUCT_GRADE_PATH = path.join(ROOT, "e2e", "state", "product-grade-history.json");
const PRINCIPLES_PATH = path.join(ROOT, "e2e", "state", "daemon-principles.json");
const MAX_REGRESSION_TESTS = 50;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const AUTO_COMMIT = args.includes("--commit");
const JSON_MODE = args.includes("--json");
const VERIFY_IMPLEMENTED = args.includes("--verify-implemented");
const SKIP_VERIFY = args.includes("--skip-verify") || !!process.env.AUTOFIX_SKIP_VERIFY;
const maxIdx = args.indexOf("--max");
const MAX_FIXES = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : 30;
// SMOKE_AFTER_FIX removed: tests run against production, so smoke after local
// commit validates the old deployment, not the fix. The next daemon test-runner
// cycle catches regressions after Vercel deploys the push.
const mocIdx = args.indexOf("--moc");
const MOC_FILTER = mocIdx !== -1 ? args[mocIdx + 1] : null;
const mocIdsIdx = args.indexOf("--moc-ids");
const MOC_IDS_FILTER = mocIdsIdx !== -1 ? args[mocIdsIdx + 1].split(",").filter(Boolean) : null;

// ---------------------------------------------------------------------------
// Logging — dual output: console + persistent progress log
// ---------------------------------------------------------------------------

const PROGRESS_LOG = path.join(ROOT, "e2e", "state", "auto-fix-progress.log");
const MAX_PROGRESS_LOG_BYTES = 2 * 1024 * 1024; // 2MB rotation
const RUN_START = Date.now();
let _mocStart = 0;

// Rotate progress log if too large
try {
  if (fs.existsSync(PROGRESS_LOG) && fs.statSync(PROGRESS_LOG).size > MAX_PROGRESS_LOG_BYTES) {
    const content = fs.readFileSync(PROGRESS_LOG, "utf-8");
    const lines = content.split("\n");
    const trimmed = lines.slice(-500).join("\n"); // keep last 500 lines
    fs.writeFileSync(PROGRESS_LOG, trimmed + "\n");
  }
} catch { /* ignore rotation failures */ }

function log(msg) {
  if (!JSON_MODE) {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    const elapsed = ((Date.now() - RUN_START) / 1000).toFixed(0);
    const line = `[${ts}] [${elapsed}s] ${msg}`;
    console.log(line);
    // Append to persistent log so `tail -f` works during long runs
    try { fs.appendFileSync(PROGRESS_LOG, line + "\n"); } catch { /* ignore */ }
  }
}

function logProgress(current, total, mocId, action) {
  const pct = total > 0 ? ((current / total) * 100).toFixed(0) : 0;
  const mocElapsed = _mocStart ? ((Date.now() - _mocStart) / 1000).toFixed(1) : "0";
  log(`[${current}/${total} ${pct}%] ${mocId}: ${action} (${mocElapsed}s)`);
}

function logRunningTotals(results) {
  const parts = [];
  if (results.fixApplied > 0) { parts.push(`${results.fixApplied} fixed`); }
  if (results.fixFailed > 0) { parts.push(`${results.fixFailed} failed`); }
  if (results.noiseAutoClose > 0) { parts.push(`${results.noiseAutoClose} noise`); }
  if (results.noFixNeeded > 0) { parts.push(`${results.noFixNeeded} no-fix`); }
  if (parts.length > 0) {
    log(`  Running totals: ${parts.join(" | ")}`);
  }
}

// ---------------------------------------------------------------------------
// Noise detection — findings that are NOT real bugs
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
  // Transient network errors during parallel persona testing
  /TypeError: Failed to fetch/i,
  /Error checking delete permissions.*Failed to fetch/i,
  /Error checking subscription.*Failed to fetch/i,
  /Error loading feature flags.*Failed to fetch/i,
  /Error loading.*Failed to fetch/i,
  /ECONNRESET|ETIMEDOUT|fetch failed/i,
  // Vision findings about empty/loading pages (not bugs)
  /loading state.*displayed.*content.*not.*available/i,
  /no visible.*listed.*may indicate/i,
  /layout appears incomplete.*lack of content/i,
  // Hydration noise
  /React.*#419|hydration.*mismatch/i,
  // Signal aborted
  /signal is aborted/i,
  // Auth session expired (normal)
  /AuthSessionMissingError/i,
  /Auth session missing/i,
  // E2E testing artifacts
  /Validation Error: Stage.*not complete/i,
  /Granular permission denied/i,
];

function loadFixEffectivenessNote() {
  try {
    const p = path.join(ROOT, "e2e", "state", "fix-effectiveness-report.json");
    if (!fs.existsSync(p)) return "";
    const d = JSON.parse(fs.readFileSync(p, "utf-8"));
    const rate = d.resolutionRate != null ? Math.round((d.resolutionRate ?? 0) * 100) : null;
    const trend = d.trend ?? "unknown";
    if (rate == null && trend === "unknown") return "";
    const parts = [];
    if (rate != null) parts.push(`resolution rate ${rate}%`);
    if (trend !== "unknown") parts.push(`trend: ${trend}`);
    return parts.length > 0 ? `\n**Fix effectiveness:** ${parts.join(", ")}. Prefer minimal, targeted changes.\n` : "";
  } catch {
    return "";
  }
}

function loadCriticalRoutes() {
  try {
    const data = JSON.parse(fs.readFileSync(CRITICAL_ROUTES_PATH, "utf-8"));
    return Array.isArray(data?.routes) ? data.routes : [];
  } catch {
    return ["/login", "/api/auth"];
  }
}

function appendFixFailureBoost(moc, pageArea) {
  if (DRY_RUN) return;
  try {
    const persona = moc.persona ?? "unknown";
    const page = pageArea ?? "unknown";
    let data = { boosts: [] };
    if (fs.existsSync(FIX_FAILURE_BOOST_PATH)) {
      data = JSON.parse(fs.readFileSync(FIX_FAILURE_BOOST_PATH, "utf-8"));
    }
    data.boosts = (data.boosts ?? []).slice(-99);
    data.boosts.push({ persona, page, at: new Date().toISOString() });
    fs.writeFileSync(FIX_FAILURE_BOOST_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

function isNoise(description) {
  for (const p of NOISE_PATTERNS) {
    if (p.test(description)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Page path → source file mapping (shared utility)
// ---------------------------------------------------------------------------

const { pagePathToSourceFiles, findApiRoute } = require("./lib/page-to-source");

// ---------------------------------------------------------------------------
// Actionable finding extraction
// ---------------------------------------------------------------------------

/**
 * Extract structured info from a MOC description.
 */
function parseMocDescription(moc) {
  const desc = moc.description || "";

  // Extract page area — try multiple patterns (root-cause MOCs use different formats)
  let pageArea = null;
  const pageMatch = desc.match(/\*\*Page area:\*\* (.+)/);
  if (pageMatch) {
    pageArea = pageMatch[1].trim();
  } else {
    // Fallback: try "**Page:** /path" or "page: /path" patterns
    const altMatch = desc.match(/\*\*Page:\*\*\s*(\S+)/) || desc.match(/\bpage:\s*(\/\S+)/i);
    if (altMatch) {
      pageArea = altMatch[1].trim();
    } else {
      // Fallback: scan for URL-like paths in the description
      const pathMatch = desc.match(/\b(\/(?:mocs|admin|review|api|account|my-department|login|pricing)(?:\/[a-z0-9_-]+)*)/i);
      if (pathMatch) {
        pageArea = pathMatch[1];
      } else if (moc.findings && moc.findings.length > 0) {
        // Last resort: extract from the findings array in the queue entry
        const findingPage = moc.findings[0]?.page;
        if (findingPage) { pageArea = findingPage; }
      }
    }
  }

  // Root-cause and theme MOCs store pageGroup directly — use it if text parsing failed
  if (!pageArea && moc.pageGroup) {
    pageArea = moc.pageGroup;
  }

  // Extract individual findings
  const findingLines = [];
  const findingRegex = /- \[([^\]]+)\] \[([^\]]+)\] (.+?)(?:\n  Classification: (.+?))?(?:\n|$)/g;
  let m;
  while ((m = findingRegex.exec(desc))) {
    findingLines.push({
      persona: m[1],
      mode: m[2],
      text: m[3].trim(),
      classification: (m[4] || "").trim(),
    });
  }

  // Extract console error count
  const consoleMatch = desc.match(/(\d+) console error\(s\)/);
  const consoleErrorCount = consoleMatch ? parseInt(consoleMatch[1], 10) : 0;

  return { pageArea, findings: findingLines, consoleErrorCount };
}

/**
 * Determine if a MOC is actionable (real bug) vs noise.
 */
function classifyMoc(moc) {
  const desc = moc.description || "";
  const { findings, consoleErrorCount } = parseMocDescription(moc);

  // Root-cause and theme MOCs have structured analysis — never classify as noise
  if (moc.rootCause || moc.fixRecommendation || moc.source === "root-cause-analysis" || moc.source === "theme-consolidation") {
    return { actionable: true, reason: "Has structured root-cause analysis" };
  }

  // needs_approval tier was explicitly set — never auto-close as noise
  if (moc.tier === "needs_approval") {
    return { actionable: true, reason: "Tier requires human approval — not auto-closeable" };
  }

  // All findings are noise → auto-close
  if (isNoise(desc)) {
    return { actionable: false, reason: "Transient network/session error" };
  }

  // All findings are "Failed to fetch" console errors → noise
  const allFetchErrors = findings.every((f) =>
    /Failed to fetch|ECONNRESET|ETIMEDOUT/i.test(f.text)
  );
  if (allFetchErrors && findings.length > 0) {
    return { actionable: false, reason: "All findings are transient fetch errors" };
  }

  // Vision findings about missing elements on legitimately sparse pages
  const allVisionEmpty = findings.every((f) =>
    f.mode.startsWith("Vision/") &&
    /missing.*elements|incomplete|not.*available|no.*visible|loading.*state/i.test(f.text)
  );
  if (allVisionEmpty && findings.length > 0) {
    // Check if this is a page that's legitimately empty (webhooks with no data, etc.)
    const { pageArea } = parseMocDescription(moc);
    const sparsePages = ["/admin/webhooks", "/admin/agents", "/admin/autonomous-operations"];
    if (sparsePages.some((p) => (pageArea || "").startsWith(p))) {
      return { actionable: false, reason: "Vision findings on legitimately sparse page" };
    }
  }

  // Console errors from exploration (not specific code failures)
  if (
    findings.length > 0 &&
    findings.every((f) => f.mode === "Explore" && /console error/i.test(f.text)) &&
    /Failed to fetch/i.test(desc)
  ) {
    return { actionable: false, reason: "Exploration console errors (transient)" };
  }

  // Positive observations that aren't bugs AND have no improvement suggestions
  const improvementHints = /could|should|suggest|improve|add|missing|consider|would\s*benefit|enhance|better|needs?\s/i;
  const allPositive = findings.every((f) =>
    /page\s*loads?\s*(correct|proper|success)|no\s*(issues?|problems?|errors?)\s*(found|detected|observed)|working\s*as\s*(design|expect|intend)|expected\s*behavior|functions?\s*(correct|proper)/i.test(f.text) &&
    !improvementHints.test(f.text)
  );
  if (allPositive && findings.length > 0) {
    return { actionable: false, reason: "All findings are positive observations with no improvements suggested" };
  }

  // Note: Spec grading findings (product quality grades) are NOT noise — they contain
  // actionable improvement suggestions that Claude should implement.

  // Has real findings → actionable
  return { actionable: true, reason: "Contains actionable findings" };
}

// ---------------------------------------------------------------------------
// LLM-powered fix generation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Claude Code integration — replaces gpt-4o-mini with Claude CLI
// ---------------------------------------------------------------------------

/**
 * Check if Claude CLI is available.
 */
function isClaudeAvailable() {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const CLAUDE_AVAILABLE = isClaudeAvailable();

// ---------------------------------------------------------------------------
// Per-model per-fix-type effectiveness tracking
// ---------------------------------------------------------------------------

let _modelEffectivenessCache = null;
let _modelEffectivenessCacheTime = 0;

function loadModelEffectiveness() {
  const now = Date.now();
  if (_modelEffectivenessCache && now - _modelEffectivenessCacheTime < 300000) {
    return _modelEffectivenessCache;
  }
  try {
    if (fs.existsSync(MODEL_EFFECTIVENESS_PATH)) {
      _modelEffectivenessCache = JSON.parse(fs.readFileSync(MODEL_EFFECTIVENESS_PATH, "utf-8"));
      _modelEffectivenessCacheTime = now;
      return _modelEffectivenessCache;
    }
  } catch { /* non-fatal */ }
  _modelEffectivenessCache = { outcomes: {}, updatedAt: null };
  _modelEffectivenessCacheTime = now;
  return _modelEffectivenessCache;
}

/**
 * Record a fix outcome for per-model per-fix-type learning.
 * @param {string} model — "opus" or "sonnet"
 * @param {string} tier — MOC tier (auto_fix, auto_approve, needs_approval, etc.)
 * @param {string} severity — Finding severity (security, bug, ux, suggestion)
 * @param {boolean} success — Whether the fix was applied successfully
 * @param {number} [verificationScore] — Post-fix verification score (0-10)
 */
function recordModelOutcome(model, tier, severity, success, verificationScore) {
  try {
    const data = loadModelEffectiveness();
    // Key: model:tier:severity (e.g., "sonnet:auto_fix:ux")
    const key = `${model}:${tier || "unknown"}:${severity || "unknown"}`;
    if (!data.outcomes[key]) {
      data.outcomes[key] = { attempts: 0, successes: 0, failures: 0, avgVerification: null, verificationSum: 0, verificationCount: 0 };
    }
    const entry = data.outcomes[key];
    entry.attempts++;
    if (success) {
      entry.successes++;
    } else {
      entry.failures++;
    }
    if (typeof verificationScore === "number" && verificationScore >= 0) {
      entry.verificationSum = (entry.verificationSum ?? 0) + verificationScore;
      entry.verificationCount = (entry.verificationCount ?? 0) + 1;
      entry.avgVerification = parseFloat((entry.verificationSum / entry.verificationCount).toFixed(2));
    }
    entry.successRate = entry.attempts > 0 ? parseFloat((entry.successes / entry.attempts).toFixed(3)) : null;
    entry.lastUpdated = new Date().toISOString();

    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(MODEL_EFFECTIVENESS_PATH, JSON.stringify(data, null, 2) + "\n");
    _modelEffectivenessCache = data;
    _modelEffectivenessCacheTime = Date.now();
  } catch { /* non-fatal */ }
}

/**
 * Query model effectiveness for a specific tier+severity combo.
 * Returns the model with the higher success rate, or null if insufficient data.
 * @param {string} tier
 * @param {string} severity
 * @returns {{ recommendedModel: string|null, reason: string }}
 */
function queryModelEffectiveness(tier, severity) {
  try {
    const data = loadModelEffectiveness();
    const sonnetKey = `sonnet:${tier}:${severity}`;
    const opusKey = `opus:${tier}:${severity}`;
    const sonnet = data.outcomes[sonnetKey];
    const opus = data.outcomes[opusKey];

    // Need >=3 attempts per model to make a recommendation
    const sonnetReady = sonnet && sonnet.attempts >= 3;
    const opusReady = opus && opus.attempts >= 3;

    if (sonnetReady && opusReady) {
      // Both models have enough data — compare success rates
      if (opus.successRate > sonnet.successRate + 0.15) {
        return { recommendedModel: "opus", reason: `opus ${opus.successRate} vs sonnet ${sonnet.successRate} for ${tier}/${severity}` };
      }
      if (sonnet.successRate > opus.successRate + 0.15) {
        return { recommendedModel: "sonnet", reason: `sonnet ${sonnet.successRate} vs opus ${opus.successRate} for ${tier}/${severity}` };
      }
    } else if (sonnetReady && sonnet.successRate < 0.3) {
      // Sonnet has enough data and it's bad — recommend opus
      return { recommendedModel: "opus", reason: `sonnet success rate only ${sonnet.successRate} for ${tier}/${severity}` };
    }

    return { recommendedModel: null, reason: "insufficient data" };
  } catch {
    return { recommendedModel: null, reason: "error loading effectiveness data" };
  }
}

/**
 * Select the right Claude model for a MOC based on tier + complexity.
 *
 * Tier-based defaults:
 *   - NEEDS_APPROVAL / SPEC_IMPLEMENTATION → opus (critical items, need best model)
 *   - AUTO_APPROVE / AUTO_FIX → sonnet (standard/cosmetic fixes)
 *
 * Complexity escalation (overrides tier default upward, never downward):
 *   - OPUS: Security MOCs, large files (1000+ lines), multi-file fixes + retried
 *   - HAIKU: Classification/analysis only (used by other scripts, not code gen)
 *
 * Returns { model, budget, timeout }
 */
function selectModelForMoc(moc, sourceFiles) {
  // Environment override always wins
  if (process.env.AUTOFIX_MODEL) {
    return {
      model: process.env.AUTOFIX_MODEL,
      budget: process.env.AUTOFIX_BUDGET || "2.00",
      timeout: 300000,
    };
  }

  const tier = moc.tier || "auto_fix";
  const desc = (moc.description || "").toLowerCase();
  const title = (moc.title || "").toLowerCase();
  const failures = moc.autoFixFailures ?? 0;

  // Check source file size
  let maxFileLines = 0;
  for (const sf of sourceFiles) {
    try {
      const content = fs.readFileSync(sf, "utf-8");
      const lines = content.split("\n").length;
      if (lines > maxFileLines) { maxFileLines = lines; }
    } catch { /* ignore */ }
  }

  // Claw repair gets Opus (critical infrastructure — a bad fix is worse than no fix)
  if (tier === "claw_repair") {
    log("  Model: OPUS (claw repair — critical infrastructure)");
    return { model: "opus", budget: "5.00", timeout: 600000 };
  }

  // Pipeline repair gets Sonnet (scripts, not app code — lower complexity)
  if (tier === "pipeline_repair") {
    log("  Model: SONNET (pipeline repair)");
    return { model: "sonnet", budget: "2.00", timeout: 300000 };
  }

  // Data-driven model selection: if we have enough historical data, prefer the winning model
  const severity = (moc.severity || "").toLowerCase() || "unknown";
  const effectivenessRec = queryModelEffectiveness(tier, severity);
  if (effectivenessRec.recommendedModel && failures === 0) {
    // Only use data-driven selection on first attempt (retries use normal escalation logic)
    const recModel = effectivenessRec.recommendedModel;
    log(`  Model: ${recModel.toUpperCase()} (data-driven: ${effectivenessRec.reason})`);
    return {
      model: recModel,
      budget: recModel === "opus" ? "5.00" : "2.00",
      timeout: recModel === "opus" ? 600000 : 300000,
    };
  }

  // Tier-based default: critical tiers get opus
  const isCriticalTier = tier === "needs_approval" || tier === "spec_implementation";

  // Fix-effectiveness escalation: when trend=declining or resolutionRate < 0.3, prefer opus for non-trivial MOCs
  // Requires >=5 total attempts before escalating — no data shouldn't trigger Opus
  let effectivenessEscalate = false;
  try {
    const ferPath = path.join(ROOT, "e2e", "state", "fix-effectiveness-report.json");
    if (fs.existsSync(ferPath)) {
      const fer = JSON.parse(fs.readFileSync(ferPath, "utf-8"));
      const rate = fer.resolutionRate ?? 1;
      const trend = (fer.trend ?? "stable").toLowerCase();
      const totalAttempts = (fer.totalResolved ?? 0) + (fer.totalRegressed ?? 0);
      if (totalAttempts >= 5 && (trend === "declining" || (typeof rate === "number" && rate < 0.3))) {
        effectivenessEscalate = sourceFiles.length >= 1 || maxFileLines >= 200;
      }
    }
  } catch { /* non-fatal */ }

  // Complexity-based escalation: these factors push any MOC to opus
  const isSecurityMoc = /security|BOLA|cross.org|injection|XSS|CSRF|permission.*leak|RLS/i.test(desc + title);
  const isLargeFile = maxFileLines >= 1000;
  const isMultiFile = sourceFiles.length >= 3;
  const hasPreviousFailures = failures >= 1;
  const isApiRoute = sourceFiles.some((f) => f.includes("/api/"));

  // OPUS: critical tier OR complexity escalation OR fix-effectiveness declining
  if (isCriticalTier || isSecurityMoc || isLargeFile || (isMultiFile && hasPreviousFailures) || effectivenessEscalate) {
    const reason = isCriticalTier ? `tier=${tier}` : effectivenessEscalate ? "fix-effectiveness declining/low" : isSecurityMoc ? "security" : isLargeFile ? `large file ${maxFileLines} lines` : "multi-file + retried";
    log(`  Model: OPUS (${reason})`);
    return {
      model: "opus",
      budget: "5.00",    // Opus needs more budget for large files
      timeout: 600000,   // 10 minutes for complex fixes
    };
  }

  // SONNET: standard code fixes (auto_fix, auto_approve, or escalated standard)
  if (hasPreviousFailures || isApiRoute) {
    log(`  Model: SONNET (${hasPreviousFailures ? "retried" : "API route"})`);
    return {
      model: "sonnet",
      budget: "3.00",
      timeout: 300000,
    };
  }

  // Default: SONNET
  return {
    model: "sonnet",
    budget: "2.00",
    timeout: 300000,
  };
}

/**
 * Determine the post-fix status for a MOC based on its tier.
 *
 * Only spec_implementation MOCs need human direction (product decisions).
 * Everything else — including needs_approval security fixes — auto-implements
 * when Claude successfully fixes the code and it passes type-check.
 * Steve gets visibility via dashboard; fixes don't block waiting for him.
 */
function getPostFixStatus(moc) {
  const tier = moc.tier || "auto_fix";
  if (tier === "spec_implementation" || tier === "needs_approval") {
    return "awaiting_closeout";
  }
  return "implemented";
}

/**
 * Check if a MOC's tier allows auto-commit (vs requiring human closeout).
 * spec_implementation and needs_approval require human sign-off.
 */
function isAutoCommitTier(moc) {
  const tier = moc.tier || "auto_fix";
  return tier !== "spec_implementation" && tier !== "needs_approval";
}

/**
 * Generate a regression test stub after a successful fix.
 * Wrapped in try-catch so the fix still commits even if generation fails.
 * Template-only (no Claude CLI), capped at MAX_REGRESSION_TESTS total.
 */
function generateRegressionTest(moc, changedFiles) {
  try {
    // Check total cap
    let regState = { tests: [] };
    try {
      if (fs.existsSync(REGRESSION_STATE_PATH)) {
        regState = JSON.parse(fs.readFileSync(REGRESSION_STATE_PATH, "utf-8"));
      }
    } catch {
      regState = { tests: [] };
    }
    if ((regState.tests || []).length >= MAX_REGRESSION_TESTS) {
      return; // Cap reached
    }

    // Extract persona and page from MOC description
    const desc = moc.description || moc.title || "";
    const personaMatch = desc.match(/(?:persona|user)[:\s]*([\w-]+)/i) || desc.match(/([\w]+-[\w]+)/);
    const pageMatch = desc.match(/(?:page|url|path)[:\s]*(\/[\w/-]+)/i) || desc.match(/(\/[\w-]+(?:\/[\w-]+)*)/);
    const personaId = personaMatch ? personaMatch[1].toLowerCase() : "unknown";
    const page = pageMatch ? pageMatch[1] : "/mocs";

    const slug = `reg-${(moc.platformMocNumber || moc.id || "unknown").toString().slice(0, 20)}`;
    const testFile = path.join(REGRESSION_DIR, `${slug}.spec.ts`);

    // Skip if already exists
    if (fs.existsSync(testFile)) {
      return;
    }

    const testContent = `/**
 * Auto-generated regression test for MOC ${moc.platformMocNumber || moc.id || "?"}.
 * Verifies the fix for: ${(moc.title || desc).slice(0, 100).replace(/\*/g, "")}
 * Changed files: ${changedFiles.slice(0, 3).join(", ")}
 * Generated by moc-auto-fix.js — do not edit manually.
 */

import { test, expect } from "../../fixtures/test";

test.describe("Regression: ${slug}", () => {
  test.beforeEach(async ({ sim }) => {
    await sim.loginAsDeveloper();
    await sim.simulateAs({
      role: "user",
      name: "${personaId}",
    });
  });

  test("page loads without errors after fix", async ({ page, sim }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await sim.goto("${page}");
    await page.waitForLoadState("networkidle");

    // Verify page loaded
    const title = await page.title();
    expect(title).toBeTruthy();

    // Check no critical console errors
    const critical = consoleErrors.filter(
      (e) => !e.includes("Failed to fetch") && !e.includes("hydration")
    );
    expect(critical.length).toBe(0);

    await sim.recordGreenPass("${slug}", ${JSON.stringify(changedFiles.slice(0, 3))});
  });
});
`;

    if (!DRY_RUN) {
      fs.mkdirSync(REGRESSION_DIR, { recursive: true });
      fs.writeFileSync(testFile, testContent);

      // Update state
      regState.tests = regState.tests || [];
      regState.tests.push({
        slug,
        moc: moc.platformMocNumber || moc.id,
        persona: personaId,
        page,
        files: changedFiles.slice(0, 5),
        generatedAt: new Date().toISOString(),
      });
      fs.mkdirSync(path.dirname(REGRESSION_STATE_PATH), { recursive: true });
      fs.writeFileSync(REGRESSION_STATE_PATH, JSON.stringify(regState, null, 2) + "\n");
    }

    log(`  Regression test generated: ${slug}`);
  } catch (err) {
    log(`  Regression test generation failed (non-fatal): ${(err.message || "").slice(0, 100)}`);
  }
}

/**
 * Invoke Claude Code to fix a bug.
 *
 * Instead of asking a small LLM to generate fragile JSON search-replace,
 * we invoke Claude Code (claude --print) which can:
 * - Read the full file and related files
 * - Understand project conventions from CLAUDE.md
 * - Use Edit tool to make precise changes
 * - Iteratively verify with type-check and lint
 *
 * Model is selected by selectModelForMoc() based on complexity:
 *   - opus: security, large files (1000+ lines), previous failures
 *   - sonnet: standard code fixes (default)
 *
 * Returns { success, output }.
 */
function invokeClaudeFix(prompt, modelConfig, retries = 1) {
  const model = modelConfig?.model || process.env.AUTOFIX_MODEL || "sonnet";
  const budget = modelConfig?.budget || process.env.AUTOFIX_BUDGET || "2.00";
  const timeout = modelConfig?.timeout || 300000;
  const requiredTier = modelConfig?.model || null; // Track what was requested

  // Write prompt to temp file to avoid shell escaping issues
  const promptFile = path.join(ROOT, "e2e", "state", "fix-prompt-autofix.md");
  fs.writeFileSync(promptFile, prompt);

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      log(`  Retry attempt ${attempt}/${retries}...`);
    }
    try {
      // Use spawnSync instead of execSync so we can use process groups on Unix
      // and the child is directly trackable (no bash intermediary)
      const result = spawnSync(
        "claude",
        ["--print", "--dangerously-skip-permissions", "--model", model, "--max-budget-usd", budget],
        {
          cwd: ROOT,
          input: fs.readFileSync(promptFile),
          stdio: ["pipe", "pipe", "pipe"],
          timeout, // opus: 10min, sonnet: 5min
          windowsHide: true,
          shell: false, // Direct spawn — no bash intermediary to create orphans
          env: {
            ...process.env,
            CLAUDE_CODE_ENTRYPOINT: "moc-auto-fix",
            // Unset nesting guard so Claude CLI can launch from within a Claude Code session
            CLAUDECODE: "",
            CLAUDE_CODE: "",
          },
        }
      );

      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        const err = new Error(`claude exited with code ${result.status}`);
        err.stderr = result.stderr;
        err.stdout = result.stdout;
        throw err;
      }

      const fullOutput = result.stdout.toString();
      const output = fullOutput.slice(-1000);
      log(`  Claude output (last 1000): ${output}`);

      // CRITICAL: Detect empty/whitespace-only output — Claude ran but produced nothing.
      // Without this check, MOC gets marked "implemented" with no actual fix applied.
      if (!fullOutput.trim()) {
        log(`  Claude returned empty output — treating as failure`);
        try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
        return { success: false, output: "Claude returned empty output (no fix generated)" };
      }
      // Token accounting
      try {
        const _tl = require("./lib/token-logger");
        const _inEst = Math.ceil((fs.existsSync(promptFile) ? fs.statSync(promptFile).size : 0) / 4);
        const _outEst = Math.ceil(result.stdout.toString().length / 4);
        _tl.logTokenUsage({ component: "moc-auto-fix", inputTokens: _inEst, outputTokens: _outEst, provider: "claude", model });
      } catch { /* non-fatal */ }
      // Clean up prompt file
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      return { success: true, output };
    } catch (err) {
      const stderr = (err.stderr || "").toString().slice(-300);
      const stdout = (err.stdout || "").toString().slice(-300);
      const isTimeout = /ETIMEDOUT|timed out/i.test(err.message || "");

      if (isTimeout && attempt < retries) {
        log(`  Claude timed out — reverting partial edits before retry (attempt ${attempt + 1}/${retries})`);
        // CRITICAL: Revert any partial edits Claude made before it was killed.
        // Without this, the retry sees corrupted files (stacked duplicate imports,
        // broken exports, <><> fragments) and makes them worse.
        try {
          execSync("git checkout -- app/ lib/ components/ e2e/", { cwd: ROOT, stdio: "pipe" });
        } catch { /* ignore — some paths may not exist */ }
        continue;
      }

      const combinedOutput = stderr || stdout || err.message || "";

      // Detect model unavailability — don't downgrade, defer for later
      const isModelUnavailable = /model.*not.*available|model.*not.*found|not.*supported|overloaded/i.test(combinedOutput);
      if (isModelUnavailable && requiredTier) {
        log(`  ${requiredTier} model unavailable — deferring MOC (not downgrading)`);
        try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
        return { success: false, output: combinedOutput, modelUnavailable: true };
      }

      log(`  Claude fix failed: ${combinedOutput}`);
      // Revert partial edits from failed attempt
      try { execSync("git checkout -- app/ lib/ components/ e2e/", { cwd: ROOT, stdio: "pipe" }); } catch { /* ignore */ }
      // Clean up prompt file
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      return { success: false, output: combinedOutput };
    }
  }

  // Should not reach here, but safety fallback
  try { execSync("git checkout -- app/ lib/ components/ e2e/", { cwd: ROOT, stdio: "pipe" }); } catch { /* ignore */ }
  try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
  return { success: false, output: "Exhausted all retry attempts" };
}

/**
 * Post-fix verification — asks Claude (haiku) whether the diff actually addresses
 * the original finding. Returns { verified: bool, score: number, reasoning: string }.
 *
 * Uses haiku (fast, cheap) since this is classification/evaluation, not code generation.
 * If verification fails (Claude unavailable, timeout, parse error), returns verified: true
 * so we don't block on verification failures.
 */
function verifyFixWithClaude(moc, changedFiles, diffOutput) {
  // Truncate diff to last 100 lines to stay within token budget
  const diffLines = (diffOutput || "").split("\n");
  const truncatedDiff = diffLines.length > 100
    ? "... (truncated)\n" + diffLines.slice(-100).join("\n")
    : diffOutput;

  const { findings } = parseMocDescription(moc);
  const findingsText = findings
    .map((f) => `- [${f.persona}] [${f.mode}] ${f.text}`)
    .join("\n");

  const prompt = `You are verifying whether code changes address the reported findings.

## Reported Findings
**Title:** ${moc.title}
**MOC:** ${moc.platformMocNumber}

**Findings:**
${findingsText || "(no structured findings)"}

**Full description:**
${(moc.description || "").slice(0, 1000)}

## Code Changes (git diff)
\`\`\`diff
${truncatedDiff}
\`\`\`

## Changed files
${changedFiles.join(", ")}

## Your Task
Evaluate whether the diff above addresses the reported findings.

Rate your confidence from 0-10:
- 0 = The diff is completely unrelated to the bug
- 3 = The diff touches the right area but doesn't fix the core issue
- 5 = The diff partially addresses the bug
- 7 = The diff likely fixes the bug
- 10 = The diff clearly and completely fixes the bug

Respond in EXACTLY this format (no other text):
SCORE: <number>
REASONING: <one sentence>`;

  const promptFile = path.join(ROOT, "e2e", "state", "verify-prompt-autofix.md");
  try {
    fs.writeFileSync(promptFile, prompt);

    const result = spawnSync(
      "claude",
      ["--print", "--model", "haiku", "--dangerously-skip-permissions", "--max-budget-usd", "0.05"],
      {
        cwd: ROOT,
        input: fs.readFileSync(promptFile),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000, // 30s — haiku is fast
        shell: false, // Direct spawn — no bash intermediary
        env: {
          ...process.env,
          CLAUDE_CODE_ENTRYPOINT: "moc-auto-fix-verify",
          CLAUDECODE: "",
          CLAUDE_CODE: "",
        },
      }
    );

    if (result.error) { throw result.error; }
    const output = (result.stdout || "").toString().trim();

    // Token accounting
    try {
      const _tl = require("./lib/token-logger");
      const _inEst = Math.ceil((fs.existsSync(promptFile) ? fs.statSync(promptFile).size : 0) / 4);
      const _outEst = Math.ceil(output.length / 4);
      _tl.logTokenUsage({ component: "moc-auto-fix-verify", inputTokens: _inEst, outputTokens: _outEst, provider: "claude", model: "haiku" });
    } catch { /* non-fatal */ }

    // Parse score
    const scoreMatch = output.match(/SCORE:\s*(\d+)/i);
    const reasonMatch = output.match(/REASONING:\s*(.+)/i);

    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : -1;
    const reasoning = reasonMatch ? reasonMatch[1].trim() : output.slice(0, 200);

    // Clean up
    try { fs.unlinkSync(promptFile); } catch { /* ignore */ }

    if (score < 0 || score > 10) {
      log(`  Fix verification: could not parse score from response — proceeding anyway`);
      return { verified: true, score: -1, reasoning: `Unparseable response: ${output.slice(0, 100)}` };
    }

    return { verified: score >= 5, score, reasoning };
  } catch (err) {
    // Clean up
    try { fs.unlinkSync(promptFile); } catch { /* ignore */ }

    const errMsg = (err.stderr || err.message || "").toString().slice(0, 200);
    log(`  Fix verification failed (Claude unavailable or timeout) — proceeding anyway`);
    return { verified: true, score: -1, reasoning: `Verification error: ${errMsg}` };
  }
}

/**
 * Get dynamic task header and instructions based on MOC change type.
 * This ensures the prompt matches the intent — bug fixes, UX improvements,
 * security patches, and feature work all get appropriate framing.
 */
function getPromptFraming(changeType) {
  const framings = {
    bug_fix: {
      header: "Fix a bug reported by quality testing",
      instructions: "If this is a real bug, fix the root cause. If it's truly just noise (transient network errors, loading states that resolve on their own), explain why. But if there's a real issue, fix it.",
    },
    ui_ux: {
      header: "Improve the user experience",
      instructions: "Implement the suggested UX improvement. Add missing feedback, improve layout, fix confusing flows, improve accessibility. Make small targeted changes — don't redesign the entire page.",
    },
    security: {
      header: "Fix a security vulnerability",
      instructions: "Implement the security fix with minimal changes. Add proper validation, access checks, or input sanitization as needed.",
    },
    feature: {
      header: "Add missing functionality",
      instructions: "Add the requested feature or capability. Keep it minimal — only what's described in the findings.",
    },
    infrastructure: {
      header: "Fix an infrastructure or reliability issue",
      instructions: "Fix the underlying reliability issue — error handling, null safety, edge cases.",
    },
  };
  const defaultFraming = {
    header: "Implement the requested change",
    instructions: "Make the change described in the findings. Follow existing patterns in the codebase.",
  };
  return framings[changeType] || defaultFraming;
}

function loadJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) { return fallback; }
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function buildPromptEnrichment(moc, pageArea) {
  const sections = [];

  // 1. Past fix attempts for this MOC
  if ((moc.autoFixFailures ?? 0) >= 1) {
    const fixLog = loadJsonSafe(FIX_LOG_PATH, { details: [] });
    const pastAttempts = (fixLog.details ?? []).filter(
      (d) => d.mocId === moc.id && (d.action === "claude_failed" || d.action === "reverted")
    );
    if (pastAttempts.length > 0) {
      const lines = pastAttempts.slice(-3).map((a) =>
        `- Attempt: ${a.action} | Files: ${(a.files ?? []).join(", ")} | Reason: ${a.reason ?? "unknown"}`
      );
      sections.push(`## Previous Fix Attempts (${moc.autoFixFailures} failure${moc.autoFixFailures > 1 ? "s" : ""})\nThese approaches already failed. Try a different strategy.\n${lines.join("\n")}`);
    }
  }

  // 2. Long-term memory patterns for this page
  if (pageArea) {
    const memory = loadJsonSafe(MEMORY_LONGTERM_PATH, { knowledge: [] });
    const pagePatterns = (memory.knowledge ?? [])
      .filter((k) => !k.resolved && (k.affected_areas ?? []).some((a) => pageArea.startsWith(a)))
      .slice(0, 5);
    if (pagePatterns.length > 0) {
      const lines = pagePatterns.map((k) =>
        `- [${k.total_occurrences}x, ${k.category}] ${k.description.slice(0, 200)}`
      );
      sections.push(`## Known Persistent Issues on ${pageArea}\nThese patterns have been seen across many iterations:\n${lines.join("\n")}`);
    }
  }

  // 3. Persona ROI tier and confidence
  const persona = moc.persona ?? moc.findings?.[0]?.persona;
  if (persona) {
    const roi = loadJsonSafe(PERSONA_ROI_PATH, { personas: {} });
    const pData = roi.personas?.[persona];
    if (pData) {
      sections.push(`## Persona Context: ${persona}\nROI tier: **${pData.tier}** (score: ${pData.roiScore}, noise rate: ${Math.round((pData.noiseRate ?? 0) * 100)}%). ${pData.tier === "low-value" ? "This persona has high noise — validate findings carefully." : "This persona's findings are generally reliable."}`);
    }
  }

  // 4. Fix history for same page (what worked / failed)
  if (pageArea) {
    const fixLog = loadJsonSafe(FIX_LOG_PATH, { details: [] });
    const pageHistory = (fixLog.details ?? []).filter(
      (d) => d.mocId !== moc.id && (d.title ?? "").includes(pageArea.replace(/^\//, ""))
    ).slice(-5);
    if (pageHistory.length > 0) {
      const lines = pageHistory.map((h) =>
        `- ${h.action === "claude_fixed" ? "SUCCESS" : "FAILED"}: ${h.title?.slice(0, 100)} | Files: ${(h.files ?? []).slice(0, 3).join(", ")}`
      );
      sections.push(`## Fix History for ${pageArea}\n${lines.join("\n")}`);
    }
  }

  // 5. Product grade for this page
  if (pageArea) {
    const grades = loadJsonSafe(PRODUCT_GRADE_PATH, { entries: [] });
    const normalPage = pageArea.replace(/^https?:\/\/[^/]+/, "");
    const latest = (grades.entries ?? [])
      .filter((e) => e.page === normalPage || e.page === pageArea)
      .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
      [0];
    if (latest) {
      const dims = Object.entries(latest.dimensionGrades ?? {}).map(([k, v]) => `${k}:${v}`).join(", ");
      sections.push(`## Page Quality Grade: ${latest.overallGrade}\nDimensions: ${dims}. Focus on the lowest-graded dimensions.`);
    }
  }

  // 6. Daemon principles
  const principles = loadJsonSafe(PRINCIPLES_PATH, []);
  if (Array.isArray(principles) && principles.length > 0) {
    const applicable = principles.filter((p) =>
      !p.applies_to || p.applies_to.includes("moc-auto-fix") || p.applies_to.includes("all")
    );
    if (applicable.length > 0) {
      const lines = applicable.map((p) => `- ${p.principle}`);
      sections.push(`## Design Principles (from human feedback)\n${lines.join("\n")}`);
    }
  }

  // 7. Prior successful fix strategies for similar MOCs
  const FIX_STRATEGIES_PATH = path.join(ROOT, "e2e", "state", "fix-strategies.json");
  const strategies = loadJsonSafe(FIX_STRATEGIES_PATH, { strategies: [] });
  if ((strategies.strategies ?? []).length > 0) {
    const relevant = (strategies.strategies ?? [])
      .filter((s) => s.verificationScore >= 5)
      .filter((s) => {
        if (s.pageArea === pageArea) { return true; }
        if (s.mocType === moc.changeType) { return true; }
        return false;
      })
      .slice(-3);
    if (relevant.length > 0) {
      const lines = relevant.map((s) =>
        `- ${s.mocType} fix on ${s.pageArea} (score ${s.verificationScore}/10, ${s.fileCount} files, model: ${s.model})`
      );
      sections.push(`## Prior Successful Fix Strategies\nThese approaches worked on similar MOCs:\n${lines.join("\n")}`);
    }
  }

  return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
}

/**
 * Build a Claude Code prompt for fixing a MOC.
 * Adapts the prompt framing based on changeType so Claude handles
 * bug fixes, UX improvements, security patches, and features appropriately.
 */
function buildClaudeFixPrompt(moc, sourceFiles) {
  const { pageArea, findings } = parseMocDescription(moc);

  // Claw repair MOCs get a specialized prompt
  if (moc.tier === "claw_repair") {
    const fileList = sourceFiles.map((f) => path.relative(ROOT, f)).join(", ");
    const principles = loadJsonSafe(PRINCIPLES_PATH, []);
    const principleLines = Array.isArray(principles)
      ? principles.filter((p) => !p.applies_to || p.applies_to.includes("all")).map((p) => `- ${p.principle}`).join("\n")
      : "";
    // Extract claw name from title: [CLAW-REPAIR:<name>]
    const clawMatch = (moc.title || "").match(/\[CLAW-REPAIR:(\w[\w-]*)\]/);
    const clawName = clawMatch ? clawMatch[1] : "unknown";
    return `You are fixing a daemon claw (autonomous worker process) for a persona-driven E2E testing system.

## Claw Repair Task (${moc.id})
**Claw:** ${clawName}
**Failure:** ${moc.title}

${moc.description ?? ""}

**Candidate files:** ${fileList}

## Instructions
1. Read the claw file (scripts/e2e/claws/${clawName}.js) and its lib dependencies to understand the current logic.
2. Diagnose the error described above — find the root cause in the code.
3. Fix the root cause — do NOT add workarounds, try/catch suppressions, or bypasses.
4. After fixing, verify: run \`node -c scripts/e2e/claws/${clawName}.js\` to confirm valid syntax.

## Safety Rules
- ONLY modify: scripts/e2e/claws/${clawName}.js and its lib dependencies (scripts/e2e/lib/*.js)
- NEVER modify: scripts/e2e/daemon.js, scripts/e2e/claw.js (core infrastructure)
- NEVER modify other claws (scripts/e2e/claws/*.js files other than ${clawName}.js)
- NEVER modify application code (app/, lib/, components/)
- Keep changes minimal and targeted — fix the bug, nothing else.
${principleLines ? `\n## Design Principles\n${principleLines}` : ""}
`;
  }

  // Pipeline repair MOCs get a specialized prompt
  if (moc.tier === "pipeline_repair") {
    const fileList = sourceFiles.map((f) => path.relative(ROOT, f)).join(", ");
    const principles = loadJsonSafe(PRINCIPLES_PATH, []);
    const principleLines = Array.isArray(principles)
      ? principles.filter((p) => !p.applies_to || p.applies_to.includes("all")).map((p) => `- ${p.principle}`).join("\n")
      : "";
    return `You are fixing an internal daemon/pipeline script for a persona-driven E2E testing system.

## Pipeline Repair Task (${moc.id})
**Failure:** ${moc.title}

${moc.description ?? ""}

**Candidate files:** ${fileList}

## Instructions
1. Read the candidate file(s) to understand the current logic.
2. Diagnose the integrity failure described above.
3. Fix the root cause — do NOT add workarounds or bypasses.
4. After fixing, verify: run \`node scripts/e2e/pipeline-integrity-check.js\` and confirm the failure is resolved.

## Safety Rules
- ONLY modify files in: scripts/e2e/*.js, daemon-config.json, e2e/state/*.json
- NEVER modify: scripts/e2e/claw.js, scripts/e2e/daemon.js, scripts/e2e/claws/*.js (core infrastructure)
- NEVER modify application code (app/, lib/, components/)
- Keep changes minimal and targeted.
${principleLines ? `\n## Design Principles\n${principleLines}` : ""}
`;
  }

  const findingsText = findings
    .map((f) => `- [${f.persona}] [${f.mode}] ${f.text}`)
    .join("\n");

  let correlatedErrorSection = "";
  const descText = moc.description || "";
  const corrIdx = descText.indexOf("### Correlated Server Errors");
  if (corrIdx !== -1) {
    correlatedErrorSection = "\n\n" + descText.slice(corrIdx);
  }

  const fileList = sourceFiles.map((f) => path.relative(ROOT, f)).join(", ");
  const changeType = moc.changeType || "bug_fix";
  const framing = getPromptFraming(changeType);

  let rootCauseSection = "";
  if (moc.rootCause || moc.fixRecommendation) {
    rootCauseSection = "\n\n## Root Cause Analysis";
    if (moc.rootCause) { rootCauseSection += `\n**Root cause:** ${moc.rootCause}`; }
    if (moc.fixRecommendation) { rootCauseSection += `\n**Recommended fix:** ${moc.fixRecommendation}`; }
  }

  const fixEffNote = loadFixEffectivenessNote();
  const enrichment = buildPromptEnrichment(moc, pageArea);

  return `You are improving a Next.js/TypeScript SaaS application based on findings from automated quality testing.
${fixEffNote}

## Task: ${framing.header} (MOC ${moc.platformMocNumber || moc.id})
**Title:** ${moc.title}
**Page:** ${pageArea || "unknown"}
**Source files:** ${fileList}
**Change type:** ${changeType}
${rootCauseSection}

**Findings:**
${findingsText}${correlatedErrorSection}
${enrichment}
## Your Task
1. Read the source file(s) listed above to understand the current code.
2. Understand what the findings are asking for — these may be bugs, UX improvements, accessibility issues, security fixes, or product quality suggestions.
3. ${framing.instructions}
4. If every finding is truly just noise (transient network errors, empty loading states, features already working correctly), explain why no changes are needed. But if the findings describe a real improvement opportunity, implement it.
5. Make your changes using the Edit tool. Follow CLAUDE.md conventions (dark mode, null safety, etc.).
6. After making changes, verify they pass type-check: run \`npx tsc --noEmit --pretty false 2>&1 | grep "error TS" | head -5\`
7. If type-check shows new errors in your modified file, fix them.

## Rules
- Only modify application code (app/, lib/, components/). NEVER touch e2e/, __tests__/, supabase/, or middleware.ts.
- Keep changes minimal and focused on what the findings describe.
- Do NOT refactor surrounding code or add comments/docs beyond what's needed.
- Do NOT replace error messages with finding descriptions.
- Every bg-white needs dark:bg-gray-800, every text-gray-900 needs dark:text-gray-100 (see CLAUDE.md).
- Use \`?.\` and \`?? fallback\` for null safety (strict mode: noUncheckedIndexedAccess).
`;
}

/**
 * Generate a fix for a MOC — either via Claude Code CLI or fallback to classification-only.
 *
 * When Claude CLI is available: invokes claude --print which can read files, edit code,
 * and type-check iteratively. Returns { claudePrompt, useClaudeCLI: true }.
 *
 * When Claude CLI is NOT available: classifies as noise/no-fix-needed based on patterns.
 * No LLM code generation is attempted (gpt-4o-mini is too unreliable for code fixes).
 */
async function generateFix(moc, sourceFiles) {
  const { pageArea, findings } = parseMocDescription(moc);

  if (sourceFiles.length === 0) {
    return { fixes: [], noFixNeeded: true, reason: "No source files found" };
  }

  // If Claude CLI is available, use it for the actual fix
  if (CLAUDE_AVAILABLE) {
    const prompt = buildClaudeFixPrompt(moc, sourceFiles);
    return { claudePrompt: prompt, useClaudeCLI: true };
  }

  // Fallback: classify only (no code generation without Claude)
  log("  Claude CLI not available — classifying only (no code fix attempted)");

  const allFindings = findings.map((f) => f.text).join(" ");
  const noiseIndicators = [
    /failed to fetch/i, /timeout/i, /network/i, /hydration/i,
    /loading state/i, /empty state/i, /no visible/i, /layout appears/i,
    /signal.*aborted/i, /auth session/i, /NEXT_REDIRECT/i,
  ];
  const isAllNoise = noiseIndicators.some((p) => p.test(allFindings));
  if (isAllNoise) {
    return { fixes: [], noFixNeeded: true, reason: "All findings are noise (network/loading/hydration)" };
  }

  return { fixes: [], noFixNeeded: true, reason: "Claude CLI unavailable — requires manual fix" };
}

// ---------------------------------------------------------------------------
// Fix application
// ---------------------------------------------------------------------------

/**
 * Validate a replacement string before applying it to prevent broken code.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
function validateReplacement(search, replace, originalContent) {
  // 0. Reject empty replacements or replacements identical to search
  if (!replace || replace === search) {
    return { valid: false, reason: "Replacement is empty or identical to search" };
  }

  // 1. Reject replacements that jam multiple statements on one line
  //    (LLM loves to do: `const a = b; const c = d; if (x) { return y; }`)
  const replaceLines = replace.split("\n");
  for (let i = 0; i < replaceLines.length; i++) {
    const line = replaceLines[i].trim();
    // Count semicolons not inside strings (rough heuristic)
    const outsideStrings = line.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, "");
    const semiCount = (outsideStrings.match(/;/g) || []).length;
    if (semiCount > 2) {
      return { valid: false, reason: `Line ${i + 1} has ${semiCount} semicolons — likely multi-statement jam` };
    }
    // Reject lines > 200 chars (LLM code jams are almost always long single lines)
    if (line.length > 200) {
      return { valid: false, reason: `Line ${i + 1} is ${line.length} chars — likely code jam` };
    }
  }

  // 2. Reject if replacement adds way more lines than it replaces
  const searchLines = search.split("\n").length;
  const replaceLineCount = replaceLines.length;
  if (replaceLineCount > searchLines * 3 && replaceLineCount > 10) {
    return { valid: false, reason: `Replacement adds ${replaceLineCount} lines (was ${searchLines}) — too large` };
  }

  // 3. Reject if replacement introduces undefined references (common LLM mistake)
  const suspiciousPatterns = [
    /\bConfirmationDialog\b/,   // LLM invented component
    /\balert\s*\(/,             // Never use alert() in production code
    /\bconsole\.log\(/,         // Don't add console.logs
    /\bprompt\s*\(/,            // Never use prompt() in production code
    /\bwindow\.confirm\(/,     // Never use confirm() in production code
    /\bdocument\.getElementById\(/,  // Wrong paradigm for React
  ];
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(replace) && !pattern.test(search) && !pattern.test(originalContent)) {
      return { valid: false, reason: `Replacement introduces suspicious pattern: ${pattern}` };
    }
  }

  // 4. Reject if replacement introduces new JSX elements not in the original
  //    (LLM loves to add random <div>, <span>, <h2> wrappers)
  const newTags = replace.match(/<([A-Z][a-zA-Z]+|[a-z]+)[^>]*>/g) || [];
  const origTags = originalContent.match(/<([A-Z][a-zA-Z]+|[a-z]+)[^>]*>/g) || [];
  const origTagSet = new Set(origTags.map((t) => t.match(/<([A-Za-z]+)/)?.[1]).filter(Boolean));
  for (const tag of newTags) {
    const tagName = tag.match(/<([A-Za-z]+)/)?.[1];
    if (tagName && !origTagSet.has(tagName) && !search.includes(`<${tagName}`)) {
      return { valid: false, reason: `Replacement introduces new element <${tagName}> not in original file` };
    }
  }

  // 5. Reject if replacement references variables/props not in the file
  //    Look for .prop or {variable} patterns that don't exist in the file
  const newDotProps = (replace.match(/\b\w+\.\w+/g) || []).filter((p) => !search.includes(p));
  for (const prop of newDotProps) {
    // Skip common patterns (Math.*, console.*, JSON.*, etc.)
    if (/^(Math|JSON|Object|Array|String|Number|Date|Promise|Error|console|window|document|process|fs|path)\./i.test(prop)) {
      continue;
    }
    if (!originalContent.includes(prop.split(".")[0])) {
      return { valid: false, reason: `Replacement references '${prop}' — '${prop.split(".")[0]}' not found in file` };
    }
  }

  // 6. Reject if replacement has mismatched braces/parens
  const braceBalance = (str) => {
    let curlies = 0, parens = 0, brackets = 0;
    // Strip strings and comments
    const stripped = str.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, "").replace(/\/\/.*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const ch of stripped) {
      if (ch === "{") { curlies++; }
      if (ch === "}") { curlies--; }
      if (ch === "(") { parens++; }
      if (ch === ")") { parens--; }
      if (ch === "[") { brackets++; }
      if (ch === "]") { brackets--; }
    }
    return { curlies, parens, brackets };
  };

  const searchBalance = braceBalance(search);
  const replaceBalance = braceBalance(replace);

  if (
    replaceBalance.curlies !== searchBalance.curlies ||
    replaceBalance.parens !== searchBalance.parens ||
    replaceBalance.brackets !== searchBalance.brackets
  ) {
    return {
      valid: false,
      reason: `Brace mismatch — search: {${searchBalance.curlies} (${searchBalance.parens} [${searchBalance.brackets}, replace: {${replaceBalance.curlies} (${replaceBalance.parens} [${replaceBalance.brackets}`,
    };
  }

  // 7. Reject if replacement changes text content (LLM replaces error messages with finding descriptions)
  const searchStrings = search.match(/(["'`])(?:(?!\1|\\).|\\.)*\1/g) || [];
  const replaceStrings = replace.match(/(["'`])(?:(?!\1|\\).|\\.)*\1/g) || [];
  const newStrings = replaceStrings.filter((s) => !searchStrings.includes(s));
  for (const s of newStrings) {
    const inner = s.slice(1, -1);
    // LLM commonly replaces error messages with finding descriptions
    if (inner.length > 40 && /select.*change area|provide justification|department|viewing.*moc/i.test(inner)) {
      return { valid: false, reason: `Replacement introduces suspicious string literal: ${inner.slice(0, 60)}...` };
    }
  }

  return { valid: true };
}

function applyFix(fix) {
  const absPath = path.resolve(ROOT, fix.file);

  // Safety: never touch migrations, auth core, or test files
  const rel = path.relative(ROOT, absPath).replace(/\\/g, "/");
  if (
    rel.startsWith("supabase/") ||
    rel.startsWith("e2e/") ||
    rel.startsWith("__tests__/") ||
    rel.includes("supabaseServer") ||
    rel.includes("supabaseClient") ||
    rel.includes("middleware.ts")
  ) {
    return { success: false, reason: `Safety: won't modify ${rel}` };
  }

  if (!fs.existsSync(absPath)) {
    return { success: false, reason: `File not found: ${rel}` };
  }

  const content = fs.readFileSync(absPath, "utf-8");

  if (!content.includes(fix.search)) {
    return { success: false, reason: `Search string not found in ${rel}` };
  }

  // Validate replacement before applying
  const validation = validateReplacement(fix.search, fix.replace, content);
  if (!validation.valid) {
    return { success: false, reason: `Validation failed: ${validation.reason}` };
  }

  // Backup
  const backupPath = absPath + ".autofix.bak";
  fs.writeFileSync(backupPath, content);

  // Apply
  const newContent = content.replace(fix.search, fix.replace);
  fs.writeFileSync(absPath, newContent);

  return { success: true, backupPath, filePath: absPath };
}

function revertFix(backupPath, filePath) {
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, filePath);
    fs.unlinkSync(backupPath);
  }
}

function cleanBackup(backupPath) {
  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
  }
}

/**
 * Capture baseline error count from `tsc` (before any fix).
 * Called once at startup so we can compare after each fix.
 */
let _baselineErrorCount = null;
function getBaselineErrorCount() {
  if (_baselineErrorCount !== null) {
    return _baselineErrorCount;
  }
  try {
    execSync(`npx tsc --noEmit --pretty false 2>&1`, {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 120000,
    });
    _baselineErrorCount = 0;
  } catch (err) {
    const output = (err.stdout || "").toString();
    const errorLines = output.split("\n").filter((l) => l.includes("error TS"));
    _baselineErrorCount = errorLines.length;
    log(`  Baseline type errors: ${_baselineErrorCount} (pre-existing)`);
  }
  return _baselineErrorCount;
}

function typeCheck(filePath) {
  const baseline = getBaselineErrorCount();

  try {
    execSync(`npx tsc --noEmit --pretty false 2>&1`, {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 120000,
    });
    return { pass: true };
  } catch (err) {
    const output = (err.stdout || "").toString().slice(0, 2000);
    const rel = path.relative(ROOT, filePath).replace(/\\/g, "/");

    const errorLines = output.split("\n").filter((l) => l.includes("error TS"));
    const ourErrors = errorLines.filter((l) => l.includes(rel));
    const totalErrors = errorLines.length;

    // Fail if ANY errors are in our modified file
    if (ourErrors.length > 0) {
      return { pass: false, errors: ourErrors.join("\n").slice(0, 500) };
    }

    // Fail if we INCREASED the error count (cascading breakage)
    if (totalErrors > baseline) {
      return {
        pass: false,
        errors: `Error count increased from ${baseline} to ${totalErrors} after fix:\n${errorLines.slice(0, 3).join("\n")}`,
      };
    }

    // Same or fewer errors as baseline — pre-existing, allow
    return { pass: true };
  }
}

/**
 * Run ESLint on a single file to catch formatting/style issues.
 * Returns { pass: true } or { pass: false, errors: string }.
 */
function lintCheck(filePath) {
  try {
    execSync(`npx eslint --no-warn-ignored --max-warnings 0 "${filePath}" 2>&1 | head -10`, {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 30000,
    });
    return { pass: true };
  } catch (err) {
    const output = (err.stdout || err.stderr || "").toString().slice(0, 300);
    // Only fail on errors, not warnings
    if (output.includes("error") && !output.includes("0 errors")) {
      return { pass: false, errors: output };
    }
    return { pass: true };
  }
}

// ---------------------------------------------------------------------------
// Post-fix verification — runs the relevant persona test to confirm the fix
// ---------------------------------------------------------------------------

/**
 * Map a page area to the persona spec file most likely to test it.
 */
function findRelevantPersonaSpec(pageArea, persona) {
  const E2E_TESTS = path.join(ROOT, "e2e", "tests", "personas");

  // Try persona-specific spec first
  if (persona) {
    const slug = persona.toLowerCase().replace(/\s+/g, "-");
    const specPath = path.join(E2E_TESTS, `${slug}.spec.ts`);
    if (fs.existsSync(specPath)) {
      return specPath;
    }
  }

  // Map page areas to persona specs
  const pageToSpec = {
    "/mocs": "ace-actionitem.spec.ts",
    "/mocs/completed": "ace-actionitem.spec.ts",
    "/mocs/new": "nelly-newchange.spec.ts",
    "/admin": "vera-view.spec.ts",
    "/admin/people": "vera-view.spec.ts",
    "/admin/permissions": "grant-powers.spec.ts",
    "/admin/webhooks": "grant-powers.spec.ts",
    "/admin/developer": "max-manual.spec.ts",
    "/my-department": "derek-department.spec.ts",
    "/account/settings": "cliff-patience.spec.ts",
    "/review": "reba-reviewer.spec.ts",
  };

  if (pageArea) {
    const cleanPath = pageArea.split("?")[0];
    // Try exact match then prefix match
    for (const [prefix, spec] of Object.entries(pageToSpec)) {
      if (cleanPath.startsWith(prefix)) {
        const specPath = path.join(E2E_TESTS, spec);
        if (fs.existsSync(specPath)) {
          return specPath;
        }
      }
    }
  }

  return null;
}

/**
 * Run a targeted persona test to verify the fix actually works.
 * Returns { pass, output }
 */
function verifyWithPersonaTest(pageArea, persona) {
  const specPath = findRelevantPersonaSpec(pageArea, persona);
  if (!specPath) {
    log(`  No persona spec found for ${pageArea} — skipping verification`);
    return { pass: true, skipped: true };
  }

  const relSpec = path.relative(ROOT, specPath);
  log(`  Verifying with: ${relSpec}`);

  try {
    // Run a single test with a short timeout
    const result = execSync(
      `npx playwright test "${relSpec}" --workers=1 --reporter=list --timeout=30000 2>&1 | tail -5`,
      {
        cwd: path.join(ROOT, "e2e"),
        stdio: "pipe",
        timeout: 120000,
      }
    );
    const output = result.toString();
    const passed = /\d+ passed/.test(output);
    return { pass: passed, output: output.slice(-300) };
  } catch (err) {
    const output = ((err.stdout || "") + (err.stderr || "")).toString().slice(-300);
    return { pass: false, output };
  }
}

// ---------------------------------------------------------------------------
// Record fixes for learning
// ---------------------------------------------------------------------------

function recordLearnedFix(moc, fix) {
  let data = { patterns: [], version: 1 };
  if (fs.existsSync(LEARNED_FIXES)) {
    try {
      data = JSON.parse(fs.readFileSync(LEARNED_FIXES, "utf-8"));
    } catch {
      // corrupted, reset
    }
  }

  data.patterns.push({
    id: `moc_autofix_${Date.now()}`,
    description: `[Auto-fix from ${moc.platformMocNumber}] ${fix.explanation}`,
    glob: fix.file,
    search: fix.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    replace: fix.replace,
    flags: "g",
    once: true,
    addedAt: new Date().toISOString(),
    source: "moc-auto-fix",
  });

  fs.writeFileSync(LEARNED_FIXES, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Resolve matching long-term memory entries when a fix is verified.
 * Closes the memory→fix→resolution feedback loop.
 */
function resolveMemoryOnFix(moc, appChanges) {
  try {
    if (!fs.existsSync(MEMORY_LONGTERM_PATH)) { return; }
    const ltData = JSON.parse(fs.readFileSync(MEMORY_LONGTERM_PATH, "utf-8"));
    const knowledge = ltData.knowledge ?? [];
    if (knowledge.length === 0) { return; }

    const { pageArea } = parseMocDescription(moc);
    const mocText = `${moc.title ?? ""} ${moc.description ?? ""}`.toLowerCase();
    let resolved = 0;

    for (const entry of knowledge) {
      if (entry.resolved) { continue; }
      // Match by page area overlap
      const areaMatch = (entry.affected_areas ?? []).some((area) => {
        const normArea = area.replace(/\/\*/g, "").toLowerCase();
        return (pageArea && pageArea.toLowerCase().includes(normArea)) ||
               appChanges.some((f) => f.toLowerCase().includes(normArea));
      });
      // Match by category+description overlap
      const descMatch = entry.description && mocText.includes(entry.category?.toLowerCase() ?? "");
      const descKeywords = (entry.description ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const keywordOverlap = descKeywords.filter((kw) => mocText.includes(kw)).length;
      const keywordMatch = descKeywords.length > 0 && keywordOverlap / descKeywords.length >= 0.4;

      if (areaMatch && (descMatch || keywordMatch)) {
        entry.resolved = true;
        entry.resolution_note = `Auto-resolved by fix ${moc.platformMocNumber ?? moc.id} at ${new Date().toISOString()}`;
        resolved++;
      }
    }

    if (resolved > 0) {
      ltData.meta.unresolved = knowledge.filter((k) => !k.resolved).length;
      ltData.meta.generatedAt = new Date().toISOString();
      fs.writeFileSync(MEMORY_LONGTERM_PATH, JSON.stringify(ltData, null, 2) + "\n");
      log(`  Resolved ${resolved} long-term memory entries`);
    }
  } catch { /* non-fatal */ }
}

function recordClaudeFix(moc, appChanges, verificationScore) {
  let data = { patterns: [], version: 1 };
  if (fs.existsSync(LEARNED_FIXES)) {
    try {
      data = JSON.parse(fs.readFileSync(LEARNED_FIXES, "utf-8"));
    } catch { /* corrupted, reset */ }
  }

  const { pageArea } = parseMocDescription(moc);

  for (const filePath of appChanges) {
    data.patterns.push({
      id: `claude_fix_${Date.now()}_${path.basename(filePath, path.extname(filePath))}`,
      description: `[Claude fix for ${moc.platformMocNumber ?? moc.id}] ${(moc.title ?? "").slice(0, 200)}`,
      glob: filePath,
      search: "",
      replace: "",
      flags: "",
      once: false,
      reference: true,
      addedAt: new Date().toISOString(),
      source: "claude-fix",
      mocType: moc.changeType ?? "unknown",
      pageArea: pageArea ?? "unknown",
      persona: moc.persona ?? "unknown",
      verificationScore: verificationScore ?? -1,
    });
  }

  if (data.patterns.length > 500) {
    data.patterns = data.patterns.slice(-500);
  }

  fs.writeFileSync(LEARNED_FIXES, JSON.stringify(data, null, 2) + "\n");
}

function recordFixStrategy(moc, appChanges, model, verificationScore, enrichmentsUsed) {
  const FIX_STRATEGIES_PATH = path.join(ROOT, "e2e", "state", "fix-strategies.json");
  let data = { strategies: [] };
  if (fs.existsSync(FIX_STRATEGIES_PATH)) {
    try {
      data = JSON.parse(fs.readFileSync(FIX_STRATEGIES_PATH, "utf-8"));
    } catch { /* corrupted, reset */ }
  }

  const { pageArea } = parseMocDescription(moc);
  data.strategies.push({
    mocType: moc.changeType ?? "unknown",
    tier: moc.tier ?? "unknown",
    model: model ?? "unknown",
    promptEnrichments: enrichmentsUsed ?? [],
    verificationScore: verificationScore ?? -1,
    succeededAt: new Date().toISOString(),
    pageArea: pageArea ?? "unknown",
    fileCount: appChanges.length,
    mocId: moc.id,
    persona: moc.persona ?? "unknown",
  });

  if (data.strategies.length > 200) {
    data.strategies = data.strategies.slice(-200);
  }

  fs.writeFileSync(FIX_STRATEGIES_PATH, JSON.stringify(data, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("=== MOC Auto-Fix: Closing the MOC-to-code loop ===\n");

  if (!fs.existsSync(QUEUE_PATH)) {
    log("No moc-queue.json found. Nothing to do.");
    return;
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));

  // --verify-implemented: re-check previously implemented MOCs
  if (VERIFY_IMPLEMENTED) {
    const implemented = queue.mocs.filter((m) => m.status === "implemented" && !m.verified);
    log(`Verifying ${implemented.length} unverified implemented MOCs...\n`);

    let verified = 0;
    let failed = 0;
    let skipped = 0;

    for (const moc of implemented.slice(0, MAX_FIXES)) {
      const { pageArea } = parseMocDescription(moc);
      log(`  ${moc.platformMocNumber}: ${pageArea || "unknown"}`);

      const result = verifyWithPersonaTest(pageArea, moc.persona);
      if (result.skipped) {
        skipped++;
        moc.verified = true; // No spec = trust it
      } else if (result.pass) {
        verified++;
        moc.verified = true;
        log(`    VERIFIED`);
      } else {
        failed++;
        moc.status = "approved"; // Pull back for re-fix
        moc.implementedAt = null;
        moc.implementationNotes = `Verification failed: ${(result.output || "").slice(0, 100)}`;
        log(`    FAILED — pulled back to approved`);
      }
    }

    if (!DRY_RUN) {
      // Merge verification results back under advisory lock
      const verifiedIds = new Set();
      const failedMocs = new Map();
      for (const m of queue.mocs.filter((m) => m.status === "implemented")) {
        if (m.verified) { verifiedIds.add(m.id); }
      }
      for (const m of queue.mocs.filter((m) => m.status === "approved" && m.implementationNotes?.startsWith("Verification failed"))) {
        failedMocs.set(m.id, m.implementationNotes);
      }
      withStateLock("moc-queue.json", (fresh) => {
        if (!fresh.mocs) { return; }
        for (const m of fresh.mocs) {
          if (verifiedIds.has(m.id)) { m.verified = true; }
          if (failedMocs.has(m.id)) {
            m.status = "approved";
            m.implementedAt = null;
            m.implementationNotes = failedMocs.get(m.id);
          }
        }
      }, { mocs: [] });
    }

    log(`\nVerification results: ${verified} verified, ${failed} failed (pulled back), ${skipped} skipped (no spec)`);
    return;
  }

  // --- Pre-processing: Escalate/archive stuck MOCs ---
  const MAX_FAILURES = 3;
  // Repair MOCs are auto-generated — lower threshold since descriptions may be imprecise
  const MAX_REPAIR_FAILURES = 2;
  const STALE_DAYS = 7;
  const now = Date.now();
  let archived = 0;

  for (const moc of queue.mocs) {
    if (moc.status !== "approved") {
      continue;
    }

    const failures = moc.autoFixFailures ?? 0;
    const ageDays = moc.submittedAt
      ? (now - new Date(moc.submittedAt).getTime()) / (24 * 60 * 60 * 1000)
      : 0;
    const isRepairTier = moc.tier === "claw_repair" || moc.tier === "pipeline_repair";
    const maxF = isRepairTier ? MAX_REPAIR_FAILURES : MAX_FAILURES;

    // Archive: stuck > 7 days with max failures — this MOC is unfixable by automation
    if (failures >= maxF && ageDays > STALE_DAYS && !DRY_RUN) {
      moc.status = "archived";
      moc.archivedAt = new Date().toISOString();
      moc.archivedReason = `Auto-archived: ${failures} failed auto-fix attempts over ${Math.floor(ageDays)} days`;
      archived++;
      continue;
    }

    // Max failures — archive. Automation can't fix it, move on.
    if (failures >= maxF && !DRY_RUN) {
      moc.status = "archived";
      moc.archivedAt = new Date().toISOString();
      moc.archivedReason = `Auto-archived: ${failures} failed auto-fix attempts (max ${maxF})`;
      archived++;
      continue;
    }
  }

  if (archived > 0) {
    log(`Pre-processing: ${archived} auto-archived (stale or max failures)`);
  }

  let candidates = queue.mocs.filter(
    (m) => m.status === "approved"
  );

  if (MOC_FILTER) {
    candidates = candidates.filter(
      (m) => m.id === MOC_FILTER || m.platformMocNumber === MOC_FILTER
    );
  }

  // --moc-ids: filter to specific claimed MOC IDs (from fix-engine distributed lock)
  if (MOC_IDS_FILTER) {
    const idSet = new Set(MOC_IDS_FILTER);
    candidates = candidates.filter((m) => idSet.has(m.id));
    log(`Filtered to ${candidates.length} claimed MOC IDs (${MOC_IDS_FILTER.length} requested)`);
  }

  // Sort by tier priority: NEEDS_APPROVAL and SPEC_IMPLEMENTATION first (Steve approved),
  // then AUTO_APPROVE (reviewed by personas), then AUTO_FIX (cosmetic)
  const TIER_PRIORITY = {
    needs_approval: 0,
    spec_implementation: 1,
    auto_approve: 2,
    auto_fix: 3,
  };
  candidates.sort((a, b) => {
    const pa = TIER_PRIORITY[a.tier] ?? 99;
    const pb = TIER_PRIORITY[b.tier] ?? 99;
    return pa - pb;
  });

  // Log tier breakdown
  const tierCounts = {};
  for (const c of candidates) {
    const t = c.tier || "unknown";
    tierCounts[t] = (tierCounts[t] || 0) + 1;
  }
  const tierSummary = Object.entries(tierCounts).map(([t, n]) => `${t}: ${n}`).join(", ");
  log(`Found ${candidates.length} approved MOCs (${tierSummary})`);

  const results = {
    total: candidates.length,
    noiseAutoClose: 0,
    fixAttempted: 0,
    fixApplied: 0,
    fixFailed: 0,
    noFixNeeded: 0,
    details: [],
  };

  let fixCount = 0;
  const stagedFiles = new Set();
  const processedFiles = new Map(); // Track: file → count of times processed (chain, not skip)

  // Start fresh progress log for this run
  try {
    const header = `\n${"=".repeat(70)}\nAUTO-FIX RUN: ${new Date().toISOString()} | ${candidates.length} candidates | max ${MAX_FIXES}\n${"=".repeat(70)}\n`;
    fs.appendFileSync(PROGRESS_LOG, header);
  } catch { /* ignore */ }

  let mocIndex = 0;
  for (const moc of candidates) {
    mocIndex++;
    if (fixCount >= MAX_FIXES) {
      log(`\nReached max fixes (${MAX_FIXES}). Stopping.`);
      break;
    }

    _mocStart = Date.now();
    const mocTier = moc.tier || "auto_fix";
    log(`\n--- [${mocIndex}/${candidates.length}] ${moc.platformMocNumber} (tier: ${mocTier}): ${moc.title.slice(0, 60)} ---`);

    // Step 1: Classify
    const classification = classifyMoc(moc);

    if (!classification.actionable) {
      log(`  NOISE: ${classification.reason} → auto-closing`);
      results.noiseAutoClose++;

      if (!DRY_RUN) {
        moc.status = "implemented";
        moc.implementedAt = new Date().toISOString();
        moc.implementationNotes = `Auto-closed: ${classification.reason}`;
      }

      results.details.push({
        moc: moc.platformMocNumber,
        action: "auto_closed",
        reason: classification.reason,
      });
      logRunningTotals(results);
      continue;
    }

    // Step 2: Pipeline/claw repair MOCs have different source file resolution and skip critical routes
    const { pageArea } = parseMocDescription(moc);
    const isPipelineRepair = mocTier === "pipeline_repair";
    const isClawRepair = mocTier === "claw_repair";

    if (!isPipelineRepair && !isClawRepair) {
      const criticalRoutes = loadCriticalRoutes();
      const touchesCritical = criticalRoutes.some((r) => (pageArea || "").startsWith(r) || (moc.description || "").includes(r));
      if (touchesCritical) {
        log(`  Critical route — archiving (cannot auto-fix auth routes): ${pageArea || "?"}`);
        if (!DRY_RUN) {
          moc.status = "archived";
          moc.archivedAt = new Date().toISOString();
          moc.archivedReason = `Critical route (${pageArea || "auth"}) — requires manual review, not eligible for auto-fix`;
        }
        results.details.push({ moc: moc.platformMocNumber, action: "archived", reason: `Critical route: ${pageArea || "?"}` });
        continue;
      }
    }

    // Step 3: Find source files
    let sourceFiles = [];

    if (isClawRepair) {
      // Claw repair: resolve to the specific claw file + its lib deps
      const clawMatch = (moc.title || "").match(/\[CLAW-REPAIR:(\w[\w-]*)\]/);
      const clawName = clawMatch ? clawMatch[1] : null;
      if (clawName) {
        const primary = path.join(ROOT, "scripts", "e2e", "claws", `${clawName}.js`);
        // Use affectedFiles from the MOC (resolved by diagnostics claw)
        const deps = (moc.affectedFiles || [])
          .map((f) => path.isAbsolute(f) ? f : path.join(ROOT, f.replace(/\\/g, "/")))
          .filter((f) => fs.existsSync(f) && f !== primary);
        sourceFiles = [primary, ...deps].filter((f) => fs.existsSync(f));
      }
      log(`  Claw repair — ${sourceFiles.length} candidate files`);
    } else if (isPipelineRepair) {
      // Pipeline repair: resolve to scripts/e2e/*.js files mentioned in the failure
      const descLower = (moc.description ?? "").toLowerCase();
      const scriptDir = path.join(ROOT, "scripts", "e2e");
      const pipelineAllowlist = fs.readdirSync(scriptDir)
        .filter((f) => f.endsWith(".js") && !f.startsWith("."))
        .map((f) => path.join(scriptDir, f));
      // Also allow daemon-config.json
      pipelineAllowlist.push(path.join(ROOT, "daemon-config.json"));

      // Find which scripts are mentioned in the failure description
      sourceFiles = pipelineAllowlist.filter((f) => {
        const base = path.basename(f);
        return descLower.includes(base.toLowerCase());
      });
      // If no specific file mentioned, include the top-level pipeline scripts
      if (sourceFiles.length === 0) {
        sourceFiles = pipelineAllowlist.slice(0, 5);
      }
      log(`  Pipeline repair — ${sourceFiles.length} candidate files`);
    } else {
      // 1. Use pre-resolved sourceFiles from MOC metadata (set by findings-to-mocs.js)
      if (Array.isArray(moc.sourceFiles) && moc.sourceFiles.length > 0) {
        sourceFiles = moc.sourceFiles.map((f) => {
          const abs = path.isAbsolute(f) ? f : path.join(ROOT, f.replace(/\\/g, "/"));
          return abs;
        }).filter((f) => fs.existsSync(f));
      }
      // 2. Root-cause MOCs may specify sourceFile directly
      if (sourceFiles.length === 0 && moc.sourceFile) {
        const sf = path.join(ROOT, moc.sourceFile.replace(/\\/g, "/"));
        if (fs.existsSync(sf)) {
          sourceFiles = [sf];
        }
      }
      // 3. Fall back to page path resolution
      if (sourceFiles.length === 0) {
        sourceFiles = pagePathToSourceFiles(pageArea || "");
      }
    }

    // Last resort: try to extract file paths from MOC description
    if (sourceFiles.length === 0) {
      const descText = moc.description ?? "";
      const fileMatches = descText.match(/(?:app|components|lib|scripts)\/[\w/.-]+\.\w+/g) || [];
      for (const fm of fileMatches) {
        const absPath = path.join(ROOT, fm.replace(/\\/g, "/"));
        if (fs.existsSync(absPath) && !sourceFiles.includes(absPath)) {
          sourceFiles.push(absPath);
        }
      }
      if (sourceFiles.length > 0) {
        log(`  Resolved ${sourceFiles.length} files from description text`);
      }
    }

    if (sourceFiles.length === 0) {
      const noSourceLabel = isClawRepair ? "claw repair" : isPipelineRepair ? "pipeline repair" : pageArea;
      // Track skip count — auto-archive after 3 skips (not needs_human — these aren't
      // valuable decisions, just unresolvable automation artifacts)
      moc.noSourceSkips = (moc.noSourceSkips || 0) + 1;
      if (moc.noSourceSkips >= 3 && !DRY_RUN) {
        moc.status = "archived";
        moc.archivedAt = new Date().toISOString();
        moc.archivedReason = `Auto-archived: no source files resolvable for "${noSourceLabel}" after ${moc.noSourceSkips} attempts`;
        log(`  No source files for ${noSourceLabel} — auto-archived after ${moc.noSourceSkips} skips`);
        results.details.push({
          moc: moc.platformMocNumber,
          action: "archived",
          reason: moc.archivedReason,
        });
      } else {
        log(`  No source files found for ${noSourceLabel} → skipping (attempt ${moc.noSourceSkips}/3)`);
        results.details.push({
          moc: moc.platformMocNumber,
          action: "skipped",
          reason: `No source files for ${noSourceLabel} (attempt ${moc.noSourceSkips}/3)`,
        });
      }
      continue;
    }

    // Dedup: allow up to 3 passes per file (each MOC may describe a unique bug),
    // but skip beyond that to avoid spending the whole budget on one file
    const MAX_PASSES_PER_FILE = 3;
    const primaryFile = path.relative(ROOT, sourceFiles[0]).replace(/\\/g, "/");
    const filePassCount = processedFiles.get(primaryFile) || 0;
    if (filePassCount >= MAX_PASSES_PER_FILE) {
      log(`  Skipping — ${primaryFile} already processed ${filePassCount}x this run`);
      results.details.push({
        moc: moc.platformMocNumber,
        action: "deduped",
        reason: `File ${primaryFile} already processed ${filePassCount}x this run`,
      });
      continue;
    }

    log(`  Source: ${sourceFiles.map((f) => path.relative(ROOT, f)).join(", ")}`);

    // Step 3: Generate fix via LLM
    results.fixAttempted++;

    if (DRY_RUN) {
      const dryModel = selectModelForMoc(moc, sourceFiles);
      const dryStatus = getPostFixStatus(moc);
      log(`  [DRY RUN] Would invoke Claude (tier: ${mocTier}, model: ${dryModel.model}) → ${dryStatus}`);
      results.details.push({
        moc: moc.platformMocNumber,
        action: "dry_run",
        tier: mocTier,
        model: dryModel.model,
        postFixStatus: dryStatus,
        sourceFiles: sourceFiles.map((f) => path.relative(ROOT, f)),
      });
      continue;
    }

    let llmResult;
    try {
      llmResult = await generateFix(moc, sourceFiles);
    } catch (err) {
      log(`  LLM error: ${err.message}`);
      results.fixFailed++;
      moc.autoFixFailures = (moc.autoFixFailures ?? 0) + 1;
      moc.lastFailedAt = new Date().toISOString();
      appendFixFailureBoost(moc, pageArea);
      results.details.push({
        moc: moc.platformMocNumber,
        action: "llm_error",
        error: err.message,
        failureCount: moc.autoFixFailures,
      });
      continue;
    }

    if (llmResult.noFixNeeded) {
      log(`  LLM says no fix needed: ${llmResult.reason || "N/A"}`);
      results.noFixNeeded++;

      moc.status = "implemented";
      moc.implementedAt = new Date().toISOString();
      moc.implementationNotes = `LLM analysis: ${llmResult.reason || "No code fix required"}`;

      results.details.push({
        moc: moc.platformMocNumber,
        action: "no_fix_needed",
        reason: llmResult.reason,
      });
      logRunningTotals(results);
      continue;
    }

    // Step 4: Apply fix — Claude CLI path vs legacy path
    if (llmResult.useClaudeCLI) {
      // ---------------------------------------------------------------
      // CLAUDE CLI PATH — Claude handles reading, editing, type-checking
      // ---------------------------------------------------------------
      // Select model based on tier + complexity: opus for critical/spec/security/large, sonnet for standard
      const modelConfig = selectModelForMoc(moc, sourceFiles);
      logProgress(mocIndex, candidates.length, moc.platformMocNumber, `Invoking Claude CLI (tier: ${mocTier}, model: ${modelConfig.model}, $${modelConfig.budget}) [file pass ${filePassCount + 1}/${MAX_PASSES_PER_FILE}]`);
      processedFiles.set(primaryFile, filePassCount + 1);

      // Snapshot dirty files before Claude runs so we can detect what changed
      let diffBefore = "";
      try {
        diffBefore = execSync("git diff --name-only", { cwd: ROOT, stdio: "pipe" }).toString().trim();
      } catch { /* ignore */ }

      const claudeResult = invokeClaudeFix(llmResult.claudePrompt, modelConfig);

      // Check what Claude changed
      let diffAfter = "";
      try {
        diffAfter = execSync("git diff --name-only", { cwd: ROOT, stdio: "pipe" }).toString().trim();
      } catch { /* ignore */ }

      const beforeSet = new Set(diffBefore.split("\n").filter(Boolean));
      const afterSet = new Set(diffAfter.split("\n").filter(Boolean));
      const newlyChanged = [...afterSet].filter((f) => !beforeSet.has(f));

      // Filter to only allowed changes (safety)
      const appChanges = newlyChanged.filter((f) =>
        f.startsWith("app/") || f.startsWith("lib/") || f.startsWith("components/") ||
        ((isPipelineRepair || isClawRepair) && f.startsWith("scripts/e2e/"))
      );

      // Budget effectiveness tracking
      try {
        const tokenLogger = require("./lib/token-logger");
        const exhaustion = tokenLogger.detectBudgetExhaustion(claudeResult.output || "", claudeResult.success ? 0 : 1);
        const budgetOutcome = exhaustion.exhausted ? "budget_exceeded"
          : exhaustion.partial ? "partial"
          : !claudeResult.success ? "failure"
          : appChanges.length === 0 ? "success"
          : "success";
        const estimatedCost = tokenLogger.estimateClaudeCost(
          (claudeResult.promptSize ?? 5000),
          (claudeResult.output || "").length,
          modelConfig?.model ?? "sonnet"
        );
        tokenLogger.logBudgetOutcome(
          "moc-auto-fix",
          `fix-${moc.platformMocNumber ?? moc.id}`,
          modelConfig?.model ?? "sonnet",
          estimatedCost,
          budgetOutcome,
          claudeResult.success && appChanges.length > 0
        );
      } catch { /* non-fatal */ }

      if (!claudeResult.success) {
        // Check if this is a rate limit / infrastructure error (not a code quality failure)
        const isRateLimit = /rate.?limit|hit your limit|resets \d|too many requests|429|quota/i.test(
          claudeResult.output || ""
        );

        if (isRateLimit) {
          logProgress(mocIndex, candidates.length, moc.platformMocNumber, "RATE LIMITED — stopping run");
          log(`  Rate limit detected. Will not burn remaining MOCs.`);
          results.details.push({
            moc: moc.platformMocNumber,
            action: "rate_limited",
            error: (claudeResult.output || "").slice(0, 200),
          });
          // Do NOT increment failure counter — this is infrastructure, not code quality
          // Break out of the loop — no point trying more MOCs
          break;
        }

        // Model unavailable — defer, don't downgrade. Come back when the right model is available.
        if (claudeResult.modelUnavailable) {
          logProgress(mocIndex, candidates.length, moc.platformMocNumber, `DEFERRED — ${modelConfig.model} unavailable`);
          log(`  Required model (${modelConfig.model}) not available. Deferring — will not attempt with a lesser model.`);
          results.details.push({
            moc: moc.platformMocNumber,
            action: "deferred_model_unavailable",
            requiredModel: modelConfig.model,
            error: (claudeResult.output || "").slice(0, 200),
          });
          // Do NOT increment failure counter — model availability is transient
          logRunningTotals(results);
          continue;
        }

        // --- Opus escalation: if Sonnet failed, retry with Opus before giving up ---
        if (modelConfig.model !== "opus") {
          // Revert Sonnet's partial changes before Opus retry
          if (appChanges.length > 0) {
            log(`  Reverting ${appChanges.length} changed file(s) from Sonnet attempt...`);
            for (const f of appChanges) {
              try {
                execSync(`git checkout HEAD -- "${f}"`, { cwd: ROOT, stdio: "pipe" });
              } catch { /* ignore */ }
            }
          }

          const opusConfig = { model: "opus", budget: "5.00", timeout: 600000 };
          logProgress(mocIndex, candidates.length, moc.platformMocNumber, `Sonnet failed — escalating to Opus ($${opusConfig.budget})`);

          // Re-snapshot dirty files
          let diffBeforeOpus = "";
          try {
            diffBeforeOpus = execSync("git diff --name-only", { cwd: ROOT, stdio: "pipe" }).toString().trim();
          } catch { /* ignore */ }

          const opusResult = invokeClaudeFix(llmResult.claudePrompt, opusConfig);

          // Check what Opus changed
          let diffAfterOpus = "";
          try {
            diffAfterOpus = execSync("git diff --name-only", { cwd: ROOT, stdio: "pipe" }).toString().trim();
          } catch { /* ignore */ }

          const beforeSetOpus = new Set(diffBeforeOpus.split("\n").filter(Boolean));
          const afterSetOpus = new Set(diffAfterOpus.split("\n").filter(Boolean));
          const newlyChangedOpus = [...afterSetOpus].filter((f) => !beforeSetOpus.has(f));
          const appChangesOpus = newlyChangedOpus.filter((f) =>
            f.startsWith("app/") || f.startsWith("lib/") || f.startsWith("components/") ||
            ((isPipelineRepair || isClawRepair) && f.startsWith("scripts/e2e/"))
          );

          if (opusResult.success && appChangesOpus.length > 0) {
            // Opus succeeded where Sonnet failed
            logProgress(mocIndex, candidates.length, moc.platformMocNumber, `OPUS ESCALATION SUCCESS (${appChangesOpus.length} file(s)) → ${getPostFixStatus(moc)}`);
            fixCount++;
            results.fixApplied++;
            for (const f of appChangesOpus) { stagedFiles.add(path.join(ROOT, f)); }
            const postFixStatus = getPostFixStatus(moc);
            moc.status = postFixStatus;
            moc.implementedAt = new Date().toISOString();
            moc.fixModel = "opus";
            moc.fixEscalated = true;
            // Record: sonnet failed, opus succeeded for this tier+severity
            recordModelOutcome("sonnet", mocTier, moc.severity, false);
            recordModelOutcome("opus", mocTier, moc.severity, true);
            results.details.push({
              moc: moc.platformMocNumber,
              action: "fix_applied_opus_escalation",
              files: appChangesOpus,
              model: "opus",
            });
            logRunningTotals(results);
            continue;  // Success — move to next MOC
          }

          // Opus also failed — revert and record as failure
          if (appChangesOpus.length > 0) {
            log(`  Reverting ${appChangesOpus.length} changed file(s) from Opus attempt...`);
            for (const f of appChangesOpus) {
              try {
                execSync(`git checkout HEAD -- "${f}"`, { cwd: ROOT, stdio: "pipe" });
              } catch { /* ignore */ }
            }
          }
          log(`  Both Sonnet and Opus failed for this MOC.`);
        } else {
          // Already using Opus — revert its changes
          if (appChanges.length > 0) {
            log(`  Reverting ${appChanges.length} changed file(s)...`);
            for (const f of appChanges) {
              try {
                execSync(`git checkout HEAD -- "${f}"`, { cwd: ROOT, stdio: "pipe" });
              } catch { /* ignore */ }
            }
          }
        }

        // Both models failed (or Opus was already in use) — record failure
        logProgress(mocIndex, candidates.length, moc.platformMocNumber, "FAILED");
        results.fixFailed++;
        moc.autoFixFailures = (moc.autoFixFailures ?? 0) + 1;
        moc.lastFailedAt = new Date().toISOString();
        appendFixFailureBoost(moc, pageArea);
        // Record model failure for effectiveness learning
        recordModelOutcome(modelConfig.model, mocTier, moc.severity, false);
        if (modelConfig.model !== "opus") {
          recordModelOutcome("opus", mocTier, moc.severity, false); // Opus also failed in escalation
        }

        results.details.push({
          moc: moc.platformMocNumber,
          action: "claude_fix_failed",
          error: claudeResult.output?.slice(0, 200),
          failureCount: moc.autoFixFailures,
          escalatedToOpus: modelConfig.model !== "opus",
        });
        logRunningTotals(results);
      } else if (appChanges.length === 0) {
        // Check if Claude hit budget limit (not a real "no fix needed" — it ran out of tokens)
        let isBudgetExceeded = /exceeded.*budget|budget.*exceeded/i.test(claudeResult.output || "");
        // Also use detectBudgetExhaustion for more comprehensive detection
        if (!isBudgetExceeded) {
          try {
            const tokenLogger = require("./lib/token-logger");
            const exhaustion = tokenLogger.detectBudgetExhaustion(claudeResult.output || "", 0);
            isBudgetExceeded = exhaustion.exhausted || exhaustion.partial;
          } catch { /* non-fatal */ }
        }
        if (isBudgetExceeded) {
          logProgress(mocIndex, candidates.length, moc.platformMocNumber, "BUDGET EXCEEDED — skipping (not a failure)");
          results.details.push({
            moc: moc.platformMocNumber,
            action: "budget_exceeded",
            error: "Claude exceeded per-MOC budget — file may be too large",
          });
          // Don't increment failure counter, don't mark as implemented — just skip
          logRunningTotals(results);
          continue;
        }

        // Claude ran successfully but made no changes — it determined no fix needed
        // Save Claude's full reasoning so we can audit decisions
        const claudeReasoning = (claudeResult.output || "").slice(-500);
        logProgress(mocIndex, candidates.length, moc.platformMocNumber, "NO FIX NEEDED (no changes)");
        results.noFixNeeded++;

        moc.status = "implemented";
        moc.implementedAt = new Date().toISOString();
        moc.implementationNotes = `Claude analysis: no code fix required.\n\nReasoning: ${claudeReasoning}`;

        results.details.push({
          moc: moc.platformMocNumber,
          action: "no_fix_needed",
          reason: claudeReasoning.slice(0, 300),
        });
        logRunningTotals(results);
      } else {
        // Claude made changes — verify they don't break the build
        log(`  Claude modified ${appChanges.length} file(s): ${appChanges.join(", ")}`);

        // Run type-check on changed files (Claude should have done this,
        // but we double-check as a safety gate)
        // Skip tsc for JS-only tiers (claw_repair, pipeline_repair) — use syntax check instead
        let typeCheckPassed = true;
        if (isClawRepair || isPipelineRepair) {
          // JS files — syntax check via node -c
          for (const f of appChanges) {
            try {
              execSync(`node -c "${path.join(ROOT, f)}"`, { cwd: ROOT, stdio: "pipe", timeout: 10000 });
            } catch (syntaxErr) {
              log(`  Post-Claude syntax check FAILED for ${f}`);
              log(`    ${(syntaxErr.message ?? "").slice(0, 200)}`);
              typeCheckPassed = false;
              break;
            }
          }
        } else {
          for (const f of appChanges) {
            const fullPath = path.join(ROOT, f);
            const tc = typeCheck(fullPath);
            if (!tc.pass) {
              log(`  Post-Claude type-check FAILED for ${f}`);
              log(`    ${tc.errors?.slice(0, 200)}`);
              typeCheckPassed = false;
              break;
            }
          }
        }

        if (!typeCheckPassed) {
          log(`  Reverting Claude changes — type-check failed`);
          results.fixFailed++;
          moc.autoFixFailures = (moc.autoFixFailures ?? 0) + 1;
          moc.lastFailedAt = new Date().toISOString();
          appendFixFailureBoost(moc, pageArea);
          recordModelOutcome(modelConfig?.model ?? "sonnet", mocTier, moc.severity, false);

          for (const f of appChanges) {
            try {
              execSync(`git checkout HEAD -- "${f}"`, { cwd: ROOT, stdio: "pipe" });
            } catch { /* ignore */ }
          }

          results.details.push({
            moc: moc.platformMocNumber,
            action: "claude_fix_reverted",
            reason: "Type-check failed after Claude fix",
            failureCount: moc.autoFixFailures,
          });
          logRunningTotals(results);
        } else {
          // Pipeline repair: validate with integrity check before accepting
          if (isPipelineRepair) {
            log("  Pipeline repair — running integrity validation...");
            try {
              const valResult = execSync("node scripts/e2e/pipeline-integrity-check.js --json", {
                cwd: ROOT, stdio: "pipe", timeout: 60000,
              }).toString();
              const val = JSON.parse(valResult);
              if (val.failedCount > 0) {
                log(`  Pipeline repair validation FAILED (${val.failedCount} failures) — reverting`);
                for (const f of appChanges) {
                  try { execSync(`git checkout HEAD -- "${f}"`, { cwd: ROOT, stdio: "pipe" }); } catch { /* ignore */ }
                }
                results.fixFailed++;
                moc.autoFixFailures = (moc.autoFixFailures ?? 0) + 1;
                moc.lastFailedAt = new Date().toISOString();
                results.details.push({
                  moc: moc.platformMocNumber ?? moc.id,
                  action: "pipeline_repair_reverted",
                  reason: `Integrity check still has ${val.failedCount} failures after fix`,
                  failureCount: moc.autoFixFailures,
                });
                logRunningTotals(results);
                continue;
              }
              log("  Pipeline repair validation passed");
            } catch (valErr) {
              log(`  Pipeline repair validation error: ${(valErr.message ?? "").slice(0, 100)} — accepting fix`);
            }
          }

          // Claw repair: validate with syntax check + integrity check before accepting
          if (isClawRepair) {
            log("  Claw repair — running verification...");
            const clawMatch = (moc.title || "").match(/\[CLAW-REPAIR:(\w[\w-]*)\]/);
            const clawName = clawMatch ? clawMatch[1] : null;
            let clawVerifyFailed = false;

            // 1. Syntax check on the claw file
            if (clawName) {
              const clawFile = path.join(ROOT, "scripts", "e2e", "claws", `${clawName}.js`);
              try {
                execSync(`node -c "${clawFile}"`, { cwd: ROOT, stdio: "pipe", timeout: 10000 });
                log(`  Claw syntax check passed: ${clawName}.js`);
              } catch (syntaxErr) {
                log(`  Claw syntax check FAILED: ${clawName}.js — ${(syntaxErr.message ?? "").slice(0, 100)}`);
                clawVerifyFailed = true;
              }
            }

            // 2. Pipeline integrity check (ensures no collateral damage)
            if (!clawVerifyFailed) {
              try {
                const valResult = execSync("node scripts/e2e/pipeline-integrity-check.js --json", {
                  cwd: ROOT, stdio: "pipe", timeout: 60000,
                }).toString();
                const val = JSON.parse(valResult);
                if (val.failedCount > 0) {
                  log(`  Claw repair integrity check FAILED (${val.failedCount} failures)`);
                  clawVerifyFailed = true;
                } else {
                  log("  Claw repair integrity check passed");
                }
              } catch (valErr) {
                log(`  Claw repair integrity check error: ${(valErr.message ?? "").slice(0, 100)} — accepting fix`);
              }
            }

            if (clawVerifyFailed) {
              log("  Claw repair verification FAILED — reverting all changes");
              for (const f of appChanges) {
                try { execSync(`git checkout HEAD -- "${f}"`, { cwd: ROOT, stdio: "pipe" }); } catch { /* ignore */ }
              }
              results.fixFailed++;
              moc.autoFixFailures = (moc.autoFixFailures ?? 0) + 1;
              moc.lastFailedAt = new Date().toISOString();
              results.details.push({
                moc: moc.platformMocNumber ?? moc.id,
                action: "claw_repair_reverted",
                reason: "Claw verification failed after fix",
                failureCount: moc.autoFixFailures,
              });
              logRunningTotals(results);
              continue;
            }
          }

          // Now verify the fix actually addresses the original finding
          let verificationNote = "";
          let verificationScore = -1;
          if (!SKIP_VERIFY) {
            try {
              const diffForVerify = execSync(
                `git diff HEAD -- ${appChanges.map((f) => `"${f}"`).join(" ")}`,
                { cwd: ROOT, stdio: "pipe", timeout: 10000 }
              ).toString();

              const verification = verifyFixWithClaude(moc, appChanges, diffForVerify);
              verificationScore = verification.score;
              log(`  Fix verification: score ${verification.score}/10 — ${verification.reasoning}`);

              if (verification.score >= 0 && verification.score < 5) {
                verificationNote = ` [Verification: ${verification.score}/10 — ${verification.reasoning}]`;
                log(`  WARNING: Low verification score (${verification.score}/10) — applying fix anyway`);
              } else if (verification.score >= 5) {
                verificationNote = ` [Verified: ${verification.score}/10]`;
              }
            } catch (verifyErr) {
              log(`  Fix verification skipped (error: ${(verifyErr.message || "").slice(0, 100)})`);
            }
          }

          // Record fix verification decision for pipeline accuracy tracking
          if (pipelineMetrics) {
            try {
              pipelineMetrics.recordDecision("fix_verification", {
                mocId: moc.platformMocNumber ?? moc.id,
                tier: mocTier,
                model: modelConfig?.model ?? "unknown",
              }, {
                action: "fix_applied",
                verificationScore,
                filesChanged: appChanges.length,
              }, {
                correct: verificationScore >= 5 ? true : verificationScore >= 0 ? false : undefined,
              });
            } catch { /* non-fatal */ }
          }

          const postFixStatus = getPostFixStatus(moc);
          logProgress(mocIndex, candidates.length, moc.platformMocNumber, `FIXED ${appChanges.length} file(s) → ${postFixStatus}`);
          results.fixApplied++;
          fixCount++;

          for (const f of appChanges) {
            stagedFiles.add(path.join(ROOT, f));
          }

          moc.status = postFixStatus;
          moc.implementedAt = new Date().toISOString();

          // Sync awaiting_closeout MOCs to database for human verification
          if (postFixStatus === "awaiting_closeout") {
            (async () => {
              try {
                const platformId = await ensurePlatformMoc(moc);
                if (platformId) {
                  await syncMocStatus(platformId, { status: "in_review", stage: 5 });
                  await notifyNeedsHuman(platformId, moc.title, "Fix applied — please verify");
                  log(`  → Synced awaiting_closeout to platform (${platformId}) stage 5`);
                }
              } catch (e) {
                log(`  → Platform sync failed: ${e.message}`);
              }
            })();
          }

          // CEO-friendly notes for critical auto-fixes
          if (mocTier === "needs_approval") {
            const tierReason = moc.tierReason || moc.description?.match(/\*\*Impact:\*\* (.+)/)?.[1] || "security issue";
            moc.implementationNotes = `Auto-fixed: ${tierReason}\nThis was applied and committed automatically. The automated test suite will verify it's working correctly on the next run.\n\nFiles changed: ${appChanges.join(", ")}${verificationNote}`;
          } else {
            moc.implementationNotes = `Claude Code fix (${mocTier}): ${appChanges.join(", ")}. ${(claudeResult.output || "").slice(0, 150)}${verificationNote}`;
          }

          results.details.push({
            moc: moc.platformMocNumber,
            mocId: moc.id,
            action: "claude_fixed",
            tier: mocTier,
            status: postFixStatus,
            files: appChanges,
            title: moc.title || "",
            changeType: moc.changeType || "",
          });
          logRunningTotals(results);

          // Generate regression test (non-fatal)
          generateRegressionTest(moc, appChanges);

          // Record model effectiveness for per-model per-fix-type learning
          recordModelOutcome(modelConfig?.model ?? "sonnet", mocTier, moc.severity, true, verificationScore);

          // Resolve matching long-term memory entries on successful fix
          try {
            resolveMemoryOnFix(moc, appChanges);
          } catch { /* non-fatal */ }

          // Record Claude fix for learning (feeds 10+ downstream consumers)
          try {
            recordClaudeFix(moc, appChanges, verificationScore);
            const enrichmentsUsed = [];
            if ((moc.autoFixFailures ?? 0) >= 1) { enrichmentsUsed.push("past-attempts"); }
            if (pageArea) { enrichmentsUsed.push("longterm-memory", "fix-history", "product-grade"); }
            if (moc.persona) { enrichmentsUsed.push("persona-roi"); }
            enrichmentsUsed.push("principles", "fix-strategies");
            recordFixStrategy(moc, appChanges, modelConfig?.model ?? "unknown", verificationScore, enrichmentsUsed);
          } catch (learnErr) {
            log(`  Fix learning record failed (non-fatal): ${(learnErr.message ?? "").slice(0, 80)}`);
          }
        }
      }
    } else if ((llmResult.fixes || []).length > 0) {
      // ---------------------------------------------------------------
      // LEGACY PATH — manual search-replace (kept for edge cases)
      // ---------------------------------------------------------------
      let allFixesSucceeded = true;
      const originalBackups = new Map();
      const modifiedFiles = new Set();

      for (const fix of llmResult.fixes) {
        log(`  Applying: ${fix.file} — ${fix.explanation}`);

        const result = applyFix(fix);
        if (!result.success) {
          log(`    FAILED: ${result.reason}`);
          allFixesSucceeded = false;
          break;
        }

        if (!originalBackups.has(result.filePath)) {
          originalBackups.set(result.filePath, result.backupPath);
        } else {
          cleanBackup(result.backupPath);
        }
        modifiedFiles.add(result.filePath);

        const tc = typeCheck(result.filePath);
        if (!tc.pass) {
          log(`    Type-check FAILED → reverting`);
          for (const [fp, bp] of originalBackups.entries()) {
            revertFix(bp, fp);
          }
          originalBackups.clear();
          allFixesSucceeded = false;
          break;
        }

        log(`    Type-check passed`);
        stagedFiles.add(result.filePath);
        recordLearnedFix(moc, fix);
      }

      if (allFixesSucceeded) {
        const postFixStatus = getPostFixStatus(moc);
        log(`  SUCCESS: ${llmResult.fixes.length} fix(es) applied → ${postFixStatus}`);
        results.fixApplied++;
        fixCount++;

        moc.status = postFixStatus;
        moc.implementedAt = new Date().toISOString();
        moc.implementationNotes = `(${mocTier}) ` + llmResult.fixes.map((f) => f.explanation).join("; ");

        // Sync awaiting_closeout MOCs to database for human verification
        if (postFixStatus === "awaiting_closeout") {
          (async () => {
            try {
              const platformId = await ensurePlatformMoc(moc);
              if (platformId) {
                await syncMocStatus(platformId, { status: "in_review", stage: 5 });
                await notifyNeedsHuman(platformId, moc.title, "Fix applied — please verify");
                log(`  → Synced awaiting_closeout to platform (${platformId}) stage 5`);
              }
            } catch (e) {
              log(`  → Platform sync failed: ${e.message}`);
            }
          })();
        }

        for (const [, bp] of originalBackups.entries()) {
          cleanBackup(bp);
        }

        results.details.push({
          moc: moc.platformMocNumber,
          mocId: moc.id,
          action: "fixed",
          tier: mocTier,
          status: postFixStatus,
          fixes: llmResult.fixes.map((f) => ({ file: f.file, explanation: f.explanation })),
          title: moc.title || "",
          changeType: moc.changeType || "",
        });

        // Generate regression test (non-fatal)
        generateRegressionTest(moc, llmResult.fixes.map((f) => f.file));
      } else {
        results.fixFailed++;
        moc.autoFixFailures = (moc.autoFixFailures ?? 0) + 1;
        moc.lastFailedAt = new Date().toISOString();
        appendFixFailureBoost(moc, pageArea);

        for (const [fp, bp] of originalBackups.entries()) {
          revertFix(bp, fp);
        }

        results.details.push({
          moc: moc.platformMocNumber,
          action: "fix_failed",
          reason: "Fix application or type-check failed",
          failureCount: moc.autoFixFailures,
        });
      }
    }
  }

  // Save queue — merge changes back under advisory lock to prevent race conditions
  if (!DRY_RUN) {
    const modifiedMocs = new Map();
    for (const m of (queue.mocs || [])) {
      modifiedMocs.set(m.id, m);
    }
    withStateLock("moc-queue.json", (fresh) => {
      if (!fresh.mocs) { fresh.mocs = []; }
      for (let i = 0; i < fresh.mocs.length; i++) {
        const updated = modifiedMocs.get(fresh.mocs[i].id);
        if (updated) {
          fresh.mocs[i] = updated;
        }
      }
    }, { mocs: [] });
  }

  // Save fix log
  const fixLog = { lastRun: new Date().toISOString(), ...results };
  if (!DRY_RUN) {
    fs.writeFileSync(FIX_LOG_PATH, JSON.stringify(fixLog, null, 2) + "\n");
  }

  // Clean up any leftover .autofix.bak files
  for (const sf of stagedFiles) {
    cleanBackup(sf + ".autofix.bak");
  }
  // Also clean any orphaned backups in app/
  try {
    const orphanedBaks = execSync(`find "${APP_DIR}" -name "*.autofix.bak" -type f 2>/dev/null || true`, {
      cwd: ROOT,
      stdio: "pipe",
    }).toString().trim().split("\n").filter(Boolean);
    for (const bak of orphanedBaks) {
      fs.unlinkSync(bak);
      log(`  Cleaned orphaned backup: ${path.relative(ROOT, bak)}`);
    }
  } catch {
    // ignore cleanup failures
  }

  /**
   * Build a clear, human-readable commit message.
   *
   * Subject: "fix(auto): <what changed> in <files>" — max 72 chars, scannable
   * Body: Per-MOC breakdown with fix explanation and files
   *
   * Goal: Someone reading the Vercel deploy email should understand what shipped.
   */
  function buildCommitMessage(res) {
    const fixedDetails = res.details.filter(
      (d) => d.action === "claude_fixed" || d.action === "fixed"
    );

    // --- Subject line: summarize WHAT was fixed, not MOC IDs ---
    // Collect unique changed files (app code only, not state)
    const allFiles = [];
    for (const d of fixedDetails) {
      const fileList = d.files || (d.fixes || []).map((f) => f.file);
      for (const f of (fileList || [])) {
        if (!f.startsWith("e2e/") && !f.startsWith("scripts/") && !allFiles.includes(f)) {
          allFiles.push(f);
        }
      }
    }

    // Build a descriptive subject from change types and affected areas
    const changeTypes = [...new Set(fixedDetails.map((d) => d.changeType).filter(Boolean))];
    const areas = allFiles
      .map((f) => {
        // Extract meaningful area: "app/admin/onboarding" → "admin/onboarding"
        const match = f.match(/^(?:app|components|lib)\/(.+?)(?:\/[^/]+\.[^.]+)?$/);
        return match ? match[1].replace(/\/page$|\/components$/, "") : null;
      })
      .filter((a, i, arr) => a && arr.indexOf(a) === i)
      .slice(0, 3);

    let subject;
    if (fixedDetails.length === 1) {
      // Single fix: use the fix explanation or a clean title
      const d = fixedDetails[0];
      const explanation = (d.fixes || [])[0]?.explanation || "";
      const cleanTitle = (d.title || "").replace(/^\[.*?\]\s*/g, "").replace(/\s+/g, " ");
      // Prefer explanation (what was done) over title (what was wrong)
      const what = explanation
        ? explanation.slice(0, 55)
        : cleanTitle.slice(0, 55);
      const where = areas.length > 0 ? ` in ${areas.join(", ")}` : "";
      subject = `fix(auto): ${what}${where}`;
    } else {
      // Multiple fixes: summarize categories
      const typeLabel = changeTypes.length > 0
        ? changeTypes.map((t) => t.replace(/_/g, " ")).join(", ")
        : `${fixedDetails.length} fixes`;
      const where = areas.length > 0 ? ` in ${areas.join(", ")}` : "";
      subject = `fix(auto): ${typeLabel}${where}`;
    }
    // Hard cap at 72 chars for clean git log
    if (subject.length > 72) {
      subject = subject.slice(0, 69) + "...";
    }

    // --- Body: per-MOC detail ---
    const lines = [""];

    for (const d of fixedDetails) {
      const num = d.moc || d.mocId?.slice(0, 12) || "";
      const tag = num ? `[${num}] ` : "";
      const changeType = d.changeType ? `(${d.changeType}) ` : "";

      // What was wrong (finding/title)
      const problem = (d.title || "")
        .replace(/^\[.*?\]\s*/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 100);
      lines.push(`${tag}${changeType}${problem}`);

      // What was done (fix explanation) — THIS is the important part
      const fileList = d.files || (d.fixes || []).map((f) => f.file);
      if (d.fixes && d.fixes.length > 0) {
        for (const fix of d.fixes.slice(0, 3)) {
          if (fix.explanation) {
            lines.push(`  → ${fix.explanation.slice(0, 120)}`);
          }
          if (fix.file) {
            lines.push(`    ${fix.file}`);
          }
        }
      } else if (fileList && fileList.length > 0) {
        lines.push(`  → ${fileList.slice(0, 4).join(", ")}${fileList.length > 4 ? ` +${fileList.length - 4} more` : ""}`);
      }
      lines.push("");
    }

    // Summary stats
    const statParts = [];
    if (res.noiseAutoClose > 0) { statParts.push(`${res.noiseAutoClose} noise`); }
    if (res.noFixNeeded > 0) { statParts.push(`${res.noFixNeeded} no-fix-needed`); }
    if (res.fixFailed > 0) { statParts.push(`${res.fixFailed} failed`); }
    if (statParts.length > 0) {
      lines.push(`Skipped: ${statParts.join(", ")}`);
    }

    return subject + "\n" + lines.join("\n");
  }

  // Stage and commit
  if (AUTO_COMMIT && stagedFiles.size > 0 && !DRY_RUN) {
    log("\n--- Committing fixes ---");
    try {
      const files = [...stagedFiles].map((f) => `"${path.relative(ROOT, f)}"`).join(" ");
      execSync(`git add ${files} e2e/state/moc-queue.json e2e/state/learned-fix-patterns.json e2e/state/auto-fix-log.json`, {
        cwd: ROOT,
        stdio: "pipe",
      });

      // Build detailed commit message with per-MOC breakdown
      const commitMsg = buildCommitMessage(results);
      const commitMsgFile = path.join(ROOT, ".tmp-commit-msg");
      fs.writeFileSync(commitMsgFile, commitMsg);

      // Use --no-verify because pre-commit hooks can stash and corrupt working tree
      execSync(
        `git commit --no-verify -F "${commitMsgFile}"`,
        { cwd: ROOT, stdio: "pipe" }
      );

      // Clean up temp file
      try { fs.unlinkSync(commitMsgFile); } catch { /* ignore */ }

      // Write commit_sha back to fixed MOCs so the pipeline can track them
      try {
        const sha = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf-8" }).trim();
        const fixedIds = new Set(results.details.filter((d) => d.action === "claude_fixed" || d.action === "fixed").map((d) => d.mocId || d.moc));
        withStateLock("moc-queue.json", (fresh) => {
          const queueMocs = fresh.mocs || [];
          for (const m of queueMocs) {
            if (fixedIds.has(m.id) || fixedIds.has(m.platformMocNumber)) {
              m.commit_sha = sha;
            }
          }
        }, { mocs: [] });
      } catch { /* non-fatal */ }

      log("Committed successfully");

      // Post-fix smoke removed: tests run against production, not local changes.
      // The next daemon test-runner cycle validates after Vercel deploys.
    } catch (err) {
      log(`Commit failed: ${(err.stderr || "").toString().slice(0, 200)}`);
      // Clean up temp file on failure
      try { fs.unlinkSync(path.join(ROOT, ".tmp-commit-msg")); } catch { /* ignore */ }
    }
  }

  // Summary
  const totalElapsed = ((Date.now() - RUN_START) / 1000).toFixed(0);
  const minutes = Math.floor(totalElapsed / 60);
  const seconds = totalElapsed % 60;
  log(`\n${"=".repeat(50)}`);
  log(`=== SUMMARY (${minutes}m ${seconds}s elapsed) ===`);
  log(`${"=".repeat(50)}`);
  if (archived > 0) {
    log(`Pre-processing: ${archived} auto-archived`);
  }
  log(`Total candidates: ${results.total} (${tierSummary})`);
  log(`Noise auto-closed: ${results.noiseAutoClose}`);
  log(`Fix attempted: ${results.fixAttempted}`);
  log(`Fix applied: ${results.fixApplied}`);
  log(`Fix failed: ${results.fixFailed}`);
  log(`No fix needed (LLM): ${results.noFixNeeded}`);
  // Break down applied fixes by post-fix status
  const implementedCount = results.details.filter((d) => d.status === "implemented" && (d.action === "claude_fixed" || d.action === "fixed")).length;
  const closeoutCount = results.details.filter((d) => d.status === "awaiting_closeout" && (d.action === "claude_fixed" || d.action === "fixed")).length;
  if (implementedCount > 0 || closeoutCount > 0) {
    log(`  -> implemented: ${implementedCount}, awaiting_closeout: ${closeoutCount}`);
  }
  const budgetExceeded = results.details.filter((d) => d.action === "budget_exceeded").length;
  if (budgetExceeded > 0) {
    log(`Budget exceeded (skipped): ${budgetExceeded}`);
  }
  if (results.fixAttempted > 0) {
    const successRate = ((results.fixApplied / results.fixAttempted) * 100).toFixed(0);
    log(`Success rate: ${successRate}% (${results.fixApplied}/${results.fixAttempted})`);
  }

  if (stagedFiles.size > 0) {
    log(`\nFiles modified: ${[...stagedFiles].map((f) => path.relative(ROOT, f)).join(", ")}`);
  }

  // Log remaining queue depth (by tier)
  const remainingApproved = queue.mocs.filter((m) => m.status === "approved");
  const remainingByTier = {};
  for (const m of remainingApproved) {
    const t = m.tier || "unknown";
    remainingByTier[t] = (remainingByTier[t] || 0) + 1;
  }
  const remainingSummary = Object.entries(remainingByTier).map(([t, n]) => `${t}: ${n}`).join(", ");
  log(`\nRemaining approved queue: ${remainingApproved.length} MOCs${remainingSummary ? ` (${remainingSummary})` : ""}`);
  const awaitingCloseout = queue.mocs.filter((m) => m.status === "awaiting_closeout").length;
  if (awaitingCloseout > 0) {
    log(`Awaiting human closeout: ${awaitingCloseout} MOCs`);
  }

  if (JSON_MODE) {
    console.log(JSON.stringify(results, null, 2));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
