#!/usr/bin/env node

/**
 * Claw 9: Observer — Centralized Cycle Intelligence
 *
 * Runs after every cycle, collects all interstitial results from every claw,
 * builds a structured cycle report, judges it for anomalies, investigates
 * root causes, and acts on findings.
 *
 * Schedule: Triggered by tests-complete, fixes-applied, diagnostics-complete.
 *           Fallback: every 30min.
 * Reads:   claw-signals.json, loop-performance.jsonl, moc-queue.json,
 *          fix-effectiveness.json, spec-compliance-report.json, green-history.json,
 *          green-skip-list.json, recently-fixed-files.json, git log
 * Writes:  cycle-reports/cycle-NNN.json, observer-latest.json,
 *          observer-baseline.json, observer-force-run.json
 * Emits:   observer-alert signal
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Claw, ROOT, STATE_DIR, readFileTail } = require("../claw");

const CYCLE_REPORTS_DIR = path.join(STATE_DIR, "cycle-reports");
const BASELINE_PATH = path.join(STATE_DIR, "observer-baseline.json");
const LATEST_PATH = path.join(STATE_DIR, "observer-latest.json");
const FORCE_RUN_PATH = path.join(STATE_DIR, "observer-force-run.json");
const RECENTLY_FIXED_PATH = path.join(STATE_DIR, "recently-fixed-files.json");

class ObserverClaw extends Claw {
  constructor() {
    super("observer");
    this._alertIdCounter = 0;
  }

  async run() {
    // Phase 1: Collect
    this.log("phase 1: collecting interstitial results");
    const report = this._collect();

    // Phase 2: Baseline + Deltas
    this.log("phase 2: updating baseline + computing deltas");
    const baseline = this._updateBaseline(report);
    report.deltas = this._computeDeltas(report, baseline);

    // Phase 3: Judge
    this.log("phase 3: judging anomalies");
    const findings = this._judge(report, baseline);
    report.findings = findings;

    const failing = findings.filter((f) => !f.ok);
    if (failing.length > 0) {
      this.log(`found ${failing.length} anomalies: ${failing.map((f) => f.name).join(", ")}`);
    } else {
      this.log("no anomalies detected");
    }

    // Phase 4: Investigate
    this.log("phase 4: investigating anomalies");
    const investigations = this._investigate(failing, report, baseline);
    report.investigations = investigations;

    // Phase 5: Act
    this.log("phase 5: acting on findings");
    const actions = this._act(failing, investigations, report);
    report.actions = actions;

    // Phase 6: Write cycle report
    this.log("phase 6: writing cycle report");
    this._writeReport(report);

    // Phase 7: Self-observe
    this.log("phase 7: self-observation");
    this._selfObserve(report, baseline, findings);

    const summary = failing.length > 0
      ? `${failing.length} anomalies (${failing.filter((f) => f.severity === "critical").length} critical)`
      : "all clear";
    return { ok: true, summary };
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Collect
  // ---------------------------------------------------------------------------

  _collect() {
    const signals = this._loadAllSignals();
    const report = {
      cycle: this.currentCycle,
      at: new Date().toISOString(),
      tests: this._collectTests(signals),
      testBreakdown: this._collectTestBreakdown(),
      personaPerformance: this._collectPersonaPerformance(),
      findingsPipeline: this._collectFindingsPipeline(signals),
      mocQueue: this._collectMocQueue(),
      timeToFix: this._collectTimeToFix(),
      fixes: this._collectFixes(signals),
      builder: this._collectBuilder(signals),
      cpMeta: this._collectCpMeta(signals),
      intelligence: this._collectIntelligence(signals),
      diagnostics: this._collectDiagnostics(signals),
      git: this._collectGit(),
      greenTracker: this._collectGreenTracker(),
      convergence: this._collectConvergence(),
      budget: this._collectBudget(signals),
      clawHealth: this._collectClawHealth(signals),
      oracle: this._collectOracle(),
      pool: this._collectPool(),
      deploy: this._collectDeploy(signals),
      deployVerification: this._collectDeployVerification(signals),
      errors: this._collectErrors(),
      resources: this._collectResources(),
      // Self-healing ecosystem collectors
      testInventory: this._collectTestInventory(),
      coverageDecay: this._collectCoverageDecay(),
      flakyTests: this._collectFlakyTests(),
      testStaleness: this._collectTestStaleness(),
      manifestCompleteness: this._collectManifestCompleteness(),
      routeMapping: this._collectRouteMapping(),
      quarantine: this._collectQuarantine(),
      testRegen: this._collectTestRegen(),
      stuckTests: this._collectStuckTests(),
      docsSync: this._collectDocsSync(),
      pipelineHealth: this._collectPipelineHealth(),
      deltas: null, // computed after baseline is loaded in Phase 2
      findings: null, // populated in Phase 3 (anomaly findings, not test findings)
      investigations: null, // populated in Phase 4
      actions: null, // populated in Phase 5
    };
    return report;
  }

  _loadAllSignals() {
    try {
      const raw = fs.readFileSync(path.join(STATE_DIR, "claw-signals.json"), "utf-8");
      return JSON.parse(raw);
    } catch {
      return { signals: {}, claws: {} };
    }
  }

  _collectTests(signals) {
    const sig = signals.signals?.["tests-complete"] ?? {};
    const result = {
      passed: sig.passed ?? null,
      failed: sig.failed ?? null,
      total: sig.total ?? null,
      skipped: null,
      effectivePassRate: null,
      duration: null,
      workers: null,
      at: sig.at ?? null,
    };

    // Enrich from loop-performance.jsonl (last entry)
    try {
      const perfPath = path.join(STATE_DIR, "loop-performance.jsonl");
      if (fs.existsSync(perfPath)) {
        const tail = readFileTail(perfPath, 4096);
        const lines = tail.trim().split("\n").filter(Boolean);
        if (lines.length > 0) {
          const last = JSON.parse(lines[lines.length - 1]);
          result.duration = last.duration ?? null;
          result.workers = last.workers ?? null;
          if (result.passed == null) { result.passed = last.passed ?? null; }
          if (result.failed == null) { result.failed = last.failed ?? null; }
          if (result.total == null) { result.total = last.total ?? null; }
          result.skipped = last.skipped ?? null;
          result.effectivePassRate = last.effectivePassRate ?? null;
        }
      }
    } catch { /* non-fatal */ }

    // Compute skipped and effectivePassRate if not already present
    if (result.total != null && result.passed != null && result.failed != null) {
      if (result.skipped == null) {
        result.skipped = result.total - result.passed - result.failed;
      }
      if (result.effectivePassRate == null) {
        const tested = result.passed + result.failed;
        result.effectivePassRate = tested > 0
          ? parseFloat(((result.passed / tested) * 100).toFixed(1))
          : 0;
      }
    }

    return result;
  }

  _collectFixes(signals) {
    const sig = signals.signals?.["fixes-applied"] ?? {};
    const result = {
      applied: sig.applied ?? 0,
      failed: sig.failed ?? 0,
      filesChanged: [],
      mocsFixed: [],
      revertedCount: 0,
      at: sig.at ?? null,
    };

    // Enrich from recently-fixed-files.json
    try {
      if (fs.existsSync(RECENTLY_FIXED_PATH)) {
        const data = JSON.parse(fs.readFileSync(RECENTLY_FIXED_PATH, "utf-8"));
        result.filesChanged = data.files ?? [];
        result.mocsFixed = data.mocIds ?? [];
        result.preFixPassRate = data.preFixPassRate ?? null;
      }
    } catch { /* non-fatal */ }

    // Enrich from fix-effectiveness.json
    try {
      const fxPath = path.join(STATE_DIR, "fix-effectiveness.json");
      if (fs.existsSync(fxPath)) {
        const data = JSON.parse(fs.readFileSync(fxPath, "utf-8"));
        result.revertedCount = data.revertedCount ?? 0;
      }
    } catch { /* non-fatal */ }

    return result;
  }

  _collectBuilder(signals) {
    const sig = signals.signals?.["build-complete"] ?? {};
    const result = {
      compliance: null,
      gaps: null,
      phase: null,
      at: sig.at ?? null,
    };

    try {
      const specPath = path.join(STATE_DIR, "spec-compliance-report.json");
      if (fs.existsSync(specPath)) {
        const data = JSON.parse(fs.readFileSync(specPath, "utf-8"));
        result.compliance = data.completionRate ?? data.compliance ?? null;
        result.gaps = data.gapsRemaining ?? data.gaps ?? null;
        result.phase = data.phase ?? null;
      }
    } catch { /* non-fatal */ }

    return result;
  }

  _collectCpMeta(signals) {
    const sig = signals.signals?.["cp-meta-complete"] ?? {};
    return {
      mocsAdvanced: sig.mocsProcessed ?? sig.mocsAdvanced ?? 0,
      remaining: sig.remaining ?? 0,
      playwrightOk: sig.playwrightOk ?? true,
      at: sig.at ?? null,
    };
  }

  _collectIntelligence(signals) {
    const sig = signals.signals?.["intelligence-complete"] ?? {};
    return {
      subsystems: sig.subsystems ?? null,
      failed: sig.failed ?? 0,
      at: sig.at ?? null,
    };
  }

  _collectDiagnostics(signals) {
    const sig = signals.signals?.["diagnostics-complete"] ?? {};
    return {
      healthChecks: sig.healthChecks ?? null,
      failing: sig.failing ?? 0,
      actions: sig.actions ?? 0,
      at: sig.at ?? null,
    };
  }

  _collectGit() {
    const result = {
      commitsSinceLastCycle: 0,
      autoFixCommits: 0,
      deploysSinceLastCycle: 0,
    };

    try {
      const since = this.lastRunAt ?? new Date(Date.now() - 3600000).toISOString();
      const log = execSync(
        `git log --oneline --since="${since}" 2>/dev/null`,
        { cwd: ROOT, encoding: "utf-8", timeout: 10000 }
      ).trim();
      if (log) {
        const lines = log.split("\n");
        result.commitsSinceLastCycle = lines.length;
        result.autoFixCommits = lines.filter((l) =>
          l.includes("auto-fix") || l.includes("moc-auto-fix") || l.includes("claw fix-engine")
        ).length;
      }
    } catch { /* non-fatal */ }

    // Count deploys from deploy signals
    try {
      const signals = this._loadAllSignals();
      const deploySig = signals.signals?.["deploy-detected"];
      if (deploySig?.at && this.lastRunAt) {
        if (new Date(deploySig.at) > new Date(this.lastRunAt)) {
          result.deploysSinceLastCycle = 1;
        }
      }
      // Git conflict detection
      const gitConflictSig = signals.signals?.["git-conflict"];
      if (gitConflictSig?.at) {
        const age = Date.now() - new Date(gitConflictSig.at).getTime();
        if (age < 24 * 60 * 60 * 1000) {
          result.gitConflict = {
            claw: gitConflictSig.claw ?? "unknown",
            detail: gitConflictSig.detail ?? "",
            at: gitConflictSig.at,
          };
        }
      }
    } catch { /* non-fatal */ }

    return result;
  }

  _collectFindingsPipeline(signals) {
    const sig = signals.signals?.["mocs-ready"] ?? {};
    const result = {
      openCount: 0,
      newThisCycle: sig.newFindings ?? 0,
      autoResolved: sig.autoResolved ?? 0,
      noiseRate: null,
      themes: null,
      at: sig.at ?? null,
    };

    // From findings.json
    try {
      const findingsPath = path.join(STATE_DIR, "findings", "findings.json");
      if (fs.existsSync(findingsPath)) {
        const data = JSON.parse(fs.readFileSync(findingsPath, "utf-8"));
        const findings = data.findings ?? data;
        if (Array.isArray(findings)) {
          result.openCount = findings.filter((f) => f.status !== "resolved").length;
          const total = findings.length;
          const noise = findings.filter((f) => f._resolvedBy === "auto-triage" || f._resolvedBy === "noise").length;
          result.noiseRate = total > 0 ? parseFloat(((noise / total) * 100).toFixed(1)) : 0;
        }
      }
    } catch { /* non-fatal */ }

    // From finding-themes.json
    try {
      const themesPath = path.join(STATE_DIR, "finding-themes.json");
      if (fs.existsSync(themesPath)) {
        const data = JSON.parse(fs.readFileSync(themesPath, "utf-8"));
        result.themes = data.themes?.length ?? data.length ?? null;
      }
    } catch { /* non-fatal */ }

    return result;
  }

  _collectMocQueue() {
    const result = {
      total: 0,
      byStatus: {},
      byTier: {},
      awaitingHuman: 0,
      staleApproved: 0,
    };

    try {
      const queue = this.readState("moc-queue.json");
      if (queue?.mocs && Array.isArray(queue.mocs)) {
        result.total = queue.mocs.length;
        for (const moc of queue.mocs) {
          const status = moc.status ?? "unknown";
          result.byStatus[status] = (result.byStatus[status] ?? 0) + 1;
          const tier = moc.tier ?? "unknown";
          result.byTier[tier] = (result.byTier[tier] ?? 0) + 1;
        }
        result.awaitingHuman = queue.mocs.filter((m) =>
          m.status === "needs_human" || m.status === "awaiting_closeout" || m.status === "pending_approval"
        ).length;
        // Malformed: MOCs without an id field
        result.malformedCount = queue.mocs.filter((m) => !m.id).length;
        // Stale: approved but unfixed for >24h
        const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
        result.staleApproved = queue.mocs.filter((m) =>
          ["approved", "pending_fix"].includes(m.status) &&
          m._approvedAt && new Date(m._approvedAt).getTime() < staleThreshold
        ).length;
      }
    } catch { /* non-fatal */ }

    return result;
  }

  _collectGreenTracker() {
    const result = {
      totalTracked: 0,
      stable5: 0,
      stable20: 0,
      stable50: 0,
      skipListSize: 0,
      reintroductionDue: 0,
    };

    try {
      const history = this.readState("green-history.json");
      if (history?.tests) {
        const tests = Object.values(history.tests);
        result.totalTracked = tests.length;
        result.stable5 = tests.filter((t) => t.consecutivePasses >= 5).length;
        result.stable20 = tests.filter((t) => t.consecutivePasses >= 20).length;
        result.stable50 = tests.filter((t) => t.consecutivePasses >= 50).length;
      }
    } catch { /* non-fatal */ }

    try {
      const skipList = this.readState("green-skip-list.json");
      result.skipListSize = skipList?.skippable?.length ?? 0;
      result.reintroductionDue = skipList?.due?.length ?? 0;
    } catch { /* non-fatal */ }

    return result;
  }

  _collectConvergence() {
    try {
      const data = this.readState("daemon-convergence.json");
      if (!data) { return { state: "unknown" }; }
      return {
        state: data.state ?? "unknown",
        netProgress: data.netProgress ?? null,
        streak: data.streak ?? null,
        convergedSince: data.convergedSince ?? null,
      };
    } catch {
      return { state: "unknown" };
    }
  }

  _collectBudget(signals) {
    const result = {
      exhausted: false,
      exhaustedAt: null,
      clawSpend: {},
    };

    try {
      const budgetPath = path.join(STATE_DIR, "budget-exhausted.json");
      if (fs.existsSync(budgetPath)) {
        const data = JSON.parse(fs.readFileSync(budgetPath, "utf-8"));
        const freshMs = 2 * 60 * 60 * 1000;
        if (data.at && Date.now() - new Date(data.at).getTime() < freshMs) {
          result.exhausted = true;
          result.exhaustedAt = data.at;
        }
      }
    } catch { /* non-fatal */ }

    // Per-claw spend from token-logger
    try {
      const { getSpendSummary } = require("../lib/token-logger");
      const spend = getSpendSummary(1); // Last hour
      result.clawSpend = spend.byComponent ?? {};
      result.hourlyTotal = spend.total ?? 0;
    } catch { /* non-fatal */ }

    // Budget effectiveness from budget-effectiveness.json
    try {
      const effectiveness = this.readState("budget-effectiveness.json");
      if (effectiveness?.summary?.last24h) {
        const summary = effectiveness.summary.last24h;
        result.totalSpend24h = summary.totalSpend ?? 0;
        result.wastedSpend24h = summary.wastedSpend ?? 0;
        result.wastedPct = summary.wastedPct ?? 0;
        result.byOutcome = summary.byOutcome ?? {};
        result.partialOutputCount = (effectiveness.entries ?? [])
          .filter((e) => {
            const at = new Date(e.at).getTime();
            return Date.now() - at < 24 * 60 * 60 * 1000 && (e.outcome === "partial" || e.outcome === "budget_exceeded");
          }).length;
      }

      // Zero-spend detection: claws running cycles but producing no token spend
      // Compare claw cycle counts from signals vs spend entries in budget-effectiveness
      const entries = effectiveness?.entries ?? [];
      const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
      const recentEntries = entries.filter((e) => new Date(e.at).getTime() > cutoff24h);
      const componentsWithSpend = new Set(recentEntries.map((e) => e.component));

      // Claws that should produce token spend when they run (they call Claude CLI or LLM APIs)
      const spendingClaws = ["fix-engine", "builder", "intelligence", "finding-pipeline", "health-deploy", "test-regen"];
      result.idleSpenders = [];
      for (const claw of spendingClaws) {
        const clawState = this.config?.claws?.[claw];
        if (!clawState?.enabled) { continue; }
        const signals = this.readState("claw-signals.json");
        const clawCycles = signals?.claws?.[claw]?.cycle ?? 0;
        if (clawCycles >= 3 && !componentsWithSpend.has(claw)) {
          result.idleSpenders.push(claw);
        }
      }
    } catch { /* non-fatal */ }

    // Token usage trends from persona-token-usage.jsonl
    try {
      const tokenLogPath = path.join(STATE_DIR, "persona-token-usage.jsonl");
      if (fs.existsSync(tokenLogPath)) {
        const raw = fs.readFileSync(tokenLogPath, "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean).slice(-200);
        const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const cutoff6h = Date.now() - 6 * 60 * 60 * 1000;
        const recent = entries.filter((e) => new Date(e.ts || e.at || 0).getTime() > cutoff6h);
        result.tokenUsage6h = {
          calls: recent.length,
          totalTokens: recent.reduce((s, e) => s + (e.totalTokens ?? e.tokens ?? 0), 0),
          totalCost: recent.reduce((s, e) => s + (e.costUSD ?? e.cost ?? 0), 0),
        };

        // OpenAI fallback detection — count OpenAI calls in last 24h
        const cutoff24hToken = Date.now() - 24 * 60 * 60 * 1000;
        const openaiCalls = entries.filter((e) => {
          const ts = new Date(e.ts || e.at || 0).getTime();
          return ts > cutoff24hToken && (e.provider === "openai" || (e.model ?? "").includes("gpt"));
        });
        result.openaiUsage = {
          calls24h: openaiCalls.length,
          cost24h: openaiCalls.reduce((s, e) => s + (e.costUSD ?? 0), 0),
          components: [...new Set(openaiCalls.map((e) => e.component))],
        };
      }
    } catch { /* non-fatal */ }

    return result;
  }

  _collectClawHealth(signals) {
    const claws = {};
    const clawNames = [
      "test-runner", "finding-pipeline", "builder", "cp-meta",
      "fix-engine", "intelligence", "health-deploy", "diagnostics", "observer", "test-regen", "docs-sync",
    ];

    for (const name of clawNames) {
      const state = signals.claws?.[name] ?? {};
      claws[name] = {
        status: state.status ?? "unknown",
        lastRun: state.lastRun ?? null,
        cycle: state.cycle ?? 0,
        heartbeat: state.heartbeat ?? null,
        stale: state.heartbeat
          ? Date.now() - new Date(state.heartbeat).getTime() > 5 * 60 * 1000
          : true,
      };
    }

    return claws;
  }

  _collectOracle() {
    const result = {
      cacheEntries: 0,
      cacheHits: 0,
      modelRouting: null,
    };

    try {
      const oracleCache = this.readState("oracle-pattern-cache.json");
      if (oracleCache) {
        result.cacheEntries = Object.keys(oracleCache.patterns ?? oracleCache).length;
        result.cacheHits = oracleCache.totalHits ?? 0;
      }
    } catch { /* non-fatal */ }

    try {
      const discovery = this.readState("discovery-samples.json");
      if (discovery) {
        result.discoverySamples = discovery.samples?.length ?? 0;
        result.blindSpotsFound = discovery.blindSpotsFound ?? 0;
      }
    } catch { /* non-fatal */ }

    return result;
  }

  _collectPool() {
    const result = {
      size: 0,
      activeSessions: 0,
    };

    try {
      const poolPath = path.join(STATE_DIR, "session-pool.json");
      if (fs.existsSync(poolPath)) {
        const data = JSON.parse(fs.readFileSync(poolPath, "utf-8"));
        const sessions = data.sessions ?? data;
        if (typeof sessions === "object") {
          const entries = Object.values(sessions);
          result.size = entries.length;
          result.activeSessions = entries.filter((s) => s.active || s.inUse).length;
        }
      }
    } catch { /* non-fatal */ }

    return result;
  }

  _collectDeploy(signals) {
    const deploySig = signals.signals?.["deploy-detected"] ?? {};
    return {
      latestSha: deploySig.sha ?? null,
      at: deploySig.at ?? null,
      timeSinceDeploy: deploySig.at
        ? Math.round((Date.now() - new Date(deploySig.at).getTime()) / 60000)
        : null,
    };
  }

  _collectErrors() {
    const result = {
      recentCount: 0,
      unresolvedCount: 0,
      topEndpoints: [],
    };

    try {
      const errPath = path.join(STATE_DIR, "error-correlation.json");
      if (fs.existsSync(errPath)) {
        const data = JSON.parse(fs.readFileSync(errPath, "utf-8"));
        result.recentCount = data.recentCount ?? data.totalErrors ?? 0;
        result.unresolvedCount = data.unresolvedCount ?? 0;
        if (data.topEndpoints) {
          result.topEndpoints = data.topEndpoints.slice(0, 5);
        }
      }
    } catch { /* non-fatal */ }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Deep Collectors: Route-level, Persona-level, Time-to-fix, Deploy chain,
  // Resources, and Deltas
  // ---------------------------------------------------------------------------

  /**
   * Parse Playwright's results.json to build route-level pass/fail breakdown.
   * Each test title contains persona + route info (e.g., "Cliff Patience -- /mocs > can see list").
   * We extract route from the test suite/spec structure and aggregate.
   */
  _collectTestBreakdown() {
    const result = {
      byRoute: {},       // route → { passed, failed, skipped, total, avgDurationMs, flaky }
      bySpec: {},        // spec file → { passed, failed, skipped, total, durationMs }
      failingTests: [],  // top 20 failing test titles with error snippets
      slowTests: [],     // top 10 slowest passing tests
      flakyTests: [],    // tests that passed on retry
      routeHeatmap: [],  // sorted by failure rate descending
    };

    try {
      const resultsPath = path.join(ROOT, "e2e", "test-results", "results.json");
      if (!fs.existsSync(resultsPath)) { return result; }

      const data = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
      const suites = data.suites ?? [];

      for (const suite of suites) {
        const specFile = suite.file ?? suite.title ?? "unknown";
        const specStats = { passed: 0, failed: 0, skipped: 0, total: 0, durationMs: 0 };

        this._walkSpecs(suite, specFile, specStats, result);
        result.bySpec[specFile] = specStats;
      }

      // Finalize route stats (compute averages, clean up raw arrays)
      this._finalizeRouteStats(result.byRoute);

      // Build route heatmap — sorted by failure rate
      result.routeHeatmap = Object.entries(result.byRoute)
        .map(([route, stats]) => ({
          route,
          ...stats,
          failureRate: stats.total > 0
            ? parseFloat(((stats.failed / stats.total) * 100).toFixed(1))
            : 0,
        }))
        .filter((r) => r.total > 0)
        .sort((a, b) => b.failureRate - a.failureRate)
        .slice(0, 30);

      // Sort and cap lists
      result.failingTests = result.failingTests.slice(0, 20);
      result.slowTests.sort((a, b) => b.durationMs - a.durationMs);
      result.slowTests = result.slowTests.slice(0, 10);
    } catch (err) {
      this.log(`test-breakdown parse error: ${err.message}`);
    }

    return result;
  }

  /**
   * Recursively walk Playwright suite tree to extract per-test data.
   * Suites can be nested (suite > suite > spec > test).
   */
  _walkSpecs(suite, specFile, specStats, result) {
    // Process specs at this level
    for (const spec of (suite.specs ?? [])) {
      const testTitle = spec.title ?? "untitled";
      // Extract route from test title — titles look like:
      // "Persona Name -- Route Description > test name"
      const route = this._extractRouteFromTitle(testTitle, specFile);

      for (const test of (spec.tests ?? [])) {
        const testResults = test.results ?? [];
        if (testResults.length === 0) { continue; }

        const lastResult = testResults[testResults.length - 1];
        const status = lastResult.status ?? test.status ?? "skipped";
        const duration = lastResult.duration ?? 0;
        const isFlaky = testResults.length > 1 && status === "passed";

        // Update spec stats
        specStats.total++;
        specStats.durationMs += duration;
        if (status === "passed" || status === "expected") { specStats.passed++; }
        else if (status === "skipped") { specStats.skipped++; }
        else { specStats.failed++; }

        // Update route stats
        if (!result.byRoute[route]) {
          result.byRoute[route] = { passed: 0, failed: 0, skipped: 0, total: 0, avgDurationMs: 0, flaky: 0, durations: [] };
        }
        const rs = result.byRoute[route];
        rs.total++;
        rs.durations.push(duration);
        if (status === "passed" || status === "expected") { rs.passed++; }
        else if (status === "skipped") { rs.skipped++; }
        else { rs.failed++; }
        if (isFlaky) { rs.flaky++; }

        // Collect failing tests with error context
        if (status !== "passed" && status !== "expected" && status !== "skipped") {
          const errors = lastResult.errors ?? [];
          const errorSnippet = errors.length > 0
            ? (errors[0].message ?? errors[0].snippet ?? "").slice(0, 300)
            : "";
          result.failingTests.push({
            title: `${specFile}: ${testTitle}`,
            route,
            status,
            durationMs: duration,
            error: errorSnippet,
            retries: testResults.length - 1,
          });
        }

        // Collect slow passing tests
        if ((status === "passed" || status === "expected") && duration > 30000) {
          result.slowTests.push({
            title: `${specFile}: ${testTitle}`,
            route,
            durationMs: duration,
          });
        }

        // Collect flaky tests
        if (isFlaky) {
          result.flakyTests.push({
            title: `${specFile}: ${testTitle}`,
            route,
            retries: testResults.length - 1,
            finalDurationMs: duration,
          });
        }
      }
    }

    // Recurse into nested suites
    for (const child of (suite.suites ?? [])) {
      this._walkSpecs(child, specFile, specStats, result);
    }
  }

  /**
   * Finalize route stats: compute averages and remove raw duration arrays.
   * Called once after all suites have been walked.
   */
  _finalizeRouteStats(byRoute) {
    for (const rs of Object.values(byRoute)) {
      if (rs.durations && rs.durations.length > 0) {
        rs.avgDurationMs = Math.round(rs.durations.reduce((a, b) => a + b, 0) / rs.durations.length);
      }
      delete rs.durations;
    }
  }

  /**
   * Extract a route identifier from a test title and spec file.
   * Persona spec files: "personas/cliff-patience.spec.ts"
   * Test titles: "Cliff Patience -- MOC Creation > Stage 0 > can see button"
   *
   * We categorize by the page/route being tested, not the persona.
   */
  _extractRouteFromTitle(title, specFile) {
    // Common route patterns in test titles
    const routePatterns = [
      { pattern: /stage[- ]?(\d)/i, route: (m) => `/moc/*/stage-${m[1]}` },
      { pattern: /\/mocs\/completed/i, route: () => "/mocs/completed" },
      { pattern: /\/mocs\/portfolio/i, route: () => "/mocs/portfolio" },
      { pattern: /\/mocs\/new/i, route: () => "/mocs/new" },
      { pattern: /\b(?:moc list|\/mocs\b|mocs page)/i, route: () => "/mocs" },
      { pattern: /\/admin\/permissions/i, route: () => "/admin/permissions" },
      { pattern: /\/admin\/departments/i, route: () => "/admin/departments" },
      { pattern: /\/admin\/people/i, route: () => "/admin/people" },
      { pattern: /\/admin\/features/i, route: () => "/admin/features" },
      { pattern: /\/admin\/developer/i, route: () => "/admin/developer" },
      { pattern: /\/admin\/agents/i, route: () => "/admin/agents" },
      { pattern: /\/admin\/audit/i, route: () => "/admin/audit-log" },
      { pattern: /\/admin\/webhooks/i, route: () => "/admin/webhooks" },
      { pattern: /\/admin/i, route: () => "/admin" },
      { pattern: /role[- ]?inbox|review inbox/i, route: () => "/review/role-inbox" },
      { pattern: /my[- ]?department/i, route: () => "/my-department" },
      { pattern: /account.*settings/i, route: () => "/account/settings" },
      { pattern: /pricing/i, route: () => "/pricing" },
      { pattern: /login|sign.?in/i, route: () => "/login" },
      { pattern: /dark mode/i, route: () => "/dark-mode" },
      { pattern: /navigation|nav\b|sidebar/i, route: () => "/navigation" },
      { pattern: /notification/i, route: () => "/notifications" },
    ];

    for (const { pattern, route } of routePatterns) {
      const match = title.match(pattern);
      if (match) { return route(match); }
    }

    // Fallback: derive from spec file
    // "personas/cliff-patience.spec.ts" → "cliff-patience"
    const specName = specFile.replace(/^.*\//, "").replace(/\.spec\.ts$/, "");
    return `/${specName}`;
  }

  /**
   * Persona-level performance: pass rate, fail count, duration per persona.
   * Cross-referenced with ROI scores for "are high-value personas healthy?"
   */
  _collectPersonaPerformance() {
    const result = {
      personas: {},     // personaId → { passed, failed, skipped, total, durationMs, passRate, roiTier }
      topFailers: [],   // sorted by failure count desc
      highValueHealth: null, // { healthy, degraded, failing } counts for high-ROI personas
    };

    try {
      const resultsPath = path.join(ROOT, "e2e", "test-results", "results.json");
      if (!fs.existsSync(resultsPath)) { return result; }

      const data = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
      const suites = data.suites ?? [];

      for (const suite of suites) {
        const specFile = suite.file ?? suite.title ?? "";
        // Extract persona ID from spec file: "personas/cliff-patience.spec.ts" → "cliff-patience"
        const personaMatch = specFile.match(/personas\/([^.]+)\.spec/);
        if (!personaMatch) { continue; }
        const personaId = personaMatch[1];

        if (!result.personas[personaId]) {
          result.personas[personaId] = { passed: 0, failed: 0, skipped: 0, total: 0, durationMs: 0 };
        }

        this._walkSuiteForPersona(suite, result.personas[personaId]);
      }

      // Compute pass rates
      for (const [id, p] of Object.entries(result.personas)) {
        p.passRate = p.total > 0
          ? parseFloat(((p.passed / p.total) * 100).toFixed(1))
          : 0;
      }

      // Merge ROI data
      try {
        const roi = this.readState("persona-roi.json");
        if (roi?.personas) {
          for (const [id, roiData] of Object.entries(roi.personas)) {
            if (result.personas[id]) {
              result.personas[id].roiTier = roiData.tier ?? null;
              result.personas[id].roiScore = roiData.roiScore ?? null;
            }
          }
        }
      } catch { /* non-fatal */ }

      // Top failers
      result.topFailers = Object.entries(result.personas)
        .filter(([, p]) => p.failed > 0)
        .map(([id, p]) => ({ personaId: id, failed: p.failed, total: p.total, passRate: p.passRate, roiTier: p.roiTier }))
        .sort((a, b) => b.failed - a.failed)
        .slice(0, 15);

      // High-value persona health
      const highValue = Object.entries(result.personas).filter(([, p]) => p.roiTier === "high");
      if (highValue.length > 0) {
        result.highValueHealth = {
          total: highValue.length,
          healthy: highValue.filter(([, p]) => p.passRate >= 90).length,
          degraded: highValue.filter(([, p]) => p.passRate >= 50 && p.passRate < 90).length,
          failing: highValue.filter(([, p]) => p.passRate < 50).length,
        };
      }
    } catch (err) {
      this.log(`persona-performance parse error: ${err.message}`);
    }

    return result;
  }

  _walkSuiteForPersona(suite, stats) {
    for (const spec of (suite.specs ?? [])) {
      for (const test of (spec.tests ?? [])) {
        const testResults = test.results ?? [];
        if (testResults.length === 0) { continue; }
        const lastResult = testResults[testResults.length - 1];
        const status = lastResult.status ?? test.status ?? "skipped";
        const duration = lastResult.duration ?? 0;

        stats.total++;
        stats.durationMs += duration;
        if (status === "passed" || status === "expected") { stats.passed++; }
        else if (status === "skipped") { stats.skipped++; }
        else { stats.failed++; }
      }
    }
    for (const child of (suite.suites ?? [])) {
      this._walkSuiteForPersona(child, stats);
    }
  }

  /**
   * Time-to-fix tracking: how long MOCs sit between stages.
   * Reveals pipeline bottlenecks (e.g., MOCs stuck at approved for days).
   */
  _collectTimeToFix() {
    const result = {
      medianApprovedToFixMs: null,
      p90ApprovedToFixMs: null,
      medianCreatedToClosedMs: null,
      oldestApprovedMoc: null,
      stuckMocs: [],       // MOCs in approved/pending_fix for >24h
      completedLast24h: 0,
      byTier: {},          // tier → { count, medianMs }
    };

    try {
      const queue = this.readState("moc-queue.json");
      if (!queue?.mocs) { return result; }

      const now = Date.now();
      const approvedDurations = [];
      const createdToClosedDurations = [];
      const tierDurations = {};

      for (const moc of queue.mocs) {
        // Time from approved to fix-applied (or still waiting)
        if (moc._approvedAt) {
          const approvedAt = new Date(moc._approvedAt).getTime();

          if (moc._fixAppliedAt) {
            const fixMs = new Date(moc._fixAppliedAt).getTime() - approvedAt;
            approvedDurations.push(fixMs);

            const tier = moc.tier ?? "unknown";
            if (!tierDurations[tier]) { tierDurations[tier] = []; }
            tierDurations[tier].push(fixMs);
          } else if (["approved", "pending_fix"].includes(moc.status)) {
            const waitMs = now - approvedAt;
            // Track stuck MOCs (>24h waiting for fix)
            if (waitMs > 24 * 60 * 60 * 1000) {
              result.stuckMocs.push({
                id: moc.id,
                tier: moc.tier,
                waitingHours: Math.round(waitMs / (60 * 60 * 1000)),
                approvedAt: moc._approvedAt,
              });
            }
            // Track oldest
            if (!result.oldestApprovedMoc || approvedAt < new Date(result.oldestApprovedMoc.approvedAt).getTime()) {
              result.oldestApprovedMoc = {
                id: moc.id,
                tier: moc.tier,
                approvedAt: moc._approvedAt,
                waitingHours: Math.round(waitMs / (60 * 60 * 1000)),
              };
            }
          }
        }

        // Time from creation to completion
        if (moc.createdAt && moc._completedAt) {
          const totalMs = new Date(moc._completedAt).getTime() - new Date(moc.createdAt).getTime();
          createdToClosedDurations.push(totalMs);
        }

        // Count completed in last 24h
        if (moc._completedAt) {
          const completedAt = new Date(moc._completedAt).getTime();
          if (now - completedAt < 24 * 60 * 60 * 1000) {
            result.completedLast24h++;
          }
        }
      }

      // Compute percentiles
      if (approvedDurations.length > 0) {
        approvedDurations.sort((a, b) => a - b);
        result.medianApprovedToFixMs = approvedDurations[Math.floor(approvedDurations.length / 2)];
        result.p90ApprovedToFixMs = approvedDurations[Math.floor(approvedDurations.length * 0.9)];
      }

      if (createdToClosedDurations.length > 0) {
        createdToClosedDurations.sort((a, b) => a - b);
        result.medianCreatedToClosedMs = createdToClosedDurations[Math.floor(createdToClosedDurations.length / 2)];
      }

      // Per-tier stats
      for (const [tier, durations] of Object.entries(tierDurations)) {
        durations.sort((a, b) => a - b);
        result.byTier[tier] = {
          count: durations.length,
          medianMs: durations[Math.floor(durations.length / 2)],
          minMs: durations[0],
          maxMs: durations[durations.length - 1],
        };
      }

      result.stuckMocs.sort((a, b) => b.waitingHours - a.waitingHours);
      result.stuckMocs = result.stuckMocs.slice(0, 10);
    } catch (err) {
      this.log(`time-to-fix parse error: ${err.message}`);
    }

    return result;
  }

  /**
   * Deploy verification chain: after a deploy, did the first test run confirm fixes?
   * Tracks: deploy SHA → test run → pass rate delta → verdict
   */
  _collectDeployVerification(signals) {
    const result = {
      lastDeploySha: null,
      deployAt: null,
      firstTestAfterDeploy: null,
      passRateBeforeDeploy: null,
      passRateAfterDeploy: null,
      verdict: null, // "confirmed" | "regression" | "inconclusive" | "pending"
      verifiedFixCount: 0,
    };

    try {
      const deploySig = signals.signals?.["deploy-detected"];
      if (!deploySig?.at) { return result; }

      result.lastDeploySha = deploySig.sha ?? null;
      result.deployAt = deploySig.at;

      // Find the first tests-complete signal after the deploy
      const testSig = signals.signals?.["tests-complete"];
      if (!testSig?.at) {
        result.verdict = "pending";
        return result;
      }

      const deployTime = new Date(deploySig.at).getTime();
      const testTime = new Date(testSig.at).getTime();

      if (testTime < deployTime) {
        result.verdict = "pending"; // Tests haven't run since deploy
        return result;
      }

      result.firstTestAfterDeploy = testSig.at;
      if (testSig.passed != null && testSig.total != null && testSig.total > 0) {
        result.passRateAfterDeploy = parseFloat(((testSig.passed / testSig.total) * 100).toFixed(1));
      }

      // Get pre-deploy pass rate from baseline
      const baseline = this._loadBaseline();
      const history = baseline.history ?? [];
      // Find last cycle before the deploy
      const preDeploy = history.filter((h) =>
        h.at && new Date(h.at).getTime() < deployTime
      );
      if (preDeploy.length > 0) {
        result.passRateBeforeDeploy = preDeploy[preDeploy.length - 1].passRate;
      }

      // Verdict
      if (result.passRateAfterDeploy != null && result.passRateBeforeDeploy != null) {
        const delta = result.passRateAfterDeploy - result.passRateBeforeDeploy;
        if (delta >= -2) {
          result.verdict = "confirmed"; // Pass rate held or improved
        } else if (delta < -10) {
          result.verdict = "regression";
        } else {
          result.verdict = "inconclusive"; // Small drop, could be noise
        }
      } else {
        result.verdict = "inconclusive";
      }

      // Count verified fixes from fix-impact
      try {
        const fxPath = path.join(STATE_DIR, "fix-impact.json");
        if (fs.existsSync(fxPath)) {
          const fx = JSON.parse(fs.readFileSync(fxPath, "utf-8"));
          result.verifiedFixCount = fx.verified ?? 0;
        }
      } catch { /* non-fatal */ }
    } catch (err) {
      this.log(`deploy-verification error: ${err.message}`);
    }

    return result;
  }

  /**
   * Resource/memory footprint: detect leaks before OOM.
   * Reads process memory for the daemon and estimates claw usage.
   */
  _collectResources() {
    const result = {
      observerHeapMB: 0,
      observerRssMB: 0,
      systemTotalMB: 0,
      systemFreeMB: 0,
      systemUsedPct: 0,
      clawProcesses: 0,
      nodeProcesses: 0,
    };

    try {
      const mem = process.memoryUsage();
      result.observerHeapMB = Math.round(mem.heapUsed / 1024 / 1024);
      result.observerRssMB = Math.round(mem.rss / 1024 / 1024);
    } catch { /* non-fatal */ }

    try {
      const os = require("os");
      result.systemTotalMB = Math.round(os.totalmem() / 1024 / 1024);
      result.systemFreeMB = Math.round(os.freemem() / 1024 / 1024);
      result.systemUsedPct = parseFloat(
        (((result.systemTotalMB - result.systemFreeMB) / result.systemTotalMB) * 100).toFixed(1)
      );
    } catch { /* non-fatal */ }

    // Count moc-ai node processes
    try {
      const ps = execSync(
        'wmic process where "name=\'node.exe\'" get CommandLine,WorkingSetSize /format:csv 2>nul || ps aux 2>/dev/null | grep node | grep -c moc-ai 2>/dev/null || true',
        { encoding: "utf-8", timeout: 10000, cwd: ROOT, stdio: "pipe" }
      );
      const lines = ps.split("\n").filter((l) => l.includes("moc-ai"));
      result.nodeProcesses = lines.length;
      // Estimate claw processes (those running from scripts/e2e/claws/)
      result.clawProcesses = lines.filter((l) => l.includes("claws/")).length;
    } catch {
      // Can't count processes — not critical
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Self-Healing Ecosystem Collectors
  // ---------------------------------------------------------------------------

  _collectTestInventory() {
    const result = {
      specsOnDisk: 0,
      testsOnDisk: 0,
      testsInGreenHistory: 0,
      personasInManifest: 0,
      personasInStrategy: 0,
      specsWithoutManifest: [],
      neverRanPersonas: [],
      testsNeverPassed: 0,
    };

    try {
      // Spec files on disk
      const specDir = path.join(ROOT, "e2e", "tests", "personas");
      if (fs.existsSync(specDir)) {
        const files = fs.readdirSync(specDir).filter((f) => f.endsWith(".spec.ts"));
        result.specsOnDisk = files.length;

        // Count test() calls per file (rough estimate)
        let totalTests = 0;
        for (const f of files) {
          try {
            const content = fs.readFileSync(path.join(specDir, f), "utf-8");
            const matches = content.match(/\btest\s*\(/g);
            totalTests += matches ? matches.length : 0;
          } catch { /* skip */ }
        }
        result.testsOnDisk = totalTests;

        // Cross-reference with manifest
        const manifest = this.readState("manifest.json");
        const manifestPersonas = new Set();
        if (manifest?.features) {
          for (const feat of Object.values(manifest.features)) {
            for (const p of feat.personas || []) {
              manifestPersonas.add(p);
            }
          }
        }
        result.personasInManifest = manifestPersonas.size;

        for (const f of files) {
          const personaId = f.replace(".spec.ts", "");
          if (!manifestPersonas.has(personaId)) {
            result.specsWithoutManifest.push(personaId);
          }
        }
      }

      // Green history
      const greenHistory = this.readState("green-history.json");
      if (greenHistory?.tests) {
        result.testsInGreenHistory = Object.keys(greenHistory.tests).length;
        result.testsNeverPassed = Object.values(greenHistory.tests)
          .filter((t) => t.consecutivePasses === 0 && !t.lastRun).length;
      }

      // Strategy
      const strategy = this.readState("test-strategy.json");
      result.personasInStrategy = strategy?.recommendedFilter?.length ?? 0;

      // Never-ran personas: in manifest but no green-history entries
      const personaLearning = this.readState("persona-learning.json");
      const personas = personaLearning?.personas ?? {};
      for (const [id, data] of Object.entries(personas)) {
        if ((data.totalRuns ?? 0) === 0) {
          result.neverRanPersonas.push(id);
        }
      }
    } catch (err) {
      this.log(`test-inventory collect error: ${err.message}`);
    }

    return result;
  }

  _collectCoverageDecay() {
    const result = {
      currentVolume: 0,
      peakVolume: 0,
      volumeDecayPct: 0,
      runningPersonas: 0,
      totalPersonas: 0,
      personaCoveragePct: 0,
      trueCoveragePct: 0,
    };

    try {
      const baseline = this._loadBaseline();
      const history = baseline.history ?? [];

      // Current and peak volume
      if (history.length > 0) {
        result.currentVolume = history[history.length - 1].total ?? 0;
        result.peakVolume = Math.max(...history.map((h) => h.total ?? 0));
        if (result.peakVolume > 0) {
          result.volumeDecayPct = parseFloat(
            (((result.peakVolume - result.currentVolume) / result.peakVolume) * 100).toFixed(1)
          );
        }
      }

      // Persona coverage
      const strategy = this.readState("test-strategy.json");
      result.runningPersonas = strategy?.recommendedFilter?.length ?? 0;

      const specDir = path.join(ROOT, "e2e", "tests", "personas");
      if (fs.existsSync(specDir)) {
        result.totalPersonas = fs.readdirSync(specDir).filter((f) => f.endsWith(".spec.ts")).length;
      }
      if (result.totalPersonas > 0) {
        result.personaCoveragePct = parseFloat(
          ((result.runningPersonas / result.totalPersonas) * 100).toFixed(1)
        );
      }

      // True coverage: passed / testsOnDisk
      const inventory = this._collectTestInventory();
      const tests = this.readState("green-history.json")?.tests ?? {};
      const passedCount = Object.values(tests).filter((t) => (t.consecutivePasses ?? 0) > 0).length;
      if (inventory.testsOnDisk > 0) {
        result.trueCoveragePct = parseFloat(
          ((passedCount / inventory.testsOnDisk) * 100).toFixed(1)
        );
      }
    } catch (err) {
      this.log(`coverage-decay collect error: ${err.message}`);
    }

    return result;
  }

  _collectFlakyTests() {
    const result = {
      totalFlaky: 0,
      topFlaky: [],
      avgFlakinessScore: 0,
      flakyByRoute: {},
    };

    try {
      const greenHistory = this.readState("green-history.json");
      if (!greenHistory?.tests) { return result; }

      const flakyTests = [];
      for (const [testTitle, entry] of Object.entries(greenHistory.tests)) {
        const totalRuns = entry.totalRunsRecorded ?? 0;
        const oscillations = entry.oscillations ?? 0;
        if (totalRuns < 5) { continue; }

        const flakinessScore = oscillations / totalRuns;
        if (flakinessScore >= 0.2) {
          flakyTests.push({ testTitle, flakinessScore, oscillations, totalRuns });
        }
      }

      result.totalFlaky = flakyTests.length;
      flakyTests.sort((a, b) => b.flakinessScore - a.flakinessScore);
      result.topFlaky = flakyTests.slice(0, 15).map((t) => ({
        test: t.testTitle.slice(0, 120),
        score: parseFloat(t.flakinessScore.toFixed(2)),
        oscillations: t.oscillations,
      }));

      if (flakyTests.length > 0) {
        result.avgFlakinessScore = parseFloat(
          (flakyTests.reduce((s, t) => s + t.flakinessScore, 0) / flakyTests.length).toFixed(2)
        );
      }
    } catch (err) {
      this.log(`flaky-tests collect error: ${err.message}`);
    }

    return result;
  }

  _collectTestStaleness() {
    const result = {
      staleSpecs: [],
      outdatedSpecs: [],
      activeSpecs: 0,
      avgSpecAgeDays: 0,
    };

    try {
      const specDir = path.join(ROOT, "e2e", "tests", "personas");
      if (!fs.existsSync(specDir)) { return result; }

      const greenHistory = this.readState("green-history.json");
      const now = Date.now();
      const agesDays = [];

      for (const f of fs.readdirSync(specDir).filter((ff) => ff.endsWith(".spec.ts"))) {
        const mtime = fs.statSync(path.join(specDir, f)).mtimeMs;
        const ageDays = Math.round((now - mtime) / (24 * 60 * 60 * 1000));
        agesDays.push(ageDays);

        if (ageDays > 30) {
          result.outdatedSpecs.push({ spec: f, ageDays });
        } else if (ageDays > 14) {
          result.staleSpecs.push({ spec: f, ageDays });
        } else {
          result.activeSpecs++;
        }
      }

      if (agesDays.length > 0) {
        result.avgSpecAgeDays = Math.round(agesDays.reduce((a, b) => a + b, 0) / agesDays.length);
      }
    } catch (err) {
      this.log(`test-staleness collect error: ${err.message}`);
    }

    return result;
  }

  _collectManifestCompleteness() {
    const result = {
      personasInSpecs: 0,
      personasInManifest: 0,
      missingFromManifest: [],
      orphanedInManifest: [],
      featuresCoveredPct: 0,
    };

    try {
      const specDir = path.join(ROOT, "e2e", "tests", "personas");
      const specPersonas = new Set();
      if (fs.existsSync(specDir)) {
        for (const f of fs.readdirSync(specDir).filter((ff) => ff.endsWith(".spec.ts"))) {
          specPersonas.add(f.replace(".spec.ts", ""));
        }
      }
      result.personasInSpecs = specPersonas.size;

      const manifest = this.readState("manifest.json");
      const manifestPersonas = new Set();
      const featuresWithPersonas = { total: 0, covered: 0 };
      if (manifest?.features) {
        for (const feat of Object.values(manifest.features)) {
          featuresWithPersonas.total++;
          const personas = feat.personas || [];
          if (personas.length > 0) {
            featuresWithPersonas.covered++;
          }
          for (const p of personas) {
            manifestPersonas.add(p);
          }
        }
      }
      result.personasInManifest = manifestPersonas.size;

      for (const p of specPersonas) {
        if (!manifestPersonas.has(p)) {
          result.missingFromManifest.push(p);
        }
      }
      for (const p of manifestPersonas) {
        if (!specPersonas.has(p)) {
          result.orphanedInManifest.push(p);
        }
      }

      if (featuresWithPersonas.total > 0) {
        result.featuresCoveredPct = parseFloat(
          ((featuresWithPersonas.covered / featuresWithPersonas.total) * 100).toFixed(1)
        );
      }
    } catch (err) {
      this.log(`manifest-completeness collect error: ${err.message}`);
    }

    return result;
  }

  _collectRouteMapping() {
    const result = {
      mappedRoutes: 0,
      totalAppRoutes: 0,
      unmappedDirectories: [],
      coveragePct: 0,
    };

    try {
      // Get all top-level app directories (excluding api, components)
      const appDir = path.join(ROOT, "app");
      if (!fs.existsSync(appDir)) { return result; }

      const allDirs = fs.readdirSync(appDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !["api", "components"].includes(d.name))
        .map((d) => d.name);
      result.totalAppRoutes = allDirs.length;

      // Read FILE_TO_ROUTE from diff-test-selector.js
      try {
        const selectorPath = path.join(ROOT, "scripts", "e2e", "lib", "diff-test-selector.js");
        const content = fs.readFileSync(selectorPath, "utf-8");
        const mapped = new Set();
        const routeRegex = /"app\/([^"/]+)/g;
        let match;
        while ((match = routeRegex.exec(content)) !== null) {
          mapped.add(match[1]);
        }
        result.mappedRoutes = mapped.size;

        for (const dir of allDirs) {
          if (!mapped.has(dir)) {
            result.unmappedDirectories.push(dir);
          }
        }
      } catch { /* non-fatal */ }

      if (result.totalAppRoutes > 0) {
        result.coveragePct = parseFloat(
          ((result.mappedRoutes / result.totalAppRoutes) * 100).toFixed(1)
        );
      }
    } catch (err) {
      this.log(`route-mapping collect error: ${err.message}`);
    }

    return result;
  }

  _collectQuarantine() {
    const result = {
      quarantinedTests: 0,
      oldestQuarantinedDays: 0,
      regenCandidates: 0,
      regenInProgress: 0,
      regenSucceeded: 0,
      regenFailed: 0,
    };

    try {
      const data = this.readState("test-quarantine.json");
      if (!data?.quarantined) { return result; }

      const entries = Object.values(data.quarantined);
      result.quarantinedTests = entries.length;

      if (entries.length > 0) {
        const now = Date.now();
        const ages = entries.map((e) => (now - new Date(e.quarantinedAt).getTime()) / (24 * 60 * 60 * 1000));
        result.oldestQuarantinedDays = Math.round(Math.max(...ages));
      }

      result.regenCandidates = entries.filter((e) => e.regenStatus === "pending").length;
      result.regenInProgress = entries.filter((e) => e.regenStatus === "in-progress").length;
      result.regenSucceeded = data.stats?.recoveredByRegen ?? 0;
      result.regenFailed = entries.filter((e) => e.regenStatus === "failed").length;
    } catch (err) {
      this.log(`quarantine collect error: ${err.message}`);
    }

    return result;
  }

  _collectTestRegen() {
    const result = {
      totalCandidates: 0,
      succeeded: 0,
      failed: 0,
      needsHuman: 0,
      pending: 0,
      totalCost: 0,
      avgCostPerRegen: 0,
      successRate: 0,
      lastRun: null,
      recentAttempts: [], // last 5 attempts for investigation context
    };

    try {
      const data = this.readState("regen-state.json");
      if (!data?.candidates) { return result; }

      const entries = Object.entries(data.candidates);
      result.totalCandidates = entries.length;
      result.lastRun = data.lastRun ?? null;

      for (const [key, c] of entries) {
        if (c.status === "regenerated") { result.succeeded++; }
        else if (c.status === "failed") { result.failed++; }
        else if (c.status === "needs-human") { result.needsHuman++; }
        else if (c.status === "pending") { result.pending++; }
        result.totalCost += c.cost ?? 0;
      }

      const completed = result.succeeded + result.failed + result.needsHuman;
      result.successRate = completed > 0 ? Math.round((result.succeeded / completed) * 100) : 0;
      result.avgCostPerRegen = completed > 0 ? Math.round((result.totalCost / completed) * 100) / 100 : 0;

      // Grab last 5 attempts sorted by lastAttempt for investigation detail
      result.recentAttempts = entries
        .filter(([, c]) => c.lastAttempt)
        .sort(([, a], [, b]) => new Date(b.lastAttempt).getTime() - new Date(a.lastAttempt).getTime())
        .slice(0, 5)
        .map(([key, c]) => ({ key, status: c.status, attempts: c.attempts, cost: c.cost, failureContext: c.failureContext }));

      // Also pull aggregate stats from state
      if (data.stats) {
        result.succeeded = data.stats.succeeded ?? result.succeeded;
        result.failed = data.stats.failed ?? result.failed;
        result.needsHuman = data.stats.needsHuman ?? result.needsHuman;
        result.totalCost = data.stats.totalCost ?? result.totalCost;
      }
    } catch (err) {
      this.log(`test-regen collect error: ${err.message}`);
    }

    return result;
  }

  _collectStuckTests() {
    const result = {
      stuckTests: [],
      stuckForDays: {},
      repairExhausted: 0,
      totalRepairAttempts: 0,
      repairSuccessRate: 0,
    };

    try {
      const stuck = this.readState("stuck-diagnostics.json");
      const greenHistory = this.readState("green-history.json");
      const tests = greenHistory?.tests ?? {};

      // Tests with 0 consecutive passes and recent lastFailed
      const now = Date.now();
      for (const [testTitle, entry] of Object.entries(tests)) {
        if (entry.consecutivePasses === 0 && entry.lastFailed) {
          const failedAt = new Date(entry.lastFailed).getTime();
          const daysSinceFail = Math.round((now - failedAt) / (24 * 60 * 60 * 1000));
          if (daysSinceFail <= 14) {
            result.stuckTests.push(testTitle.slice(0, 120));
            result.stuckForDays[testTitle.slice(0, 120)] = daysSinceFail;
          }
        }
      }

      // Repair exhaustion from stuck-diagnostics
      const stuckEntries = stuck?.tests ?? stuck?.stuck ?? {};
      for (const entry of Object.values(stuckEntries)) {
        const attempts = entry.repairAttempts ?? entry.attempts ?? 0;
        result.totalRepairAttempts += attempts;
        if (attempts >= 3) {
          result.repairExhausted++;
        }
      }

      if (result.totalRepairAttempts > 0) {
        const successes = Object.values(stuckEntries).filter((e) => e.resolved).length;
        result.repairSuccessRate = parseFloat(
          ((successes / result.totalRepairAttempts) * 100).toFixed(1)
        );
      }

      result.stuckTests = result.stuckTests.slice(0, 20);
    } catch (err) {
      this.log(`stuck-tests collect error: ${err.message}`);
    }

    return result;
  }

  _collectDocsSync() {
    const result = {
      driftCount: 0,
      fixedCount: 0,
      consecutiveUnfixedCycles: 0,
      lastRun: null,
      backlogSize: 0,
    };

    try {
      const state = this.readState("docs-sync-state.json");
      if (state) {
        result.driftCount = state.driftCount ?? 0;
        result.fixedCount = state.fixedCount ?? 0;
        result.lastRun = state.lastRun ?? null;
        result.consecutiveUnfixedCycles = state.consecutiveUnfixedCycles ?? 0;
      }
    } catch { /* non-fatal */ }

    try {
      const backlog = this.readState("improvement-backlog.json");
      if (backlog?.items) {
        result.backlogSize = backlog.items.filter((i) => i.status === "backlogged" || i.status === "suggested").length;
      }
    } catch { /* non-fatal */ }

    return result;
  }

  /**
   * Collect pipeline health metrics: dedup effectiveness, throttle activity,
   * test-runner deferrals, and MOC queue churn.
   *
   * This collector reads from state files written by findings-to-mocs.js
   * and test-runner.js, making those pipeline changes visible to the observer
   * without requiring manual integration every time a pipeline change ships.
   */
  _collectPipelineHealth() {
    const result = {
      dedup: { skipped: 0, byActive: 0, byImplemented: 0, throttled: 0 },
      testRunnerDeferrals: { total: 0, lastAt: null, lastReason: null },
      lastFindingsRun: null,
      mocCreationRate: 0,  // MOCs created in last run
      noiseRate: 0,        // noise resolved vs total
      dbMocCount: null,    // platform DB MOC count (if available)
    };

    // findings-to-mocs pipeline stats
    try {
      const lastRun = this.readState("findings-to-mocs-last.json");
      if (lastRun) {
        result.dedup.skipped = lastRun.dedupSkipped ?? 0;
        result.dedup.byActive = lastRun.dedupByActive ?? 0;
        result.dedup.byImplemented = lastRun.dedupByImplemented ?? 0;
        result.dedup.throttled = lastRun.throttled ?? 0;
        result.mocCreationRate = lastRun.submitted ?? 0;
        result.noiseRate = lastRun.noiseResolved ?? 0;
        result.lastFindingsRun = lastRun.timestamp ?? null;
      }
    } catch { /* non-fatal */ }

    // test-runner deferral tracking
    try {
      const deferPath = path.join(STATE_DIR, "test-runner-deferrals.json");
      if (fs.existsSync(deferPath)) {
        const deferrals = JSON.parse(fs.readFileSync(deferPath, "utf-8"));
        result.testRunnerDeferrals.total = deferrals.count ?? 0;
        result.testRunnerDeferrals.lastAt = deferrals.lastAt ?? null;
        result.testRunnerDeferrals.lastReason = deferrals.lastReason ?? null;
      }
    } catch { /* non-fatal */ }

    // commit tracker stats
    try {
      const ctPath = path.join(STATE_DIR, "commit-tracker-last.json");
      if (fs.existsSync(ctPath)) {
        const ct = JSON.parse(fs.readFileSync(ctPath, "utf-8"));
        result.commitTracker = {
          scanned: ct.scanned ?? 0,
          committed: ct.committed ?? 0,
          unverified: ct.unverified ?? 0,
          lastAt: ct.at ?? null,
        };
      }
    } catch { /* non-fatal */ }

    // Pipeline accuracy metrics (from pipeline-metrics.js)
    try {
      const pipelineMetrics = require("../lib/pipeline-metrics");
      const overview = pipelineMetrics.getOverview();
      if (overview && overview.stages) {
        result.pipelineAccuracy = {};
        for (const [stage, acc] of Object.entries(overview.stages)) {
          result.pipelineAccuracy[stage] = {
            total: acc.total,
            accuracy: acc.accuracy,
            correct: acc.correct,
            incorrect: acc.incorrect,
          };
        }
      }
    } catch { /* non-fatal */ }

    return result;
  }

  /**
   * Compute cycle-over-cycle deltas against the previous cycle.
   * Called after baseline is updated so we have prior cycle data.
   */
  _computeDeltas(report, baseline) {
    const history = baseline.history ?? [];
    if (history.length < 2) {
      return { note: "insufficient history for deltas" };
    }

    // Previous cycle is second-to-last (current was just appended)
    const prev = history[history.length - 2];
    const curr = history[history.length - 1];

    const delta = (a, b) => {
      if (a == null || b == null) { return null; }
      return parseFloat((a - b).toFixed(2));
    };

    const pctDelta = (a, b) => {
      if (a == null || b == null || b === 0) { return null; }
      return parseFloat((((a - b) / b) * 100).toFixed(1));
    };

    const result = {
      passRate: { current: curr.passRate, previous: prev.passRate, delta: delta(curr.passRate, prev.passRate) },
      effectivePassRate: { current: curr.effectivePassRate, previous: prev.effectivePassRate, delta: delta(curr.effectivePassRate, prev.effectivePassRate) },
      skipRate: { current: curr.skipRate, previous: prev.skipRate, delta: delta(curr.skipRate, prev.skipRate) },
      total: { current: curr.total, previous: prev.total, delta: delta(curr.total, prev.total), pctChange: pctDelta(curr.total, prev.total) },
      fixesApplied: { current: curr.fixesApplied, previous: prev.fixesApplied, delta: delta(curr.fixesApplied, prev.fixesApplied) },
      fixesFailed: { current: curr.fixesFailed, previous: prev.fixesFailed, delta: delta(curr.fixesFailed, prev.fixesFailed) },

      // Cross-section deltas (compare current report fields to previous report if available)
      findingsOpen: null,
      mocQueueTotal: null,
      budgetHourly: null,
    };

    // Load previous observer-latest for cross-section comparison
    try {
      const prevReport = this._loadPreviousReport();
      if (prevReport) {
        result.findingsOpen = {
          current: report.findingsPipeline?.openCount ?? null,
          previous: prevReport.findingsPipeline?.openCount ?? null,
          delta: delta(report.findingsPipeline?.openCount, prevReport.findingsPipeline?.openCount),
        };
        result.mocQueueTotal = {
          current: report.mocQueue?.total ?? null,
          previous: prevReport.mocQueue?.total ?? null,
          delta: delta(report.mocQueue?.total, prevReport.mocQueue?.total),
        };
        result.budgetHourly = {
          current: report.budget?.hourlyTotal ?? null,
          previous: prevReport.budget?.hourlyTotal ?? null,
          delta: delta(report.budget?.hourlyTotal, prevReport.budget?.hourlyTotal),
        };

        // Persona-level deltas for high-value personas
        if (report.personaPerformance?.personas && prevReport.personaPerformance?.personas) {
          const personaDeltas = {};
          for (const [id, curr] of Object.entries(report.personaPerformance.personas)) {
            const prev = prevReport.personaPerformance?.personas?.[id];
            if (prev && curr.passRate != null && prev.passRate != null) {
              const d = curr.passRate - prev.passRate;
              if (Math.abs(d) >= 5) { // Only report significant changes
                personaDeltas[id] = {
                  current: curr.passRate,
                  previous: prev.passRate,
                  delta: parseFloat(d.toFixed(1)),
                  roiTier: curr.roiTier,
                };
              }
            }
          }
          if (Object.keys(personaDeltas).length > 0) {
            result.personaPassRateChanges = personaDeltas;
          }
        }

        // Route-level deltas
        if (report.testBreakdown?.byRoute && prevReport.testBreakdown?.byRoute) {
          const routeDeltas = {};
          for (const [route, curr] of Object.entries(report.testBreakdown.byRoute)) {
            const prev = prevReport.testBreakdown?.byRoute?.[route];
            if (prev && curr.total > 0 && prev.total > 0) {
              const currRate = (curr.passed / curr.total) * 100;
              const prevRate = (prev.passed / prev.total) * 100;
              const d = currRate - prevRate;
              if (Math.abs(d) >= 10) { // Only report big swings
                routeDeltas[route] = {
                  current: parseFloat(currRate.toFixed(1)),
                  previous: parseFloat(prevRate.toFixed(1)),
                  delta: parseFloat(d.toFixed(1)),
                };
              }
            }
          }
          if (Object.keys(routeDeltas).length > 0) {
            result.routePassRateChanges = routeDeltas;
          }
        }
      }
    } catch { /* non-fatal — first cycle won't have previous */ }

    return result;
  }

  /**
   * Load the previous cycle's observer report for delta computation.
   */
  _loadPreviousReport() {
    try {
      if (!fs.existsSync(CYCLE_REPORTS_DIR)) { return null; }
      const files = fs.readdirSync(CYCLE_REPORTS_DIR)
        .filter((f) => f.startsWith("cycle-") && f.endsWith(".json"))
        .sort();
      if (files.length === 0) { return null; }
      // If current cycle report already exists, get second-to-last
      const lastFile = files[files.length - 1];
      const currentCycleFile = `cycle-${String(this.currentCycle).padStart(4, "0")}.json`;
      const targetFile = lastFile === currentCycleFile && files.length >= 2
        ? files[files.length - 2]
        : lastFile;
      return JSON.parse(fs.readFileSync(path.join(CYCLE_REPORTS_DIR, targetFile), "utf-8"));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Baseline
  // ---------------------------------------------------------------------------

  _updateBaseline(report) {
    let baseline = this._loadBaseline();

    // Add current cycle summary to history
    const summary = {
      cycle: report.cycle,
      at: report.at,
      passRate: report.tests.total > 0
        ? parseFloat(((report.tests.passed / report.tests.total) * 100).toFixed(1))
        : null,
      effectivePassRate: report.tests.effectivePassRate ?? null,
      skipRate: report.tests.total > 0
        ? parseFloat(((report.tests.skipped / report.tests.total) * 100).toFixed(1))
        : null,
      total: report.tests.total,
      fixesApplied: report.fixes.applied,
      fixesFailed: report.fixes.failed,
      trueCoverage: report.coverageDecay?.trueCoveragePct ?? null,
      quarantinedCount: report.quarantine?.quarantinedTests ?? 0,
      neverRanPersonas: report.testInventory?.neverRanPersonas?.length ?? 0,
      flakyCount: report.flakyTests?.totalFlaky ?? 0,
      manifestCoveragePct: report.manifestCompleteness?.featuresCoveredPct ?? null,
      regenSucceeded: report.testRegen?.succeeded ?? 0,
      regenFailed: report.testRegen?.failed ?? 0,
      regenPending: report.testRegen?.pending ?? 0,
      regenCost: report.testRegen?.totalCost ?? 0,
    };

    // Track trueCoverage history for test-surface-decay rule
    if (!baseline._trueCoverageHistory) {
      baseline._trueCoverageHistory = [];
    }
    if (summary.trueCoverage != null) {
      baseline._trueCoverageHistory.push(summary.trueCoverage);
      if (baseline._trueCoverageHistory.length > 20) {
        baseline._trueCoverageHistory = baseline._trueCoverageHistory.slice(-20);
      }
    }

    baseline.history.push(summary);
    // Keep bounded to 50
    if (baseline.history.length > 50) {
      baseline.history = baseline.history.slice(-50);
    }

    // Update rolling stats
    const passRates = baseline.history.map((h) => h.passRate).filter((v) => v != null);
    baseline.rollingPassRate = this._computeStats(passRates);

    const effectiveRates = baseline.history.map((h) => h.effectivePassRate).filter((v) => v != null);
    baseline.rollingEffectiveRate = this._computeStats(effectiveRates);

    const skipRates = baseline.history.map((h) => h.skipRate).filter((v) => v != null);
    baseline.rollingSkipRate = this._computeStats(skipRates);

    const totals = baseline.history.map((h) => h.total).filter((v) => v != null && v > 0);
    baseline.rollingTotal = this._computeStats(totals);

    // Track pre/post fix snapshots
    if (report.fixes.applied > 0 && report.fixes.preFixPassRate != null) {
      baseline.preFixSnapshots.push({
        cycle: report.cycle,
        at: report.at,
        preFixPassRate: report.fixes.preFixPassRate,
        postFixPassRate: summary.passRate,
        filesChanged: report.fixes.filesChanged,
        mocsFixed: report.fixes.mocsFixed,
      });
      if (baseline.preFixSnapshots.length > 20) {
        baseline.preFixSnapshots = baseline.preFixSnapshots.slice(-20);
      }
    }

    this._saveBaseline(baseline);
    return baseline;
  }

  _computeStats(values) {
    if (values.length === 0) {
      return { mean: 0, stddev: 0, min: 0, max: 0, count: 0 };
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);
    return {
      mean: parseFloat(mean.toFixed(1)),
      stddev: parseFloat(stddev.toFixed(1)),
      min: parseFloat(Math.min(...values).toFixed(1)),
      max: parseFloat(Math.max(...values).toFixed(1)),
      count: values.length,
    };
  }

  _loadBaseline() {
    try {
      if (fs.existsSync(BASELINE_PATH)) {
        return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
      }
    } catch { /* fresh start */ }
    return {
      history: [],
      rollingPassRate: { mean: 0, stddev: 0, min: 0, max: 0, count: 0 },
      rollingEffectiveRate: { mean: 0, stddev: 0, min: 0, max: 0, count: 0 },
      rollingSkipRate: { mean: 0, stddev: 0, min: 0, max: 0, count: 0 },
      rollingTotal: { mean: 0, stddev: 0, min: 0, max: 0, count: 0 },
      preFixSnapshots: [],
      lastInvestigation: null,
      runtimeThresholds: null,
      meta: {
        alertsEmitted: 0,
        alertsLeadingToFix: 0,
        alertsPrecision: 0,
        forceRunsIssued: 0,
        forceRunsCaughtRegression: 0,
        forceRunPrecision: 0,
        falsePositives: [],
        missedRegressions: [],
        thresholdHistory: [],
      },
      recommendations: [],
    };
  }

  _saveBaseline(baseline) {
    this.writeState("observer-baseline.json", baseline);
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Judge
  // ---------------------------------------------------------------------------

  _judge(report, baseline) {
    const config = this.clawConfig;
    const rt = baseline.runtimeThresholds ?? {};
    const findings = [];

    // Need at least 3 cycles of data for meaningful anomaly detection
    if (baseline.history.length < 3) {
      return [{ name: "insufficient-data", ok: true, severity: "info", detail: `Only ${baseline.history.length} cycles collected — need 3+` }];
    }

    const passRate = report.tests.total > 0
      ? (report.tests.passed / report.tests.total) * 100
      : null;
    const skipRate = report.tests.total > 0
      ? (report.tests.skipped / report.tests.total) * 100
      : null;
    const effectiveRate = report.tests.effectivePassRate;

    // pass-rate-drop
    const passDropThreshold = rt.passRateDropThreshold ?? config.passRateDropThreshold ?? 15;
    if (passRate != null && baseline.rollingPassRate.count >= 3) {
      const drop = baseline.rollingPassRate.mean - passRate;
      if (drop > passDropThreshold) {
        const severity = drop > passDropThreshold * 2 ? "critical" : "warning";
        findings.push({
          name: "pass-rate-drop",
          ok: false,
          severity,
          detail: `Pass rate ${passRate.toFixed(1)}% is ${drop.toFixed(1)}pp below rolling mean ${baseline.rollingPassRate.mean}% (threshold: ${passDropThreshold}pp)`,
        });
      } else {
        findings.push({ name: "pass-rate-drop", ok: true, severity: "info", detail: "within normal range" });
      }
    }

    // skip-rate-high
    const highSkipThreshold = rt.highSkipThreshold ?? config.highSkipThreshold ?? 70;
    if (skipRate != null) {
      if (skipRate > highSkipThreshold) {
        findings.push({
          name: "skip-rate-high",
          ok: false,
          severity: "warning",
          detail: `Skip rate ${skipRate.toFixed(1)}% exceeds ${highSkipThreshold}% threshold`,
        });
      } else {
        findings.push({ name: "skip-rate-high", ok: true, severity: "info", detail: "within normal range" });
      }
    }

    // skip-rate-low
    const lowSkipThreshold = rt.lowSkipThreshold ?? config.lowSkipThreshold ?? 10;
    if (skipRate != null && baseline.rollingSkipRate.count >= 3) {
      if (skipRate < lowSkipThreshold && baseline.rollingSkipRate.mean > 20) {
        findings.push({
          name: "skip-rate-low",
          ok: false,
          severity: "warning",
          detail: `Skip rate ${skipRate.toFixed(1)}% is unusually low (rolling mean: ${baseline.rollingSkipRate.mean}%). Green tracker may be broken.`,
        });
      } else {
        findings.push({ name: "skip-rate-low", ok: true, severity: "info", detail: "within normal range" });
      }
    }

    // effective-rate-drop
    const effectiveDropThreshold = rt.effectiveRateDropThreshold ?? config.effectiveRateDropThreshold ?? 5;
    if (effectiveRate != null && baseline.rollingEffectiveRate.count >= 3) {
      const drop = baseline.rollingEffectiveRate.mean - effectiveRate;
      if (drop > effectiveDropThreshold) {
        findings.push({
          name: "effective-rate-drop",
          ok: false,
          severity: "critical",
          detail: `Effective pass rate ${effectiveRate}% dropped ${drop.toFixed(1)}pp from rolling mean ${baseline.rollingEffectiveRate.mean}% (threshold: ${effectiveDropThreshold}pp)`,
        });
      } else {
        findings.push({ name: "effective-rate-drop", ok: true, severity: "info", detail: "within normal range" });
      }
    }

    // fix-regression
    const fixRegressionThreshold = rt.fixRegressionThreshold ?? config.fixRegressionThreshold ?? 5;
    if (baseline.preFixSnapshots.length > 0) {
      const latest = baseline.preFixSnapshots[baseline.preFixSnapshots.length - 1];
      if (latest.postFixPassRate != null && latest.preFixPassRate != null) {
        const regression = latest.preFixPassRate - latest.postFixPassRate;
        if (regression > fixRegressionThreshold) {
          findings.push({
            name: "fix-regression",
            ok: false,
            severity: "critical",
            detail: `Post-fix pass rate (${latest.postFixPassRate}%) is ${regression.toFixed(1)}pp LOWER than pre-fix (${latest.preFixPassRate}%). Files: ${latest.filesChanged.join(", ")}`,
          });
        }
      }
    }

    // untested-fixes
    this._judgeUntestedFixes(report, findings);

    // volume-anomaly
    const volumeDevPct = rt.volumeDeviationPct ?? config.volumeDeviationPct ?? 20;
    if (report.tests.total != null && baseline.rollingTotal.count >= 3) {
      const median = baseline.rollingTotal.mean; // approximation
      const deviation = Math.abs(report.tests.total - median) / median * 100;
      if (deviation > volumeDevPct) {
        findings.push({
          name: "volume-anomaly",
          ok: false,
          severity: "warning",
          detail: `Test count ${report.tests.total} deviates ${deviation.toFixed(0)}% from median ${median.toFixed(0)} (threshold: ${volumeDevPct}%)`,
        });
      } else {
        findings.push({ name: "volume-anomaly", ok: true, severity: "info", detail: "within normal range" });
      }
    }

    // convergence-negative
    const convergenceStreak = config.convergenceStreakThreshold ?? 3;
    const recentHistory = baseline.history.slice(-convergenceStreak);
    if (recentHistory.length >= convergenceStreak) {
      const allNegative = recentHistory.every((h) =>
        h.passRate != null && h.fixesApplied === 0 && h.fixesFailed > 0
      );
      if (allNegative) {
        findings.push({
          name: "convergence-negative",
          ok: false,
          severity: "warning",
          detail: `${convergenceStreak}+ consecutive cycles with 0 fixes applied and failures — pipeline may be stuck`,
        });
      }
    }

    // fix-stall
    if (baseline.history.length >= 3) {
      const last3 = baseline.history.slice(-3);
      const allZeroFixes = last3.every((h) => h.fixesApplied === 0);
      if (allZeroFixes) {
        // Check if there are approved MOCs waiting
        const queue = this.readState("moc-queue.json");
        const approvedMocs = (queue?.mocs ?? []).filter((m) =>
          ["approved", "pending_fix"].includes(m.status)
        );
        if (approvedMocs.length > 0) {
          findings.push({
            name: "fix-stall",
            ok: false,
            severity: "warning",
            detail: `3+ cycles with 0 fixes applied while ${approvedMocs.length} approved MOCs are waiting`,
          });
        }
      }
    }

    // zero-results (with daemon warmup grace period)
    if (report.tests.total === 0) {
      // Don't flag zero-results within 5 minutes of daemon start — first cycle is still warming up.
      // Without this, observer reads the stale tests-complete signal and force-triggers restarts
      // before the first Playwright run can even finish.
      const signals = this.readState("claw-signals.json");
      const daemonStarted = signals?.signals?.["daemon-started"];
      const daemonAge = daemonStarted?.timestamp
        ? Date.now() - new Date(daemonStarted.timestamp).getTime()
        : Infinity;
      if (daemonAge < 5 * 60 * 1000) {
        this.log("zero-results: suppressed — daemon started " + Math.round(daemonAge / 1000) + "s ago (warmup grace period)");
      } else {
        findings.push({
          name: "zero-results",
          ok: false,
          severity: "critical",
          detail: "Test run produced 0 results — Playwright may have crashed",
        });
      }
    }

    // high-value-persona-degraded: any high-ROI persona with pass rate <70%
    if (report.personaPerformance?.highValueHealth) {
      const hvh = report.personaPerformance.highValueHealth;
      if (hvh.failing > 0) {
        findings.push({
          name: "high-value-persona-failing",
          ok: false,
          severity: "critical",
          detail: `${hvh.failing}/${hvh.total} high-ROI personas have pass rate <50%`,
          affectedPersonas: Object.entries(report.personaPerformance?.personas ?? {})
            .filter(([, p]) => p.roiTier === "high" && p.passRate < 50)
            .map(([id]) => id),
        });
      } else if (hvh.degraded > 0) {
        findings.push({
          name: "high-value-persona-degraded",
          ok: false,
          severity: "warning",
          detail: `${hvh.degraded}/${hvh.total} high-ROI personas have pass rate 50-90%`,
        });
      }
    }

    // route-regression: any route's failure rate jumped >30pp
    if (report.deltas?.routePassRateChanges) {
      const regressions = Object.entries(report.deltas.routePassRateChanges)
        .filter(([, d]) => d.delta < -30);
      if (regressions.length > 0) {
        findings.push({
          name: "route-regression",
          ok: false,
          severity: "critical",
          detail: `${regressions.length} route(s) regressed >30pp: ${regressions.map(([r, d]) => `${r} (${d.delta}pp)`).join(", ")}`,
          routes: regressions.map(([r]) => r),
        });
      }
    }

    // deploy-regression: deploy verification shows regression
    if (report.deployVerification?.verdict === "regression") {
      findings.push({
        name: "deploy-regression",
        ok: false,
        severity: "critical",
        detail: `Deploy ${report.deployVerification.lastDeploySha ?? "unknown"} caused regression: ${report.deployVerification.passRateBeforeDeploy}% → ${report.deployVerification.passRateAfterDeploy}%`,
      });
    }

    // memory-pressure: system memory >85%
    if (report.resources?.systemUsedPct > 85) {
      findings.push({
        name: "memory-pressure",
        ok: false,
        severity: report.resources.systemUsedPct > 92 ? "critical" : "warning",
        detail: `System memory at ${report.resources.systemUsedPct}% (${report.resources.systemFreeMB}MB free of ${report.resources.systemTotalMB}MB)`,
      });
    }

    // stale-claws: any claw heartbeat stale >5min (excluding observer itself)
    if (report.clawHealth) {
      const staleClaws = Object.entries(report.clawHealth)
        .filter(([name, c]) => name !== "observer" && c.stale && c.status !== "stopped" && c.status !== "unknown")
        .map(([name]) => name);
      if (staleClaws.length > 0) {
        findings.push({
          name: "stale-claws",
          ok: false,
          severity: staleClaws.length >= 3 ? "critical" : "warning",
          detail: `${staleClaws.length} claw(s) have stale heartbeats: ${staleClaws.join(", ")}`,
        });
      }
    }

    // fix-pipeline-stall: MOCs stuck at approved >48h with fix-engine running
    if (report.timeToFix?.stuckMocs?.length > 0) {
      const over48h = report.timeToFix.stuckMocs.filter((m) => m.waitingHours > 48);
      if (over48h.length > 0) {
        findings.push({
          name: "fix-pipeline-stall",
          ok: false,
          severity: "warning",
          detail: `${over48h.length} MOC(s) stuck at approved >48h: ${over48h.map((m) => `${m.id} (${m.waitingHours}h)`).join(", ")}`,
        });
      }
    }

    // cp-meta-stall: cp-meta not advancing MOCs despite remaining work
    if (report.cpMeta) {
      const { mocsAdvanced, remaining, playwrightOk } = report.cpMeta;
      if (!playwrightOk && remaining > 0) {
        // Read error details if available
        let errorType = "unknown";
        try {
          const errState = this.readState("cp-meta-errors.json");
          errorType = errState?.errorType ?? "unknown";
        } catch { /* non-fatal */ }
        findings.push({
          name: "cp-meta-stall",
          ok: false,
          severity: "warning",
          detail: `cp-meta Playwright failing with ${remaining} MOCs waiting (error: ${errorType})`,
          errorType,
        });
      } else if (mocsAdvanced === 0 && remaining > 0 && baseline.history.length >= 3) {
        // Check if multiple consecutive cycles had 0 advances
        const last3 = baseline.history.slice(-3);
        const allZeroAdvances = last3.every((h) =>
          h.cpMeta && h.cpMeta.mocsAdvanced === 0 && h.cpMeta.remaining > 0
        );
        if (allZeroAdvances) {
          findings.push({
            name: "cp-meta-stall",
            ok: false,
            severity: "warning",
            detail: `cp-meta advanced 0 MOCs for 3+ cycles while ${remaining} remain in queue`,
          });
        }
      }
    }

    // pipeline-starvation: open findings but no processable MOCs
    {
      const openCount = report.findingsPipeline?.openCount ?? 0;
      const processable = (report.mocQueue?.byStatus?.approved ?? 0) + (report.mocQueue?.byStatus?.pending_fix ?? 0);
      const malformed = report.mocQueue?.malformedCount ?? 0;
      if (openCount > 100 && processable === 0) {
        findings.push({
          name: "pipeline-starvation",
          ok: false,
          severity: "critical",
          detail: `${openCount} open findings but 0 processable MOCs (${malformed} malformed, ${report.mocQueue?.total ?? 0} total in queue)`,
        });
      } else if (openCount > 500 && processable <= 1) {
        findings.push({
          name: "pipeline-starvation",
          ok: false,
          severity: "warning",
          detail: `${openCount} open findings with only ${processable} processable MOC(s) — pipeline may be starving`,
        });
      }
    }

    // orphan-mocs: approved MOCs without platformMocId — invisible to cp-meta
    {
      const queue = this.readState("moc-queue.json");
      const mocs = Array.isArray(queue?.mocs) ? queue.mocs : [];
      const orphans = mocs.filter((m) =>
        !m.platformMocId &&
        ["approved", "pending_fix", "pending", "pending_approval", "needs_human"].includes(m.status)
      );
      if (orphans.length > 5) {
        findings.push({
          name: "orphan-mocs",
          ok: false,
          severity: orphans.length > 30 ? "critical" : "warning",
          detail: `${orphans.length} MOCs without platformMocId — invisible to cp-meta workflow`,
          orphanCount: orphans.length,
        });
      }
    }

    // flaky-test-surge: more than 5 flaky tests in one run
    if (report.testBreakdown?.flakyTests?.length > 5) {
      findings.push({
        name: "flaky-test-surge",
        ok: false,
        severity: "warning",
        detail: `${report.testBreakdown.flakyTests.length} flaky tests (passed on retry) — possible infrastructure instability`,
      });
    }

    // slow-test-creep: more than 5 tests taking >30s
    if (report.testBreakdown?.slowTests?.length > 5) {
      findings.push({
        name: "slow-test-creep",
        ok: false,
        severity: "warning",
        detail: `${report.testBreakdown.slowTests.length} tests taking >30s — total test duration may be ballooning`,
      });
    }

    // --- Self-Healing Ecosystem Rules ---

    // test-inventory-decay: test volume dropped significantly from peak
    if (report.coverageDecay) {
      const decay = report.coverageDecay.volumeDecayPct;
      if (decay > 30) {
        findings.push({ name: "test-inventory-decay", ok: false, severity: "critical",
          detail: `Test volume decayed ${decay}% from peak (${report.coverageDecay.peakVolume} → ${report.coverageDecay.currentVolume})` });
      } else if (decay > 15) {
        findings.push({ name: "test-inventory-decay", ok: false, severity: "warning",
          detail: `Test volume decayed ${decay}% from peak` });
      }
    }

    // cold-start-personas: too many never-run personas
    if (report.testInventory?.neverRanPersonas?.length > 5) {
      findings.push({ name: "cold-start-personas", ok: false, severity: "warning",
        detail: `${report.testInventory.neverRanPersonas.length} personas have NEVER run: ${report.testInventory.neverRanPersonas.slice(0, 8).join(", ")}` });
    }

    // manifest-incomplete: specs without manifest entries
    if (report.manifestCompleteness?.missingFromManifest?.length > 3) {
      findings.push({ name: "manifest-incomplete", ok: false, severity: "warning",
        detail: `${report.manifestCompleteness.missingFromManifest.length} personas have spec files but no manifest entries` });
    }

    // flaky-accumulation: too many flaky tests
    if (report.flakyTests?.totalFlaky > 10) {
      findings.push({ name: "flaky-accumulation", ok: false, severity: "warning",
        detail: `${report.flakyTests.totalFlaky} tests are flaky (oscillation score ≥0.2, avg: ${report.flakyTests.avgFlakinessScore})` });
    }

    // test-staleness: many outdated specs
    if (report.testStaleness?.outdatedSpecs?.length > 10) {
      findings.push({ name: "test-staleness", ok: false, severity: "warning",
        detail: `${report.testStaleness.outdatedSpecs.length} spec files unchanged for >30 days` });
    }

    // quarantine-overflow: too many quarantined tests
    if (report.quarantine?.quarantinedTests > 15) {
      findings.push({ name: "quarantine-overflow", ok: false, severity: "warning",
        detail: `${report.quarantine.quarantinedTests} tests quarantined (oldest: ${report.quarantine.oldestQuarantinedDays}d)` });
    }

    // route-mapping-gaps: FILE_TO_ROUTE coverage too low
    if (report.routeMapping?.coveragePct < 70) {
      findings.push({ name: "route-mapping-gaps", ok: false, severity: "warning",
        detail: `FILE_TO_ROUTE covers only ${report.routeMapping.coveragePct}% of app directories. Unmapped: ${(report.routeMapping.unmappedDirectories || []).slice(0, 5).join(", ")}` });
    }

    // repair-exhaustion: too many tests exhausted repair attempts
    if (report.stuckTests?.repairExhausted > 5) {
      findings.push({ name: "repair-exhaustion", ok: false, severity: "warning",
        detail: `${report.stuckTests.repairExhausted} tests exhausted repair-agent attempts (success rate: ${report.stuckTests.repairSuccessRate}%)` });
    }

    // test-surface-decay: trueCoverage declined over recent cycles
    if (report.coverageDecay?.trueCoveragePct != null && baseline.history.length >= 5) {
      const recentTrueCov = baseline._trueCoverageHistory ?? [];
      if (recentTrueCov.length >= 5) {
        const oldest = recentTrueCov[0];
        const newest = recentTrueCov[recentTrueCov.length - 1];
        const decline = oldest - newest;
        if (decline > 15) {
          findings.push({ name: "test-surface-decay", ok: false, severity: "critical",
            detail: `True coverage declined ${decline.toFixed(1)}pp over ${recentTrueCov.length} cycles (${oldest.toFixed(1)}% → ${newest.toFixed(1)}%)` });
        } else if (decline > 5) {
          findings.push({ name: "test-surface-decay", ok: false, severity: "warning",
            detail: `True coverage declined ${decline.toFixed(1)}pp over ${recentTrueCov.length} cycles` });
        }
      }
    }

    // --- Budget Intelligence Rules ---

    // budget-waste-high: too much wasted spend
    if (report.budget?.wastedPct > 60) {
      findings.push({ name: "budget-waste-high", ok: false, severity: "critical",
        detail: `Budget waste at ${report.budget.wastedPct}% ($${report.budget.wastedSpend24h} of $${report.budget.totalSpend24h} in last 24h)` });
    } else if (report.budget?.wastedPct > 40) {
      findings.push({ name: "budget-waste-high", ok: false, severity: "warning",
        detail: `Budget waste at ${report.budget.wastedPct}%` });
    }

    // budget-partial-outputs: too many truncated outputs
    if (report.budget?.partialOutputCount > 3) {
      findings.push({ name: "budget-partial-outputs", ok: false, severity: "warning",
        detail: `${report.budget.partialOutputCount} partial/truncated Claude outputs in last 24h — budgets may be too low` });
    }

    // idle-spender: claw running cycles but producing zero token spend
    if (report.budget?.idleSpenders?.length > 0) {
      findings.push({ name: "idle-spender", ok: false, severity: "warning",
        detail: `${report.budget.idleSpenders.join(", ")} ran cycles but produced $0 token spend in 24h — Claude CLI may be failing silently or claw is no-op` });
    }

    // zero-token-activity: entire system has no token spend despite active claws
    if (report.budget?.totalSpend24h === 0 && report.budget?.hourlyTotal === 0) {
      const activeClaws = Object.entries(report.clawHealth ?? {}).filter(([, v]) => v.cycle > 0 && !v.stale).length;
      if (activeClaws >= 3) {
        findings.push({ name: "zero-token-activity", ok: false, severity: "critical",
          detail: `${activeClaws} claws active but $0 total spend — Claude CLI or API may be completely down` });
      }
    }

    // git-conflict: a claw encountered a git push/rebase conflict
    if (report.git?.gitConflict) {
      const gc = report.git.gitConflict;
      findings.push({ name: "git-conflict", ok: false, severity: "critical",
        detail: `Git conflict in ${gc.claw}: ${gc.detail}. Code fixes may not be deploying. Run 'git pull --rebase' manually or resolve conflict.` });
    }

    // openai-fallback-active: OpenAI was used as fallback (should be Gemini-only)
    if (report.budget?.openaiUsage?.calls24h > 0) {
      const ou = report.budget.openaiUsage;
      findings.push({ name: "openai-fallback-active", ok: false, severity: "warning",
        detail: `${ou.calls24h} OpenAI call(s) in last 24h ($${ou.cost24h.toFixed(4)}) from: ${ou.components.join(", ")}. Gemini should be primary — investigate why fallback fired.` });
    }

    // --- Test Regen Rules ---

    // regen-failure-rate: test-regen claw has low success rate
    const regen = report.testRegen;
    if (regen) {
      const regenCompleted = regen.succeeded + regen.failed + regen.needsHuman;
      if (regenCompleted >= 3 && regen.successRate < 30) {
        findings.push({ name: "regen-failure-rate", ok: false, severity: "warning",
          detail: `Test regen success rate is ${regen.successRate}% (${regen.succeeded}/${regenCompleted}). ${regen.needsHuman} need human intervention.` });
      }

      // regen-cost-high: regen spend is disproportionate
      if (regen.totalCost > 30) {
        findings.push({ name: "regen-cost-high", ok: false, severity: "warning",
          detail: `Test regen total cost is $${regen.totalCost.toFixed(2)} (avg $${regen.avgCostPerRegen}/regen). ${regen.succeeded} succeeded, ${regen.failed} failed.` });
      }

      // regen-backlog: too many pending candidates not being processed
      if (regen.pending > 10) {
        findings.push({ name: "regen-backlog", ok: false, severity: "warning",
          detail: `${regen.pending} tests awaiting regeneration. Regen claw may need higher maxRegensPerCycle or more frequent runs.` });
      }

      // regen-stalled: claw hasn't run recently but has pending work
      if (regen.pending > 0 && regen.lastRun) {
        const hoursSinceRun = (Date.now() - new Date(regen.lastRun).getTime()) / (60 * 60 * 1000);
        if (hoursSinceRun > 6) {
          findings.push({ name: "regen-stalled", ok: false, severity: "warning",
            detail: `Test-regen claw last ran ${Math.round(hoursSinceRun)}h ago but has ${regen.pending} pending candidates. May be paused or crashed.` });
        }
      }
    }

    // --- Docs Sync Rules ---

    // docs-drift-unresolved: docs-sync detected drift but couldn't fix it
    if (report.docsSync?.driftCount > report.docsSync?.fixedCount) {
      const unfixed = report.docsSync.driftCount - report.docsSync.fixedCount;
      const cycles = report.docsSync.consecutiveUnfixedCycles ?? 0;
      if (cycles >= 3) {
        findings.push({ name: "docs-drift-unresolved", ok: false, severity: "warning",
          detail: `${unfixed} doc drift(s) unresolved for ${cycles} consecutive cycles. Check docs-sync-state.json for details.` });
      }
    }

    // --- Pipeline Health Rules ---
    const ph = report.pipelineHealth;
    if (ph) {
      // dedup-ineffective: many MOCs created despite dedup (dedup key may be too specific)
      if (ph.mocCreationRate > 10 && ph.dedup.skipped < 2) {
        findings.push({ name: "dedup-ineffective", ok: false, severity: "warning",
          detail: `${ph.mocCreationRate} MOCs created this cycle but only ${ph.dedup.skipped} deduped. Check dedup key normalization.` });
      }

      // throttle-active: page-level throttle is actively preventing MOC spam
      if (ph.dedup.throttled > 0) {
        findings.push({ name: "throttle-active", ok: true, severity: "info",
          detail: `Page throttle prevented ${ph.dedup.throttled} duplicate MOC(s). Dedup is working.` });
      }

      // excessive-deferrals: test-runner deferring too many times (fixes aren't landing)
      if (ph.testRunnerDeferrals.total > 0) {
        // Check recent deferrals in last 3 hours
        const lastAt = ph.testRunnerDeferrals.lastAt ? new Date(ph.testRunnerDeferrals.lastAt).getTime() : 0;
        const recent = Date.now() - lastAt < 3 * 60 * 60 * 1000;
        if (recent && ph.testRunnerDeferrals.total > 5) {
          findings.push({ name: "excessive-deferrals", ok: false, severity: "warning",
            detail: `Test-runner deferred ${ph.testRunnerDeferrals.total} times total. Last: "${ph.testRunnerDeferrals.lastReason}". Fix-engine may be stuck.` });
        } else if (recent) {
          findings.push({ name: "test-runner-deferred", ok: true, severity: "info",
            detail: `Test-runner deferred: ${ph.testRunnerDeferrals.lastReason}. Waiting for fixes to apply before retesting.` });
        }
      }

      // high-noise-ratio: most findings are noise (oracle may need tuning)
      if (ph.noiseRate > 20 && ph.mocCreationRate < 3) {
        findings.push({ name: "high-noise-ratio", ok: false, severity: "info",
          detail: `${ph.noiseRate} findings auto-resolved as noise, only ${ph.mocCreationRate} MOCs created. Oracle may be generating low-value findings.` });
      }

      // pipeline-accuracy-degraded: triage or tier assignment accuracy is low
      if (ph.pipelineAccuracy) {
        for (const [stage, acc] of Object.entries(ph.pipelineAccuracy)) {
          if (acc.accuracy !== null && acc.accuracy < 0.5 && acc.total >= 20) {
            findings.push({ name: "pipeline-accuracy-degraded", ok: false, severity: "warning",
              detail: `Pipeline stage "${stage}" accuracy is ${(acc.accuracy * 100).toFixed(0)}% (${acc.correct}/${acc.correct + acc.incorrect} correct, ${acc.total} total). Classification rules may need updating.` });
          }
        }
      }
    }

    return findings;
  }

  _judgeUntestedFixes(report, findings) {
    if (report.fixes.filesChanged.length === 0) {
      return;
    }

    try {
      const { mapFilesToRoutes } = require("../lib/diff-test-selector");
      const { routes } = mapFilesToRoutes(report.fixes.filesChanged);

      if (routes.length === 0 || routes.includes("*")) {
        return; // Can't determine specific routes, or full run needed
      }

      // Check which routes were actually tested in the last run
      // We infer from the test-strategy or loop-performance
      const strategy = this.readState("test-strategy.json");
      const testedFiles = strategy?.recommendedFilter ?? [];

      // If we have tested file info, check route overlap
      if (testedFiles.length > 0) {
        const untestedRoutes = routes.filter((route) => {
          // Check if any tested spec file maps to this route
          return !testedFiles.some((f) => {
            const specRoute = f.replace(/.*tests\/personas\//, "").replace(/\.spec\.ts$/, "");
            return route.includes(specRoute) || specRoute.includes(route.replace(/^\//, ""));
          });
        });

        if (untestedRoutes.length > 0) {
          findings.push({
            name: "untested-fixes",
            ok: false,
            severity: "critical",
            detail: `${untestedRoutes.length} fixed routes were NOT tested: ${untestedRoutes.join(", ")}. Files changed: ${report.fixes.filesChanged.join(", ")}`,
            untestedRoutes,
            fixedFiles: report.fixes.filesChanged,
          });
          return;
        }
      }

      findings.push({ name: "untested-fixes", ok: true, severity: "info", detail: "all fixed routes were tested" });
    } catch {
      // diff-test-selector not available — can't check
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Investigate
  // ---------------------------------------------------------------------------

  _investigate(failing, report, baseline) {
    const investigations = {};

    for (const finding of failing) {
      switch (finding.name) {
        case "pass-rate-drop":
          investigations[finding.name] = this._investigatePassRateDrop(report, baseline);
          break;
        case "fix-regression":
          investigations[finding.name] = this._investigateFixRegression(baseline);
          break;
        case "skip-rate-high":
        case "skip-rate-low":
          investigations[finding.name] = this._investigateSkipRate(report);
          break;
        case "untested-fixes":
          investigations[finding.name] = this._investigateUntestedFixes(finding, report);
          break;
        case "convergence-negative":
        case "fix-stall":
          investigations[finding.name] = this._investigateFixStall(report);
          break;
        case "zero-results":
          investigations[finding.name] = { diagnosis: "Playwright crash or misconfiguration", action: "check diagnostics claw output" };
          break;
        case "high-value-persona-failing":
        case "high-value-persona-degraded":
          investigations[finding.name] = this._investigatePersonaDegraded(finding, report);
          break;
        case "route-regression":
          investigations[finding.name] = this._investigateRouteRegression(finding, report);
          break;
        case "deploy-regression":
          investigations[finding.name] = this._investigateDeployRegression(report);
          break;
        case "memory-pressure":
          investigations[finding.name] = this._investigateMemoryPressure(report);
          break;
        case "stale-claws":
          investigations[finding.name] = { diagnosis: `Stale claws may have crashed or hung`, action: "trigger diagnostics" };
          break;
        case "fix-pipeline-stall":
        case "pipeline-starvation":
          investigations[finding.name] = this._investigateFixStall(report);
          break;
        case "flaky-test-surge":
          investigations[finding.name] = this._investigateFlakyTests(report);
          break;
        case "slow-test-creep":
          investigations[finding.name] = this._investigateSlowTests(report);
          break;
        case "test-inventory-decay":
          investigations[finding.name] = {
            diagnosis: `Test volume dropped from ${report.coverageDecay?.peakVolume ?? "?"} to ${report.coverageDecay?.currentVolume ?? "?"}`,
            action: "review generate-tests.js output and check for spec file deletions",
          };
          break;
        case "cold-start-personas":
          investigations[finding.name] = {
            diagnosis: `${report.testInventory?.neverRanPersonas?.length ?? 0} personas have never run due to MAX_PERSONAS cap`,
            action: "force-run with expanded MAX_PERSONAS or rotation guarantee",
            personas: report.testInventory?.neverRanPersonas?.slice(0, 10),
          };
          break;
        case "repair-exhaustion":
          investigations[finding.name] = {
            diagnosis: `${report.stuckTests?.repairExhausted ?? 0} tests exhausted 3 repair-agent attempts`,
            action: "route to test-regen claw for full regeneration",
          };
          break;
        case "quarantine-overflow":
          investigations[finding.name] = {
            diagnosis: `${report.quarantine?.quarantinedTests ?? 0} quarantined tests (oldest: ${report.quarantine?.oldestQuarantinedDays ?? 0}d)`,
            action: "increase test-regen capacity or investigate common failure patterns",
          };
          break;
        case "budget-waste-high":
          investigations[finding.name] = {
            diagnosis: `${report.budget?.wastedPct ?? 0}% of budget wasted on failed/partial outcomes`,
            action: "review budget-effectiveness.json for repeated failures and adjust per-call budgets",
            byOutcome: report.budget?.byOutcome ?? {},
          };
          break;
        case "idle-spender":
          investigations[finding.name] = {
            diagnosis: `Claws running but not spending tokens: ${report.budget?.idleSpenders?.join(", ") ?? "unknown"}`,
            action: "check if Claude CLI is available (`claude --version`), check API keys, check if claws are short-circuiting before LLM calls",
            idleClaws: report.budget?.idleSpenders ?? [],
          };
          break;
        case "zero-token-activity":
          investigations[finding.name] = {
            diagnosis: "No token spend across entire system despite active claws — likely systemic failure",
            action: "verify Claude CLI works (`claude --print 'test'`), check GEMINI_API_KEY, check rate limits, check budget-exhausted.json",
          };
          break;
        case "regen-failure-rate":
          investigations[finding.name] = {
            diagnosis: `Test-regen success rate ${report.testRegen?.successRate ?? 0}% — ${report.testRegen?.needsHuman ?? 0} need human, ${report.testRegen?.failed ?? 0} failed`,
            action: "investigate common failure contexts in regen-state.json; may need better prompt or page source resolution",
            recentAttempts: report.testRegen?.recentAttempts ?? [],
          };
          break;
        case "regen-cost-high":
          investigations[finding.name] = {
            diagnosis: `Total regen spend $${(report.testRegen?.totalCost ?? 0).toFixed(2)}, avg $${report.testRegen?.avgCostPerRegen ?? 0}/regen`,
            action: "consider lowering per-regen budget or switching more regens to sonnet",
          };
          break;
        case "regen-backlog":
          investigations[finding.name] = {
            diagnosis: `${report.testRegen?.pending ?? 0} tests pending regen, claw processing ${this.config?.claws?.["test-regen"]?.maxRegensPerCycle ?? 3}/cycle`,
            action: "increase maxRegensPerCycle in daemon-config.json or reduce intervalMinutes",
          };
          break;
        case "regen-stalled": {
          const clawState = report.clawHealth?.["test-regen"] ?? {};
          investigations[finding.name] = {
            diagnosis: `test-regen claw status: ${clawState.status ?? "unknown"}, stale: ${clawState.stale ?? true}, last cycle: ${clawState.cycle ?? 0}`,
            action: "check if claw is crashed/paused; trigger manually with: node scripts/e2e/daemon.js --trigger test-regen",
          };
          break;
        }
        default:
          investigations[finding.name] = { diagnosis: "no specific investigation available" };
      }
    }

    return investigations;
  }

  _investigatePassRateDrop(report, baseline) {
    const result = { diagnosis: "", correlations: [] };

    // Check if drop correlates with auto-fix commits
    if (report.git.autoFixCommits > 0) {
      result.correlations.push(`${report.git.autoFixCommits} auto-fix commit(s) since last cycle — possible regression`);
    }

    // Check if drop correlates with deploy
    if (report.git.deploysSinceLastCycle > 0) {
      result.correlations.push("new deployment detected — may have introduced regression");
    }

    // Check recent fix snapshots for regression pattern
    if (baseline.preFixSnapshots.length > 0) {
      const latest = baseline.preFixSnapshots[baseline.preFixSnapshots.length - 1];
      if (latest.postFixPassRate != null && latest.postFixPassRate < latest.preFixPassRate) {
        result.correlations.push(
          `recent fix may have regressed: pre=${latest.preFixPassRate}% → post=${latest.postFixPassRate}%`
        );
      }
    }

    // Try to find the specific commit that started the drop
    try {
      const log = execSync(
        'git log --oneline -10 --format="%h %s" 2>/dev/null',
        { cwd: ROOT, encoding: "utf-8", timeout: 10000 }
      ).trim();
      result.recentCommits = log.split("\n").slice(0, 5);
    } catch { /* non-fatal */ }

    result.diagnosis = result.correlations.length > 0
      ? `Pass rate drop correlates with: ${result.correlations.join("; ")}`
      : "Pass rate drop with no clear correlation — may be transient or environment issue";

    return result;
  }

  _investigateFixRegression(baseline) {
    if (baseline.preFixSnapshots.length === 0) {
      return { diagnosis: "no pre-fix snapshots available" };
    }
    const latest = baseline.preFixSnapshots[baseline.preFixSnapshots.length - 1];
    return {
      diagnosis: `Fix applied to ${latest.filesChanged.join(", ")} caused pass rate to drop from ${latest.preFixPassRate}% to ${latest.postFixPassRate}%`,
      filesChanged: latest.filesChanged,
      mocsFixed: latest.mocsFixed,
      action: "consider reverting the fix or creating a repair MOC",
    };
  }

  _investigateSkipRate(report) {
    const greenHistory = this.readState("green-history.json");
    const skipList = this.readState("green-skip-list.json");

    const totalTracked = greenHistory ? Object.keys(greenHistory.tests ?? {}).length : 0;
    const stableTests = greenHistory
      ? Object.values(greenHistory.tests ?? {}).filter((t) => t.consecutivePasses >= 5).length
      : 0;
    const skipListSize = skipList?.skippable?.length ?? 0;

    return {
      diagnosis: `Tracked: ${totalTracked}, stable (5+ passes): ${stableTests}, skip list: ${skipListSize}`,
      hint: skipListSize === 0 && stableTests > 0
        ? "Skip list is empty despite stable tests — compute-skippable may be broken"
        : skipListSize > stableTests * 0.9
          ? "Skip list is very aggressive — thresholds may need relaxing"
          : "skip rate within expectations given green history",
    };
  }

  _investigateUntestedFixes(finding, report) {
    return {
      diagnosis: `${finding.untestedRoutes?.length ?? 0} routes changed by fix-engine but not tested in the last run`,
      untestedRoutes: finding.untestedRoutes ?? [],
      fixedFiles: finding.fixedFiles ?? report.fixes.filesChanged,
      action: "force-run these routes in next test cycle",
    };
  }

  _investigateFixStall(report) {
    const queue = this.readState("moc-queue.json");
    const allMocs = queue?.mocs ?? [];
    const approved = allMocs.filter((m) =>
      ["approved", "pending_fix"].includes(m.status)
    );

    // Check for data integrity issues
    const missingIds = allMocs.filter((m) => !m.id).length;
    const noSourceFiles = approved.filter((m) =>
      !m.sourceFiles || m.sourceFiles.length === 0
    ).length;

    // Check if fix-engine is running
    const signals = this._loadAllSignals();
    const feStatus = signals.claws?.["fix-engine"]?.status ?? "unknown";
    const feLastRun = signals.claws?.["fix-engine"]?.lastRun;

    let hint;
    if (missingIds > 0) {
      hint = `${missingIds} MOCs have no id — fix-engine cannot process them. Diagnostics repair-pipeline-starvation will assign IDs.`;
    } else if (feStatus === "circuit_broken") {
      hint = "fix-engine circuit breaker is tripped — check diagnostics";
    } else if (feStatus === "idle" && feLastRun) {
      hint = "fix-engine is idle but has work — may be budget-constrained";
    } else {
      hint = "unknown — check fix-engine logs";
    }

    return {
      diagnosis: `fix-engine status: ${feStatus}, last run: ${feLastRun ?? "never"}, ${approved.length} MOCs waiting`,
      pendingMocs: approved.map((m) => m.id).slice(0, 10),
      missingIds,
      noSourceFiles,
      hint,
    };
  }

  _investigatePersonaDegraded(finding, report) {
    const affected = finding.affectedPersonas ?? [];
    const details = affected.map((id) => {
      const p = report.personaPerformance?.personas?.[id];
      if (!p) { return { personaId: id, info: "no data" }; }
      return {
        personaId: id,
        passRate: p.passRate,
        failed: p.failed,
        total: p.total,
        roiTier: p.roiTier,
        roiScore: p.roiScore,
      };
    });

    // Check if these personas' failures correlate with specific routes
    const failingRoutes = new Set();
    for (const ft of (report.testBreakdown?.failingTests ?? [])) {
      for (const personaId of affected) {
        if (ft.title.toLowerCase().includes(personaId.replace(/-/g, " ")) ||
            ft.title.toLowerCase().includes(personaId)) {
          failingRoutes.add(ft.route);
        }
      }
    }

    return {
      diagnosis: `${affected.length} high-value persona(s) degraded`,
      personas: details,
      correlatedRoutes: Array.from(failingRoutes),
      action: failingRoutes.size > 0
        ? `Force-test these routes: ${Array.from(failingRoutes).join(", ")}`
        : "Review persona-specific test failures",
    };
  }

  _investigateRouteRegression(finding, report) {
    const routes = finding.routes ?? [];
    const details = routes.map((route) => {
      const routeData = report.testBreakdown?.byRoute?.[route] ?? {};
      const failingTests = (report.testBreakdown?.failingTests ?? [])
        .filter((t) => t.route === route)
        .slice(0, 5);
      return {
        route,
        passed: routeData.passed,
        failed: routeData.failed,
        total: routeData.total,
        failingTests: failingTests.map((t) => ({
          title: t.title,
          error: t.error?.slice(0, 200),
        })),
      };
    });

    // Check if route regression correlates with recent commits
    let recentChanges = [];
    try {
      const { mapFilesToRoutes, getChangedFiles } = require("../lib/diff-test-selector");
      const changed = getChangedFiles("HEAD~3");
      for (const route of routes) {
        const relatedFiles = changed.filter((f) => {
          const { routes: fileRoutes } = mapFilesToRoutes([f]);
          return fileRoutes.includes(route);
        });
        if (relatedFiles.length > 0) {
          recentChanges.push({ route, changedFiles: relatedFiles });
        }
      }
    } catch { /* non-fatal */ }

    return {
      diagnosis: `${routes.length} route(s) regressed significantly`,
      routes: details,
      recentChanges,
      action: "force-run regressed routes next cycle; investigate recent commits to those routes",
    };
  }

  _investigateDeployRegression(report) {
    const dv = report.deployVerification;
    return {
      diagnosis: `Deploy ${dv.lastDeploySha ?? "unknown"} caused pass rate to drop from ${dv.passRateBeforeDeploy}% to ${dv.passRateAfterDeploy}%`,
      deploySha: dv.lastDeploySha,
      deployAt: dv.deployAt,
      delta: dv.passRateAfterDeploy - dv.passRateBeforeDeploy,
      action: "investigate commits in this deploy; consider reverting if regression is severe",
    };
  }

  _investigateMemoryPressure(report) {
    const res = report.resources;
    return {
      diagnosis: `System memory at ${res.systemUsedPct}% (${res.systemFreeMB}MB free). ${res.nodeProcesses} node processes, ${res.clawProcesses} claw processes.`,
      hint: res.nodeProcesses > 15
        ? "Excessive node processes — possible orphan accumulation. Consider zombie cleanup."
        : res.systemUsedPct > 92
          ? "CRITICAL: approaching emergency threshold. Daemon may auto-shutdown."
          : "Memory elevated but manageable. Monitor next few cycles.",
      action: res.systemUsedPct > 92
        ? "pausing non-essential claws to reduce memory"
        : "monitoring — no action needed yet",
    };
  }

  _investigateFlakyTests(report) {
    const flakyTests = report.testBreakdown?.flakyTests ?? [];
    const routeDistribution = {};
    for (const t of flakyTests) {
      routeDistribution[t.route] = (routeDistribution[t.route] ?? 0) + 1;
    }

    return {
      diagnosis: `${flakyTests.length} flaky tests across ${Object.keys(routeDistribution).length} routes`,
      topRoutes: Object.entries(routeDistribution)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([route, count]) => ({ route, flakyCount: count })),
      hint: flakyTests.length > 10
        ? "Widespread flakiness suggests infrastructure issue (rate limits, network, server load)"
        : "Concentrated flakiness — likely specific test or route issue",
    };
  }

  _investigateSlowTests(report) {
    const slowTests = report.testBreakdown?.slowTests ?? [];
    const totalSlowTime = slowTests.reduce((sum, t) => sum + t.durationMs, 0);

    return {
      diagnosis: `${slowTests.length} tests taking >30s, consuming ${(totalSlowTime / 1000).toFixed(0)}s total`,
      slowest: slowTests.slice(0, 5).map((t) => ({
        title: t.title,
        route: t.route,
        seconds: (t.durationMs / 1000).toFixed(1),
      })),
      hint: totalSlowTime > 300000
        ? "Slow tests are adding >5min to total run time. Consider timeouts or optimization."
        : "Manageable — monitor for growth trend",
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 5: Act
  // ---------------------------------------------------------------------------

  _act(failing, investigations, report) {
    const actions = [];

    for (const finding of failing) {
      switch (finding.name) {
        case "untested-fixes": {
          const forceRun = this._writeForceRunList(finding, investigations);
          if (forceRun) { actions.push(forceRun); }
          break;
        }
        case "fix-regression": {
          actions.push(this._createRegressionAlert(finding, investigations));
          break;
        }
        case "zero-results": {
          actions.push({ type: "signal", detail: "emitting diagnostics-requested + force-triggering test-runner for zero-results" });
          this.emitSignal("diagnostics-requested", {
            reason: "observer: zero test results",
            source: "observer",
          });
          // Force-trigger test-runner immediately — don't wait for diagnostics (could be 6h away)
          this._forceTriggerClaw("test-runner");
          actions.push({ type: "force-trigger", detail: "force-triggered test-runner for zero-results recovery" });
          break;
        }
        case "route-regression": {
          // Force-run regressed routes in next test cycle
          const routes = finding.routes ?? [];
          if (routes.length > 0) {
            const forceRun = this._writeForceRunList(
              { untestedRoutes: routes },
              { "untested-fixes": { untestedRoutes: routes } }
            );
            if (forceRun) {
              forceRun.reason = "route-regression";
              actions.push(forceRun);
            }
          }
          break;
        }
        case "high-value-persona-failing": {
          // Force-run routes associated with failing high-value personas
          const inv = investigations?.["high-value-persona-failing"];
          const routes = inv?.correlatedRoutes ?? [];
          if (routes.length > 0) {
            const forceRun = this._writeForceRunList(
              { untestedRoutes: routes },
              { "untested-fixes": { untestedRoutes: routes } }
            );
            if (forceRun) {
              forceRun.reason = "high-value-persona-failing";
              actions.push(forceRun);
            }
          }
          break;
        }
        case "deploy-regression": {
          actions.push(this._createRegressionAlert(finding, investigations));
          break;
        }
        case "stale-claws": {
          actions.push({ type: "signal", detail: "emitting diagnostics-requested + force-triggering stale claws" });
          this.emitSignal("diagnostics-requested", {
            reason: `observer: stale claws detected — ${finding.detail}`,
            source: "observer",
          });
          // Extract stale claw names and force-trigger each one
          const staleMatch = finding.detail.match(/:\s*(.+)$/);
          if (staleMatch) {
            const staleNames = staleMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
            for (const staleName of staleNames) {
              if (staleName === "observer") { continue; }
              this._forceTriggerClaw(staleName);
              actions.push({ type: "force-trigger", detail: `force-triggered stale claw: ${staleName}` });
            }
          }
          break;
        }
        case "memory-pressure": {
          // At critical levels, pause non-essential claws
          if (report.resources?.systemUsedPct > 92) {
            actions.push({ type: "signal", detail: "emitting memory-critical for emergency response" });
            this.emitSignal("memory-critical", {
              usedPct: report.resources.systemUsedPct,
              freeMB: report.resources.systemFreeMB,
              source: "observer",
            });
          }
          break;
        }
        case "cold-start-personas": {
          // Write force-run with never-run persona spec files
          const neverRan = report.testInventory?.neverRanPersonas ?? [];
          if (neverRan.length > 0) {
            const specFiles = neverRan
              .slice(0, 5)
              .map((p) => `tests/personas/${p}.spec.ts`);
            this.writeState("observer-force-run.json", {
              specs: specFiles,
              reason: "observer: cold-start personas need first run",
              createdAt: new Date().toISOString(),
              cycle: this.currentCycle,
            });
            actions.push({ type: "force-run", reason: "cold-start-personas", specs: specFiles });
          }
          break;
        }
        case "repair-exhaustion": {
          // Emit regen-requested signal for the test-regen claw
          const stuckCount = report.stuckTests?.repairExhausted ?? 0;
          if (stuckCount > 0) {
            this.emitSignal("regen-requested", {
              count: stuckCount,
              stuckTests: (report.stuckTests?.stuckTests ?? []).slice(0, 10),
              source: "observer",
            });
            actions.push({ type: "signal", detail: `emitting regen-requested for ${stuckCount} repair-exhausted tests` });
          }
          break;
        }
        case "flaky-accumulation": {
          // Write quarantine candidates from flaky tests
          const topFlaky = report.flakyTests?.topFlaky ?? [];
          if (topFlaky.length > 0) {
            actions.push({ type: "quarantine-candidates", count: topFlaky.length,
              detail: `${topFlaky.length} flaky tests flagged for quarantine review` });
          }
          break;
        }
        case "pass-rate-drop":
        case "effective-rate-drop": {
          // Request diagnostics + force-run affected routes
          actions.push({ type: "signal", detail: `emitting diagnostics-requested for ${finding.name}` });
          this.emitSignal("diagnostics-requested", {
            reason: `observer: ${finding.name} — ${finding.detail}`,
            source: "observer",
          });
          // If we have route-level data, force-run regressed routes
          const routeChanges = report.deltas?.routePassRateChanges ?? {};
          const regressedRoutes = Object.entries(routeChanges)
            .filter(([, d]) => d.delta < -15)
            .map(([r]) => r);
          if (regressedRoutes.length > 0) {
            const forceRun = this._writeForceRunList(
              { untestedRoutes: regressedRoutes },
              { "untested-fixes": { untestedRoutes: regressedRoutes } }
            );
            if (forceRun) {
              forceRun.reason = finding.name;
              actions.push(forceRun);
            }
          }
          break;
        }
        case "fix-stall":
        case "fix-pipeline-stall":
        case "convergence-negative": {
          // Force-trigger fix-engine and request diagnostics
          actions.push({ type: "force-trigger", detail: `force-triggering fix-engine for ${finding.name}` });
          this._withSignalsLock((signals) => {
            if (signals.claws?.["fix-engine"]) {
              signals.claws["fix-engine"].lastRun = null;
            }
          });
          this.emitSignal("diagnostics-requested", {
            reason: `observer: ${finding.name} — ${finding.detail}`,
            source: "observer",
          });
          break;
        }
        case "cp-meta-stall": {
          // cp-meta not advancing MOCs — request diagnostics with error context
          let errorSummary = null;
          try {
            errorSummary = this.readState("cp-meta-errors.json");
          } catch { /* non-fatal */ }
          actions.push({ type: "signal", detail: `emitting diagnostics-requested for cp-meta-stall (error: ${finding.errorType ?? errorSummary?.errorType ?? "unknown"})` });
          this.emitSignal("diagnostics-requested", {
            reason: `observer: cp-meta-stall — ${finding.detail}`,
            source: "observer",
            errorType: finding.errorType ?? errorSummary?.errorType ?? "unknown",
          });
          // Force-trigger cp-meta immediately
          this._forceTriggerClaw("cp-meta");
          actions.push({ type: "force-trigger", detail: "force-triggered cp-meta for stall recovery" });
          break;
        }
        case "orphan-mocs": {
          // Force-trigger cp-meta which now has Phase 1.5 backfill
          actions.push({ type: "signal", detail: `emitting diagnostics-requested for orphan-mocs (${finding.orphanCount} orphans)` });
          this.emitSignal("diagnostics-requested", {
            reason: `observer: ${finding.orphanCount} orphan MOCs without platformMocId`,
            source: "observer",
          });
          this._forceTriggerClaw("cp-meta");
          actions.push({ type: "force-trigger", detail: `force-triggered cp-meta to backfill ${finding.orphanCount} orphan MOCs` });
          break;
        }
        case "pipeline-starvation": {
          // Force-trigger finding-pipeline to create fresh MOCs + request diagnostics for repair
          actions.push({ type: "signal", detail: `emitting diagnostics-requested for ${finding.name}` });
          this.emitSignal("diagnostics-requested", {
            reason: `observer: pipeline-starvation — ${finding.detail}`,
            source: "observer",
          });
          this._withSignalsLock((signals) => {
            if (signals.claws?.["finding-pipeline"]) {
              signals.claws["finding-pipeline"].lastRun = null;
            }
          });
          actions.push({ type: "force-trigger", detail: "force-triggering finding-pipeline (pipeline starvation)" });
          break;
        }
        case "git-conflict": {
          // Request diagnostics which now has a git-conflict resolver
          actions.push({ type: "signal", detail: "emitting diagnostics-requested for git-conflict" });
          this.emitSignal("diagnostics-requested", {
            reason: `observer: git conflict — ${finding.detail}`,
            source: "observer",
          });
          break;
        }
        case "zero-token-activity": {
          // System-wide LLM failure — pause compute-intensive claws until LLM recovers
          actions.push({ type: "signal", detail: "emitting diagnostics-requested for zero-token-activity" });
          this.emitSignal("diagnostics-requested", {
            reason: `observer: zero token activity — ${finding.detail}`,
            source: "observer",
          });
          break;
        }
        case "budget-waste-high": {
          // Log a warning — diagnostics or human should investigate
          actions.push({ type: "alert", detail: `budget waste at ${report.budget?.wastedPct}% — logging for review` });
          try {
            const { writeToFile } = require("../lib/notify");
            writeToFile(`Budget waste: ${finding.detail}`, "warning");
          } catch { /* non-fatal */ }
          break;
        }
        case "high-value-persona-degraded": {
          // Force-run degraded high-value personas to get more data
          const degradedPersonas = Object.entries(report.personaPerformance?.personas ?? {})
            .filter(([, p]) => p.roiTier === "high" && p.passRate >= 50 && p.passRate < 90)
            .map(([id]) => id);
          if (degradedPersonas.length > 0) {
            const specFiles = degradedPersonas
              .slice(0, 5)
              .map((p) => `tests/personas/${p}.spec.ts`);
            this.writeState("observer-force-run.json", {
              specs: specFiles,
              routes: [],
              reason: "observer: high-value persona degraded — collecting more data",
              createdAt: new Date().toISOString(),
              cycle: this.currentCycle,
            });
            actions.push({ type: "force-run", reason: "high-value-persona-degraded", specs: specFiles });
          }
          break;
        }
        case "skip-rate-high": {
          // Green tracker may be too aggressive — request diagnostics
          actions.push({ type: "signal", detail: "emitting diagnostics-requested for skip-rate-high" });
          this.emitSignal("diagnostics-requested", {
            reason: `observer: skip rate high — ${finding.detail}`,
            source: "observer",
          });
          break;
        }
        case "excessive-deferrals": {
          // Fix-engine may be stuck — force-trigger it and request diagnostics
          actions.push({ type: "signal", detail: "force-triggering fix-engine due to excessive deferrals" });
          this.emitSignal("mocs-ready", { source: "observer", reason: "excessive test-runner deferrals" });
          this.emitSignal("diagnostics-requested", {
            reason: `observer: test-runner deferred ${report.pipelineHealth?.testRunnerDeferrals?.total} times — fix-engine may be stuck`,
            source: "observer",
          });
          break;
        }
        case "dedup-ineffective": {
          // Log for human review — may need dedup key tuning
          actions.push({ type: "logged", detail: `dedup-ineffective: ${finding.detail}` });
          break;
        }
        default:
          // Other findings just get recorded in the report
          break;
      }
    }

    // Emit observer-alert if any critical findings
    const criticals = failing.filter((f) => f.severity === "critical");
    if (criticals.length > 0) {
      const alertId = `alert-${this.currentCycle}-${++this._alertIdCounter}`;
      this.emitSignal("observer-alert", {
        severity: "critical",
        alertId,
        findings: criticals.map((f) => f.name),
        detail: criticals.map((f) => f.detail).join(" | "),
      });
      actions.push({ type: "alert", alertId, findings: criticals.map((f) => f.name) });

      // Track alert in baseline meta
      const baseline = this._loadBaseline();
      baseline.meta.alertsEmitted = (baseline.meta.alertsEmitted ?? 0) + 1;
      baseline.lastInvestigation = { alertId, at: new Date().toISOString(), findings: criticals.map((f) => f.name) };
      this._saveBaseline(baseline);

      // Send notification
      try {
        const { writeToFile } = require("../lib/notify");
        const msg = `Observer alert (cycle ${this.currentCycle}): ${criticals.map((f) => `${f.name} — ${f.detail}`).join("; ")}`;
        writeToFile(msg, "warning");
      } catch { /* non-fatal */ }
    }

    return actions;
  }

  _writeForceRunList(finding, investigations) {
    const routes = finding.untestedRoutes ?? investigations?.["untested-fixes"]?.untestedRoutes ?? [];
    if (routes.length === 0) { return null; }

    const forceRun = {
      routes,
      reason: "observer: untested fixes",
      createdAt: new Date().toISOString(),
      cycle: this.currentCycle,
    };

    this.writeState("observer-force-run.json", forceRun);
    this.log(`wrote force-run list: ${routes.length} routes`);

    // Track in baseline meta
    const baseline = this._loadBaseline();
    baseline.meta.forceRunsIssued = (baseline.meta.forceRunsIssued ?? 0) + 1;
    this._saveBaseline(baseline);

    return { type: "force-run", routes };
  }

  _createRegressionAlert(finding, investigations) {
    const inv = investigations?.["fix-regression"] ?? {};
    const detail = `Fix regression detected: ${finding.detail}. ${inv.action ?? ""}`;

    try {
      const { writeToFile } = require("../lib/notify");
      writeToFile(`Observer: ${detail}`, "warning");
    } catch { /* non-fatal */ }

    return { type: "regression-alert", detail };
  }

  // ---------------------------------------------------------------------------
  // Phase 6: Write Report
  // ---------------------------------------------------------------------------

  _writeReport(report) {
    // Ensure cycle-reports directory exists
    fs.mkdirSync(CYCLE_REPORTS_DIR, { recursive: true });

    // Write individual cycle report
    const reportPath = path.join(CYCLE_REPORTS_DIR, `cycle-${String(report.cycle).padStart(4, "0")}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

    // Write latest (always the most recent)
    this.writeState("observer-latest.json", report);

    // Trim old reports
    const maxReports = this.clawConfig.maxCycleReports ?? 100;
    this._trimReports(maxReports);
  }

  _trimReports(maxReports) {
    try {
      if (!fs.existsSync(CYCLE_REPORTS_DIR)) { return; }
      const files = fs.readdirSync(CYCLE_REPORTS_DIR)
        .filter((f) => f.startsWith("cycle-") && f.endsWith(".json"))
        .sort();
      if (files.length > maxReports) {
        const toDelete = files.slice(0, files.length - maxReports);
        for (const f of toDelete) {
          try { fs.unlinkSync(path.join(CYCLE_REPORTS_DIR, f)); } catch { /* ignore */ }
        }
        this.log(`trimmed ${toDelete.length} old cycle reports`);
      }
    } catch { /* non-fatal */ }
  }

  // ---------------------------------------------------------------------------
  // Phase 7: Self-Observe (Meta-Loop)
  // ---------------------------------------------------------------------------

  _selfObserve(report, baseline, findings) {
    // 7A: Track own effectiveness
    this._trackEffectiveness(baseline, findings);

    // 7B: Auto-tune thresholds
    this._autoTuneThresholds(baseline);

    // 7C: Self-health check
    this._selfHealthCheck(report, baseline);

    // 7D: Recommendation engine (after 10+ cycles)
    if (baseline.history.length >= 10) {
      this._generateRecommendations(baseline);
    }
  }

  // 7A: Track own effectiveness
  _trackEffectiveness(baseline, findings) {
    const meta = baseline.meta;
    if (!meta) { return; }

    // Check if previous alerts led to fixes
    if (meta.lastAlert) {
      const lastAlertCycle = meta.lastAlert.cycle;
      // Look at cycles after the alert — did pass rate recover?
      const postAlertCycles = baseline.history.filter((h) => h.cycle > lastAlertCycle);
      if (postAlertCycles.length >= 2) {
        const recovered = postAlertCycles.some((h) =>
          h.passRate != null && h.passRate >= baseline.rollingPassRate.mean - 2
        );
        const fixApplied = postAlertCycles.some((h) => h.fixesApplied > 0);

        if (recovered && fixApplied) {
          meta.alertsLeadingToFix = (meta.alertsLeadingToFix ?? 0) + 1;
        } else if (recovered && !fixApplied) {
          // Resolved without intervention — false positive
          meta.falsePositives = meta.falsePositives ?? [];
          meta.falsePositives.push({ alertId: meta.lastAlert.alertId, cycle: lastAlertCycle });
          if (meta.falsePositives.length > 10) {
            meta.falsePositives = meta.falsePositives.slice(-10);
          }
        }
        // Clear last alert — we've judged it
        meta.lastAlert = null;
      }
    }

    // Store current alert for next cycle's evaluation
    const currentCriticals = findings.filter((f) => !f.ok && f.severity === "critical");
    if (currentCriticals.length > 0) {
      meta.lastAlert = {
        cycle: this.currentCycle,
        alertId: `alert-${this.currentCycle}`,
        findings: currentCriticals.map((f) => f.name),
      };
    }

    // Check for force-run effectiveness
    const forceRunPath = FORCE_RUN_PATH;
    if (!fs.existsSync(forceRunPath)) {
      // If we previously issued a force-run and it's been consumed, check results
      // (force-run file is deleted by test-runner after reading)
      // We check if any of the forced routes had failures
      const lastForceRun = meta._lastForceRun;
      if (lastForceRun && this.currentCycle > lastForceRun.cycle) {
        // Check recent test results for regressions on forced routes
        const testResults = this.readState("observer-latest.json");
        if (testResults?.tests?.failed > 0) {
          meta.forceRunsCaughtRegression = (meta.forceRunsCaughtRegression ?? 0) + 1;
        }
        meta._lastForceRun = null;
      }
    }

    // Update precision
    if (meta.alertsEmitted > 0) {
      meta.alertsPrecision = parseFloat(
        ((meta.alertsLeadingToFix ?? 0) / meta.alertsEmitted).toFixed(2)
      );
    }
    if (meta.forceRunsIssued > 0) {
      meta.forceRunPrecision = parseFloat(
        ((meta.forceRunsCaughtRegression ?? 0) / meta.forceRunsIssued).toFixed(2)
      );
    }

    // Missed regression detection
    const failing = findings.filter((f) => !f.ok);
    const flaggedRoutes = new Set();
    for (const f of failing) {
      if (f.untestedRoutes) {
        f.untestedRoutes.forEach((r) => flaggedRoutes.add(r));
      }
    }

    // Check if test-runner found failures on routes we didn't flag
    // (Would require route-level failure data — approximate from overall results)
    // TODO: Enhance when per-route failure data becomes available

    this._saveBaseline(baseline);
  }

  // 7B: Auto-tune thresholds
  _autoTuneThresholds(baseline) {
    const meta = baseline.meta;
    if (!meta || meta.alertsEmitted < 10) { return; } // Need data

    const config = this.clawConfig;
    let rt = baseline.runtimeThresholds ?? {
      passRateDropThreshold: config.passRateDropThreshold ?? 15,
      effectiveRateDropThreshold: config.effectiveRateDropThreshold ?? 5,
      highSkipThreshold: config.highSkipThreshold ?? 70,
      lowSkipThreshold: config.lowSkipThreshold ?? 10,
      volumeDeviationPct: config.volumeDeviationPct ?? 20,
      fixRegressionThreshold: config.fixRegressionThreshold ?? 5,
    };

    let changed = false;

    // If precision < 30% (too many false positives), relax thresholds
    if (meta.alertsPrecision < 0.3 && meta.alertsEmitted > 10) {
      rt.passRateDropThreshold = Math.min((rt.passRateDropThreshold ?? 15) + 2, 30);
      rt.highSkipThreshold = Math.min((rt.highSkipThreshold ?? 70) + 5, 85);
      this.log(`auto-tune: relaxed thresholds (precision ${(meta.alertsPrecision * 100).toFixed(0)}% too low)`);
      changed = true;
    }

    // If precision > 80% AND we have missed regressions, tighten thresholds
    if (meta.alertsPrecision > 0.8 && (meta.missedRegressions?.length ?? 0) > 0) {
      rt.passRateDropThreshold = Math.max((rt.passRateDropThreshold ?? 15) - 2, 5);
      rt.effectiveRateDropThreshold = Math.max((rt.effectiveRateDropThreshold ?? 5) - 1, 2);
      this.log(`auto-tune: tightened thresholds (${meta.missedRegressions.length} missed regressions)`);
      changed = true;
    }

    // Self-deprecation: precision < 20% over 20+ alerts — generating noise
    if (meta.alertsPrecision < 0.2 && meta.alertsEmitted > 20) {
      rt.passRateDropThreshold = Math.min((rt.passRateDropThreshold ?? 15) * 1.25, 40);
      rt.effectiveRateDropThreshold = Math.min((rt.effectiveRateDropThreshold ?? 5) * 1.25, 15);
      rt.highSkipThreshold = Math.min((rt.highSkipThreshold ?? 70) * 1.1, 90);
      this.log("auto-tune: NOISE WARNING — precision <20% over 20+ alerts, widening all thresholds 25%");
      changed = true;
    }

    if (changed) {
      meta.thresholdHistory = meta.thresholdHistory ?? [];
      meta.thresholdHistory.push({
        at: new Date().toISOString(),
        cycle: this.currentCycle,
        thresholds: { ...rt },
        precision: meta.alertsPrecision,
        reason: meta.alertsPrecision < 0.3 ? "relaxed (low precision)" : "tightened (missed regressions)",
      });
      if (meta.thresholdHistory.length > 20) {
        meta.thresholdHistory = meta.thresholdHistory.slice(-20);
      }
    }

    baseline.runtimeThresholds = rt;
    this._saveBaseline(baseline);
  }

  // 7C: Self-health check
  _selfHealthCheck(report, baseline) {
    const issues = [];

    // Am I collecting? Check for null/empty fields on claws that ran
    const signals = this._loadAllSignals();
    for (const claw of ["test-runner", "fix-engine", "finding-pipeline"]) {
      const clawStatus = signals.claws?.[claw];
      if (clawStatus?.lastRun) {
        const clawRan = new Date(clawStatus.lastRun) > new Date(Date.now() - 2 * 3600000);
        if (clawRan && claw === "test-runner" && report.tests.total == null) {
          issues.push(`test-runner ran recently but tests.total is null — collection bug`);
        }
      }
    }

    // Am I acting? Check for anomaly-to-action ratio
    const meta = baseline.meta;
    if (meta.alertsEmitted >= 5 && meta.forceRunsIssued === 0) {
      issues.push("5+ alerts emitted but 0 force-runs issued — action logic may be broken");
    }

    if (issues.length > 0) {
      this.log(`self-health issues: ${issues.join("; ")}`);
    }
  }

  // 7D: Recommendation engine
  _generateRecommendations(baseline) {
    const recommendations = [];
    const meta = baseline.meta;

    // Threshold adjustment recommendation
    if (meta.alertsPrecision < 0.4 && meta.alertsEmitted >= 10) {
      recommendations.push({
        type: "threshold-adjustment",
        detail: `Alert precision is ${(meta.alertsPrecision * 100).toFixed(0)}% over ${meta.alertsEmitted} alerts. Auto-tuning is adjusting.`,
        confidence: "high",
        autoApplied: true,
      });
    }

    // Missing route mapping recommendation
    try {
      if (fs.existsSync(RECENTLY_FIXED_PATH)) {
        const data = JSON.parse(fs.readFileSync(RECENTLY_FIXED_PATH, "utf-8"));
        const { mapFilesToRoutes } = require("../lib/diff-test-selector");
        const { routes } = mapFilesToRoutes(data.files ?? []);
        const unmapped = (data.files ?? []).filter((f) => {
          const { routes: r } = mapFilesToRoutes([f]);
          return r.length === 0;
        });
        if (unmapped.length > 0) {
          recommendations.push({
            type: "missing-route-mapping",
            detail: `${unmapped.length} file(s) not in FILE_TO_ROUTE: ${unmapped.join(", ")}`,
            confidence: "high",
            autoApplied: false,
            actionRequired: "Add mapping to diff-test-selector.js",
          });
        }
      }
    } catch { /* non-fatal */ }

    // Fix-engine ordering recommendation
    if (baseline.preFixSnapshots.length >= 3) {
      const regressions = baseline.preFixSnapshots.filter(
        (s) => s.postFixPassRate != null && s.preFixPassRate != null && s.postFixPassRate < s.preFixPassRate - 3
      );
      if (regressions.length >= 2) {
        recommendations.push({
          type: "claw-interaction",
          detail: `${regressions.length} fix regressions detected. Consider reordering: test → observe → fix.`,
          confidence: "medium",
          autoApplied: false,
        });
      }
    }

    baseline.recommendations = recommendations;
    this._saveBaseline(baseline);
  }
}

// Direct execution
if (require.main === module) {
  const claw = new ObserverClaw();
  claw.start().catch((err) => {
    console.error(`observer fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { ObserverClaw };
