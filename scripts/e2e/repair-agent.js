#!/usr/bin/env node

/**
 * repair-agent.js — Auto-generate and validate patches for classifiable test failures.
 *
 * Pipeline per failure:
 *   1. Load failure details from convergence-state.json
 *   2. Classify via auto-triage's classifyFailureType()
 *   3. Skip if REAL_BUG or TRANSIENT (these need humans)
 *   4. Call change-intent.js: if regression → flag as bug, skip repair
 *   5. If intentional or uncertain → generate patch via LLM
 *   6. Apply patch to test file (backup first)
 *   7. Re-run JUST that single test to validate
 *   8. If green: keep patch, record in learned-fix-patterns.json
 *   9. If red: revert from backup, flag for human review
 *
 * Safety:
 *   - ONLY patches test files under e2e/tests/ — NEVER app code
 *   - Max 3 repair attempts per test per convergence run
 *   - .bak backup before every patch
 *   - Automatic revert on validation failure
 *
 * Usage:
 *   node scripts/e2e/repair-agent.js                                    # All failures from convergence state
 *   node scripts/e2e/repair-agent.js --persona cliff-patience           # Single persona
 *   node scripts/e2e/repair-agent.js --dry-run                          # Preview only
 *   node scripts/e2e/repair-agent.js --max-repairs 5                    # Limit repairs per run
 *   node scripts/e2e/repair-agent.js --json                             # Machine-readable output
 */

try {
  require("dotenv").config({ path: ".env.local", quiet: true });
} catch {
  // dotenv not installed
}

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const E2E_DIR = path.join(ROOT, "e2e");
const STATE_DIR = path.join(E2E_DIR, "state");
const CONVERGENCE_STATE = path.join(STATE_DIR, "convergence-state.json");
const REPAIR_STATE_FILE = path.join(STATE_DIR, "repair-state.json");
const LEARNED_FIXES_FILE = path.join(STATE_DIR, "learned-fix-patterns.json");
const GREEN_HISTORY_FILE = path.join(STATE_DIR, "green-history.json");
const PROMPT_FILE = path.join(ROOT, "e2e", "oracle", "prompts", "repair-test.txt");

// Import from sibling scripts (guarded with require.main checks)
const { logTokenUsage } = require("./lib/token-logger");
const { FAILURE_TYPES, classifyFailureType } = require("./auto-triage");
const { analyzeIntent } = require("./change-intent");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    persona: null,
    dryRun: false,
    maxRepairs: 10,
    json: false,
    postLoop: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--persona":
        opts.persona = args[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--max-repairs":
        opts.maxRepairs = parseInt(args[++i], 10);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--post-loop":
        opts.postLoop = true;
        break;
    }
  }

  return opts;
}

/**
 * Read lastRunCommit from green-history.json for commit-aware diffs.
 * Falls back to "HEAD~1" if not available.
 */
function getLastRunCommit() {
  try {
    if (fs.existsSync(GREEN_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(GREEN_HISTORY_FILE, "utf-8"));
      if (data.lastRunCommit) {
        return data.lastRunCommit;
      }
    }
  } catch {
    // ignore
  }
  return "HEAD~1";
}

// Repairable failure types (skip REAL_BUG and TRANSIENT)
const REPAIRABLE_TYPES = new Set([
  FAILURE_TYPES.STALE_SELECTOR,
  FAILURE_TYPES.TEST_EXPECTATION,
  FAILURE_TYPES.UI_REFACTOR,
  FAILURE_TYPES.PERMISSION_CHANGED,
]);

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function loadRepairState() {
  try {
    if (fs.existsSync(REPAIR_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(REPAIR_STATE_FILE, "utf-8"));
    }
  } catch {
    // ignore
  }
  return { runId: null, attempts: {}, stats: { attempted: 0, succeeded: 0, failed: 0, skipped: 0 } };
}

function saveRepairState(state) {
  fs.writeFileSync(REPAIR_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function loadConvergenceState() {
  try {
    if (fs.existsSync(CONVERGENCE_STATE)) {
      return JSON.parse(fs.readFileSync(CONVERGENCE_STATE, "utf-8"));
    }
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Failure extraction from convergence state
// ---------------------------------------------------------------------------

function extractFailures(convergenceState, personaFilter) {
  if (!convergenceState?.personas) {
    return [];
  }

  const failures = [];

  for (const [personaId, persona] of Object.entries(convergenceState.personas)) {
    if (personaFilter && personaId !== personaFilter) {
      continue;
    }

    // Get failures from the most recent iteration
    const latestHistory = persona.history?.[persona.history.length - 1];
    if (!latestHistory || latestHistory.failed === 0) {
      continue;
    }

    for (let i = 0; i < (latestHistory.failedTests ?? []).length; i++) {
      const testTitle = latestHistory.failedTests[i];
      const errorSig = latestHistory.errorSigs?.[i] ?? "";

      failures.push({
        personaId,
        testTitle,
        errorMessage: errorSig,
        specFile: persona.specFile,
        iteration: latestHistory.iteration,
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// LLM patch generation
// ---------------------------------------------------------------------------

async function generatePatch(failure, intentResult) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!geminiKey && !openaiKey) {
    return null;
  }

  let promptTemplate;
  try {
    promptTemplate = fs.readFileSync(PROMPT_FILE, "utf-8");
  } catch {
    return null;
  }

  let testSource = "";
  const specPath = failure.specFile
    ? path.join(ROOT, failure.specFile)
    : null;

  if (specPath && fs.existsSync(specPath)) {
    const fullSource = fs.readFileSync(specPath, "utf-8");
    const testMatch = fullSource.indexOf(failure.testTitle);
    if (testMatch >= 0) {
      const lines = fullSource.split("\n");
      const lineIndex = fullSource.slice(0, testMatch).split("\n").length - 1;
      const start = Math.max(0, lineIndex - 5);
      const end = Math.min(lines.length, lineIndex + 45);
      testSource = lines.slice(start, end).join("\n");
    } else {
      testSource = fullSource.split("\n").slice(0, 100).join("\n");
    }
  }

  const sinceRef = getLastRunCommit();
  let gitDiff = "";
  try {
    gitDiff = execSync(`git diff ${sinceRef}..HEAD -- app/ components/ lib/`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 512 * 1024,
    });
    if (gitDiff.length > 3000) {
      gitDiff = gitDiff.slice(0, 3000) + "\n... (truncated)";
    }
  } catch {
    // ignore
  }

  const prompt = promptTemplate
    .replace("{{testFile}}", failure.specFile ?? "(unknown)")
    .replace("{{testSource}}", testSource.slice(0, 3000))
    .replace("{{errorMessage}}", failure.errorMessage ?? "(unknown)")
    .replace("{{failureType}}", failure.failureType ?? "(unknown)")
    .replace("{{intentAnalysis}}", JSON.stringify(intentResult ?? {}, null, 2))
    .replace("{{gitDiff}}", gitDiff);

  // Prefer Gemini; fallback to OpenAI
  if (geminiKey) {
    const result = await generatePatchGemini(geminiKey, prompt);
    if (result) return result;
  }
  if (openaiKey) {
    const result = await generatePatchOpenAI(openaiKey, prompt);
    if (result) return result;
  }
  return null;
}

async function generatePatchGemini(apiKey, prompt) {
  const model = process.env.REPAIR_AGENT_GEMINI_MODEL ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens: 1000,
        },
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const usage = data.usageMetadata ?? {};
    logTokenUsage({
      component: "repair-agent",
      inputTokens: usage.promptTokenCount ?? Math.ceil(prompt.length / 4),
      outputTokens: usage.candidatesTokenCount ?? Math.ceil(text.length / 4),
      provider: "gemini",
      model,
    });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function generatePatchOpenAI(apiKey, prompt) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 1000,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const usage = data.usage ?? {};
    logTokenUsage({
      component: "repair-agent",
      inputTokens: usage.prompt_tokens ?? Math.ceil(prompt.length / 4),
      outputTokens: usage.completion_tokens ?? Math.ceil(content.length / 4),
      provider: "openai",
      model: "gpt-4o-mini",
    });
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Patch application + validation
// ---------------------------------------------------------------------------

function applyPatch(patchResult) {
  if (!patchResult?.canRepair || !patchResult.patch) {
    return { applied: false, reason: "LLM said canRepair=false or no patch" };
  }

  const patchFile = patchResult.patch.file;
  if (!patchFile) {
    return { applied: false, reason: "No file specified in patch" };
  }

  const fullPath = path.isAbsolute(patchFile) ? patchFile : path.join(ROOT, patchFile);

  // Safety: only modify files under e2e/tests/
  if (!fullPath.replace(/\\/g, "/").includes("e2e/tests/")) {
    return { applied: false, reason: `Safety: ${patchFile} is not under e2e/tests/` };
  }

  if (!fs.existsSync(fullPath)) {
    return { applied: false, reason: `File not found: ${patchFile}` };
  }

  // Create backup
  const bakPath = fullPath + ".bak";
  const originalContent = fs.readFileSync(fullPath, "utf-8");
  fs.writeFileSync(bakPath, originalContent);

  // Apply changes
  let content = originalContent;
  const changes = patchResult.patch.changes ?? [];

  for (const change of changes) {
    if (!change.oldLine || !change.newLine) {
      continue;
    }

    // Find and replace (first occurrence only)
    const index = content.indexOf(change.oldLine);
    if (index === -1) {
      // Revert
      fs.writeFileSync(fullPath, originalContent);
      return { applied: false, reason: `Could not find "${change.oldLine.slice(0, 60)}" in file` };
    }

    content = content.slice(0, index) + change.newLine + content.slice(index + change.oldLine.length);
  }

  if (content === originalContent) {
    return { applied: false, reason: "No changes applied (content unchanged)" };
  }

  fs.writeFileSync(fullPath, content);
  return { applied: true, bakPath, fullPath, changesApplied: changes.length };
}

function revertPatch(fullPath) {
  const bakPath = fullPath + ".bak";
  if (fs.existsSync(bakPath)) {
    fs.copyFileSync(bakPath, fullPath);
    fs.unlinkSync(bakPath);
    return true;
  }
  return false;
}

function cleanupBackup(fullPath) {
  const bakPath = fullPath + ".bak";
  if (fs.existsSync(bakPath)) {
    fs.unlinkSync(bakPath);
  }
}

function validatePatch(specFile, testTitle) {
  // Run just this one test to validate the patch
  const specPath = path.isAbsolute(specFile) ? specFile : path.join(ROOT, specFile);
  const relSpec = path.relative(E2E_DIR, specPath);

  // Escape test title for grep
  const escaped = testTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  try {
    const result = spawnSync(
      "npx",
      ["playwright", "test", relSpec, "--grep", escaped, "--workers=1", "--reporter=list"],
      {
        cwd: E2E_DIR,
        encoding: "utf-8",
        timeout: 120000,
        env: { ...process.env, E2E_COVERAGE: "0" }, // Disable coverage during validation
      }
    );

    return result.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Record learned fix patterns
// ---------------------------------------------------------------------------

function recordLearnedFix(failure, patchResult) {
  let patterns = [];
  try {
    if (fs.existsSync(LEARNED_FIXES_FILE)) {
      patterns = JSON.parse(fs.readFileSync(LEARNED_FIXES_FILE, "utf-8"));
    }
  } catch {
    patterns = [];
  }

  patterns.push({
    type: "llm_repair",
    failureType: failure.failureType,
    persona: failure.personaId,
    description: patchResult.explanation ?? "LLM-generated repair",
    testFile: failure.specFile,
    changes: (patchResult.patch?.changes ?? []).map((c) => ({
      old: c.oldLine?.slice(0, 100),
      new: c.newLine?.slice(0, 100),
    })),
    appliedAt: new Date().toISOString(),
  });

  // Keep last 100 entries
  if (patterns.length > 100) {
    patterns = patterns.slice(-100);
  }

  fs.writeFileSync(LEARNED_FIXES_FILE, JSON.stringify(patterns, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Main repair pipeline
// ---------------------------------------------------------------------------

async function repairFailures(opts) {
  const convergenceState = loadConvergenceState();
  if (!convergenceState) {
    if (!opts.json) {
      console.log("[repair-agent] No convergence state found. Run convergence-loop first.");
    }
    return { attempted: 0, succeeded: 0, failed: 0, skipped: 0, results: [] };
  }

  const repairState = loadRepairState();
  repairState.runId = convergenceState.runId ?? `repair-${Date.now().toString(36)}`;

  // Post-loop mode: reset attempt counts for a fresh sweep and raise max-repairs
  if (opts.postLoop) {
    repairState.attempts = {};
    repairState.stats = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
    if (opts.maxRepairs === 10) {
      opts.maxRepairs = 20; // Higher default for post-loop sweep
    }
  }

  const failures = extractFailures(convergenceState, opts.persona);

  if (failures.length === 0) {
    if (!opts.json) {
      console.log("[repair-agent] No failures to repair.");
    }
    return { attempted: 0, succeeded: 0, failed: 0, skipped: 0, results: [] };
  }

  if (!opts.json) {
    console.log(`[repair-agent] ${failures.length} failure(s) found, max ${opts.maxRepairs} repairs${opts.dryRun ? " (dry-run)" : ""}`);
  }

  const results = [];
  let repairCount = 0;

  for (const failure of failures) {
    if (repairCount >= opts.maxRepairs) {
      break;
    }

    // Check attempt limit (max 3 per test per run)
    const attemptKey = failure.testTitle;
    const existing = repairState.attempts[attemptKey];
    if (existing && existing.attempts >= 3) {
      results.push({ testTitle: failure.testTitle, outcome: "skipped", reason: "Max 3 attempts reached" });
      repairState.stats.skipped++;
      continue;
    }

    // Step 1: Classify failure type
    const failureType = classifyFailureType({
      description: failure.errorMessage,
      page: failure.specFile ?? "",
    });
    failure.failureType = failureType;

    // Step 2: Skip non-repairable types
    if (!REPAIRABLE_TYPES.has(failureType)) {
      if (!opts.json) {
        console.log(`  SKIP: ${failure.testTitle.slice(0, 60)} — ${failureType} (not repairable)`);
      }
      results.push({ testTitle: failure.testTitle, outcome: "skipped", reason: `Type ${failureType} not repairable` });
      repairState.stats.skipped++;
      continue;
    }

    // Step 3: Analyze intent (commit-aware: uses lastRunCommit)
    const sinceCommit = getLastRunCommit();
    let intentResult = null;
    try {
      intentResult = await analyzeIntent({
        test: failure.specFile,
        error: failure.errorMessage,
        codeAreas: null,
        since: sinceCommit,
      });
    } catch {
      intentResult = { intent: "uncertain", confidence: 0.3 };
    }

    // Step 4: Skip if regression (real bug)
    if (intentResult?.intent === "regression" && intentResult.confidence >= 0.7) {
      if (!opts.json) {
        console.log(`  SKIP: ${failure.testTitle.slice(0, 60)} — regression detected (${(intentResult.confidence * 100).toFixed(0)}% confidence)`);
      }
      results.push({ testTitle: failure.testTitle, outcome: "skipped", reason: "Regression detected", intentResult });
      repairState.stats.skipped++;
      continue;
    }

    // Step 5: Generate patch via LLM
    if (!opts.json) {
      console.log(`  REPAIR: ${failure.testTitle.slice(0, 60)} (${failureType}, intent: ${intentResult?.intent ?? "unknown"})`);
    }

    // Record attempt
    if (!repairState.attempts[attemptKey]) {
      repairState.attempts[attemptKey] = { attempts: 0, outcome: null };
    }
    repairState.attempts[attemptKey].attempts++;
    repairState.stats.attempted++;
    repairCount++;

    if (opts.dryRun) {
      results.push({ testTitle: failure.testTitle, outcome: "dry-run", failureType, intentResult });
      continue;
    }

    const patchResult = await generatePatch(failure, intentResult);

    if (!patchResult || !patchResult.canRepair) {
      if (!opts.json) {
        console.log(`    LLM: cannot repair — ${patchResult?.explanation ?? "no response"}`);
      }
      results.push({ testTitle: failure.testTitle, outcome: "failed", reason: "LLM cannot repair" });
      repairState.attempts[attemptKey].outcome = "failed";
      repairState.stats.failed++;
      continue;
    }

    // Step 6: Apply patch
    const applyResult = applyPatch(patchResult);

    if (!applyResult.applied) {
      if (!opts.json) {
        console.log(`    APPLY FAILED: ${applyResult.reason}`);
      }
      results.push({ testTitle: failure.testTitle, outcome: "failed", reason: applyResult.reason });
      repairState.attempts[attemptKey].outcome = "failed";
      repairState.stats.failed++;
      continue;
    }

    if (!opts.json) {
      console.log(`    Applied ${applyResult.changesApplied} change(s). Validating...`);
    }

    // Step 7: Validate by re-running the single test
    const valid = validatePatch(failure.specFile, failure.testTitle);

    if (valid) {
      // Keep the patch
      cleanupBackup(applyResult.fullPath);
      recordLearnedFix(failure, patchResult);

      if (!opts.json) {
        console.log(`    PASS — patch kept`);
      }
      results.push({
        testTitle: failure.testTitle,
        outcome: "success",
        explanation: patchResult.explanation,
        changes: patchResult.patch?.changes?.length ?? 0,
      });
      repairState.attempts[attemptKey].outcome = "success";
      repairState.stats.succeeded++;
    } else {
      // Revert
      revertPatch(applyResult.fullPath);

      if (!opts.json) {
        console.log(`    FAIL — patch reverted`);
      }
      results.push({ testTitle: failure.testTitle, outcome: "failed", reason: "Validation failed (test still red)" });
      repairState.attempts[attemptKey].outcome = "failed";
      repairState.stats.failed++;
    }
  }

  saveRepairState(repairState);

  return {
    attempted: repairState.stats.attempted,
    succeeded: repairState.stats.succeeded,
    failed: repairState.stats.failed,
    skipped: repairState.stats.skipped,
    results,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const summary = await repairFailures(opts);

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\n[repair-agent] Summary: ${summary.attempted} attempted, ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.skipped} skipped`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[repair-agent]", e);
    process.exit(1);
  });
}

module.exports = { repairFailures };
