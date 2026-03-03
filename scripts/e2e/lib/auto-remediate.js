#!/usr/bin/env node

/**
 * Auto-Remediation Module — ACTUAL fixes for pipeline failures.
 *
 * Each function performs a direct remediation action and returns
 * { fixed: boolean, detail: string }.
 *
 * Used by the diagnostics claw instead of just signaling/retrying.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = `[${ts}] [auto-remediate] ${msg}`;
  try { fs.appendFileSync(path.join(STATE_DIR, "daemon.log"), line + "\n"); } catch {}
  return line;
}

// ---------------------------------------------------------------------------
// 1. Playwright Browser Check + Install
// ---------------------------------------------------------------------------

function fixPlaywrightBrowsers() {
  log("checking Playwright browser installation...");

  // Step 0: Ensure e2e/package.json exists with playwright dependency
  const e2eDir = path.join(ROOT, "e2e");
  const e2ePkg = path.join(e2eDir, "package.json");
  if (!fs.existsSync(e2ePkg)) {
    log("e2e/package.json missing — creating with playwright dependency");
    try {
      fs.writeFileSync(e2ePkg, JSON.stringify({
        name: `${path.basename(ROOT).toLowerCase()}-e2e`,
        private: true,
        scripts: { test: "npx playwright test", "test:list": "npx playwright test --list" },
        devDependencies: { "@playwright/test": "latest", "playwright": "latest" },
      }, null, 2) + "\n");
      log("created e2e/package.json");
    } catch (err) {
      log(`failed to create e2e/package.json: ${err.message}`);
    }
  }

  // Step 0b: Ensure e2e/node_modules exists (npm install)
  if (!fs.existsSync(path.join(e2eDir, "node_modules", "playwright"))) {
    log("e2e/node_modules/playwright missing — running npm install...");
    try {
      execSync("npm install", { cwd: e2eDir, encoding: "utf-8", timeout: 120000, stdio: "pipe" });
      log("npm install in e2e/ succeeded");
    } catch (err) {
      log(`npm install in e2e/ failed: ${err.message.slice(0, 200)}`);
    }
  }

  try {
    // Quick check: can playwright list tests?
    const listResult = execSync(
      "npx playwright test --list --reporter=json 2>&1",
      { cwd: e2eDir, encoding: "utf-8", timeout: 30000 }
    );
    if (listResult.includes('"tests"') || listResult.includes("spec.ts")) {
      log("Playwright browsers OK — test listing works");
      return { fixed: true, detail: "browsers already installed" };
    }
  } catch (err) {
    const output = err.stdout || err.stderr || err.message || "";
    if (output.includes("browserType.launch") || output.includes("Executable doesn't exist") || output.includes("chromium") || output.includes("Cannot find module")) {
      log("Playwright browsers missing — installing...");
      try {
        execSync("npx playwright install chromium", {
          cwd: ROOT,
          encoding: "utf-8",
          timeout: 120000,
          stdio: "pipe",
        });
        log("Playwright chromium installed successfully");
        return { fixed: true, detail: "reinstalled chromium" };
      } catch (installErr) {
        log(`Playwright install failed: ${installErr.message}`);
        return { fixed: false, detail: `browser install failed: ${installErr.message.slice(0, 200)}` };
      }
    }
  }
  return { fixed: false, detail: "unable to determine browser status" };
}

// ---------------------------------------------------------------------------
// 2. Corrupt State File Repair
// ---------------------------------------------------------------------------

const STATE_FILE_DEFAULTS = {
  "claw-signals.json": { signals: {}, claws: {} },
  "moc-queue.json": { mocs: [], archivedDedupIndex: {}, lastPruned: new Date().toISOString() },
  "findings/findings.json": { findings: [], lastUpdated: new Date().toISOString() },
  "persona-learning.json": { personas: {}, lastUpdated: new Date().toISOString() },
  "green-history.json": { tests: {}, updated: new Date().toISOString() },
  "daemon-convergence.json": { state: "unknown", stuckCycles: 0, lastUpdated: new Date().toISOString() },
  "oracle-pattern-cache.json": { patterns: [], updated: new Date().toISOString() },
  "test-quarantine.json": { quarantined: [], updated: new Date().toISOString() },
};

function repairCorruptStateFiles() {
  const repaired = [];
  const checked = [];

  for (const [relPath, defaultContent] of Object.entries(STATE_FILE_DEFAULTS)) {
    const fullPath = path.join(STATE_DIR, relPath);
    checked.push(relPath);

    if (!fs.existsSync(fullPath)) { continue; }

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      JSON.parse(content); // validates JSON
    } catch {
      // Corrupt — backup and rebuild
      log(`CORRUPT: ${relPath} — backing up and rebuilding`);
      try {
        const backup = fullPath + `.corrupt.${Date.now()}`;
        fs.copyFileSync(fullPath, backup);
        fs.writeFileSync(fullPath, JSON.stringify(defaultContent, null, 2) + "\n");
        repaired.push(relPath);
        log(`REPAIRED: ${relPath} (backup at ${path.basename(backup)})`);
      } catch (err) {
        log(`FAILED to repair ${relPath}: ${err.message}`);
      }
    }
  }

  if (repaired.length > 0) {
    return { fixed: true, detail: `repaired ${repaired.length} corrupt files: ${repaired.join(", ")}` };
  }
  return { fixed: true, detail: `${checked.length} state files validated OK` };
}

// ---------------------------------------------------------------------------
// 3. Auto-Archive Stale MOCs (retry limit reached)
// ---------------------------------------------------------------------------

function archiveStaleMocs(retryLimitMocIds) {
  const queuePath = path.join(STATE_DIR, "moc-queue.json");
  try {
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf-8"));
    const mocs = Array.isArray(queue.mocs) ? queue.mocs : [];
    let archived = 0;

    for (const moc of mocs) {
      // Archive MOCs at retry limit (3+ failures)
      if (retryLimitMocIds && retryLimitMocIds.includes(moc.id)) {
        moc.status = "archived";
        moc.archivedAt = new Date().toISOString();
        moc.archivedReason = "auto-archive: retry limit exceeded (3+ failures)";
        archived++;
        continue;
      }

      // Also archive any approved MOC that's been sitting for 48+ hours with 3+ failures
      if (
        (moc.status === "approved" || moc.status === "pending_fix") &&
        (moc.failures ?? 0) >= 3 &&
        moc.approvedAt
      ) {
        const age = Date.now() - new Date(moc.approvedAt).getTime();
        if (age > 48 * 3600000) {
          moc.status = "archived";
          moc.archivedAt = new Date().toISOString();
          moc.archivedReason = `auto-archive: ${moc.failures} failures over ${Math.round(age / 3600000)}h`;
          archived++;
        }
      }
    }

    if (archived > 0) {
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
      log(`archived ${archived} stale MOCs at retry limit`);
      return { fixed: true, detail: `archived ${archived} stale MOCs` };
    }

    return { fixed: true, detail: "no MOCs at retry limit need archiving" };
  } catch (err) {
    log(`archive failed: ${err.message}`);
    return { fixed: false, detail: `archive error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// 4. Reset Circuit-Broken Claw via Signals File
// ---------------------------------------------------------------------------

function resetCircuitBrokenClaw(clawName) {
  const signalsPath = path.join(STATE_DIR, "claw-signals.json");
  try {
    const signals = JSON.parse(fs.readFileSync(signalsPath, "utf-8"));
    const claw = signals.claws?.[clawName];
    if (!claw) {
      return { fixed: false, detail: `claw ${clawName} not found in signals` };
    }

    if (claw.status !== "circuit_broken") {
      return { fixed: true, detail: `${clawName} is not circuit-broken (status: ${claw.status})` };
    }

    // Reset: set status back to idle, clear lastRun to trigger immediate run
    claw.status = "idle";
    claw.lastRun = null;
    fs.writeFileSync(signalsPath, JSON.stringify(signals, null, 2) + "\n");
    log(`reset circuit-broken claw: ${clawName}`);
    return { fixed: true, detail: `reset ${clawName} from circuit_broken to idle` };
  } catch (err) {
    return { fixed: false, detail: `reset failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// 5. Force-Trigger with Circuit Breaker Reset
// ---------------------------------------------------------------------------

function forceTriggerWithReset(clawName) {
  const signalsPath = path.join(STATE_DIR, "claw-signals.json");
  try {
    const signals = JSON.parse(fs.readFileSync(signalsPath, "utf-8"));
    const claw = signals.claws?.[clawName];
    if (!claw) {
      return { fixed: false, detail: `claw ${clawName} not found` };
    }

    // Reset circuit breaker if tripped
    if (claw.status === "circuit_broken") {
      claw.status = "idle";
      log(`reset circuit breaker for ${clawName} before force-trigger`);
    }

    // Clear lastRun to force immediate execution
    claw.lastRun = null;
    fs.writeFileSync(signalsPath, JSON.stringify(signals, null, 2) + "\n");
    log(`force-triggered ${clawName} (with circuit breaker reset)`);
    return { fixed: true, detail: `force-triggered ${clawName}` };
  } catch (err) {
    return { fixed: false, detail: `force-trigger failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// 6. Prune Oversized JSONL Files
// ---------------------------------------------------------------------------

const JSONL_MAX_LINES = 3000;
const JSONL_FILES = [
  "loop-performance.jsonl",
  "persona-token-usage.jsonl",
  "run-log.jsonl",
  "screenshot-metadata.jsonl",
  "claw-history.jsonl",
  "audit/audit.jsonl",
];

function pruneJsonlFiles() {
  let pruned = 0;
  for (const file of JSONL_FILES) {
    const fp = path.join(STATE_DIR, file);
    if (!fs.existsSync(fp)) { continue; }
    try {
      const content = fs.readFileSync(fp, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length > JSONL_MAX_LINES) {
        const trimmed = lines.slice(-JSONL_MAX_LINES);
        fs.writeFileSync(fp, trimmed.join("\n") + "\n");
        log(`pruned ${file}: ${lines.length} → ${JSONL_MAX_LINES} lines`);
        pruned++;
      }
    } catch { /* skip */ }
  }
  return { fixed: true, detail: pruned > 0 ? `pruned ${pruned} JSONL files` : "all JSONL files within limits" };
}

// ---------------------------------------------------------------------------
// 7. Clear Stale Lock Files
// ---------------------------------------------------------------------------

function clearStaleLocks() {
  const lockFiles = [
    ".git-commit.lock",
    "claw-signals.json.lock",
  ];
  const gitLock = path.join(ROOT, ".git", "index.lock");
  let cleared = 0;

  for (const lockFile of lockFiles) {
    const fp = path.join(STATE_DIR, lockFile);
    if (fs.existsSync(fp)) {
      try {
        // Only clear if older than 5 minutes
        const stat = fs.statSync(fp);
        if (Date.now() - stat.mtimeMs > 5 * 60000) {
          fs.unlinkSync(fp);
          log(`cleared stale lock: ${lockFile}`);
          cleared++;
        }
      } catch { /* skip */ }
    }
  }

  if (fs.existsSync(gitLock)) {
    try {
      const stat = fs.statSync(gitLock);
      if (Date.now() - stat.mtimeMs > 5 * 60000) {
        fs.unlinkSync(gitLock);
        log("cleared stale .git/index.lock");
        cleared++;
      }
    } catch { /* skip */ }
  }

  return { fixed: true, detail: cleared > 0 ? `cleared ${cleared} stale locks` : "no stale locks" };
}

// ---------------------------------------------------------------------------
// 8. Full Pipeline Reset (nuclear option — when everything is stuck)
// ---------------------------------------------------------------------------

function fullPipelineReset() {
  log("FULL PIPELINE RESET — clearing all blockers");
  const results = [];

  // 1. Repair corrupt state files
  results.push(repairCorruptStateFiles());

  // 2. Clear stale locks
  results.push(clearStaleLocks());

  // 3. Prune oversized JSONL files
  results.push(pruneJsonlFiles());

  // 4. Archive all retry-limit MOCs
  results.push(archiveStaleMocs(null)); // null = use 48h+3failures heuristic

  // 5. Reset zero-results counter
  const zeroPath = path.join(STATE_DIR, "test-runner-zero-results.json");
  try {
    fs.writeFileSync(zeroPath, JSON.stringify({ count: 0, lastAt: new Date().toISOString(), resetBy: "auto-remediate" }) + "\n");
    results.push({ fixed: true, detail: "reset zero-results counter" });
  } catch { /* skip */ }

  // 6. Reset all circuit-broken claws via signals
  try {
    const signalsPath = path.join(STATE_DIR, "claw-signals.json");
    const signals = JSON.parse(fs.readFileSync(signalsPath, "utf-8"));
    let resetCount = 0;
    for (const [name, claw] of Object.entries(signals.claws ?? {})) {
      if (claw.status === "circuit_broken") {
        claw.status = "idle";
        claw.lastRun = null;
        resetCount++;
      }
    }
    if (resetCount > 0) {
      fs.writeFileSync(signalsPath, JSON.stringify(signals, null, 2) + "\n");
      results.push({ fixed: true, detail: `reset ${resetCount} circuit-broken claws` });
    }
  } catch { /* skip */ }

  // 7. Check Playwright browsers
  results.push(fixPlaywrightBrowsers());

  const fixedCount = results.filter(r => r.fixed).length;
  const details = results.map(r => r.detail).join("; ");
  log(`pipeline reset complete: ${fixedCount}/${results.length} fixes applied`);

  return { fixed: fixedCount > 0, detail: details };
}

// ---------------------------------------------------------------------------
// 9. Comprehensive Zero-Results Fix
// ---------------------------------------------------------------------------

function fixZeroResults() {
  log("fixing zero test results...");
  const results = [];

  // Step 1: Check Playwright browsers
  const browserFix = fixPlaywrightBrowsers();
  results.push(browserFix);

  // Step 2: Clear stale locks that might block test-runner
  results.push(clearStaleLocks());

  // Step 3: Repair corrupt state files
  results.push(repairCorruptStateFiles());

  // Step 4: Reset zero-results counter
  const zeroPath = path.join(STATE_DIR, "test-runner-zero-results.json");
  try {
    fs.writeFileSync(zeroPath, JSON.stringify({ count: 0, lastAt: new Date().toISOString(), resetBy: "auto-remediate" }) + "\n");
    results.push({ fixed: true, detail: "reset zero-results counter" });
  } catch { /* skip */ }

  // Step 5: Force-trigger test-runner (with circuit breaker reset)
  results.push(forceTriggerWithReset("test-runner"));

  const details = results.map(r => r.detail).join("; ");
  return { fixed: results.some(r => r.fixed), detail: details };
}

module.exports = {
  fixPlaywrightBrowsers,
  repairCorruptStateFiles,
  archiveStaleMocs,
  resetCircuitBrokenClaw,
  forceTriggerWithReset,
  pruneJsonlFiles,
  clearStaleLocks,
  fullPipelineReset,
  fixZeroResults,
};
