#!/usr/bin/env node

/**
 * Convergence Tracker — Updates daemon convergence state for test-runner behavior.
 *
 * The daemon seeks convergence: when there are no novel findings and no fixes
 * being applied, the system is "converged" and can slow down or skip test runs.
 *
 * State: converged | converging | diverging | stuck | unknown
 * - converged: N consecutive runs with 0 new MOCs, 0 actionable work
 * - converging: trend declining (fewer MOCs/findings)
 * - diverging: last run added work
 * - stuck: approved MOCs exist but 0 fixes applied for N runs (fix-engine enabled)
 *
 * Usage:
 *   node runtime/convergence-tracker.js                           # After finding-pipeline
 *   node runtime/convergence-tracker.js --mocs-submitted 5        # Override
 *   node runtime/convergence-tracker.js --fixes-applied 2         # After fix-engine
 *   node runtime/convergence-tracker.js --reset                   # Reset on deploy
 */

const fs = require("fs");
const path = require("path");

function findProjectRoot() {
  let dir = path.resolve(__dirname, "..", "..");
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "persona-engine.json")) || fs.existsSync(path.join(dir, "daemon-config.json")) || fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, "..", "..");
}
const ROOT = findProjectRoot();
const STATE_DIR = path.join(ROOT, "e2e", "state");
const CONVERGENCE_PATH = path.join(STATE_DIR, "daemon-convergence.json");

const CONVERGED_THRESHOLD = parseInt(process.env.E2E_CONVERGENCE_THRESHOLD ?? "3", 10);
const STUCK_THRESHOLD = parseInt(process.env.E2E_STUCK_THRESHOLD ?? "3", 10);

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function loadJson(filePath, defaultVal = null) {
  if (!fs.existsSync(filePath)) return defaultVal;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return defaultVal;
  }
}

function main() {
  const reset = args.includes("--reset");
  const mocsSubmitted = getArg("--mocs-submitted");
  const fixesApplied = getArg("--fixes-applied");

  let state = {
    state: "unknown",
    consecutiveZeroMocs: 0,
    consecutiveZeroFixes: 0,
    lastMocsSubmitted: 0,
    lastFixesApplied: 0,
    approvedMocsCount: 0,
    lastDeployAt: null,
    history: [],
    updatedAt: new Date().toISOString(),
  };

  if (fs.existsSync(CONVERGENCE_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(CONVERGENCE_PATH, "utf-8"));
      state = { ...state, ...prev };
    } catch {}
  }

  if (reset) {
    state.state = "unknown";
    state.consecutiveZeroMocs = 0;
    state.consecutiveZeroFixes = 0;
    state.lastDeployAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(CONVERGENCE_PATH), { recursive: true });
    fs.writeFileSync(CONVERGENCE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
    return;
  }

  // Read moc-queue for approved count (stuck detection)
  const queue = loadJson(path.join(STATE_DIR, "moc-queue.json"), {});
  const mocs = Array.isArray(queue?.mocs) ? queue.mocs : [];
  const approved = mocs.filter((m) => ["approved", "pending_fix"].includes(m.status ?? ""));
  state.approvedMocsCount = approved.length;

  // MOCs submitted this run (from finding-pipeline)
  let submitted = null;
  if (mocsSubmitted !== null) {
    submitted = parseInt(mocsSubmitted, 10);
  } else {
    const last = loadJson(path.join(STATE_DIR, "findings-to-mocs-last.json"), {});
    submitted = last.submitted ?? 0;
  }

  // Fixes applied (from fix-engine run)
  let applied = null;
  if (fixesApplied !== null) {
    applied = parseInt(fixesApplied, 10);
  } else {
    const fixLog = loadJson(path.join(STATE_DIR, "auto-fix-log.json"), {});
    applied = fixLog.fixApplied ?? 0;
  }

  // Update consecutive counters
  if (submitted !== null) {
    state.lastMocsSubmitted = submitted;
    if (submitted === 0) {
      state.consecutiveZeroMocs = (state.consecutiveZeroMocs ?? 0) + 1;
    } else {
      state.consecutiveZeroMocs = 0;
    }
  }

  if (applied !== null) {
    state.lastFixesApplied = applied;
    if (applied === 0) {
      state.consecutiveZeroFixes = (state.consecutiveZeroFixes ?? 0) + 1;
    } else {
      state.consecutiveZeroFixes = 0;
    }
  }

  // Read fix-impact for success rate
  const impact = loadJson(path.join(STATE_DIR, "fix-impact.json"), {});
  state.fixSuccessRate = impact?.aggregateSuccessRate ?? null;

  // Count findings created/resolved in last 24h for net progress
  const findingsPath = path.join(STATE_DIR, "findings", "findings.json");
  const allFindings = loadJson(findingsPath, []);
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  let resolvedLast24h = 0;
  let createdLast24h = 0;
  if (Array.isArray(allFindings)) {
    for (const f of allFindings) {
      if (f.resolvedAt && new Date(f.resolvedAt).getTime() > twentyFourHoursAgo) {
        resolvedLast24h++;
      }
      if (f.firstSeen && new Date(f.firstSeen).getTime() > twentyFourHoursAgo) {
        createdLast24h++;
      }
    }
  }
  state.findingsResolvedLast24h = resolvedLast24h;
  state.findingsCreatedLast24h = createdLast24h;
  state.netProgress = resolvedLast24h - createdLast24h;

  // Compute state using netProgress for richer signal
  const config = loadJson(path.join(ROOT, "daemon-config.json"), {});
  const fixEngineEnabled = process.env.E2E_FIX_ENGINE_ENABLED === "1" || config?.claws?.["fix-engine"]?.enabled === true;

  if (state.consecutiveZeroMocs >= CONVERGED_THRESHOLD && state.approvedMocsCount === 0) {
    state.state = "converged";
  } else if (
    fixEngineEnabled &&
    state.approvedMocsCount > 0 &&
    (state.consecutiveZeroFixes ?? 0) >= STUCK_THRESHOLD
  ) {
    state.state = "stuck";
  } else if ((state.netProgress ?? 0) > 0) {
    // Net positive progress — resolving more than creating
    state.state = "converging";
  } else if ((state.lastMocsSubmitted ?? 0) > 0 || (state.netProgress ?? 0) < 0) {
    state.state = "diverging";
  } else if ((state.consecutiveZeroMocs ?? 0) >= 1 && (state.consecutiveZeroMocs ?? 0) < CONVERGED_THRESHOLD) {
    state.state = "converging";
  } else {
    state.state = "unknown";
  }

  // Trim history (keep last 10)
  state.history = (state.history ?? []).slice(-10);
  state.history.push({
    at: new Date().toISOString(),
    mocsSubmitted: state.lastMocsSubmitted,
    fixesApplied: state.lastFixesApplied,
    approvedMocs: state.approvedMocsCount,
    fixSuccessRate: state.fixSuccessRate,
    netProgress: state.netProgress,
    findingsResolved: state.findingsResolvedLast24h,
    findingsCreated: state.findingsCreatedLast24h,
    state: state.state,
  });

  state.updatedAt = new Date().toISOString();
  if (state.state === "converged" && (state.convergedSince ?? "") === "") {
    state.convergedSince = new Date().toISOString();
  } else if (state.state !== "converged") {
    state.convergedSince = null;
  }

  fs.mkdirSync(path.dirname(CONVERGENCE_PATH), { recursive: true });
  fs.writeFileSync(CONVERGENCE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");

  // Stuck escalation: write summary for human review + notification payload
  if (state.state === "stuck") {
    const summaryPath = path.join(STATE_DIR, "stuck-summary.md");
    const lines = [
      "# Daemon Stuck — Needs Attention",
      "",
      `Generated: ${state.updatedAt}`,
      "",
      "## Summary",
      `- **Approved MOCs:** ${state.approvedMocsCount}`,
      `- **Consecutive zero-fix runs:** ${state.consecutiveZeroFixes ?? 0}`,
      "",
      "## Open MOCs (approved/pending_fix)",
    ];
    for (const m of approved.slice(0, 20)) {
      lines.push(`- ${m.title ?? m.id ?? "?"} (${m.tier ?? "?"})`);
    }
    if (approved.length > 20) {
      lines.push(`- ... and ${approved.length - 20} more`);
    }
    lines.push("", "## Actions", "- Run the auto-fix script manually or enable fix-engine", "- Check if MOCs need human clarification", "- Resolve via error query tool if errors");
    fs.writeFileSync(summaryPath, lines.join("\n") + "\n", "utf-8");

    // Emit diagnostics-requested signal so diagnostics claw runs immediately
    try {
      const signalsPath = path.join(STATE_DIR, "claw-signals.json");
      const signals = fs.existsSync(signalsPath)
        ? JSON.parse(fs.readFileSync(signalsPath, "utf-8"))
        : { signals: {}, claws: {} };
      signals.signals["diagnostics-requested"] = {
        at: new Date().toISOString(),
        emittedBy: "convergence-tracker",
        reason: "stuck",
        mocCount: state.approvedMocsCount,
      };
      fs.writeFileSync(signalsPath, JSON.stringify(signals, null, 2) + "\n");
    } catch { /* non-fatal */ }

    // Send notification via notify system
    try {
      const { notify } = require("./lib/notify");
      const msg = `Daemon stuck: ${state.approvedMocsCount} approved MOCs, ${state.consecutiveZeroFixes ?? 0} consecutive zero-fix runs. Run auto-fix manually or enable fix-engine.`;
      notify(msg, "warning").catch(() => {});
    } catch { /* notify module may not be available */ }
  }
}

main();
