#!/usr/bin/env node

/**
 * pipeline-integrity-check.js — Validates daemon pipeline correctness.
 *
 * Unlike self-test.js (which checks "can things run?"), this checks
 * "are things working correctly?" — output plausibility, feedback loop
 * completeness, config-behavior alignment, signal flow connectivity.
 *
 * Usage:
 *   node runtime/pipeline-integrity-check.js          # Run all checks
 *   node runtime/pipeline-integrity-check.js --json    # Machine-readable output
 *
 * Called by diagnostics claw during periodic self-test. Results written
 * to e2e/state/pipeline-integrity.json for health heartbeat consumption.
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
const CONFIG_PATH = path.join(ROOT, "daemon-config.json");

const JSON_MODE = process.argv.includes("--json");

function log(msg) {
  if (!JSON_MODE) { console.log(`[integrity] ${msg}`); }
}

function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function fileAge(filePath) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs;
  } catch {
    return Infinity;
  }
}

function countLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function runChecks() {
  const passed = [];
  const failed = [];
  const warnings = [];

  // -------------------------------------------------------------------------
  // 1. Data format integrity — catch structural bugs like the queue depth bug
  // -------------------------------------------------------------------------
  log("Checking data format integrity...");

  const queue = loadJson(path.join(STATE_DIR, "moc-queue.json"));
  if (queue !== null) {
    if (Array.isArray(queue?.mocs)) {
      passed.push(`moc-queue: correct format ({ mocs: [...] }), ${queue.mocs.length} entries`);
    } else if (Array.isArray(queue)) {
      failed.push("moc-queue: raw array format — should be { mocs: [...] }. Scripts reading queue.mocs will get undefined.");
    } else {
      failed.push(`moc-queue: unexpected format — ${typeof queue}. Expected { mocs: [...] }.`);
    }
  }

  const findingsRaw = loadJson(path.join(STATE_DIR, "findings", "findings.json"));
  // Support both { findings: [...] } wrapper and raw array format
  const findings = findingsRaw !== null
    ? (Array.isArray(findingsRaw) ? findingsRaw : (Array.isArray(findingsRaw?.findings) ? findingsRaw.findings : null))
    : null;
  if (findingsRaw !== null && findings === null) {
    failed.push(`findings: unexpected format — expected array or { findings: [...] }, got ${typeof findingsRaw}`);
  } else if (findings) {
    passed.push(`findings: valid format, ${findings.length} entries`);
  }

  const signals = loadJson(path.join(STATE_DIR, "claw-signals.json"));
  if (signals !== null) {
    if (signals.signals && signals.claws) {
      passed.push("claw-signals: correct format ({ signals, claws })");
    } else {
      failed.push("claw-signals: missing .signals or .claws keys");
    }
  }

  // -------------------------------------------------------------------------
  // 1b. Schema validation — deeper structural checks on critical state files
  // -------------------------------------------------------------------------
  log("Checking state file schemas...");

  // Load config early — needed for schema validation and later checks
  const config = loadJson(CONFIG_PATH, {});

  // Issue queue schema — read required fields from config, with sensible defaults
  const issueSchema = config?.issueSchema ?? {};
  const requiredIssueFields = issueSchema.requiredFields ?? ["title", "status"];
  const requiredFindingFields = issueSchema.requiredFindingFields ?? ["status"];

  if (queue?.mocs && Array.isArray(queue.mocs)) {
    const invalidMocs = queue.mocs.filter((m) => {
      return requiredIssueFields.some((f) => !m[f] || typeof m[f] !== "string");
    });
    if (invalidMocs.length > 0) {
      const sample = invalidMocs.slice(0, 3).map((m) => JSON.stringify(m).slice(0, 80));
      warnings.push(`issue-queue: ${invalidMocs.length} entries missing required fields (${requiredIssueFields.join(", ")}). Sample: ${sample.join("; ")}`);
    } else {
      passed.push(`issue-queue: all ${queue.mocs.length} entries have valid schema`);
    }
  }

  if (Array.isArray(findings)) {
    const invalidFindings = findings.filter((f) => {
      if (requiredFindingFields.some((field) => !f[field])) { return true; }
      // At minimum need a page, url, or description to identify the finding
      if (!f.page && !f.url && !f.description) { return true; }
      return false;
    });
    if (invalidFindings.length > 0) {
      warnings.push(`findings: ${invalidFindings.length}/${findings.length} entries missing required fields or identifiers`);
    } else {
      passed.push(`findings: all ${findings.length} entries have valid schema`);
    }
  }

  // Convergence state should have valid state enum
  const convergence = loadJson(path.join(STATE_DIR, "daemon-convergence.json"));
  if (convergence !== null) {
    const validStates = ["converged", "converging", "diverging", "stuck", "unknown"];
    if (validStates.includes(convergence.state)) {
      passed.push(`convergence: valid state "${convergence.state}"`);
    } else {
      failed.push(`convergence: invalid state "${convergence.state}" — expected one of: ${validStates.join(", ")}`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Output plausibility — values that should correlate but might not
  // -------------------------------------------------------------------------
  log("Checking output plausibility...");

  if (queue?.mocs) {
    const approved = queue.mocs.filter((m) => m.status === "approved" && !m.implementedAt);
    const healthSummary = loadJson(path.join(STATE_DIR, "daemon-health-summary.json"));
    if (healthSummary && typeof healthSummary.mocQueueDepth === "number") {
      // Health summary should reflect reality — if approved count > 0 but health says 0, something's wrong
      if (approved.length > 0 && healthSummary.mocQueueDepth === 0) {
        warnings.push(`plausibility: ${approved.length} approved MOCs in queue but health summary reports 0 pending. Health heartbeat may have stale data.`);
      } else {
        passed.push("plausibility: health summary queue depth consistent with moc-queue");
      }
    }
  }

  // Health summary staleness — if diagnostics ran recently, summary shouldn't be ancient
  const healthAge = fileAge(path.join(STATE_DIR, "daemon-health-summary.json"));
  const heartbeatHours = config?.claws?.diagnostics?.healthHeartbeatHours ?? 6;
  const maxHealthAge = heartbeatHours * 3 * 3600000; // 3x the interval = stale
  if (healthAge < Infinity && healthAge > maxHealthAge) {
    warnings.push(`plausibility: daemon-health-summary.json is ${Math.round(healthAge / 3600000)}h old (expected update every ${heartbeatHours}h). Diagnostics claw may not be running.`);
  }

  // -------------------------------------------------------------------------
  // 3. Feedback loop completeness — are loops closed?
  // -------------------------------------------------------------------------
  log("Checking feedback loop completeness...");

  // Oracle feedback: noise resolutions should produce oracle feedback entries
  if (findings && Array.isArray(findings)) {
    const noiseCount = findings.filter((f) => f.status === "noise" && f.resolvedBy).length;
    const feedbackLines = countLines(path.join(STATE_DIR, "oracle-feedback.jsonl"));

    if (noiseCount > 0 && feedbackLines === 0) {
      failed.push(`feedback-loop: ${noiseCount} findings resolved as noise but oracle-feedback.jsonl is empty. Oracle isn't learning from triage.`);
    } else if (noiseCount > 0 && feedbackLines < noiseCount * 0.3) {
      warnings.push(`feedback-loop: ${noiseCount} noise findings but only ${feedbackLines} oracle feedback entries (${Math.round(feedbackLines / noiseCount * 100)}% coverage). Some triage paths may not feed back.`);
    } else if (noiseCount > 0) {
      passed.push(`feedback-loop: oracle feedback has ${feedbackLines} entries for ${noiseCount} noise findings (${Math.round(feedbackLines / noiseCount * 100)}% coverage)`);
    }

    // Oracle patterns: if feedback exists, patterns should be generated
    if (feedbackLines > 0) {
      const patterns = loadJson(path.join(STATE_DIR, "oracle-feedback-patterns.json"));
      if (!patterns || (Array.isArray(patterns) && patterns.length === 0)) {
        warnings.push("feedback-loop: oracle-feedback.jsonl has entries but oracle-feedback-patterns.json is empty. oracle-feedback-loader.js may not be running.");
      } else {
        passed.push("feedback-loop: oracle feedback patterns generated from feedback entries");
      }
    }
  }

  // Fix effectiveness: if fixes were applied, effectiveness should be tracked
  if (queue?.mocs) {
    // Support multiple "completed" status values across different issue schemas
    const completedStatuses = issueSchema.completedStatuses ?? ["implemented", "completed", "closed", "done"];
    const completed = queue.mocs.filter((m) => completedStatuses.includes(m.status));
    const effectivenessReport = loadJson(path.join(STATE_DIR, "fix-effectiveness-report.json"));
    if (completed.length >= 5 && !effectivenessReport) {
      warnings.push(`feedback-loop: ${completed.length} issues completed but no fix-effectiveness-report.json. Fix quality isn't being measured.`);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Config-behavior alignment — config values actually drive behavior
  // -------------------------------------------------------------------------
  log("Checking config-behavior alignment...");

  if (config.claws) {
    // Fix-engine: if disabled in config, should not have recent successful cycles
    const fixEngineEnabled = config.claws["fix-engine"]?.enabled === true;
    if (!fixEngineEnabled) {
      const historyPath = path.join(STATE_DIR, "claw-history.jsonl");
      if (fs.existsSync(historyPath)) {
        const lines = fs.readFileSync(historyPath, "utf-8").split("\n").filter(Boolean);
        const recentFixRuns = lines
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .filter((e) => e.claw === "fix-engine" && e.ok && Date.now() - new Date(e.at).getTime() < 86400000);

        if (recentFixRuns.length > 0) {
          failed.push(`config-alignment: fix-engine.enabled=false but ${recentFixRuns.length} successful fix-engine cycles in last 24h. Config may not be respected.`);
        } else {
          passed.push("config-alignment: fix-engine disabled and no recent fix cycles (consistent)");
        }
      }
    }

    // Test-runner: coverageBasedSuspend should be explicitly set, not undefined
    const trConfig = config.claws["test-runner"] ?? {};
    if (trConfig.coverageBasedSuspend === undefined) {
      warnings.push("config-alignment: test-runner.coverageBasedSuspend is not set in config (defaults to false). Add it explicitly to prevent surprises.");
    }

    // Auto-tune runaway detection: if tuning log shows >10 changes in 24h, something's oscillating
    const tuningLog = loadJson(path.join(STATE_DIR, "config-tuning-log.json"), []);
    if (Array.isArray(tuningLog)) {
      const recent = tuningLog.filter((e) => e.at && Date.now() - new Date(e.at).getTime() < 86400000);
      if (recent.length > 10) {
        const totalChanges = recent.reduce((sum, e) => sum + (e.changes?.length ?? 0), 0);
        failed.push(`config-alignment: auto-tune made ${totalChanges} config changes across ${recent.length} cycles in 24h. Possible oscillation — check autoTune min/max guards.`);
      } else if (recent.length > 0) {
        passed.push(`config-alignment: auto-tune made ${recent.length} adjustments in 24h (within bounds)`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Signal flow connectivity — upstream runs should produce downstream signals
  // -------------------------------------------------------------------------
  log("Checking signal flow connectivity...");

  if (signals?.signals && signals?.claws) {
    const clawStates = signals.claws;
    const signalStates = signals.signals;

    // If test-runner ran recently, tests-complete should exist
    const trState = clawStates["test-runner"];
    if (trState?.lastRun) {
      const trAge = Date.now() - new Date(trState.lastRun).getTime();
      if (trAge < 3600000) { // ran in last hour
        if (signalStates["tests-complete"]) {
          const sigAge = Date.now() - new Date(signalStates["tests-complete"].at).getTime();
          if (sigAge < 3600000) {
            passed.push("signal-flow: test-runner → tests-complete signal connected");
          } else {
            warnings.push("signal-flow: test-runner ran recently but tests-complete signal is stale. Signal may not be emitting properly.");
          }
        } else {
          warnings.push("signal-flow: test-runner ran recently but no tests-complete signal found.");
        }
      }
    }

    // If finding-pipeline ran, mocs-ready should exist (when fix-engine is enabled)
    const fpState = clawStates["finding-pipeline"];
    if (fpState?.lastRun && config?.claws?.["fix-engine"]?.enabled === true) {
      const fpAge = Date.now() - new Date(fpState.lastRun).getTime();
      if (fpAge < 3600000 && !signalStates["mocs-ready"]) {
        warnings.push("signal-flow: finding-pipeline ran recently but no mocs-ready signal found.");
      }
    }
  }

  // -------------------------------------------------------------------------
  // 6. Dead state detection — files written but never consumed
  // -------------------------------------------------------------------------
  log("Checking for potentially dead state files...");

  // Check for state files that haven't been modified in 30+ days (may be abandoned)
  const STALE_THRESHOLD = 30 * 24 * 3600000;
  try {
    if (fs.existsSync(STATE_DIR)) {
      const stateFiles = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
      const staleFiles = stateFiles.filter((f) => {
        const age = fileAge(path.join(STATE_DIR, f));
        return age > STALE_THRESHOLD && age < Infinity;
      });
      if (staleFiles.length > 0) {
        warnings.push(`dead-state: ${staleFiles.length} state files unchanged for 30+ days: ${staleFiles.slice(0, 5).join(", ")}${staleFiles.length > 5 ? "..." : ""}`);
      }
    }
  } catch { /* skip */ }

  // -------------------------------------------------------------------------
  // 7. Daemon principles validation
  // -------------------------------------------------------------------------
  log("Checking daemon principles...");

  const principlesPath = path.join(STATE_DIR, "daemon-principles.json");
  if (fs.existsSync(principlesPath)) {
    try {
      const principles = JSON.parse(fs.readFileSync(principlesPath, "utf-8"));
      if (!Array.isArray(principles)) {
        failed.push("principles: daemon-principles.json is not an array");
      } else if (principles.length === 0) {
        warnings.push("principles: daemon-principles.json is empty — no guardrails encoded");
      } else {
        const valid = principles.every((p) => p.id && p.principle);
        if (!valid) {
          failed.push("principles: some entries missing required 'id' or 'principle' field");
        } else {
          passed.push(`principles: ${principles.length} principles loaded and valid`);
        }

        // Check no-bypass principle: restricted paths should not block core app routes
        const noBypass = principles.find((p) => p.id === "no-bypass");
        if (noBypass) {
          const critRoutes = loadJson(path.join(STATE_DIR, "critical-routes.json"), { routes: [] });
          // Read project-specific restricted paths from config (renamed from protectedPages for generality)
          const restrictedPaths = config?.restrictedPaths ?? config?.protectedPages ?? [];
          if (restrictedPaths.length > 0) {
            const blocked = (critRoutes.routes ?? []).filter((r) => restrictedPaths.includes(r));
            if (blocked.length > 0) {
              failed.push(`principles(no-bypass): critical-routes.json blocks auto-fix on core paths: ${blocked.join(", ")}. This bypasses the fix pipeline instead of fixing code.`);
            }
          }
        }
      }
    } catch (err) {
      failed.push(`principles: failed to parse daemon-principles.json — ${err.message}`);
    }
  } else {
    warnings.push("principles: daemon-principles.json does not exist — no design constraints encoded");
  }

  return { passed, failed, warnings };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const result = runChecks();

  // Persist results for health heartbeat consumption
  const output = {
    ...result,
    at: new Date().toISOString(),
    passedCount: result.passed.length,
    failedCount: result.failed.length,
    warningCount: result.warnings.length,
    healthy: result.failed.length === 0,
  };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STATE_DIR, "pipeline-integrity.json"),
      JSON.stringify(output, null, 2) + "\n"
    );
  } catch { /* non-fatal */ }

  if (JSON_MODE) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (result.passed.length > 0) {
      console.log(`\nPassed (${result.passed.length}):`);
      result.passed.forEach((p) => console.log(`  + ${p}`));
    }
    if (result.warnings.length > 0) {
      console.log(`\nWarnings (${result.warnings.length}):`);
      result.warnings.forEach((w) => console.log(`  ! ${w}`));
    }
    if (result.failed.length > 0) {
      console.log(`\nFailed (${result.failed.length}):`);
      result.failed.forEach((f) => console.log(`  X ${f}`));
    }
    console.log(`\nResult: ${result.failed.length === 0 ? "HEALTHY" : "DEGRADED"} (${result.passed.length} passed, ${result.warnings.length} warnings, ${result.failed.length} failed)`);
  }

  process.exit(result.failed.length > 0 ? 1 : 0);
}

main();
