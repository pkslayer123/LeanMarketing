#!/usr/bin/env node

/**
 * findings-to-mocs.js -- Primary findings classifier and MOC pipeline.
 *
 * Findings are classified into four categories:
 *
 * 1. NOISE: Network drops, hydration, timeouts, test framework issues.
 *    -> NO MOC created. Finding auto-resolved as noise.
 *    -> Never enters the platform at all.
 *
 * 2. AUTO_FIX (low risk): Minor UI issues, stale selectors, cosmetic bugs.
 *    -> Creates MOC. Auto-approved and routed to fix queue.
 *    -> Goes straight to the auto-fix loop without full review.
 *
 * 3. AUTO_APPROVE (standard): Bugs, API errors, permission issues, vision defects.
 *    -> Creates full MOC. Departments auto-review.
 *    -> cp-meta.spec.ts handles full lifecycle advancement.
 *
 * 4. NEEDS_APPROVAL (critical): Security, BOLA, data isolation, spec conflicts,
 *    migrations, features that could modify BUILD-SPEC.
 *    -> Creates full MOC. Routes to management (Steve/Darren) for approval.
 *    -> cp-meta.spec.ts handles lifecycle; human approval required.
 *
 * This script replaces auto-triage for findings classification.
 * Auto-triage.js now only handles error_logs (--errors-only).
 *
 * Usage:
 *   node scripts/e2e/findings-to-mocs.js                     # Full conversion
 *   node scripts/e2e/findings-to-mocs.js --dry-run            # Preview only
 *   node scripts/e2e/findings-to-mocs.js --iteration 5        # Tag with iteration
 *   node scripts/e2e/findings-to-mocs.js --json               # Machine-readable output
 *   node scripts/e2e/findings-to-mocs.js --skip-dedup         # Skip semantic dedup
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { pagePathToSourceFiles, toRelativePaths } = require("./lib/page-to-source");
const { withStateLock } = require("./claw");

// Pipeline accuracy tracking
let pipelineMetrics;
try {
  pipelineMetrics = require("./lib/pipeline-metrics");
} catch { /* pipeline-metrics not available */ }

let _llmE2e = null;
function getLlmE2e() {
  if (_llmE2e) return _llmE2e;
  try {
    _llmE2e = require("./llm-e2e.js");
    return _llmE2e;
  } catch {
    return null;
  }
}

const ROOT = path.resolve(__dirname, "..", "..");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const SUBMITTED_TRACKER = path.join(ROOT, "e2e", "state", "moc-submitted-findings.json");
const QUEUE_PATH = path.join(ROOT, "e2e", "state", "moc-queue.json");
const ORACLE_FEEDBACK_PATH = path.join(ROOT, "e2e", "state", "oracle-feedback.jsonl");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const jsonOutput = args.includes("--json");
const skipDedup = args.includes("--skip-dedup");
const iterationIdx = args.indexOf("--iteration");
const iteration = iterationIdx !== -1 ? parseInt(args[iterationIdx + 1], 10) : null;

// Import submit-moc functions
const { submitMoc, CHANGE_TYPE_MAP, ROUTING_MAP } = require("./submit-moc.js");

// Import spec-change-guard for BUILD-SPEC protected section checks
let specGuard = null;
try {
  specGuard = require("./spec-change-guard.js");
} catch {
  // spec-change-guard not available — skip protected section checks
}

/** Cached protected sections from BUILD-SPEC.md (loaded once per run). */
let _cachedProtectedSections = null;
function getCachedProtectedSections() {
  if (_cachedProtectedSections !== null) { return _cachedProtectedSections; }
  if (!specGuard) { return {}; }
  try {
    _cachedProtectedSections = specGuard.getProtectedSections();
    return _cachedProtectedSections;
  } catch {
    _cachedProtectedSections = {};
    return {};
  }
}

/**
 * Check if a finding is from a vision/UI persona or describes a cosmetic issue.
 * Vision and cosmetic findings should never escalate to NEEDS_APPROVAL via spec-guard.
 */
function isVisionOrCosmeticFinding(finding) {
  const persona = (finding.persona ?? "").toLowerCase();
  const desc = (finding.description ?? finding.summary ?? "").toLowerCase();

  // Vision persona findings
  if (persona.startsWith("vision/") || persona.startsWith("[vision/") || persona.startsWith("vision-")) {
    return true;
  }
  // Known UI personas
  if (["daria-dark", "ally-access", "pete-performance", "dana-pixel"].some((p) => persona.includes(p))) {
    return true;
  }

  // Cosmetic keywords — these are never spec-breaking
  // Use specific compound terms to avoid false matches (e.g., "color" alone matches "color coding")
  const cosmeticPatterns = /\b(contrast\s*ratio|spacing\s*issue|alignment\s*off|dark\s*mode|layout\s*shift|visual\s*glitch|heading\s*missing|responsive\s*breakpoint|truncat(ed|ion)|z-index|font\s*size|text\s*color|background\s*color|padding\s*missing|margin\s*issue|border\s*radius|icon\s*missing|gradient\s*broken|shadow\s*missing|opacity\s*issue)\b/i;
  if (cosmeticPatterns.test(desc)) {
    return true;
  }

  return false;
}

/**
 * Check if a finding's page path touches a protected BUILD-SPEC section.
 * Maps the page path to feature areas, then checks if any have SME-protected decisions.
 */
function touchesProtectedSpec(finding) {
  if (!specGuard) { return false; }
  const page = finding.page ?? "";
  if (!page) { return false; }

  const protectedSections = getCachedProtectedSections();
  if (Object.keys(protectedSections).length === 0) { return false; }

  // Convert page path to approximate file path for mapping
  const cleanPath = page.replace(/^\/+/, "");
  const features = specGuard.mapFileToFeatures(`app/${cleanPath}/page.tsx`);

  for (const feature of features) {
    for (const section of Object.keys(protectedSections)) {
      if (section.includes(feature) || feature.includes(section.split(":")[0])) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tier classification: NOISE / AUTO_FIX / AUTO_APPROVE / NEEDS_APPROVAL
// ---------------------------------------------------------------------------

const TIERS = {
  NOISE: "noise",                // True noise — no MOC created, finding auto-resolved
  AUTO_FIX: "auto_fix",          // Low risk — MOC created, auto-approved, routed to fix queue
  AUTO_APPROVE: "auto_approve",  // Standard — full MOC with department auto-review
  NEEDS_APPROVAL: "needs_approval", // Critical — full MOC requiring human approval
};

// Noise patterns — findings matching these are resolved directly (NO MOC created)
const NOISE_PATTERNS = [
  { pattern: /network\s*(error|offline|failed\s*to\s*fetch)/i, reason: "Transient network error" },
  { pattern: /abort(ed)?.*signal/i, reason: "Request aborted (navigation)" },
  { pattern: /timed?\s*out|timeout/i, reason: "Timeout (transient)" },
  { pattern: /hydration.*mismatch/i, reason: "React hydration noise" },
  { pattern: /NEXT_REDIRECT/i, reason: "Next.js redirect mechanism" },
  { pattern: /long\s*task/i, reason: "Performance long task warning" },
  { pattern: /super_admin.*admin.*page.*visible/i, reason: "Super admins have admin access" },
  { pattern: /developer.*admin.*visible/i, reason: "Developers have full access" },
  { pattern: /got\s*405\s*instead\s*of\s*403/i, reason: "405 = method not allowed (correct)" },
  { pattern: /empty\s*state.*no\s*(mocs?|reviews?|items?)/i, reason: "Empty state is valid" },
  { pattern: /loading\s*(skeleton|spinner).*visible/i, reason: "Loading states are expected" },
  { pattern: /ResizeObserver/i, reason: "ResizeObserver loop (browser noise)" },
  { pattern: /refresh_token_not_found/i, reason: "Session expired (handled by auth)" },
  { pattern: /bad_jwt/i, reason: "Expired JWT (handled by auth)" },
];

// Auto-fix patterns — high-confidence bugs that bypass full review (auto-fixed)
const AUTO_FIX_PATTERNS = [
  { pattern: /dark\s*mode.*missing|missing.*dark:\s*class/i, reason: "Missing dark mode class (cosmetic)" },
  { pattern: /stale\s*selector|element.*not\s*found/i, reason: "Stale selector (test maintenance)" },
  { pattern: /missing\s*aria|aria-label.*missing/i, reason: "Missing accessibility attribute" },
  { pattern: /console\s*(error|warning).*(?!500|403|BOLA)/i, reason: "Console warning (non-critical)" },
  { pattern: /text\s*truncat|overflow.*hidden.*text/i, reason: "Text truncation (cosmetic)" },
  { pattern: /placeholder.*generic|placeholder.*lorem/i, reason: "Placeholder text (cosmetic)" },
  { pattern: /z-index|overlap|layer/i, reason: "Z-index / layering issue (cosmetic)" },
  // High-confidence bugs — auto-fix without review
  { pattern: /500\s*(error|status|internal)/i, reason: "Server 500 error (auto-fix)" },
  { pattern: /API\s*(error|failure|returned?\s*error)/i, reason: "API error (auto-fix)" },
  { pattern: /null\s*reference|undefined\s*is\s*not|cannot\s*read\s*propert/i, reason: "Null/undefined error (auto-fix)" },
  { pattern: /missing\s*null\s*check|\.single\(\)/i, reason: "Missing null check (auto-fix)" },
  { pattern: /empty\s*(page|content|body).*no.*error/i, reason: "Empty page without error (auto-fix)" },
  { pattern: /broken\s*link|404.*page/i, reason: "Broken link / 404 (auto-fix)" },
  { pattern: /form\s*validation.*missing|required.*field.*not.*validated/i, reason: "Missing form validation (auto-fix)" },
];

// Critical patterns — findings matching these ALWAYS go to NEEDS_APPROVAL tier
// ONLY true security breaches and spec conflicts — nothing else.
// Reasons are written in CEO-friendly language (no jargon).
const CRITICAL_PATTERNS = [
  { pattern: /BOLA|cross.org|data\s*isolation/i, reason: "User from one company could see another company's data", impact: "If unfixed, one customer could potentially access another customer's records." },
  { pattern: /sensitive\s*data.*expos|PII.*expos|credential.*expos|secret.*expos/i, reason: "Private information (passwords, personal details) visible to wrong people", impact: "If unfixed, sensitive personal information could be seen by unauthorized users." },
  { pattern: /SQL\s*injection|XSS|CSRF/i, reason: "Security gap that could let outsiders tamper with the system", impact: "If unfixed, someone outside the organization could potentially modify data." },
  { pattern: /spec.conflict|BUILD-SPEC.*conflict|protected.decision.*violat/i, reason: "Conflicts with a product decision you already approved", impact: "This change may override a previous product decision. Review before applying." },
];

// Spec-impact patterns — features/changes that MIGHT conflict with BUILD-SPEC.
// Routed to Product + Engineering departments for review (AUTO_APPROVE), not escalated to Steve.
const SPEC_IMPACT_PATTERNS = [
  { pattern: /new\s*feature|feature\s*request|feature\s*suggestion/i, reason: "New feature — routed to Product dept" },
  { pattern: /architecture.*redesign|breaking.*change.*spec/i, reason: "Architectural change — routed to Engineering dept" },
];

// Patterns that used to be NEEDS_APPROVAL but now AUTO_APPROVE (departments handle these)
const DEPT_HANDLED_PATTERNS = [
  { pattern: /permission.*leak|permission.*bypass/i, reason: "Permission issue — routed to Security dept" },
  { pattern: /RLS.*policy.*missing|RLS.*bypass/i, reason: "RLS gap — routed to Security dept" },
  { pattern: /migration.*breaking|schema.*breaking/i, reason: "Breaking migration — routed to Engineering dept" },
  { pattern: /unauthorized\s*access/i, reason: "Unauthorized access — routed to Security dept" },
  { pattern: /workflow\s*change|process\s*change/i, reason: "Workflow change — routed to Product dept" },
  { pattern: /permission.*matrix.*change|permission.*key.*add|rls.*policy.*change/i, reason: "Permission change — routed to Security dept" },
  { pattern: /stage.*gate.*change|stage.*validation.*change|stage.*order/i, reason: "Stage change — routed to Engineering dept" },
  { pattern: /review.*routing.*change|reviewer.*assignment.*change/i, reason: "Review routing — routed to Product dept" },
  { pattern: /agent.*behavior|riley.*change|agentic.*feature/i, reason: "Agent change — routed to Engineering dept" },
  { pattern: /notification.*dispatch|notification.*table.*change/i, reason: "Notification change — routed to Engineering dept" },
  { pattern: /feature.*flag.*toggle|feature.*flag.*default/i, reason: "Feature flag change — routed to Product dept" },
  { pattern: /refactor.*major/i, reason: "Major refactor — routed to Engineering dept" },
];

/**
 * Classify a single finding into a tier.
 * Returns { tier, reason }
 */
function classifyFinding(finding) {
  const desc = (finding.description ?? finding.summary ?? "").toLowerCase();
  const severity = (finding.severity ?? "").toLowerCase();

  // --- NOISE: true noise, auto-resolved with NO MOC ---
  for (const { pattern, reason } of NOISE_PATTERNS) {
    if (pattern.test(desc)) {
      return { tier: TIERS.NOISE, reason };
    }
  }

  // Transient failure types → noise
  if (finding.failureType === "transient") {
    return { tier: TIERS.NOISE, reason: "Transient failure type" };
  }

  // Test expectation issues → noise (fix the test, not the app)
  if (finding.failureType === "test_expectation") {
    return { tier: TIERS.NOISE, reason: "Test expectation (not app bug)" };
  }

  // --- NEEDS_APPROVAL: only TRUE critical patterns (BOLA, injection, spec conflicts) ---
  for (const { pattern, reason } of CRITICAL_PATTERNS) {
    if (pattern.test(desc)) {
      return { tier: TIERS.NEEDS_APPROVAL, reason };
    }
  }

  // Spec-impact patterns — routed to departments, not escalated to Steve.
  // The spec-guard CI check is the right enforcement point for BUILD-SPEC conflicts.
  for (const { pattern, reason } of SPEC_IMPACT_PATTERNS) {
    if (pattern.test(desc)) {
      return { tier: TIERS.AUTO_APPROVE, reason };
    }
  }

  // Tag spec-protected findings for routing metadata (NOT tier escalation).
  // BUILD-SPEC protection informs which department reviews, not whether Steve must approve.
  if (!isVisionOrCosmeticFinding(finding) && touchesProtectedSpec(finding)) {
    finding._specProtected = true; // Metadata tag for routing
  }

  // --- AUTO_FIX: high-confidence bugs that should be fixed without review ---
  for (const { pattern, reason } of AUTO_FIX_PATTERNS) {
    if (pattern.test(desc)) {
      return { tier: TIERS.AUTO_FIX, reason };
    }
  }

  // Bug severity findings → auto-fix (high certainty of real bug)
  if (severity === "bug") {
    return { tier: TIERS.AUTO_FIX, reason: "Bug severity — auto-fix" };
  }

  // Product quality findings — all go to AUTO_FIX (cosmetic/UX improvements)
  if (severity === "product") {
    const grade = finding.productGrade ?? "";
    const effort = finding.productEffort ?? "";

    // A/B with no actionable effort → noise (page is good, nothing specific to fix)
    if ((grade === "A" || grade === "B") && effort !== "quick_win" && effort !== "medium") {
      return { tier: TIERS.NOISE, reason: `Product grade ${grade} — already good` };
    }

    // Everything else → auto-fix (any grade with actionable effort)
    return { tier: TIERS.AUTO_FIX, reason: `Product quality (grade ${grade || "?"}, ${effort || "?"}) — analyst fix` };
  }

  // --- AUTO_APPROVE: department-handled patterns (security, permissions, migrations, etc.) ---
  // These get routed to the right department but don't need product owner approval.
  for (const { pattern, reason } of DEPT_HANDLED_PATTERNS) {
    if (pattern.test(desc)) {
      return { tier: TIERS.AUTO_APPROVE, reason };
    }
  }

  // Security severity → auto-approve (routed to Security dept, not escalated to Steve)
  if (severity === "security") {
    return { tier: TIERS.AUTO_APPROVE, reason: "Security finding — routed to Security dept" };
  }

  // Migration findings → auto-approve (routed to Engineering + DevOps)
  if (/migration|schema\s*change/i.test(desc)) {
    return { tier: TIERS.AUTO_APPROVE, reason: "Migration — routed to Engineering dept" };
  }

  // --- AUTO_APPROVE: everything else ---
  const baseTier = { tier: TIERS.AUTO_APPROVE, reason: `Standard finding (${severity || finding.failureType || "general"})` };

  // Confidence-based tier adjustment: promote high-confidence findings, demote low-confidence ones
  const confidence = finding.confidence ?? 0.5;
  if (confidence >= 0.8 && (severity === "security" || severity === "bug")) {
    return { tier: TIERS.AUTO_FIX, reason: `${baseTier.reason} — high confidence (${confidence.toFixed(2)}), promoted to auto-fix` };
  }
  if (confidence < 0.3) {
    return { tier: TIERS.NOISE, reason: `${baseTier.reason} — low confidence (${confidence.toFixed(2)}), demoted to noise` };
  }

  return baseTier;
}

// ---------------------------------------------------------------------------
// Track which findings have already been submitted as MOCs
// ---------------------------------------------------------------------------

function loadSubmittedTracker() {
  if (!fs.existsSync(SUBMITTED_TRACKER)) {
    return { version: 2, submitted: {} }; // findingId -> { mocId, tier }
  }
  try {
    return JSON.parse(fs.readFileSync(SUBMITTED_TRACKER, "utf-8"));
  } catch {
    return { version: 2, submitted: {} };
  }
}

function saveSubmittedTracker(tracker) {
  const dir = path.dirname(SUBMITTED_TRACKER);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(SUBMITTED_TRACKER, JSON.stringify(tracker, null, 2) + "\n");
}

function appendOracleFeedback(entry) {
  try {
    const dir = path.dirname(ORACLE_FEEDBACK_PATH);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.appendFileSync(ORACLE_FEEDBACK_PATH, JSON.stringify(entry) + "\n");
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Map finding characteristics to MOC change types
// ---------------------------------------------------------------------------

function findingToChangeType(finding) {
  const desc = (finding.description ?? finding.summary ?? "").toLowerCase();
  const severity = (finding.severity ?? "").toLowerCase();
  const failureType = finding.failureType ?? "";

  if (severity === "security" || /BOLA|cross.org|data\s*isolation|injection|XSS|CSRF|RLS/i.test(desc)) {
    return "security";
  }
  if (/permission/i.test(desc) || failureType === "permission_changed") {
    return "security";
  }
  if (failureType === "api_route_moved" || /\/api\//i.test(finding.page ?? "")) {
    return "api_change";
  }
  if (failureType === "ui_refactor" || failureType === "stale_selector") {
    return "ui_ux";
  }
  if (/dark\s*mode|contrast|accessibility/i.test(desc)) {
    return "ui_ux";
  }
  if (/migration|database|schema/i.test(desc)) {
    return "migration";
  }
  if (/CI|deploy|build|config/i.test(desc)) {
    return "infrastructure";
  }
  if (severity === "product") {
    return "ui_ux";
  }
  return "bug_fix";
}

function findingToInitiatingDepartment(finding) {
  const desc = (finding.description ?? finding.summary ?? "").toLowerCase();
  const severity = (finding.severity ?? "").toLowerCase();
  const page = (finding.page ?? "").toLowerCase();
  const persona = (finding.persona ?? "").toLowerCase();

  if (severity === "security" || /BOLA|cross.org|data.isolation|injection|XSS|CSRF|RLS|auth.bypass|permission.leak/i.test(desc)) {
    return "Security";
  }
  if (/\/api\//i.test(page) || /500|server.error|route.*failed|TypeError/i.test(desc)) {
    return "Engineering";
  }
  if (/dark.mode|contrast|visual|layout|icon|color|css|responsive|accessibility|wcag/i.test(desc)) {
    return "Design";
  }
  if (/test|persona|oracle|fixture|selector|spec.*fail|flaky|green.tracker/i.test(desc) || persona.startsWith("cp-qa")) {
    return "QA & Testing";
  }
  if (/usability|confus|workflow|user.experience|onboard|navigation|discoverability/i.test(desc)) {
    return "Product";
  }
  if (/CI|deploy|build|config|migration|schema|vercel|github.action|docker|infrastructure/i.test(desc)) {
    return "DevOps";
  }
  if (severity === "bug") {
    return "Engineering";
  }
  return "Product";
}

// ---------------------------------------------------------------------------
// Cluster findings into logical groups (same tier + change type + page area)
// ---------------------------------------------------------------------------

/**
 * Extract a stable issue signature from finding text.
 * Uses first 6 meaningful words (sorted) to identify distinct issues.
 * Strips numbers so "2 findings" and "3 findings" produce same signature.
 * Sorts to make order-independent ("dark mode bg" == "bg dark mode").
 */
function extractFindingSignature(finding) {
  const CLUSTER_STOP_WORDS = new Set(["the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or", "not", "no", "with", "this", "that", "are", "was", "has", "have", "page", "should", "does", "can", "persona", "oracle", "semantics", "vision"]);
  const text = (finding.summary ?? finding.description ?? "").toLowerCase().replace(/[^a-z\s]/g, " ");
  const words = text.split(/\s+/).filter((w) => w.length > 2 && !CLUSTER_STOP_WORDS.has(w));
  return words.slice(0, 6).sort().join("_") || "general";
}

function clusterFindings(findings) {
  const clusters = {};

  for (const finding of findings) {
    const changeType = findingToChangeType(finding);
    const page = finding.page ?? "unknown";
    const pageGroup = page.split("/").slice(0, 3).join("/") || "/";
    const tier = finding._tier; // Set during classification

    // Include issue signature in key so distinct issues on the same page
    // become separate MOCs instead of being lumped together
    const sig = extractFindingSignature(finding);
    const key = `${tier}::${changeType}::${pageGroup}::${sig}`;

    if (!clusters[key]) {
      clusters[key] = {
        tier,
        changeType,
        pageGroup,
        findings: [],
        isCritical: tier === TIERS.NEEDS_APPROVAL,
        affectedFiles: new Set(),
        personas: new Set(),
      };
    }

    clusters[key].findings.push(finding);
    if (finding.persona) {
      clusters[key].personas.add(finding.persona);
    }
    if (finding.affectedFile) {
      clusters[key].affectedFiles.add(finding.affectedFile);
    }
    if (finding.component) {
      clusters[key].affectedFiles.add(finding.component);
    }
  }

  return Object.values(clusters);
}

// ---------------------------------------------------------------------------
// Semantic dedup: merge clusters that describe the same underlying bug
// ---------------------------------------------------------------------------

/**
 * Check if Claude CLI is available for semantic dedup.
 */
function isClaudeAvailableForDedup() {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Semantic dedup — uses Claude CLI (haiku) or Gemini API to identify clusters
 * targeting the same page area that describe the same underlying bug.
 *
 * Groups clusters by pageGroup, then for groups with 2+ clusters, asks the LLM
 * whether any describe the same root cause. Merges recommended clusters.
 *
 * Priority: Claude CLI (when available) → Gemini API (E2E_DEDUP_MODEL) → skip.
 * Env: E2E_DEDUP_MODEL (default: gemini-2.5-flash) for Gemini fallback.
 *
 * @param {Array} clusters - Array of cluster objects from clusterFindings()
 * @returns {Promise<Array>} - Deduplicated array of clusters
 */
async function semanticDedupClusters(clusters) {
  if (clusters.length < 2) {
    return clusters;
  }

  const byPageGroup = {};
  for (const cluster of clusters) {
    const pg = cluster.pageGroup;
    if (!byPageGroup[pg]) byPageGroup[pg] = [];
    byPageGroup[pg].push(cluster);
  }

  const candidateGroups = Object.entries(byPageGroup).filter(([, g]) => g.length >= 2);
  if (candidateGroups.length === 0) return clusters;

  const useClaude = isClaudeAvailableForDedup();
  const llm = getLlmE2e();
  const useGemini = !useClaude && llm && process.env.GEMINI_API_KEY?.trim();

  if (!useClaude && !useGemini) {
    if (!jsonOutput) console.log("[findings-to-mocs] Semantic dedup: Claude CLI and Gemini API not available, skipping.");
    return clusters;
  }

  if (useGemini && !jsonOutput) {
    console.log("[findings-to-mocs] Semantic dedup: using Gemini fallback (Claude CLI not available).");
  }

  let totalMerged = 0;
  const mergedSet = new Set();
  const clusterIndex = new Map();
  for (let i = 0; i < clusters.length; i++) clusterIndex.set(clusters[i], i);

  const dedupModel = process.env.E2E_DEDUP_MODEL ?? "gemini-2.5-flash";

  for (const [pageGroup, group] of candidateGroups) {
    if (group.length < 2) continue;

    const clusterSummaries = group.map((c, idx) => ({
      index: idx,
      tier: c.tier,
      changeType: c.changeType,
      personas: [...c.personas].join(", "),
      findingCount: c.findings.length,
      descriptions: c.findings.slice(0, 5).map((f) => (f.summary ?? f.description ?? "").slice(0, 150)),
    }));

    const prompt = [
      "You are analyzing bug report clusters for the same page area to find duplicates.",
      "",
      `Page area: ${pageGroup}`,
      `Number of clusters: ${group.length}`,
      "",
      "Each cluster below groups related findings. Determine if any clusters describe the SAME underlying bug.",
      "Only merge clusters that are clearly about the same root cause, not just the same page.",
      "",
      "Clusters:",
      JSON.stringify(clusterSummaries, null, 2),
      "",
      "Respond with ONLY a JSON object (no markdown, no explanation):",
      '{ "merges": [[0, 2], [1, 3]] }',
      "",
      "Each inner array lists cluster indices that should be merged together.",
      "If no clusters should be merged, respond: { \"merges\": [] }",
      "",
      "Rules:",
      "- Only merge clusters describing the same root cause bug",
      "- Different tiers (e.g., auto_fix vs auto_approve) should NOT be merged",
      "- Different change types (e.g., security vs ui_ux) should NOT be merged",
      "- When in doubt, do NOT merge",
    ].join("\n");

    let parsed = null;
    const promptFile = path.join(ROOT, "e2e", "state", "fix-prompt-dedup.md");

    try {
      if (useClaude) {
        fs.writeFileSync(promptFile, prompt);
        const result = execSync(
          `claude --print --dangerously-skip-permissions --model haiku --max-budget-usd 0.10 < "${promptFile}"`,
          { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], timeout: 30000, env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE: "" } }
        );
        const output = result.toString().trim();
        try {
          const _tl = require("./lib/token-logger");
          const _inEst = Math.ceil((fs.existsSync(promptFile) ? fs.statSync(promptFile).size : 0) / 4);
          const _outEst = Math.ceil(output.length / 4);
          _tl.logTokenUsage({ component: "findings-to-mocs", inputTokens: _inEst, outputTokens: _outEst, provider: "claude", model: "haiku" });
        } catch { /* non-fatal */ }

        let jsonStr = output;
        const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();
        const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (braceMatch) jsonStr = braceMatch[0];
        parsed = JSON.parse(jsonStr);
      } else {
        const raw = await llm.callLLMWithRetry({
          prompt,
          model: dedupModel,
          component: "findings-to-mocs",
          maxTokens: 1024,
        });
        parsed = typeof raw === "object" ? raw : JSON.parse(String(raw ?? "{}"));
      }
    } catch (err) {
      if (!jsonOutput) console.log(`[findings-to-mocs] Semantic dedup: failed for ${pageGroup}: ${(err.message ?? "").slice(0, 100)}`);
      continue;
    } finally {
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
    }

    const merges = parsed?.merges ?? [];
    if (!Array.isArray(merges) || merges.length === 0) continue;

    for (const mergeGroup of merges) {
      if (!Array.isArray(mergeGroup) || mergeGroup.length < 2) continue;

      const validIndices = mergeGroup.filter((idx) => typeof idx === "number" && idx >= 0 && idx < group.length);
      if (validIndices.length < 2) continue;

      const tiers = new Set(validIndices.map((idx) => group[idx].tier));
      const changeTypes = new Set(validIndices.map((idx) => group[idx].changeType));
      if (tiers.size > 1 || changeTypes.size > 1) continue;

      const primaryIdx = validIndices[0];
      const primary = group[primaryIdx];

      for (let i = 1; i < validIndices.length; i++) {
        const secondary = group[validIndices[i]];
        const secondaryGlobalIdx = clusterIndex.get(secondary);
        if (mergedSet.has(secondaryGlobalIdx)) continue;

        primary.findings.push(...secondary.findings);
        for (const p of secondary.personas) primary.personas.add(p);
        for (const f of secondary.affectedFiles) primary.affectedFiles.add(f);

        mergedSet.add(secondaryGlobalIdx);
        totalMerged++;
      }
    }
  }

  if (totalMerged > 0) {
    const result = clusters.filter((_, idx) => !mergedSet.has(idx));
    if (!jsonOutput) {
      console.log(`[findings-to-mocs] Semantic dedup: merged ${clusters.length} clusters into ${result.length} (saved ${totalMerged} MOCs)`);
    }
    return result;
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Build MOC title and description from cluster
// ---------------------------------------------------------------------------

function buildMocFromCluster(cluster) {
  const changeInfo = CHANGE_TYPE_MAP[cluster.changeType] ?? CHANGE_TYPE_MAP.bug_fix;
  const findingCount = cluster.findings.length;
  const personas = [...cluster.personas].join(", ") || "system";

  const tierLabel = {
    [TIERS.AUTO_FIX]: "[AUTO-FIX]",
    [TIERS.AUTO_APPROVE]: "",
    [TIERS.NEEDS_APPROVAL]: "[NEEDS YOUR REVIEW]",
  }[cluster.tier] ?? "";

  let title;
  if (findingCount === 1) {
    const f = cluster.findings[0];
    title = (f.summary ?? f.description ?? "").slice(0, 80);
  } else {
    // Extract a meaningful summary from the first finding instead of just showing a count
    const leadDesc = (cluster.findings[0]?.summary ?? cluster.findings[0]?.description ?? "")
      .replace(/^\[.*?\]\s*/, "")  // Strip [Oracle/Semantics] prefixes
      .slice(0, 60);
    if (leadDesc) {
      title = `${changeInfo.label}: ${leadDesc} (+${findingCount - 1} related)`;
    } else {
      title = `${changeInfo.label}: ${findingCount} findings on ${cluster.pageGroup}`;
    }
  }
  // Never allow empty titles — they bypass dedup and create garbage MOCs
  if (!title || !title.trim()) {
    const fallbackDesc = (cluster.findings[0]?.description ?? cluster.findings[0]?.summary ?? "").slice(0, 60);
    title = fallbackDesc
      ? `${changeInfo.label}: ${fallbackDesc}`
      : `${changeInfo.label} on ${cluster.pageGroup}`;
  }
  if (tierLabel) {
    title = `${tierLabel} ${title}`;
  }

  // For NEEDS_APPROVAL, find the matching critical pattern to get CEO-friendly impact
  let impactLine = "";
  if (cluster.tier === TIERS.NEEDS_APPROVAL) {
    const clusterDesc = cluster.findings.map((f) => f.summary ?? f.description ?? "").join(" ");
    for (const cp of CRITICAL_PATTERNS) {
      if (cp.pattern.test(clusterDesc)) {
        impactLine = cp.impact;
        break;
      }
    }
  }

  // Pre-resolve source files for description header
  const headerPages = [...new Set(cluster.findings.map((f) => f.page).filter(Boolean))];
  const headerSourceFiles = [];
  for (const page of headerPages) {
    for (const sf of toRelativePaths(pagePathToSourceFiles(page))) {
      if (!headerSourceFiles.includes(sf)) { headerSourceFiles.push(sf); }
      if (headerSourceFiles.length >= 5) { break; }
    }
    if (headerSourceFiles.length >= 5) { break; }
  }

  const descLines = [
    `**Tier:** ${cluster.tier}`,
    ...(impactLine ? [`**Impact:** ${impactLine}`] : []),
    `**Findings:** ${findingCount} identified by persona testing`,
    `**Change type:** ${changeInfo.label} (${changeInfo.risk_level} risk)`,
    `**Page area:** ${cluster.pageGroup}`,
    `**Personas:** ${personas}`,
    ...(headerSourceFiles.length > 0 ? [`**Source files:** ${headerSourceFiles.join(", ")}`] : []),
    "",
    "### Findings:",
  ];

  // Include ALL findings with full descriptions — clusters are now fine-grained
  // (keyed by issue signature), so each cluster is a focused issue, not a grab-bag
  const maxFindings = Math.min(findingCount, 30);
  for (const f of cluster.findings.slice(0, maxFindings)) {
    const desc = (f.summary ?? f.description ?? "").slice(0, 400);
    const persona = f.persona ?? "unknown";
    const tierReason = f._tierReason ?? "";
    const component = f.component ? ` [${f.component}]` : "";
    const affectedFile = f.affectedFile ? ` (file: ${f.affectedFile})` : "";
    descLines.push(`- [${persona}]${component}${affectedFile} ${desc}`);
    if (tierReason) {
      descLines.push(`  Classification: ${tierReason}`);
    }
  }

  if (findingCount > maxFindings) {
    descLines.push(`... and ${findingCount - maxFindings} more similar findings`);
  }

  // Append correlated server errors if any findings have error context
  const correlatedFindings = cluster.findings.filter((f) => f.errorContext && f.errorContext.count > 0);
  if (correlatedFindings.length > 0) {
    descLines.push("");
    descLines.push("### Correlated Server Errors");
    const allEndpoints = new Set();
    const allStatusCodes = new Set();
    const allMessages = [];
    let totalErrorCount = 0;
    for (const f of correlatedFindings) {
      const ctx = f.errorContext;
      for (const ep of (ctx.endpoints || [])) { allEndpoints.add(ep); }
      for (const sc of (ctx.statusCodes || [])) { allStatusCodes.add(sc); }
      for (const msg of (ctx.messages || []).slice(0, 2)) {
        if (allMessages.length < 5) { allMessages.push(msg); }
      }
      totalErrorCount += ctx.count || 0;
    }
    descLines.push(`**Error count:** ${totalErrorCount} server errors correlated with ${correlatedFindings.length} finding(s)`);
    if (allEndpoints.size > 0) {
      descLines.push(`**Endpoints:** ${[...allEndpoints].join(", ")}`);
    }
    if (allStatusCodes.size > 0) {
      descLines.push(`**Status codes:** ${[...allStatusCodes].join(", ")}`);
    }
    if (allMessages.length > 0) {
      descLines.push("**Error messages:**");
      for (const msg of allMessages) {
        descLines.push(`- ${msg.slice(0, 150)}`);
      }
    }
  }

  // Resolve source files from page paths so moc-auto-fix.js can locate code
  const pageArea = cluster.pageGroup || null;
  const affectedPages = [...new Set(cluster.findings.map((f) => f.page).filter(Boolean))];
  const sourceFilesSet = new Set();
  for (const page of affectedPages) {
    for (const sf of toRelativePaths(pagePathToSourceFiles(page))) {
      sourceFilesSet.add(sf);
    }
  }
  const sourceFiles = [...sourceFilesSet].slice(0, 10);
  const findingIds = cluster.findings.map((f) => f.id ?? f.findingId).filter(Boolean);

  return {
    title: title.slice(0, 140),
    description: descLines.join("\n"),
    category: cluster.tier === TIERS.NEEDS_APPROVAL ? "critical" : "standard",
    tier: cluster.tier,
    source: "persona",
    persona: [...cluster.personas][0] ?? "system",
    findings: findingIds,
    findingIds,
    affectedFiles: [...cluster.affectedFiles].slice(0, 10),
    sourceFiles,
    pageArea,
    affectedPages,
    changeType: cluster.changeType,
    initiatingDepartment: findingToInitiatingDepartment(cluster.findings[0]),
    iteration,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(FINDINGS_FILE)) {
    if (!jsonOutput) { console.log("[findings-to-mocs] No findings file found."); }
    if (jsonOutput) { console.log(JSON.stringify({ tiers: {}, submitted: 0, noiseResolved: 0 })); }
    return;
  }

  let findings;
  try {
    findings = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
    if (!Array.isArray(findings)) { findings = []; }
  } catch {
    if (!jsonOutput) { console.log("[findings-to-mocs] Could not parse findings.json"); }
    if (jsonOutput) { console.log(JSON.stringify({ submitted: 0, error: "parse" })); }
    return;
  }

  // Load tracker to avoid re-submitting
  const tracker = loadSubmittedTracker();

  // Classify ALL findings (skip only those already submitted as MOCs)
  const tierStats = { [TIERS.NOISE]: 0, [TIERS.AUTO_FIX]: 0, [TIERS.AUTO_APPROVE]: 0, [TIERS.NEEDS_APPROVAL]: 0 };
  const newFindings = [];
  let noiseResolved = 0;

  for (const finding of findings) {
    const id = finding.id ?? finding.findingId ?? "";

    // Already submitted as a MOC — skip
    if (id && tracker.submitted[id]) {
      continue;
    }

    // Already processed in a previous run
    if (finding.status === "in_moc" || finding.status === "in_moc_archived" || finding.status === "resolved") {
      continue;
    }

    // Classify this finding
    const { tier, reason } = classifyFinding(finding);
    tierStats[tier]++;

    // Record tier assignment for pipeline accuracy tracking
    if (pipelineMetrics && !dryRun) {
      try {
        pipelineMetrics.recordDecision("tier_assignment", {
          findingId: finding.id ?? finding.hash,
          severity: finding.severity ?? "unknown",
          page: finding.page ?? "unknown",
        }, {
          tier,
          reason,
        });
      } catch { /* non-fatal */ }
    }

    // NOISE: resolve directly, no MOC created
    if (tier === TIERS.NOISE) {
      finding.status = "resolved";
      finding.resolution = "noise";
      finding.resolvedAt = new Date().toISOString();
      finding.resolvedBy = "findings-to-mocs (auto-noise)";
      finding._tierReason = reason;
      noiseResolved++;
      if (!dryRun) {
        appendOracleFeedback({ persona: finding.persona ?? "?", page: finding.page ?? "?", textSnippet: (finding.text ?? "").slice(0, 200), reason, at: new Date().toISOString() });
      }
      continue;
    }

    finding._tier = tier;
    finding._tierReason = reason;
    newFindings.push(finding);
  }

  if (!jsonOutput && noiseResolved > 0) {
    console.log(`[findings-to-mocs] Auto-resolved ${noiseResolved} noise findings (no MOC created).`);
  }

  if (newFindings.length === 0) {
    // Still save findings if we resolved noise
    if (noiseResolved > 0 && !dryRun) {
      fs.writeFileSync(FINDINGS_FILE, JSON.stringify(findings, null, 2), "utf-8");
    }
    if (!dryRun) {
      try {
        const lastPath = path.join(ROOT, "e2e", "state", "findings-to-mocs-last.json");
        fs.writeFileSync(lastPath, JSON.stringify({
          submitted: 0, noiseResolved, dedupSkipped: 0, dedupByActive: 0,
          dedupByImplemented: 0, throttled: 0, skipped: findings.length,
          autoFix: 0, timestamp: new Date().toISOString(),
        }) + "\n", "utf-8");
      } catch { /* non-fatal */ }
    }
    if (!jsonOutput) { console.log("[findings-to-mocs] No actionable findings to submit as MOCs."); }
    if (jsonOutput) { console.log(JSON.stringify({ tiers: tierStats, submitted: 0, noiseResolved, skipped: findings.length })); }
    return;
  }

  if (!jsonOutput) {
    console.log(`[findings-to-mocs] Classified ${newFindings.length} actionable findings:`);
    console.log(`  AUTO_FIX (low risk, auto-fix queue): ${tierStats[TIERS.AUTO_FIX]}`);
    console.log(`  AUTO_APPROVE (standard review): ${tierStats[TIERS.AUTO_APPROVE]}`);
    console.log(`  NEEDS_APPROVAL (critical): ${tierStats[TIERS.NEEDS_APPROVAL]}`);
  }

  // Cluster by tier + change type + page area
  let clusters = clusterFindings(newFindings);

  // --- Force needs_approval sample for dogfooding (E2E_DOGFOOD_NEEDS_APPROVAL_RATE) ---
  const dogfoodRate = parseFloat(process.env.E2E_DOGFOOD_NEEDS_APPROVAL_RATE ?? "0", 10);
  if (dogfoodRate > 0) {
    for (const cluster of clusters) {
      if (cluster.tier !== TIERS.NEEDS_APPROVAL && cluster.tier !== TIERS.NOISE) {
        if (Math.random() < dogfoodRate) {
          cluster.tier = TIERS.NEEDS_APPROVAL;
          cluster.isCritical = true;
        }
      }
    }
    const forced = clusters.filter((c) => c.tier === TIERS.NEEDS_APPROVAL).length;
    if (forced > 0 && !jsonOutput) {
      console.log(`[findings-to-mocs] Dogfood: forced ${forced} cluster(s) to NEEDS_APPROVAL (rate=${dogfoodRate})`);
    }
  }

  // --- Semantic dedup: merge clusters that describe the same underlying bug ---
  if (!skipDedup) {
    clusters = await semanticDedupClusters(clusters);
  } else if (!jsonOutput) {
    console.log("[findings-to-mocs] Semantic dedup: skipped (--skip-dedup flag).");
  }

  // --- Queue-level dedup: skip clusters that already have a MOC (active OR recent) ---
  // Dedup key: changeType::pageGroup::issueSignature — allows different issues on same page
  const IMPLEMENTED_DEDUP_MS = 3 * 24 * 60 * 60 * 1000; // 3 days for implemented
  const STOP_WORDS = new Set(["the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or", "not", "no", "with",
    "auto", "fix", "vision", "bug", "page", "area", "moc", "spec", "implementation", "should", "does", "can", "has", "are",
    "this", "that", "from", "was", "were", "been", "have", "will", "but", "all", "its", "our", "when"]);
  let activeQueueKeys = new Set();
  let dedupSkipped = 0;
  let dedupByActive = 0;
  let dedupByImplemented = 0;
  let dedupByArchived = 0;

  function normalizeForDedup(text) {
    if (!text) { return ""; }
    return text
      .replace(/^\[.*?\]\s*/g, "")
      .replace(/\*\*[^*]+\*\*\s*/g, "")
      .replace(/[^a-zA-Z\s]/g, " ")       // Strip numbers too — "2 findings" and "3 findings" should match
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
      .slice(0, 8)
      .sort()
      .join("_");
  }

  function extractIssueSignature(text) {
    return normalizeForDedup(text) || "general";
  }

  function extractPageGroup(text) {
    if (!text) { return "unknown"; }
    const pageMatch = text.match(/\*\*Page area:\*\*\s*(.+)/);
    if (pageMatch) {
      return pageMatch[1].trim().split("/").slice(0, 3).join("/");
    }
    return "unknown";
  }

  try {
    if (fs.existsSync(QUEUE_PATH)) {
      const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));

      // Auto-prune: if archived MOCs exceed threshold, move to compact index
      const archivedInMocs = (queue.mocs || []).filter((m) => m.status === "archived");
      if (archivedInMocs.length > 500) {
        withStateLock("moc-queue.json", (fresh) => {
          if (!fresh.mocs) { return; }
          const archivedFresh = fresh.mocs.filter((m) => m.status === "archived");
          if (archivedFresh.length <= 500) { return; }
          const kept = [];
          if (!fresh.archivedDedupIndex) { fresh.archivedDedupIndex = []; }
          for (const m of fresh.mocs) {
            if (m.status === "archived") {
              fresh.archivedDedupIndex.push({
                changeType: m.changeType,
                pageGroup: m.pageGroup,
                title: (m.title || "").slice(0, 100),
              });
            } else {
              kept.push(m);
            }
          }
          fresh.mocs = kept;
          fresh.lastPruned = new Date().toISOString();
        }, { mocs: [] });
        // Reload queue after prune for downstream dedup checks
        try {
          const updatedQueue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
          queue.mocs = updatedQueue.mocs;
          queue.archivedDedupIndex = updatedQueue.archivedDedupIndex;
        } catch { /* use existing */ }
        if (!jsonOutput) {
          console.log(`[findings-to-mocs] Auto-pruned ${archivedInMocs.length} archived MOCs from queue`);
        }
      }

      for (const m of (queue.mocs || [])) {
        let pg = m.pageGroup || extractPageGroup(m.description);
        if (pg === "unknown") { continue; }

        const titleSig = extractIssueSignature(m.title);
        const descSig = extractIssueSignature(m.description);
        const sig = titleSig.split("_").length >= descSig.split("_").length ? titleSig : descSig;
        const key = `${m.changeType}::${pg}::${sig}`;

        if (m.status === "pending_approval" || m.status === "awaiting_approval") {
          continue;
        }

        // Archived MOCs should NOT block new MOCs — the original fix was never applied
        // or was superseded. Only truly active MOCs (approved, awaiting_closeout, etc.) dedup.
        if (m.status === "archived") { continue; }

        // Active MOCs (approved, awaiting_closeout, committed, etc.) — always dedup
        if (m.status !== "implemented") {
          activeQueueKeys.add(key);
          dedupByActive++;
          continue;
        }

        // Implemented MOCs with real fix — dedup within 3 days
        if (!m.commit_sha) { continue; }
        const completedAt = m.implementedAt;
        if (completedAt) {
          const age = Date.now() - new Date(completedAt).getTime();
          if (age < IMPLEMENTED_DEDUP_MS) {
            activeQueueKeys.add(key);
            dedupByImplemented++;
          }
        }
      }

      // Archived dedup index: NO LONGER blocks new MOCs.
      // Archived MOCs were never fixed — their dedup keys should not prevent
      // new MOCs from being created for the same areas.
      // We still track the count for logging/diagnostics.
      dedupByArchived = (queue.archivedDedupIndex || []).length;
    }
  } catch {
    // Queue not available — skip dedup
  }

  // --- Page-level throttle: cap active MOCs per pageGroup+changeType ---
  // Prevents the same root cause from spawning many differently-titled MOCs
  const MAX_ACTIVE_PER_PAGE = 3;
  const activePerPage = {};
  try {
    if (fs.existsSync(QUEUE_PATH)) {
      const q = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
      for (const m of (q.mocs || [])) {
        if (m.status === "archived" || m.status === "implemented" || m.status === "needs_human") { continue; }
        const pg = m.pageGroup || "unknown";
        const ct = m.changeType || "bug_fix";
        const pageKey = `${ct}::${pg}`;
        activePerPage[pageKey] = (activePerPage[pageKey] || 0) + 1;
      }
    }
  } catch { /* non-fatal */ }

  let submitted = 0;
  let autoFixCount = 0;
  let skipped = 0;
  let throttled = 0;
  const mocs = [];

  for (const cluster of clusters) {
    // Throttle: skip if too many active MOCs already exist for this page+type
    const pageThrottleKey = `${cluster.changeType}::${cluster.pageGroup}`;
    if ((activePerPage[pageThrottleKey] || 0) >= MAX_ACTIVE_PER_PAGE) {
      if (!jsonOutput) {
        console.log(`[findings-to-mocs] Throttle: skipping ${pageThrottleKey} (${activePerPage[pageThrottleKey]} active MOCs, max ${MAX_ACTIVE_PER_PAGE})`);
      }
      for (const f of cluster.findings) {
        const id = f.id ?? f.findingId;
        if (id) {
          tracker.submitted[id] = { mocId: "throttled", tier: cluster.tier };
        }
        f.status = "in_moc";
        f.mocTier = cluster.tier;
      }
      throttled++;
      continue;
    }

    // Dedup: skip if queue already has an active MOC for this type+page+issue
    const clusterText = cluster.findings[0]?.description || cluster.findings[0]?.summary || "";
    const clusterSig = extractIssueSignature(clusterText);
    const dedupKey = `${cluster.changeType}::${cluster.pageGroup}::${clusterSig}`;
    if (activeQueueKeys.has(dedupKey)) {
      if (!jsonOutput) {
        console.log(`[findings-to-mocs] Dedup: skipping ${dedupKey} (active MOC exists in queue)`);
      }
      // Still mark findings as submitted so they don't re-appear
      for (const f of cluster.findings) {
        const id = f.id ?? f.findingId;
        if (id) {
          tracker.submitted[id] = { mocId: "dedup_existing", tier: cluster.tier };
        }
        f.status = "in_moc";
        f.mocTier = cluster.tier;
      }
      dedupSkipped++;
      continue;
    }

    const mocInput = buildMocFromCluster(cluster);

    // Guard: skip MOCs with 0 pages and 0 source files — they'll never be fixable
    if ((!mocInput.sourceFiles || mocInput.sourceFiles.length === 0) && (!mocInput.affectedPages || mocInput.affectedPages.length === 0)) {
      if (!jsonOutput) {
        console.log(`[findings-to-mocs] Skipping unfixable cluster: "${mocInput.title}" — 0 pages, 0 source files`);
      }
      for (const f of cluster.findings) {
        f.status = "noise_resolved";
        f.noiseReason = "unfixable: no source files or pages";
      }
      noiseResolved += cluster.findings.length;
      continue;
    }

    if (dryRun) {
      if (!jsonOutput) {
        console.log(`[DRY RUN] Would submit [${cluster.tier}]: ${mocInput.title}`);
        console.log(`  Type: ${mocInput.changeType}, Findings: ${cluster.findings.length}`);
      }
      mocs.push(mocInput);
      submitted++;
      continue;
    }

    try {
      const mocEntry = await submitMoc(mocInput);
      if (!mocEntry) {
        skipped++;
        continue;
      }

      mocs.push({
        ...mocInput,
        mocId: mocEntry.id,
        platformMocId: mocEntry.platformMocId,
        status: mocEntry.status,
      });
      submitted++;
      if (cluster.tier === TIERS.AUTO_FIX) { autoFixCount++; }

      // Increment page throttle counter for this submission
      activePerPage[pageThrottleKey] = (activePerPage[pageThrottleKey] || 0) + 1;

      // Track submitted findings and update their status in findings.json
      // cp-meta.spec.ts handles all workflow advancement
      for (const f of cluster.findings) {
        const id = f.id ?? f.findingId;
        if (id) {
          tracker.submitted[id] = { mocId: mocEntry.id, tier: cluster.tier };
        }
        f.status = "in_moc";
        f.mocId = mocEntry.id;
        f.mocTier = cluster.tier;
      }
    } catch (e) {
      if (!jsonOutput) { console.error(`[findings-to-mocs] Error submitting: ${e.message}`); }
      skipped++;
    }
  }

  if (!dryRun) {
    // Keep tracker manageable (last 3000 entries)
    const entries = Object.entries(tracker.submitted);
    if (entries.length > 3000) {
      tracker.submitted = Object.fromEntries(entries.slice(-3000));
    }
    saveSubmittedTracker(tracker);

    // Write findings back with updated status fields
    fs.writeFileSync(FINDINGS_FILE, JSON.stringify(findings, null, 2), "utf-8");

    // Write last-run result for observer + coverage-suspend automation
    try {
      const lastPath = path.join(ROOT, "e2e", "state", "findings-to-mocs-last.json");
      fs.writeFileSync(lastPath, JSON.stringify({
        submitted,
        noiseResolved,
        dedupSkipped,
        dedupByActive,
        dedupByImplemented,
        throttled,
        skipped,
        autoFix: autoFixCount,
        timestamp: new Date().toISOString(),
      }) + "\n", "utf-8");
    } catch { /* non-fatal */ }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ tiers: tierStats, submitted, autoFix: autoFixCount, noiseResolved, skipped, dedupSkipped, dedupByActive, dedupByImplemented, throttled, mocs }));
  } else {
    console.log(`\n[findings-to-mocs] Summary:`);
    console.log(`  Noise auto-resolved (no MOC): ${noiseResolved}`);
    console.log(`  MOCs created: ${submitted}`);
    console.log(`  Dedup skipped: ${dedupSkipped} (active MOC in queue)`);
    if (throttled > 0) {
      console.log(`  Throttled: ${throttled} (max ${MAX_ACTIVE_PER_PAGE} active MOCs per page+type)`);
    }
    console.log(`  Skipped (errors): ${skipped}`);
    if (submitted > 0) {
      const critical = mocs.filter((m) => m.tier === TIERS.NEEDS_APPROVAL);
      const standard = mocs.filter((m) => m.tier === TIERS.AUTO_APPROVE);
      const autoFixMocs = mocs.filter((m) => m.tier === TIERS.AUTO_FIX);
      if (critical.length > 0) {
        console.log(`  NEEDS_APPROVAL (management review): ${critical.length}`);
      }
      if (standard.length > 0) {
        console.log(`  AUTO_APPROVE (standard review): ${standard.length}`);
      }
      if (autoFixMocs.length > 0) {
        console.log(`  AUTO_FIX (low risk, auto-fix queue): ${autoFixMocs.length}`);
      }
    }
  }
}

main().catch((err) => {
  console.error("[findings-to-mocs] Fatal:", err.message);
  process.exit(1);
});
