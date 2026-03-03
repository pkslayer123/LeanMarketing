#!/usr/bin/env node

/**
 * convergence-loop.js — Work-driven persona testing loop.
 *
 * Instead of running all personas for a fixed number of iterations, this runs
 * all personas once, then re-runs only those with failures/findings until they
 * converge (all pass) or get stuck (no progress after 3 iterations).
 *
 * Result: Iteration 1 runs 58 personas (10 min). Iteration 2 runs only the 12
 * that failed (2 min). Iteration 3 runs the 4 still failing (30 sec). Total:
 * ~13 min vs ~30 min for 3 full fixed iterations.
 *
 * Usage:
 *   node scripts/e2e/convergence-loop.js                                 # All personas
 *   node scripts/e2e/convergence-loop.js --subset "cliff-patience,wanda-walls"
 *   node scripts/e2e/convergence-loop.js --max-iterations 5              # Safety limit (default 10)
 *   node scripts/e2e/convergence-loop.js --no-auto-fix                   # Skip pre-iteration-fix
 *   node scripts/e2e/convergence-loop.js --workers 8                     # Override worker count
 *   node scripts/e2e/convergence-loop.js --resume                        # Resume interrupted run
 *   node scripts/e2e/convergence-loop.js --verbose                       # Per-test detail logging
 *   node scripts/e2e/convergence-loop.js --completion-promise "DONE"     # Output string on convergence
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, "..", "..");
const E2E_DIR = path.join(ROOT, "e2e");
const STATE_DIR = path.join(E2E_DIR, "state");
const RESULTS_JSON = path.join(E2E_DIR, "test-results", "results.json");
const FINDINGS_PATH = path.join(STATE_DIR, "findings", "findings.json");
const CONVERGENCE_STATE = path.join(STATE_DIR, "convergence-state.json");
const REPORTS_DIR = path.join(E2E_DIR, "reports");
const PERSONAS_DIR = path.join(E2E_DIR, "tests", "personas");
const PERF_LOG = path.join(STATE_DIR, "loop-performance.jsonl");
const ORACLE_REPORTS_DIR = path.join(E2E_DIR, "oracle", "reports");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    maxIterations: 10,
    workers: parseInt(process.env.E2E_WORKERS ?? "1", 10),
    subset: null,
    noAutoFix: false,
    resume: false,
    verbose: false,
    completionPromise: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--max-iterations":
        opts.maxIterations = parseInt(args[++i], 10);
        break;
      case "--workers":
        opts.workers = parseInt(args[++i], 10);
        break;
      case "--subset":
        opts.subset = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--no-auto-fix":
        opts.noAutoFix = true;
        break;
      case "--resume":
        opts.resume = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "--completion-promise":
        opts.completionPromise = args[++i];
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------
function generateRunId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `convergence-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function createInitialState(opts) {
  return {
    version: 1,
    runId: generateRunId(),
    startedAt: new Date().toISOString(),
    status: "running",
    iteration: 0,
    maxIterations: opts.maxIterations,
    personas: {},
    workQueue: [],
    converged: [],
    stuck: [],
    iterations: [],
  };
}

function loadState() {
  if (!fs.existsSync(CONVERGENCE_STATE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(CONVERGENCE_STATE, "utf-8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(CONVERGENCE_STATE), { recursive: true });
  fs.writeFileSync(CONVERGENCE_STATE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Persona discovery
// ---------------------------------------------------------------------------
function discoverPersonas(subset) {
  const allFiles = fs.readdirSync(PERSONAS_DIR).filter((f) => f.endsWith(".spec.ts"));
  const personas = {};
  for (const file of allFiles) {
    const id = file.replace(".spec.ts", "");
    if (subset && !subset.includes(id)) {
      continue;
    }
    personas[id] = {
      status: "in_queue",
      specFile: `tests/personas/${file}`,
      history: [],
      convergedAt: null,
      stuckReason: null,
    };
  }
  return personas;
}

// ---------------------------------------------------------------------------
// Playwright results parsing (matches test-frequency.js walkSpecs pattern)
// ---------------------------------------------------------------------------
function walkSuites(suites, fn) {
  if (!suites || !Array.isArray(suites)) {
    return;
  }
  for (const suite of suites) {
    if (suite.specs && Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        fn(spec, suite);
      }
    }
    if (suite.suites) {
      walkSuites(suite.suites, fn);
    }
  }
}

/**
 * Parse results.json and group by persona spec file.
 * Returns: { "cliff-patience": { passed: 12, failed: 3, failedTests: [...], errorSigs: [...] } }
 */
function parseResultsByPersona() {
  if (!fs.existsSync(RESULTS_JSON)) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(RESULTS_JSON, "utf-8"));
  } catch {
    return null;
  }

  const results = {};

  walkSuites(data.suites ?? [], (spec, suite) => {
    // Extract persona ID from the suite file path
    // e.g. "tests/personas/cliff-patience.spec.ts" → "cliff-patience"
    const filePath = suite.file || spec.file || "";
    const match = filePath.match(/personas[/\\]([^/\\]+)\.spec\.ts/);
    if (!match) {
      return;
    }
    const personaId = match[1];

    if (!results[personaId]) {
      results[personaId] = { passed: 0, failed: 0, failedTests: [], errorSigs: [] };
    }

    const tests = spec.tests ?? [];
    for (const t of tests) {
      if (t.status === "expected" || t.status === "passed") {
        results[personaId].passed++;
      } else if (t.status === "unexpected" || t.status === "flaky") {
        results[personaId].failed++;
        results[personaId].failedTests.push(spec.title || "unknown");
        // Capture first 80 chars of error for stuckness signature
        const errorMsg = t.results?.[0]?.error?.message ?? "";
        results[personaId].errorSigs.push(errorMsg.slice(0, 80));
      }
    }
  });

  return results;
}

// ---------------------------------------------------------------------------
// Findings detection
// ---------------------------------------------------------------------------
function loadFindings() {
  if (!fs.existsSync(FINDINGS_PATH)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(FINDINGS_PATH, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Count new unresolved findings per persona since a given timestamp.
 */
function countNewFindings(beforeSnapshot, iterationStart) {
  const current = loadFindings();
  const counts = {};

  for (const finding of current) {
    if (finding.status === "noise" || finding.status === "resolved") {
      continue;
    }
    const ts = finding.timestamp || finding.firstSeen;
    if (!ts || new Date(ts) < new Date(iterationStart)) {
      continue;
    }
    // Check it wasn't in the before-snapshot
    const wasKnown = beforeSnapshot.some(
      (f) => f.description === finding.description && f.persona === finding.persona
    );
    if (wasKnown) {
      continue;
    }
    const persona = finding.persona;
    if (persona) {
      // Normalize persona name to ID: "Cliff Patience" → "cliff-patience"
      const personaId = persona.toLowerCase().replace(/\s+/g, "-");
      counts[personaId] = (counts[personaId] ?? 0) + 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Stuckness detection
// ---------------------------------------------------------------------------
const STUCK_THRESHOLD = 3; // iterations with zero progress

function isStuck(history) {
  if (history.length < STUCK_THRESHOLD) {
    return null;
  }
  const recent = history.slice(-STUCK_THRESHOLD);

  // Check: same or worse failed count across all recent iterations
  const failCounts = recent.map((h) => h.failed);
  const noImprovement = failCounts.every((f) => f >= failCounts[0]);
  if (!noImprovement) {
    return null;
  }

  // Check: same error signatures repeating
  const sigSets = recent.map((h) => new Set(h.errorSigs));
  const firstSigs = sigSets[0];
  const sameSigs = sigSets.every((s) => {
    if (s.size !== firstSigs.size) {
      return false;
    }
    for (const sig of s) {
      if (!firstSigs.has(sig)) {
        return false;
      }
    }
    return true;
  });

  if (sameSigs && firstSigs.size > 0) {
    const topSig = [...firstSigs][0] || "unknown error";
    return `Same ${failCounts[0]} failure(s) for ${STUCK_THRESHOLD} iterations: ${topSig}`;
  }

  if (noImprovement) {
    return `No progress: ${failCounts.join(" → ")} failures over ${STUCK_THRESHOLD} iterations`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Run Playwright for specific spec files
// ---------------------------------------------------------------------------
function runPlaywright(specFiles, workers, verbose, iteration) {
  const specArgs = specFiles.map((f) => path.posix.join("tests", "personas", path.basename(f)));
  // Worker auto-scaling: for small queues, don't over-allocate
  const effectiveWorkers = Math.min(workers, specFiles.length * 2);

  const reporterArg = verbose ? "list,json" : "json";
  const cmd = [
    "npx",
    "playwright",
    "test",
    ...specArgs,
    `--workers=${effectiveWorkers}`,
    `--reporter=${reporterArg}`,
  ].join(" ");

  console.log(`  Running: ${cmd}`);
  const env = {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: "test-results/results.json",
    CONVERGENCE_ITERATION: String(iteration ?? 0),
  };

  const result = spawnSync(cmd, {
    cwd: E2E_DIR,
    stdio: verbose ? "inherit" : "pipe",
    shell: true,
    env,
    timeout: 600_000, // 10 min max per iteration
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

// ---------------------------------------------------------------------------
// Run hook scripts (reuse existing run-loop-hooks.js)
// ---------------------------------------------------------------------------
function runHook(cmd, description) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: "pipe", timeout: 120_000 });
  } catch (e) {
    console.warn(`  [hook] ${description} failed (non-fatal): ${e.message?.slice(0, 100) ?? e}`);
  }
}

function runBeforeIteration(iteration, noAutoFix) {
  if (iteration > 1 && !noAutoFix) {
    runHook(
      `node scripts/e2e/run-loop-hooks.js before-iteration --iteration ${iteration}`,
      "before-iteration"
    );
  }
}

function runAfterTests(iteration, passed, failed) {
  runHook(
    `node scripts/e2e/run-loop-hooks.js after-tests --iteration ${iteration} --passed ${passed} --failed ${failed}`,
    "after-tests"
  );
}

function runAfterIteration(iteration) {
  // Apply selector migrations (auto-rewrite test files from resilience fallbacks)
  runHook("node scripts/e2e/apply-selector-migrations.js --apply", "selector-migrations");

  runHook(
    `node scripts/e2e/run-loop-hooks.js after-iteration --iteration ${iteration}`,
    "after-iteration"
  );
  // Update test frequency tiers
  if (fs.existsSync(RESULTS_JSON)) {
    runHook(
      `node scripts/e2e/test-frequency.js --update ${RESULTS_JSON}`,
      "test-frequency update"
    );
  }
  // Auto-triage findings
  runHook("node scripts/e2e/auto-triage.js", "auto-triage");
  // Debottleneck analysis
  runHook("node scripts/e2e/debottleneck-analysis.js", "debottleneck-analysis");
}

// ---------------------------------------------------------------------------
// Performance logging (append to loop-performance.jsonl)
// ---------------------------------------------------------------------------
function logPerformance(iteration, personasRun, passed, failed, duration, workers) {
  const entry = {
    iter: iteration,
    duration: Math.round(duration / 1000),
    passRate: personasRun > 0 ? Math.round(((passed / (passed + failed)) * 100) || 0) : 0,
    workers,
    total: passed + failed,
    mode: "convergence",
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(PERF_LOG, JSON.stringify(entry) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Oracle token budget tracking
// ---------------------------------------------------------------------------
function readLatestOracleTokens() {
  if (!fs.existsSync(ORACLE_REPORTS_DIR)) {
    return null;
  }
  try {
    const files = fs.readdirSync(ORACLE_REPORTS_DIR)
      .filter((f) => f.startsWith("budget-") && f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length === 0) {
      return null;
    }
    const latest = JSON.parse(fs.readFileSync(path.join(ORACLE_REPORTS_DIR, files[0]), "utf-8"));
    return {
      inputTokens: latest.totalInputTokens ?? 0,
      outputTokens: latest.totalOutputTokens ?? 0,
      cost: latest.estimatedCostUSD ?? 0,
      calls: latest.totalCalls ?? 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stuck diagnostics integration
// ---------------------------------------------------------------------------
function runStuckDiagnostics(personaId) {
  try {
    execSync(
      `node scripts/e2e/stuck-diagnostics.js --persona ${personaId}`,
      { cwd: ROOT, stdio: "pipe", timeout: 60_000 }
    );
  } catch (e) {
    console.warn(`  [stuck-diagnostics] Failed for ${personaId}: ${e.message?.slice(0, 80) ?? e}`);
  }
}

function loadStuckDiagnostics() {
  const diagPath = path.join(STATE_DIR, "stuck-diagnostics.json");
  if (!fs.existsSync(diagPath)) {
    return {};
  }
  try {
    const data = JSON.parse(fs.readFileSync(diagPath, "utf-8"));
    return data.diagnostics ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------
function generateReport(state) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const reportPath = path.join(REPORTS_DIR, `convergence-${timestamp}.md`);

  const totalDuration = state.iterations.reduce((sum, i) => sum + i.duration, 0);
  const durationStr = totalDuration >= 60
    ? `${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s`
    : `${totalDuration}s`;

  let md = `# Convergence Report\n`;
  md += `**Status:** ${state.status} | **Duration:** ${durationStr} | **Iterations:** ${state.iteration} of ${state.maxIterations}\n\n`;

  // Iteration summary table
  const hasTokens = state.iterations.some((i) => i.oracleTokens);
  if (hasTokens) {
    md += `| Iter | Personas | Passed | Failed | Duration | Converged | Oracle Cost |\n`;
    md += `|------|----------|--------|--------|----------|-----------|-------------|\n`;
  } else {
    md += `| Iter | Personas | Passed | Failed | Duration | Newly Converged |\n`;
    md += `|------|----------|--------|--------|----------|-----------------|\n`;
  }
  for (const iter of state.iterations) {
    const durStr = iter.duration >= 60
      ? `${Math.floor(iter.duration / 60)}m ${iter.duration % 60}s`
      : `${iter.duration}s`;
    if (hasTokens) {
      const costStr = iter.oracleCost != null ? `$${iter.oracleCost.toFixed(3)}` : "-";
      md += `| ${iter.iter} | ${iter.personasRun} | ${iter.passed} | ${iter.failed} | ${durStr} | ${iter.newlyConverged ?? 0} | ${costStr} |\n`;
    } else {
      md += `| ${iter.iter} | ${iter.personasRun} | ${iter.passed} | ${iter.failed} | ${durStr} | ${iter.newlyConverged ?? 0} |\n`;
    }
  }
  md += `\n`;

  // Cumulative oracle cost
  const totalOracleCost = state.iterations.reduce((sum, i) => sum + (i.oracleCost ?? 0), 0);
  const totalOracleTokens = state.iterations.reduce((sum, i) => sum + (i.oracleTokens ?? 0), 0);
  if (totalOracleTokens > 0) {
    md += `**Oracle:** ${totalOracleTokens.toLocaleString()} tokens, $${totalOracleCost.toFixed(3)} total\n\n`;
  }

  // Totals
  md += `**Converged:** ${state.converged.length} | **Stuck:** ${state.stuck.length} | **Remaining:** ${state.workQueue.length}\n\n`;

  // Stuck personas (with diagnostic details if available)
  if (state.stuck.length > 0) {
    const diags = loadStuckDiagnostics();
    md += `## Stuck (needs human review)\n`;
    for (const id of state.stuck) {
      const p = state.personas[id];
      const lastHist = p?.history[p.history.length - 1];
      const failCount = lastHist?.failed ?? "?";
      const iters = p?.history.length ?? "?";
      const diag = diags[id];
      md += `- **${id}:** ${p?.stuckReason ?? "unknown"} (${failCount} tests, ${iters} iterations)\n`;
      if (diag) {
        md += `  - Category: \`${diag.category}\` (${diag.diagnosisSource ?? "regex"}, confidence: ${diag.confidence ?? "?"})\n`;
        md += `  - Pattern: ${diag.errorPattern}\n`;
        md += `  - Fix: ${diag.suggestedFix}\n`;
        if (diag.rootCause) {
          md += `  - Root cause: ${diag.rootCause}\n`;
        }
      }
    }
    md += `\n`;
  }

  // Per-persona progression (only non-trivial ones: had failures or took >1 iter)
  const interesting = Object.entries(state.personas).filter(
    ([, p]) => p.history.length > 1 || p.history.some((h) => h.failed > 0)
  );
  if (interesting.length > 0) {
    md += `## Persona Progression\n`;
    for (const [id, p] of interesting) {
      const progression = p.history
        .map((h) => `Iter ${h.iteration}: ${h.passed}/${h.passed + h.failed} pass`)
        .join(" -> ");
      const badge = p.status === "converged" ? " (CONVERGED)" : p.status === "stuck" ? " (STUCK)" : "";
      md += `- **${id}:** ${progression}${badge}\n`;
    }
    md += `\n`;
  }

  // Converged list
  if (state.converged.length > 0) {
    md += `## Converged (${state.converged.length})\n`;
    md += state.converged.map((id) => `\`${id}\``).join(", ") + "\n\n";
  }

  md += `---\n_Generated: ${new Date().toISOString()}_\n`;

  fs.writeFileSync(reportPath, md, "utf-8");
  console.log(`\nReport: ${reportPath}`);
  return reportPath;
}

// ---------------------------------------------------------------------------
// SIGINT handler — save state on Ctrl+C
// ---------------------------------------------------------------------------
let currentState = null;

function setupSigintHandler() {
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) {
      console.log("\nForce exit.");
      process.exit(1);
    }
    interrupted = true;
    console.log("\n\nInterrupted! Saving state for --resume...");
    if (currentState) {
      currentState.status = "interrupted";
      saveState(currentState);
      generateReport(currentState);
      console.log("State saved. Resume with: node scripts/e2e/convergence-loop.js --resume");
    }
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------
// Main convergence loop
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs();
  setupSigintHandler();

  let state;
  if (opts.resume) {
    state = loadState();
    if (!state || state.status === "converged" || state.status === "max_iterations") {
      console.log("No interrupted run to resume (status: " + (state?.status ?? "none") + "). Starting fresh.");
      state = null;
    }
    if (state) {
      console.log(`Resuming run ${state.runId} at iteration ${state.iteration + 1}`);
      state.status = "running";
    }
  }

  if (!state) {
    state = createInitialState(opts);
    // Discover personas
    const personas = discoverPersonas(opts.subset);
    const personaIds = Object.keys(personas);
    if (personaIds.length === 0) {
      console.error("No persona spec files found.");
      process.exit(1);
    }
    state.personas = personas;
    state.workQueue = personaIds;
    console.log(`Convergence loop: ${personaIds.length} personas, max ${opts.maxIterations} iterations`);
  }

  currentState = state;
  saveState(state);

  // Main loop
  while (state.workQueue.length > 0 && state.iteration < state.maxIterations) {
    state.iteration++;
    const iter = state.iteration;

    const queuedPersonas = [...state.workQueue];
    const specFiles = queuedPersonas.map((id) => state.personas[id].specFile);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`  Iteration ${iter}: ${queuedPersonas.length} persona(s) in queue`);
    console.log(`  ${queuedPersonas.join(", ")}`);
    console.log(`${"=".repeat(60)}`);

    // Before-iteration hooks
    runBeforeIteration(iter, opts.noAutoFix);

    // Snapshot findings before run
    const findingsBefore = loadFindings();
    const iterationStart = new Date().toISOString();

    // Run Playwright
    const startTime = Date.now();
    const { exitCode } = runPlaywright(specFiles, opts.workers, opts.verbose, iter);
    const durationSec = Math.round((Date.now() - startTime) / 1000);

    // Handle Playwright crash (exit code > 1 with no results)
    if (exitCode > 1 && !fs.existsSync(RESULTS_JSON)) {
      console.error(`  Playwright crashed (exit ${exitCode}), retrying once...`);
      const retry = runPlaywright(specFiles, opts.workers, opts.verbose, iter);
      if (retry.exitCode > 1 && !fs.existsSync(RESULTS_JSON)) {
        console.error("  Second crash — marking all queued personas as stuck.");
        for (const id of queuedPersonas) {
          state.personas[id].status = "stuck";
          state.personas[id].stuckReason = `Playwright crash (exit code ${retry.exitCode})`;
          state.stuck.push(id);
        }
        state.workQueue = [];
        break;
      }
    }

    // Parse results
    const results = parseResultsByPersona();
    if (!results || Object.keys(results).length === 0) {
      console.error("  No test results parsed — aborting to avoid false convergence.");
      state.status = "error";
      break;
    }

    // Detect new findings
    const newFindingCounts = countNewFindings(findingsBefore, iterationStart);

    // Process each persona
    let totalPassed = 0;
    let totalFailed = 0;
    let newlyConverged = 0;

    for (const id of queuedPersonas) {
      const r = results[id] ?? { passed: 0, failed: 0, failedTests: [], errorSigs: [] };
      const newFindings = newFindingCounts[id] ?? 0;
      totalPassed += r.passed;
      totalFailed += r.failed;

      // Record history
      const histEntry = {
        iteration: iter,
        passed: r.passed,
        failed: r.failed,
        newFindings,
        failedTests: r.failedTests.slice(0, 10), // cap for state file size
        errorSigs: r.errorSigs.slice(0, 10),
      };
      state.personas[id].history.push(histEntry);

      if (opts.verbose) {
        console.log(`  ${id}: ${r.passed} passed, ${r.failed} failed, ${newFindings} new findings`);
      }

      // Check convergence: all pass + no new findings
      if (r.failed === 0 && newFindings === 0) {
        state.personas[id].status = "converged";
        state.personas[id].convergedAt = iter;
        state.converged.push(id);
        state.workQueue = state.workQueue.filter((x) => x !== id);
        newlyConverged++;
        if (opts.verbose) {
          console.log(`    -> CONVERGED`);
        }
        continue;
      }

      // Check stuckness
      const stuckReason = isStuck(state.personas[id].history);
      if (stuckReason) {
        state.personas[id].status = "stuck";
        state.personas[id].stuckReason = stuckReason;
        state.stuck.push(id);
        state.workQueue = state.workQueue.filter((x) => x !== id);
        // Run stuck diagnostics (regex + optional LLM)
        runStuckDiagnostics(id);
        if (opts.verbose) {
          console.log(`    -> STUCK: ${stuckReason}`);
        }
        continue;
      }

      // Still in queue
    }

    // Read oracle token budget for this iteration
    const oracleTokens = readLatestOracleTokens();

    // Record iteration stats
    const iterEntry = {
      iter,
      personasRun: queuedPersonas.length,
      passed: totalPassed,
      failed: totalFailed,
      duration: durationSec,
      newlyConverged,
    };
    if (oracleTokens) {
      iterEntry.oracleTokens = oracleTokens.inputTokens + oracleTokens.outputTokens;
      iterEntry.oracleCost = Math.round(oracleTokens.cost * 1000) / 1000;
    }
    state.iterations.push(iterEntry);

    console.log(`  Results: ${totalPassed} passed, ${totalFailed} failed, ${newlyConverged} newly converged`);
    console.log(`  Queue: ${state.workQueue.length} remaining, ${state.converged.length} converged, ${state.stuck.length} stuck`);

    // Run after-tests and after-iteration hooks
    runAfterTests(iter, totalPassed, totalFailed);
    runAfterIteration(iter);

    // Repair agent: on iterations 2+, attempt auto-repair of classifiable failures
    if (iter >= 2 && totalFailed > 0) {
      const failingPersonas = state.workQueue.join(",");
      if (failingPersonas) {
        runHook(
          `node scripts/e2e/repair-agent.js --max-repairs 5`,
          "repair-agent"
        );
      }
    }

    // Log performance
    logPerformance(iter, queuedPersonas.length, totalPassed, totalFailed, durationSec * 1000, opts.workers);

    // Save state after every iteration (resumable)
    saveState(state);
  }

  // Post-loop final repair sweep: one last attempt at remaining failures
  const totalFailed = state.iterations[state.iterations.length - 1]?.failed ?? 0;
  if (totalFailed > 0 || state.stuck.length > 0) {
    console.log("\n  Post-loop repair sweep...");
    runHook(
      "node scripts/e2e/repair-agent.js --post-loop --max-repairs 20",
      "post-loop-repair"
    );
  }

  // Determine final status
  if (state.workQueue.length === 0 && state.status === "running") {
    state.status = state.stuck.length > 0 ? "stuck" : "converged";
  } else if (state.iteration >= state.maxIterations && state.workQueue.length > 0) {
    // Hit max iterations — mark remaining as stuck
    for (const id of state.workQueue) {
      state.personas[id].status = "stuck";
      state.personas[id].stuckReason = `Max iterations (${state.maxIterations}) reached`;
      state.stuck.push(id);
    }
    state.workQueue = [];
    state.status = "max_iterations";
  }

  saveState(state);
  const reportPath = generateReport(state);

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  CONVERGENCE LOOP COMPLETE`);
  console.log(`  Status: ${state.status}`);
  console.log(`  Iterations: ${state.iteration}`);
  console.log(`  Converged: ${state.converged.length} personas`);
  console.log(`  Stuck: ${state.stuck.length} personas`);
  console.log(`  Report: ${reportPath}`);
  console.log(`${"=".repeat(60)}`);

  // Completion promise: output string on convergence (for outer loop integration)
  if (opts.completionPromise && state.status === "converged") {
    console.log(opts.completionPromise);
  }

  // Exit code: 0 if fully converged, 1 if stuck/max
  process.exit(state.status === "converged" ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  if (currentState) {
    currentState.status = "error";
    saveState(currentState);
  }
  process.exit(1);
});
