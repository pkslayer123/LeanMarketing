#!/usr/bin/env node

/**
 * verify-iteration.js — Per-phase health gate for the E2E loop
 *
 * Validates that each phase produced expected outputs. Called from loop.sh
 * at phase boundaries. Fast (< 2s), no LLM calls, pure file/JSON checks.
 *
 * Usage:
 *   node scripts/e2e/verify-iteration.js --phase test-results --iteration 1
 *   node scripts/e2e/verify-iteration.js --phase after-tests --iteration 2
 *   node scripts/e2e/verify-iteration.js --phase cp-meta --iteration 1
 *   node scripts/e2e/verify-iteration.js --phase after-iteration --iteration 3 --passed 89 --failed 2
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const E2E = path.join(ROOT, "e2e");
const STATE = path.join(E2E, "state");
const HEALTH_FILE = path.join(STATE, "iteration-health.json");

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

const phase = getArg("--phase");
const iteration = parseInt(getArg("--iteration") ?? "0", 10);
const passedArg = parseInt(getArg("--passed") ?? "0", 10);
const failedArg = parseInt(getArg("--failed") ?? "0", 10);

if (!phase) {
  console.error("Usage: verify-iteration.js --phase <test-results|after-tests|cp-meta|after-iteration> --iteration N");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------
const checks = [];

function check(name, fn) {
  try {
    const result = fn();
    checks.push({ name, passed: result.passed, detail: result.detail });
  } catch (err) {
    checks.push({ name, passed: false, detail: `Exception: ${err.message}` });
  }
}

function validJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return { data: null, error: "file not found" };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return { data: JSON.parse(raw), error: null };
  } catch (e) {
    return { data: null, error: `invalid JSON: ${e.message.slice(0, 80)}` };
  }
}

function fileAge(filePath) {
  if (!fs.existsSync(filePath)) {
    return Infinity;
  }
  return Date.now() - fs.statSync(filePath).mtimeMs;
}

function minutesAgo(ms) {
  return Math.round(ms / 60000);
}

// ---------------------------------------------------------------------------
// Phase checks
// ---------------------------------------------------------------------------

function checkTestResults() {
  const resultsPath = path.join(E2E, "test-results", "results.json");

  check("results.json exists", () => {
    const exists = fs.existsSync(resultsPath);
    return { passed: exists, detail: exists ? "found" : "NOT FOUND — Playwright JSON reporter may not have written output" };
  });

  check("results.json valid JSON", () => {
    const { data, error } = validJson(resultsPath);
    if (error) {
      return { passed: false, detail: error };
    }
    return { passed: true, detail: `keys: ${Object.keys(data).join(", ")}` };
  });

  check("tests actually ran", () => {
    const { data } = validJson(resultsPath);
    if (!data) {
      return { passed: false, detail: "no results data" };
    }
    const stats = data.stats || {};
    const total = (stats.expected || 0) + (stats.unexpected || 0) + (stats.skipped || 0);
    const expected = stats.expected || 0;
    return {
      passed: total > 10,
      detail: `expected=${expected} unexpected=${stats.unexpected || 0} skipped=${stats.skipped || 0} total=${total}`,
    };
  });

  check("pass count non-zero", () => {
    const { data } = validJson(resultsPath);
    if (!data) {
      return { passed: false, detail: "no results data" };
    }
    const expected = data.stats?.expected || 0;
    return {
      passed: expected > 0,
      detail: `${expected} tests passed`,
    };
  });
}

function checkAfterTests() {
  check("findings.json valid", () => {
    const { data, error } = validJson(path.join(STATE, "findings", "findings.json"));
    if (error) {
      return { passed: false, detail: error };
    }
    const count = Array.isArray(data) ? data.length : 0;
    return { passed: true, detail: `${count} findings` };
  });

  check("moc-queue.json valid", () => {
    const { data, error } = validJson(path.join(STATE, "moc-queue.json"));
    if (error) {
      return { passed: false, detail: error };
    }
    const count = Array.isArray(data?.mocs) ? data.mocs.length : 0;
    return { passed: true, detail: `${count} MOCs in queue` };
  });

  check("auto-fix-log.json valid", () => {
    const { data, error } = validJson(path.join(STATE, "auto-fix-log.json"));
    if (error) {
      return { passed: false, detail: error };
    }
    return { passed: true, detail: "valid" };
  });

  check("daemon ran recently", () => {
    // Prefer claw-signals.json (daemon model) over orchestrator-state.json (loop.sh model)
    const signalsPath = path.join(STATE, "claw-signals.json");
    const orchestratorPath = path.join(STATE, "orchestrator-state.json");
    const statePath = fs.existsSync(signalsPath) ? signalsPath : orchestratorPath;
    const age = fileAge(statePath);
    const mins = minutesAgo(age);
    return {
      passed: mins < 30,
      detail: mins < 30 ? `updated ${mins}m ago` : `STALE — last updated ${mins}m ago`,
    };
  });
}

function checkCpMeta() {
  check("moc-queue.json still valid after cp-meta", () => {
    const { data, error } = validJson(path.join(STATE, "moc-queue.json"));
    if (error) {
      return { passed: false, detail: `CORRUPT after cp-meta: ${error}` };
    }
    const count = Array.isArray(data?.mocs) ? data.mocs.length : 0;
    return { passed: true, detail: `${count} MOCs` };
  });

  check("findings.json still valid after cp-meta", () => {
    const { data, error } = validJson(path.join(STATE, "findings", "findings.json"));
    if (error) {
      return { passed: false, detail: `CORRUPT after cp-meta: ${error}` };
    }
    return { passed: true, detail: `${Array.isArray(data) ? data.length : 0} findings` };
  });
}

function checkAfterIteration() {
  // Daemon-compatible: check claw-signals.json (daemon model) or orchestrator-state.json (loop.sh model)
  check("daemon state fresh", () => {
    const signalsPath = path.join(STATE, "claw-signals.json");
    const orchestratorPath = path.join(STATE, "orchestrator-state.json");
    const statePath = fs.existsSync(signalsPath) ? signalsPath : orchestratorPath;
    const age = fileAge(statePath);
    const mins = minutesAgo(age);
    return {
      passed: mins < 10,
      detail: mins < 10 ? `updated ${mins}m ago` : `STALE — last updated ${mins}m ago`,
    };
  });

  check("claws ran successfully", () => {
    const signalsPath = path.join(STATE, "claw-signals.json");
    const orchestratorPath = path.join(STATE, "orchestrator-state.json");

    // Daemon model: check claw-signals.json
    if (fs.existsSync(signalsPath)) {
      const { data } = validJson(signalsPath);
      if (!data?.claws) {
        return { passed: false, detail: "no claw data in signals" };
      }
      const claws = Object.entries(data.claws);
      const okStatuses = new Set(["idle", "running", "stopped", "starting", "waiting"]);
      const errorStatuses = new Set(["circuit_broken", "error"]);
      const ok = claws.filter(([, c]) => okStatuses.has(c.status)).length;
      const errored = claws.filter(([, c]) => errorStatuses.has(c.status)).length;
      return {
        passed: ok > 0,
        detail: `${ok} ok, ${errored} errored out of ${claws.length} claws`,
      };
    }

    // Loop.sh model fallback: orchestrator-state.json
    const { data } = validJson(orchestratorPath);
    if (!data) {
      return { passed: false, detail: "no daemon/orchestrator state" };
    }
    const ok = data.summary?.ok || 0;
    const failed = data.summary?.failed || 0;
    return {
      passed: ok > 0,
      detail: `${ok} ok, ${failed} failed`,
    };
  });

  const criticalClaws = [
    "test-runner",
    "finding-pipeline",
    "fix-engine",
    "health-deploy",
  ];

  check("critical claws healthy", () => {
    const signalsPath = path.join(STATE, "claw-signals.json");
    const orchestratorPath = path.join(STATE, "orchestrator-state.json");

    // Daemon model
    if (fs.existsSync(signalsPath)) {
      const { data } = validJson(signalsPath);
      if (!data?.claws) {
        return { passed: false, detail: "no claw data" };
      }
      const failures = criticalClaws.filter(
        (name) => data.claws[name]?.status === "circuit_broken" || data.claws[name]?.status === "error"
      );
      return {
        passed: failures.length === 0,
        detail: failures.length === 0
          ? `all ${criticalClaws.length} critical claws ok`
          : `FAILED: ${failures.join(", ")}`,
      };
    }

    // Loop.sh model fallback
    const { data } = validJson(orchestratorPath);
    if (!data?.subsystems) {
      return { passed: false, detail: "no subsystem data" };
    }
    const failures = ["self-clean-queue", "feature-health", "coverage-matrix", "improvement-report"].filter(
      (name) => data.subsystems[name]?.status === "failed"
    );
    return {
      passed: failures.length === 0,
      detail: failures.length === 0 ? "all critical subsystems ok" : `FAILED: ${failures.join(", ")}`,
    };
  });

  check("error count reasonable", () => {
    const signalsPath = path.join(STATE, "claw-signals.json");
    const orchestratorPath = path.join(STATE, "orchestrator-state.json");

    if (fs.existsSync(signalsPath)) {
      const { data } = validJson(signalsPath);
      const claws = Object.values(data?.claws ?? {});
      const errored = claws.filter((c) => c.status === "circuit_broken" || c.status === "error").length;
      return {
        passed: errored <= 3,
        detail: errored <= 3 ? `${errored} errors (within threshold)` : `${errored} errors — systemic issue`,
      };
    }

    const { data } = validJson(orchestratorPath);
    const failed = data?.summary?.failed || 0;
    return {
      passed: failed <= 3,
      detail: failed <= 3 ? `${failed} failures (within threshold)` : `${failed} failures — systemic issue`,
    };
  });

  check("green-history.json valid", () => {
    const { data, error } = validJson(path.join(STATE, "green-history.json"));
    if (error) {
      return { passed: false, detail: error };
    }
    const count = Object.keys(data || {}).length;
    return { passed: true, detail: `${count} test entries` };
  });

  check("persona-learning.json valid", () => {
    const { data, error } = validJson(path.join(STATE, "persona-learning.json"));
    if (error) {
      return { passed: false, detail: error };
    }
    const count = Object.keys(data?.personas || data || {}).length;
    return { passed: true, detail: `${count} persona entries` };
  });

  check("iteration report generated", () => {
    const reportsDir = path.join(E2E, "reports");
    if (!fs.existsSync(reportsDir)) {
      return { passed: false, detail: "reports directory missing" };
    }
    const reports = fs.readdirSync(reportsDir).filter(
      (f) => f.startsWith(`iteration-${iteration}-`) && f.endsWith(".md")
    );
    return {
      passed: reports.length > 0,
      detail: reports.length > 0 ? reports[reports.length - 1] : `no iteration-${iteration}-*.md report found`,
    };
  });

  check("passRate recorded", () => {
    return {
      passed: passedArg + failedArg > 0,
      detail: `passed=${passedArg} failed=${failedArg} total=${passedArg + failedArg}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

switch (phase) {
  case "test-results":
    checkTestResults();
    break;
  case "after-tests":
    checkAfterTests();
    break;
  case "cp-meta":
    checkCpMeta();
    break;
  case "after-iteration":
    checkAfterIteration();
    break;
  default:
    console.error(`Unknown phase: ${phase}`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const passed = checks.filter((c) => c.passed).length;
const failed = checks.filter((c) => !c.passed).length;
const total = checks.length;

console.log(`[verify] Phase: ${phase} | Iteration: ${iteration}`);
for (const c of checks) {
  const icon = c.passed ? "[PASS]" : "[FAIL]";
  console.log(`[verify] ${icon} ${c.name}: ${c.detail}`);
}
console.log(`[verify] Result: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ""}`);

// ---------------------------------------------------------------------------
// Persist to iteration-health.json
// ---------------------------------------------------------------------------

try {
  let health = {};
  if (fs.existsSync(HEALTH_FILE)) {
    try {
      health = JSON.parse(fs.readFileSync(HEALTH_FILE, "utf-8"));
    } catch {
      health = {};
    }
  }

  const key = `iteration-${iteration}`;
  if (!health[key]) {
    health[key] = { iteration, timestamp: new Date().toISOString(), phases: {} };
  }

  health[key].phases[phase] = {
    passed,
    failed,
    checks: checks.map((c) => ({
      name: c.name,
      passed: c.passed,
      detail: c.detail,
    })),
  };

  // Recalculate totals
  let totalPassed = 0;
  let totalFailed = 0;
  const failedChecks = [];
  for (const [, phaseData] of Object.entries(health[key].phases)) {
    totalPassed += phaseData.passed || 0;
    totalFailed += phaseData.failed || 0;
    for (const c of phaseData.checks || []) {
      if (!c.passed) {
        failedChecks.push(c.name);
      }
    }
  }
  health[key].totalPassed = totalPassed;
  health[key].totalFailed = totalFailed;
  health[key].failedChecks = failedChecks;
  health[key].timestamp = new Date().toISOString();

  fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2) + "\n");
} catch {
  // Best-effort persistence
}

process.exit(failed > 0 ? 1 : 0);
