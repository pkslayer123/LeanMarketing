#!/usr/bin/env node

/**
 * Health Checks — Pure check functions for diagnostics claw.
 *
 * Each check reads state files and returns:
 *   { name, ok, detail, action? }
 *
 * "action" is present only when the check took a remediation step.
 * Checks do NOT modify state themselves — they return instructions
 * for the diagnostics claw to execute.
 *
 * Genericized: Vercel-specific and project-specific checks are gated
 * behind env vars and config file presence. Generic checks (pass rate,
 * signals, convergence, queue, pool, pipeline, fix efficacy) always run.
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Project root detection — walks up from __dirname looking for config files
// ---------------------------------------------------------------------------

function findProjectRoot() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (
      fs.existsSync(path.join(dir, "persona-engine.json")) ||
      fs.existsSync(path.join(dir, "daemon-config.json")) ||
      fs.existsSync(path.join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return path.resolve(__dirname, "..", "..");
}

const ROOT = findProjectRoot();
const STATE_DIR = path.join(ROOT, "e2e", "state");

/**
 * Read + parse a JSON state file, returning null on any error.
 */
function readState(filename) {
  try {
    const fp = path.join(STATE_DIR, filename);
    if (!fs.existsSync(fp)) { return null; }
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Read the last N entries from a JSONL file.
 */
function readJsonlTail(filename, maxEntries = 50) {
  try {
    const fp = path.join(STATE_DIR, filename);
    if (!fs.existsSync(fp)) { return []; }
    // Try to use claw's readFileTail if available, otherwise read full file
    let content;
    try {
      const clawPath = path.resolve(__dirname, "..", "claw");
      const { readFileTail } = require(clawPath);
      content = readFileTail(fp, 256 * 1024);
    } catch {
      // Fallback: read last 256KB of file
      const stat = fs.statSync(fp);
      if (stat.size > 256 * 1024) {
        const buf = Buffer.alloc(256 * 1024);
        const fd = fs.openSync(fp, "r");
        fs.readSync(fd, buf, 0, buf.length, stat.size - buf.length);
        fs.closeSync(fd);
        content = buf.toString("utf-8");
      } else {
        content = fs.readFileSync(fp, "utf-8");
      }
    }
    const lines = content.split("\n").filter(Boolean);
    return lines
      .slice(-maxEntries)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Check 1: Test Pass Rate Collapse
// ---------------------------------------------------------------------------

/**
 * Detects N consecutive test runs with 0% pass rate (but total > 0 tests).
 * @param {number} collapseRuns — number of consecutive 0% runs to trigger (default 3)
 */
function checkPassRateCollapse(collapseRuns = 3) {
  const entries = readJsonlTail("loop-performance.jsonl", 20);
  if (entries.length < collapseRuns) {
    return { name: "pass-rate-collapse", ok: true, detail: `insufficient data (${entries.length} entries)` };
  }

  // Take last N entries and check if all are 0% pass rate with tests > 0
  const recent = entries.slice(-collapseRuns);
  const allZero = recent.every((e) => {
    const passRate = e.passRate ?? e.pass_rate ?? null;
    const total = e.totalTests ?? e.total ?? e.tests ?? 0;
    return passRate === 0 && total > 0;
  });

  if (!allZero) {
    return { name: "pass-rate-collapse", ok: true, detail: "pass rate within normal range" };
  }

  // Check if collapse started after a deploy
  const signals = readState("claw-signals.json");
  const deploySha = signals?.signals?.["deploy-detected"]?.sha ?? null;
  const deployDetail = deploySha ? ` (after deploy ${deploySha.slice(0, 8)})` : "";

  return {
    name: "pass-rate-collapse",
    ok: false,
    detail: `${collapseRuns} consecutive runs with 0% pass rate${deployDetail}`,
    action: "force-trigger-test-runner",
  };
}

// ---------------------------------------------------------------------------
// Check 2: Signal Flow Timeout
// ---------------------------------------------------------------------------

/**
 * Detects when an upstream signal was emitted but the downstream claw hasn't responded.
 * @param {Record<string, number>} timeouts — signal pair -> max minutes before stale
 */
function checkSignalFlow(timeouts = {
  "tests-complete->finding-pipeline": 90,
  "mocs-ready->fix-engine": 60,
  "fixes-applied->intelligence": 180,
}) {
  const signals = readState("claw-signals.json");
  if (!signals) {
    return { name: "signal-flow", ok: true, detail: "no signals file" };
  }

  const issues = [];

  for (const [pairKey, maxMinutes] of Object.entries(timeouts)) {
    // Support both -> and unicode arrow
    const parts = pairKey.includes("\u2192") ? pairKey.split("\u2192") : pairKey.split("->");
    const signalName = (parts[0] || "").trim();
    const downstreamClaw = (parts[1] || "").trim();
    if (!signalName || !downstreamClaw) { continue; }

    const signalData = signals.signals?.[signalName];
    if (!signalData?.at) { continue; }

    const signalAge = Date.now() - new Date(signalData.at).getTime();
    const maxMs = maxMinutes * 60 * 1000;

    if (signalAge <= maxMs) { continue; }

    // Check if downstream claw is crashed or paused — those are expected stalls
    const clawState = signals.claws?.[downstreamClaw];
    if (clawState?.status === "crashed" || clawState?.status === "paused") { continue; }

    // Check if downstream claw ran after the signal
    const clawLastRun = clawState?.lastRun ? new Date(clawState.lastRun).getTime() : 0;
    const signalTime = new Date(signalData.at).getTime();
    if (clawLastRun > signalTime) { continue; }

    issues.push({
      signal: signalName,
      claw: downstreamClaw,
      staleMins: Math.round(signalAge / 60000),
    });
  }

  if (issues.length === 0) {
    return { name: "signal-flow", ok: true, detail: "all signal flows healthy" };
  }

  const stalled = issues.map((i) => `${i.signal}->${i.claw} (${i.staleMins}min)`).join(", ");
  return {
    name: "signal-flow",
    ok: false,
    detail: `stalled flows: ${stalled}`,
    action: "force-trigger-stalled",
    stalledClaws: issues.map((i) => i.claw),
  };
}

// ---------------------------------------------------------------------------
// Check 3: Convergence / Stuck Response
// ---------------------------------------------------------------------------

/**
 * Responds to diagnostics-requested signal or detects persistent stuck state.
 * @param {number} stuckCycleThreshold — number of stuck cycles before acting
 */
function checkConvergenceStuck(stuckCycleThreshold = 5) {
  const signals = readState("claw-signals.json");
  const convergence = readState("daemon-convergence.json");
  const queue = readState("moc-queue.json");

  // Check for diagnostics-requested signal with reason=stuck
  const diagRequested = signals?.signals?.["diagnostics-requested"];
  const isStuckRequest = diagRequested?.reason === "stuck" &&
    diagRequested?.at &&
    (Date.now() - new Date(diagRequested.at).getTime() < 24 * 3600000);

  // Check convergence state
  const isStuck = convergence?.state === "stuck";
  const stuckCycles = convergence?.stuckCycles ?? 0;

  if (!isStuckRequest && !(isStuck && stuckCycles >= stuckCycleThreshold)) {
    return { name: "convergence-stuck", ok: true, detail: `state: ${convergence?.state ?? "unknown"}, stuckCycles: ${stuckCycles}` };
  }

  // Diagnose root cause
  const fixEngine = signals?.claws?.["fix-engine"];
  const mocs = Array.isArray(queue?.mocs) ? queue.mocs : [];
  const approvedMocs = mocs.filter((m) => m.status === "approved" || m.status === "pending_fix");

  const causes = [];

  if (fixEngine?.status === "crashed") {
    causes.push("fix-engine crashed");
  } else if (fixEngine?.status === "paused") {
    causes.push("fix-engine paused");
  }

  if (approvedMocs.length === 0) {
    causes.push("no approved MOCs in queue");
  }

  const retryLimitMocs = mocs.filter((m) => (m.failures ?? 0) >= 3);
  if (retryLimitMocs.length > 0) {
    causes.push(`${retryLimitMocs.length} MOCs at retry limit`);
  }

  const fixIdle = fixEngine?.lastRun
    ? (Date.now() - new Date(fixEngine.lastRun).getTime() > 3600000)
    : true;
  if (fixIdle && fixEngine?.status !== "crashed" && fixEngine?.status !== "paused") {
    causes.push("fix-engine idle >1h");
  }

  const rootCause = causes.length > 0 ? causes.join("; ") : "unknown root cause";

  return {
    name: "convergence-stuck",
    ok: false,
    detail: `stuck for ${stuckCycles} cycles — ${rootCause}`,
    action: fixIdle ? "force-trigger-fix-engine" : "log-stuck",
    causes,
    retryLimitMocIds: retryLimitMocs.map((m) => m.id),
  };
}

// ---------------------------------------------------------------------------
// Check 4: MOC Queue Stagnation
// ---------------------------------------------------------------------------

/**
 * Detects approved MOCs that haven't progressed.
 * @param {number} staleHours — hours since approval before considered stale
 */
function checkMocQueueStagnation(staleHours = 24) {
  const queue = readState("moc-queue.json");
  const mocs = Array.isArray(queue?.mocs) ? queue.mocs : [];

  const now = Date.now();
  const staleMs = staleHours * 3600000;

  const staleMocs = mocs.filter((m) => {
    if (m.status !== "approved" && m.status !== "pending_fix") { return false; }
    const approvedAt = m.approvedAt ? new Date(m.approvedAt).getTime() : 0;
    return approvedAt > 0 && (now - approvedAt > staleMs);
  });

  if (staleMocs.length === 0) {
    return { name: "moc-queue-stagnation", ok: true, detail: "no stale approved MOCs" };
  }

  // MOCs at retry limit should be escalated to needs_human
  const retryLimitMocs = staleMocs.filter((m) => (m.failures ?? 0) >= 3);
  const pendingMocs = staleMocs.filter((m) => (m.failures ?? 0) < 3);

  const parts = [];
  if (retryLimitMocs.length > 0) {
    parts.push(`${retryLimitMocs.length} at retry limit -> needs_human`);
  }
  if (pendingMocs.length > 0) {
    parts.push(`${pendingMocs.length} approved but untouched`);
  }

  return {
    name: "moc-queue-stagnation",
    ok: false,
    detail: `${staleMocs.length} stale MOCs (${staleHours}h+): ${parts.join(", ")}`,
    action: "escalate-stale-mocs",
    retryLimitMocIds: retryLimitMocs.map((m) => m.id),
    staleMocIds: staleMocs.map((m) => m.id),
  };
}

// ---------------------------------------------------------------------------
// Check 5: Pool Account Health
// ---------------------------------------------------------------------------

/**
 * Reads pool config and returns check metadata.
 * Actual DB queries happen in the diagnostics claw (needs exec context).
 */
function checkPoolAccountHealth() {
  try {
    const poolPath = path.join(ROOT, "e2e", "pool-config.json");
    if (!fs.existsSync(poolPath)) {
      return { name: "pool-account-health", ok: true, detail: "no pool-config.json" };
    }
    const poolConfig = JSON.parse(fs.readFileSync(poolPath, "utf-8"));
    const accounts = poolConfig.accounts ?? poolConfig.pool ?? [];
    if (accounts.length === 0) {
      return { name: "pool-account-health", ok: true, detail: "no pool accounts configured" };
    }
    return {
      name: "pool-account-health",
      ok: true, // Will be re-evaluated after DB check
      detail: `${accounts.length} pool accounts configured`,
      action: "verify-pool-accounts",
      accountEmails: accounts.map((a) => a.email).filter(Boolean),
    };
  } catch {
    return { name: "pool-account-health", ok: true, detail: "pool check skipped (read error)" };
  }
}

// ---------------------------------------------------------------------------
// Check 6: Finding Pipeline Liveness
// ---------------------------------------------------------------------------

/**
 * Detects when finding-pipeline hasn't run despite tests-complete being available.
 * @param {number} stalenessHours — hours of inactivity to trigger
 */
function checkFindingPipelineLiveness(stalenessHours = 2) {
  const signals = readState("claw-signals.json");
  if (!signals) {
    return { name: "finding-pipeline-liveness", ok: true, detail: "no signals file" };
  }

  const testsComplete = signals.signals?.["tests-complete"];
  const pipelineClaw = signals.claws?.["finding-pipeline"];

  if (!testsComplete?.at) {
    return { name: "finding-pipeline-liveness", ok: true, detail: "no tests-complete signal" };
  }

  if (pipelineClaw?.status === "crashed" || pipelineClaw?.status === "paused") {
    return { name: "finding-pipeline-liveness", ok: true, detail: `finding-pipeline is ${pipelineClaw.status}` };
  }

  const signalTime = new Date(testsComplete.at).getTime();
  const pipelineLastRun = pipelineClaw?.lastRun ? new Date(pipelineClaw.lastRun).getTime() : 0;

  // Pipeline ran after the signal — no issue
  if (pipelineLastRun > signalTime) {
    return { name: "finding-pipeline-liveness", ok: true, detail: "finding-pipeline ran after tests-complete" };
  }

  const gapMs = Date.now() - signalTime;
  const maxMs = stalenessHours * 3600000;

  if (gapMs < maxMs) {
    return { name: "finding-pipeline-liveness", ok: true, detail: `tests-complete is ${Math.round(gapMs / 60000)}min old (threshold: ${stalenessHours}h)` };
  }

  return {
    name: "finding-pipeline-liveness",
    ok: false,
    detail: `tests-complete is ${Math.round(gapMs / 60000)}min old but finding-pipeline hasn't run`,
    action: "force-trigger-finding-pipeline",
  };
}

// ---------------------------------------------------------------------------
// Check 7: Deploy Health (optional — requires deploy tracking)
// ---------------------------------------------------------------------------

/**
 * Detects failed deployments that would make testing against prod useless.
 * Reads last-deploy-check.json and checks deploy age.
 *
 * This check is optional — it only runs if last-deploy-check.json exists
 * (written by a deploy monitor configured for the hosting platform).
 */
function checkDeployHealth() {
  const lastDeploy = readState("last-deploy-check.json");
  if (!lastDeploy) {
    return { name: "deploy-health", ok: true, detail: "no deploy data (deploy monitoring not configured)" };
  }

  // Check if last successful deploy is very old (>7 days)
  const deployAge = lastDeploy.createdAt
    ? Date.now() - new Date(lastDeploy.createdAt).getTime()
    : null;

  if (deployAge && deployAge > 7 * 24 * 3600000) {
    return {
      name: "deploy-health",
      ok: false,
      detail: `last successful deploy is ${Math.round(deployAge / 86400000)}d old — prod may be stale`,
      action: "log-stuck",
    };
  }

  // Check if local HEAD is ahead of deployed SHA (if git is available)
  try {
    const { execSync } = require("child_process");
    const localHead = execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      timeout: 5000,
      cwd: ROOT,
    }).trim();
    const deployedSha = (lastDeploy.sha || "").slice(0, 7);
    if (deployedSha && localHead !== deployedSha) {
      // Check how far ahead
      try {
        const aheadCount = execSync(
          `git rev-list --count ${deployedSha}..HEAD 2>/dev/null || echo 0`,
          { encoding: "utf-8", timeout: 5000, cwd: ROOT }
        ).trim();
        const count = parseInt(aheadCount, 10);
        if (count > 20) {
          return {
            name: "deploy-health",
            ok: false,
            detail: `local is ${count} commits ahead of deployed ${deployedSha} — push needed`,
            action: "log-stuck",
          };
        }
      } catch { /* git command failed */ }
    }
  } catch { /* git not available */ }

  return { name: "deploy-health", ok: true, detail: "deploy healthy" };
}

// ---------------------------------------------------------------------------
// Check 8: Fix Efficacy
// ---------------------------------------------------------------------------

/**
 * Detects when the fix pipeline is running but producing no results.
 * @param {number} zeroCycleThreshold — consecutive cycles with 0 fixes before alerting
 */
function checkFixEfficacy(zeroCycleThreshold = 10) {
  const convergence = readState("daemon-convergence.json");
  const impact = readState("fix-impact.json");
  const queue = readState("moc-queue.json");
  const mocs = Array.isArray(queue?.mocs) ? queue.mocs : [];
  const approvedCount = mocs.filter((m) => m.status === "approved" || m.status === "pending_fix").length;

  // Check consecutive zero-fix cycles
  const zeroFixes = convergence?.consecutiveZeroFixes ?? 0;

  // Check fix success rate from verification
  const successRate = impact?.aggregateSuccessRate ?? null;

  const issues = [];

  if (approvedCount > 0 && zeroFixes >= zeroCycleThreshold) {
    // Diagnose why: no source files? no budget? all at retry limit?
    const noSourceFiles = mocs.filter((m) =>
      (m.status === "approved" || m.status === "pending_fix") &&
      (!m.sourceFiles || m.sourceFiles.length === 0)
    ).length;
    const atRetryLimit = mocs.filter((m) =>
      (m.status === "approved" || m.status === "pending_fix") &&
      (m.failures ?? 0) >= 3
    ).length;

    const causes = [];
    if (noSourceFiles > 0) { causes.push(`${noSourceFiles} MOCs missing sourceFiles`); }
    if (atRetryLimit > 0) { causes.push(`${atRetryLimit} MOCs at retry limit`); }
    if (causes.length === 0) { causes.push("budget exhausted or fix-engine not running"); }

    issues.push(`${zeroFixes} consecutive zero-fix cycles with ${approvedCount} approved MOCs (${causes.join(", ")})`);
  }

  if (successRate !== null && successRate < 0.1 && (impact?.verified ?? 0) + (impact?.failed ?? 0) >= 3) {
    issues.push(`fix success rate ${Math.round(successRate * 100)}% (below 10% threshold)`);
  }

  if (issues.length === 0) {
    const rateStr = successRate !== null ? ` success rate: ${Math.round(successRate * 100)}%` : "";
    return { name: "fix-efficacy", ok: true, detail: `fix pipeline healthy${rateStr}` };
  }

  return {
    name: "fix-efficacy",
    ok: false,
    detail: issues.join("; "),
    action: "force-trigger-fix-engine",
  };
}

// ---------------------------------------------------------------------------
// Run all checks
// ---------------------------------------------------------------------------

/**
 * Run all health checks and return results array.
 * @param {object} config — diagnostics config from daemon-config.json
 */
function runAllChecks(config = {}) {
  return [
    checkPassRateCollapse(config.passRateCollapseRuns ?? 3),
    checkSignalFlow(config.signalFlowTimeouts ?? undefined),
    checkConvergenceStuck(config.stuckCycleThreshold ?? 5),
    checkMocQueueStagnation(config.staleApprovedMocHours ?? 24),
    checkPoolAccountHealth(),
    checkFindingPipelineLiveness(config.findingPipelineStalenessHours ?? 2),
    checkDeployHealth(),
    checkFixEfficacy(config.fixEfficacyZeroCycleThreshold ?? 10),
  ];
}

module.exports = {
  checkPassRateCollapse,
  checkSignalFlow,
  checkConvergenceStuck,
  checkMocQueueStagnation,
  checkPoolAccountHealth,
  checkFindingPipelineLiveness,
  checkDeployHealth,
  checkFixEfficacy,
  runAllChecks,
};
