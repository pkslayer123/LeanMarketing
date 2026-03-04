#!/usr/bin/env node

/**
 * Claw 1: Test Runner
 *
 * Owns: Running Playwright persona tests, worker titration, green-tracker pruning.
 * Schedule: Continuous — waits for signal (deploy webhook, timer, manual trigger).
 * Reads: test-strategy.json, green-history.json, debottleneck-signal.json
 * Writes: findings/findings.json, green-history.json, test-frequency.json
 * Emits: tests-complete signal
 *
 * Genericized from ChangePilot's test-runner claw for use in any persona-engine project.
 */

const path = require("path");
const fs = require("fs");
const { Claw, STATE_DIR } = require("../claw");

// Optional lib imports — gracefully degrade if not available
let getAffectedTests, getLastDeploySha, getFailureFirstGrep, resetAllCircuits, evictSessions;
try { ({ getAffectedTests, getLastDeploySha } = require("../lib/diff-test-selector")); } catch { /* optional */ }
try { ({ getFailureFirstGrep } = require("../lib/predictive-selector")); } catch { /* optional */ }
try { ({ resetAllCircuits } = require("../lib/fetch-timeout")); } catch { /* optional */ }
try { ({ evictExpired: evictSessions } = require("../lib/session-pool")); } catch { /* optional */ }

function findProjectRoot() {
  let dir = path.resolve(__dirname, "..", "..", "..");
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "persona-engine.json")) || fs.existsSync(path.join(dir, "daemon-config.json")) || fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, "..", "..", "..");
}
const ROOT = findProjectRoot();

class TestRunnerClaw extends Claw {
  constructor() {
    super("test-runner");
    this.workers = this.clawConfig.maxWorkersOverride ?? null;
    this.testFilter = this.clawConfig.testFilter ?? "personas";
    // Framework-agnostic test runner configuration
    this.testRunner = this.clawConfig.testRunner ?? "playwright"; // playwright | jest | vitest | pytest | custom
    this.testDir = this.clawConfig.testDir ?? "e2e";
    this.testCommand = this.clawConfig.testCommand ?? null; // fully custom command override
    this.resultsFormat = this.clawConfig.resultsFormat ?? "playwright-json"; // playwright-json | jest-json | junit-xml | custom
    this.resultsPath = this.clawConfig.resultsPath ?? null; // custom results file path
  }

  async run() {
    // Phase 0: Optional suspend when fix-engine is off (manual or coverage-based)
    const fixEngineEnabled = this.config?.claws?.["fix-engine"]?.enabled === true;
    const suspendWhenFixEngineOff = this.clawConfig.suspendWhenFixEngineOff === true;
    const coverageBasedSuspend = this.clawConfig.coverageBasedSuspend === true;
    const threshold = this.clawConfig.consecutiveZeroActionableThreshold ?? 3;

    if (!fixEngineEnabled) {
      if (suspendWhenFixEngineOff) {
        this.log("suspend: fix-engine disabled and suspendWhenFixEngineOff=true — skipping test run");
        this.emitSignal("tests-complete", { iteration: this.currentCycle, suspended: true });
        return { ok: true, summary: "skipped (fix-engine off, suspend enabled)" };
      }
      if (coverageBasedSuspend) {
        const coveragePath = path.join(STATE_DIR, "coverage-suspend.json");
        if (fs.existsSync(coveragePath)) {
          try {
            const state = JSON.parse(fs.readFileSync(coveragePath, "utf-8"));
            const consecutive = state.consecutiveZeroActionable ?? 0;
            if (consecutive >= threshold) {
              this.log(`suspend: fix-engine off, ${consecutive} consecutive runs with 0 new MOCs (threshold ${threshold}) — skipping`);
              this.emitSignal("tests-complete", { iteration: this.currentCycle, suspended: true, reason: "coverage_stable" });
              return { ok: true, summary: `skipped (coverage stable, ${consecutive} zero-MOC runs)` };
            }
          } catch {}
        }
      }
    }

    // Phase 0.4: Poll for new deployments (optional — project may have its own deploy check)
    try {
      this.exec("node scripts/e2e/check-latest-deploy.js", {
        label: "deploy-check",
        timeoutMs: 15000,
      });
    } catch { /* deploy check not available */ }

    // Phase 0.5: Worker titration from debottleneck signal + cap
    const workers = this._getWorkerCount();

    // Phase 0.5: Differential test selection — only test changed routes
    const diffSelection = this._getDiffSelection();
    if (diffSelection && !diffSelection.fullRun && diffSelection.affectedRoutes.length === 0 && diffSelection.changedFiles.length > 0) {
      this.log("diff-selector: no route-mapped changes, running predictive selection instead");
    }

    // Phase 0.6: Evict stale browser sessions + reset fetch circuits on deploy
    try { if (evictSessions) { evictSessions(); } } catch {}
    const deploySignal = this.readState("claw-signals.json")?.signals?.["deploy-detected"];
    if (deploySignal?.at && (!this.lastRunAt || new Date(deploySignal.at) > new Date(this.lastRunAt))) {
      try { if (resetAllCircuits) { resetAllCircuits(); } } catch {}
      this.log("deploy detected: reset fetch circuit breakers");
      // Reset convergence state — new code may produce new findings
      this.exec("node scripts/e2e/convergence-tracker.js --reset", {
        label: "convergence-reset",
        timeoutMs: 5000,
      });
    }

    // Phase 0.55: When converged, optionally skip (save compute) or use extended interval
    const convergence = this._readConvergence();
    const skipWhenConverged = this.clawConfig.convergenceSkipWhenConverged === true;
    if (convergence?.state === "converged" && skipWhenConverged) {
      // Phase 0.555: When converged AND budget exhausted (fresh), skip to avoid generating more work
      const budgetExhaustedPath = path.join(STATE_DIR, "budget-exhausted.json");
      if (fs.existsSync(budgetExhaustedPath)) {
        try {
          const be = JSON.parse(fs.readFileSync(budgetExhaustedPath, "utf-8"));
          const at = be.at ? new Date(be.at).getTime() : 0;
          const freshMs = 2 * 60 * 60 * 1000; // 2 hours
          if (Date.now() - at < freshMs) {
            this.log("converged + budget exhausted (fresh): skipping test run");
            this.emitSignal("tests-complete", { iteration: this.currentCycle, suspended: true, reason: "converged_budget_exhausted" });
            return { ok: true, summary: "skipped (converged + budget exhausted)" };
          }
        } catch {}
      }
      this.log("converged: skipping test run (convergenceSkipWhenConverged)");
      this.emitSignal("tests-complete", { iteration: this.currentCycle, suspended: true, reason: "converged" });
      return { ok: true, summary: "skipped (converged)" };
    }

    // Phase 0.56: Exploration run — full suite periodically or when converged too long
    const explorationInterval = this.clawConfig.explorationRunInterval ?? 0;
    const staleConvergedHours = this.clawConfig.staleConvergedHours ?? 0;
    let forceExploration = false;
    if (explorationInterval > 0 && this.currentCycle > 0 && this.currentCycle % explorationInterval === 0) {
      forceExploration = true;
      this.log(`exploration run: cycle ${this.currentCycle} % ${explorationInterval} === 0`);
    }
    if (!forceExploration && staleConvergedHours > 0 && convergence?.state === "converged" && convergence?.convergedSince) {
      const elapsed = (Date.now() - new Date(convergence.convergedSince).getTime()) / (60 * 60 * 1000);
      if (elapsed >= staleConvergedHours) {
        forceExploration = true;
        this.log(`exploration run: converged ${elapsed.toFixed(0)}h (threshold ${staleConvergedHours}h)`);
      }
    }

    // Phase 1: Compute skippable tests (green-tracker pruning)
    this.exec("node scripts/e2e/compute-skippable.js", { label: "compute-skippable" });

    // Phase 2: Get test strategy (skip filter)
    const strategy = this.readState("test-strategy.json");
    const skipFilter = strategy?.skipFilter ?? [];

    // Phase 2.5: Predictive test ordering — front-load likely failures
    const predictiveGrep = this._getPredictiveGrep(diffSelection);

    // Phase 3: Build test arguments (framework-aware)
    const testArgs = this._buildTestArgs(workers, skipFilter, diffSelection, predictiveGrep, forceExploration);
    this.log(`running tests: ${testArgs}`);

    // Phase 4: Run tests (framework-agnostic — supports Playwright, Jest, Vitest, pytest, custom)
    const testCommand = this._buildTestCommand(testArgs);
    this.log(`test command: ${testCommand}`);
    const testResult = await this.execAsync(
      testCommand,
      {
        label: `${this.testRunner}-tests`,
        timeoutMs: this.clawConfig.testTimeoutMs ?? 1200000, // 20 min default
        env: { E2E_LLM_RATE_LIMIT_SAFE: "1" },
      }
    );

    // Phase 5: Update test frequency
    this.exec("node scripts/e2e/test-frequency.js --update", { label: "test-frequency" });

    // Phase 5.5: Flush cross-run oracle cache (oracle writes during Playwright tests)
    try {
      const oracleCache = require("../lib/oracle-cache");
      oracleCache.flushCache();
      const stats = oracleCache.getCacheStats();
      this.log(`oracle-cache flushed: ${stats.entries} entries, ${stats.totalHits} hits`);
    } catch { /* oracle-cache not available */ }

    // Phase 6: Parse results
    const results = this._parseResults(testResult.ok);

    // Phase 7: Log performance and run debottleneck
    this._logPerformance(results, workers);
    this.exec("node scripts/e2e/debottleneck-analysis.js", { label: "debottleneck" });

    // Phase 7.5: Run feature tests (tests/features/) — real functional assertions
    const featureTestResult = this.exec(
      `cd ${this.testDir} && npx playwright test tests/features/ --workers 4 --reporter=json 2>/dev/null || true`,
      { label: "feature-tests", timeoutMs: 120000 }
    );
    if (featureTestResult.ok) {
      this.log("feature tests completed");
    }

    // Phase 7.6: Run visual tests periodically (every 5 cycles)
    if (this.currentCycle % 5 === 0 || this.currentCycle === 1) {
      const visualResult = this.exec(
        "node scripts/e2e/visual-test.js",
        { label: "visual-tests", timeoutMs: 120000 }
      );
      if (visualResult.ok) {
        this.log("visual tests completed");
      }
    }

    // Phase 8: Run before-hooks for next cycle (route discovery on first run)
    if (this.currentCycle === 1) {
      this.exec("node scripts/e2e/discover-routes.js", { label: "discover-routes", timeoutMs: 60000 });
    }

    // Log token spend from oracle calls during this test cycle
    try {
      const { getSpendSummary } = require("../lib/token-logger");
      const spend = getSpendSummary(0.5); // Last 30 minutes
      const testComponents = ["oracle", "discovery-sampler", "jit-test-gen", "screenshot-oracle"];
      let totalSpend = 0;
      for (const comp of testComponents) {
        totalSpend += spend.byComponent[comp] || 0;
      }
      if (totalSpend > 0) {
        this.addBudgetSpend(totalSpend);
        this.log(`token spend this cycle: $${totalSpend.toFixed(4)} (oracle + discovery + jit + screenshot)`);
      }
    } catch { /* non-fatal */ }

    // Emit signal for finding-pipeline (even on failure — findings still need processing)
    this.emitSignal("tests-complete", {
      iteration: this.currentCycle,
      passed: results.passed,
      failed: results.failed,
      total: results.total,
      playwrightExitOk: testResult.ok,
    });

    // ok = tests actually ran and produced results (test failures are expected, not an error)
    // The daemon should only see "error" when tests crash or produce 0 results.
    const testsRan = results.total > 0;
    return {
      ok: testsRan,
      summary: !testsRan
        ? "no test results (Playwright may have crashed)"
        : `${results.passed}/${results.total} passed, ${results.failed} failed`,
    };
  }

  _getWorkerCount() {
    const MIN_WORKERS = parseInt(process.env.E2E_MIN_WORKERS ?? "3", 10);
    const vercelCap = parseInt(process.env.E2E_VERCEL_WORKER_CAP ?? "0", 10);
    const maxWorkers = vercelCap > 0 ? vercelCap : 12;

    if (this.workers) { return Math.min(Math.max(this.workers, MIN_WORKERS), maxWorkers); }

    const signal = this.readState("debottleneck-signal.json");
    if (!signal?.recommendedWorkers) { return MIN_WORKERS; }

    let workers;
    if (signal.signal === "load_bottleneck") {
      workers = Math.max(MIN_WORKERS, Math.floor(signal.recommendedWorkers * 0.8));
    } else if (signal.signal === "crash_recovery") {
      workers = Math.max(MIN_WORKERS, 6);
    } else if (signal.signal === "headroom") {
      workers = Math.ceil(signal.recommendedWorkers * 1.1);
    } else {
      workers = signal.recommendedWorkers;
    }

    return Math.min(Math.max(workers, MIN_WORKERS), maxWorkers);
  }

  _getDiffSelection() {
    if (!getAffectedTests || !getLastDeploySha) { return null; }
    try {
      const lastDeploySha = getLastDeploySha();
      const since = lastDeploySha ?? "HEAD~1";
      return getAffectedTests({ since });
    } catch (err) {
      this.log(`diff-selector error: ${err.message}`);
      return null;
    }
  }

  _getPredictiveGrep(diffSelection) {
    if (!getFailureFirstGrep) { return null; }
    try {
      const affectedRoutes = diffSelection?.affectedRoutes ?? [];
      return getFailureFirstGrep({ affectedRoutes, topN: 15 });
    } catch {
      return null;
    }
  }

  _buildTestArgs(workers, skipFilter, diffSelection, predictiveGrep, forceExploration = false) {
    const strategy = this.readState("test-strategy.json");
    const recommendedFiles = strategy?.recommendedFilter ?? [];

    // Use explicit file list when available (more reliable than --grep-invert)
    const useFileSelection = recommendedFiles.length > 0 && !forceExploration;
    const parts = useFileSelection ? [...recommendedFiles] : [`tests/${this.testFilter}/`];

    if (workers) {
      parts.push(`--workers ${workers}`);
    }

    if (useFileSelection) {
      this.log(`file-selection: ${recommendedFiles.length} persona specs (${skipFilter.length} skipped)`);
    }

    if (forceExploration) {
      return parts.join(" ");
    }

    // Differential selection: if not a full run and we have a grep pattern, use it
    if (diffSelection && !diffSelection.fullRun && diffSelection.grepPattern) {
      this.log(`diff-selector: targeting ${diffSelection.affectedRoutes.length} routes — ${diffSelection.reason}`);
      if (this.currentCycle <= 1) {
        parts.push(`--grep "${diffSelection.grepPattern}"`);
        return parts.join(" ");
      }
    }

    // Predictive selection: front-load likely failures (cycle 1 only)
    if (predictiveGrep && this.currentCycle <= 1) {
      this.log(`predictive: front-loading likely failures — ${predictiveGrep}`);
    }

    // Apply test frequency selection (cycle > 1) — only when running full suite, not file selection
    if (this.currentCycle > 1 && !useFileSelection) {
      const freqResult = this.exec(`node scripts/e2e/test-frequency.js --select --iteration ${this.currentCycle}`, {
        label: "test-frequency-select",
      });
      if (freqResult.ok) {
        try {
          const selection = JSON.parse(freqResult.stdout);
          const pattern = selection.grepPattern ?? (Array.isArray(selection) && selection.length > 0 ? selection.join("|") : null);
          if (pattern) {
            parts.push(`--grep "${pattern}"`);
          }
        } catch {
          // Use default — run all
        }
      }
    }

    return parts.join(" ");
  }

  /**
   * Build the full test execution command based on configured runner.
   */
  _buildTestCommand(testArgs) {
    // Fully custom command override
    if (this.testCommand) {
      return this.testCommand.replace("{args}", testArgs);
    }

    switch (this.testRunner) {
      case "playwright":
        return `cd ${this.testDir} && npx playwright test ${testArgs}`;
      case "jest":
        return `npx jest ${testArgs} --json --outputFile=${this.testDir}/test-results/results.json`;
      case "vitest":
        return `npx vitest run ${testArgs} --reporter=json --outputFile=${this.testDir}/test-results/results.json`;
      case "pytest":
        return `python -m pytest ${testArgs} --tb=short -q --json-report --json-report-file=${this.testDir}/test-results/results.json`;
      default:
        return `cd ${this.testDir} && npx playwright test ${testArgs}`;
    }
  }

  _parseResults(testExitOk) {
    const resultsPath = this.resultsPath ?? path.join(ROOT, this.testDir, "test-results", "results.json");
    try {
      if (fs.existsSync(resultsPath)) {
        const data = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
        let passed = 0, failed = 0, total = 0;

        switch (this.resultsFormat) {
          case "playwright-json": {
            const stats = data.stats ?? {};
            passed = stats.expected ?? data.passed ?? 0;
            failed = (stats.unexpected ?? 0) + (stats.flaky ?? 0) + (data.failed ?? 0);
            total = passed + failed + (stats.skipped ?? 0);
            break;
          }
          case "jest-json": {
            passed = data.numPassedTests ?? 0;
            failed = data.numFailedTests ?? 0;
            total = data.numTotalTests ?? (passed + failed);
            break;
          }
          case "vitest-json": {
            const suites = data.testResults ?? [];
            for (const suite of suites) {
              passed += (suite.assertionResults ?? []).filter((t) => t.status === "passed").length;
              failed += (suite.assertionResults ?? []).filter((t) => t.status === "failed").length;
            }
            total = passed + failed;
            break;
          }
          case "junit-xml": {
            // Basic XML parsing for JUnit format
            const content = fs.readFileSync(resultsPath, "utf-8");
            const testsMatch = content.match(/tests="(\d+)"/);
            const failsMatch = content.match(/failures="(\d+)"/);
            const errorsMatch = content.match(/errors="(\d+)"/);
            total = testsMatch ? parseInt(testsMatch[1], 10) : 0;
            failed = (failsMatch ? parseInt(failsMatch[1], 10) : 0) + (errorsMatch ? parseInt(errorsMatch[1], 10) : 0);
            passed = total - failed;
            break;
          }
          default: {
            // Best-effort: look for common fields
            passed = data.passed ?? data.numPassedTests ?? data.stats?.expected ?? 0;
            failed = data.failed ?? data.numFailedTests ?? data.stats?.unexpected ?? 0;
            total = data.total ?? data.numTotalTests ?? (passed + failed);
          }
        }

        if (total === 0 && !testExitOk) {
          this.log(`warning: ${this.testRunner} exited with error but produced no results — likely crash`);
        }

        return { passed, failed, total };
      }
    } catch {}

    if (!testExitOk) {
      this.log(`warning: no results file and ${this.testRunner} failed — tests did not execute`);
    }
    return { passed: 0, failed: 0, total: 0 };
  }

  /** Read daemon-convergence.json for convergence state (skip/extended interval). */
  _readConvergence() {
    try {
      const p = path.join(STATE_DIR, "daemon-convergence.json");
      if (!fs.existsSync(p)) { return null; }
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  }

  /** Override to use extended interval when converged (timer only; signals always run). */
  shouldRun() {
    const base = super.shouldRun();
    const convergence = this._readConvergence();
    const extendedMin = this.clawConfig.convergenceExtendedIntervalMinutes;
    const useExtended = convergence?.state === "converged" && extendedMin != null && extendedMin > 0;
    const isSignal = base.reason?.startsWith?.("signal:");
    const isInitial = base.reason === "initial";

    if (isSignal || isInitial) {
      return base;
    }
    if (useExtended && this.lastRunAt) {
      const extendedMs = extendedMin * 60 * 1000;
      const elapsed = Date.now() - new Date(this.lastRunAt).getTime();
      if (elapsed >= extendedMs) {
        return { run: true, reason: "converged-extended-interval" };
      }
      return { run: false, reason: "converged-waiting-extended-interval" };
    }
    return base;
  }

  _logPerformance(results, workers) {
    const entry = {
      iter: this.currentCycle,
      duration: Date.now() - (this.lastRunAt ? new Date(this.lastRunAt).getTime() : Date.now()),
      total: results.total,
      passed: results.passed,
      failed: results.failed,
      passRate: results.total > 0 ? ((results.passed / results.total) * 100).toFixed(1) : "0",
      workers: workers ?? "default",
      timestamp: new Date().toISOString(),
    };

    try {
      const logPath = path.join(STATE_DIR, "loop-performance.jsonl");
      fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
      // Prune every 100 entries to prevent unbounded growth
      if (this.currentCycle % 100 === 0) {
        const { pruneJsonlFile } = require("../claw");
        pruneJsonlFile(logPath, 2000);
      }
    } catch {}
  }
}

// Direct execution
if (require.main === module) {
  const claw = new TestRunnerClaw();
  claw.start().catch((err) => {
    console.error(`test-runner fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { TestRunnerClaw };
