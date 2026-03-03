#!/usr/bin/env node

/**
 * Claw 4: Intelligence
 *
 * Owns: ROI scoring, Thompson sampling, homeostatic drives, curiosity, foraging,
 *       evolution, health scores, memory consolidation, strategy fusion.
 * Schedule: Triggered by fixes-applied signal OR periodic (every 2h).
 * Reads: persona-learning.json, persona-roi.json, fix-effectiveness.json
 * Writes: persona-roi.json, test-strategy.json, persona-drives.json, evolution state
 * Maps to: Orchestrator Phases 2-4 (track, health, evolve)
 *
 * Genericized from ChangePilot's intelligence claw for use in any persona-engine project.
 */

const fs = require("fs");
const path = require("path");
const { Claw } = require("../claw");

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
const STATE_DIR = path.join(ROOT, "e2e", "state");

class IntelligenceClaw extends Claw {
  constructor() {
    super("intelligence");
  }

  async run() {
    const phases = [];

    // -----------------------------------------------------------------------
    // Phase 2 equivalents: Track effectiveness & sync state
    // -----------------------------------------------------------------------

    // Sequential: queue maintenance
    this._runPhase(phases, "self-clean-queue", "node scripts/e2e/self-clean-queue.js");
    this._runPhase(phases, "reclassify-queue", "node scripts/e2e/reclassify-queue.js");
    this._runPhase(phases, "moc-completion-sync", "node scripts/e2e/moc-completion-sync.js");
    this._runPhase(phases, "fix-effectiveness", "node scripts/e2e/fix-effectiveness-tracker.js");

    // Parallel: stale triage + cleanup
    await this._runParallel(phases, [
      { name: "triage-stale-mocs", cmd: "node scripts/e2e/triage-stale-mocs.js" },
      { name: "cleanup-archived-mocs", cmd: "node scripts/e2e/cleanup-archived-mocs.js" },
      { name: "stale-approval-check", cmd: "node scripts/e2e/stale-approval-check.js" },
    ]);

    // Sequential: effectiveness scoring
    const findingsCount = this._getFindingsCount();
    this._runPhase(phases, "record-fix-effectiveness", `node scripts/e2e/record-fix-effectiveness.js --iteration ${this.currentCycle} --findings-count ${findingsCount}`);
    this._runPhase(phases, "fix-funnel-dashboard", "node scripts/e2e/fix-funnel-dashboard.js");
    this._runPhase(phases, "persona-roi-scorer", "node scripts/e2e/persona-roi-scorer.js");

    // -----------------------------------------------------------------------
    // Phase 3 equivalents: Health scores & coverage
    // -----------------------------------------------------------------------

    await this._runParallel(phases, [
      { name: "feature-health", cmd: "node scripts/e2e/feature-health.js" },
      { name: "coverage-matrix", cmd: "node scripts/e2e/coverage-matrix.js" },
      { name: "spec-change-guard", cmd: "node scripts/e2e/spec-change-guard.js --json" },
      { name: "learn-from-production", cmd: "node scripts/e2e/learn-from-production.js" },
    ]);

    this._runPhase(phases, "causal-analysis", "node scripts/e2e/causal-analysis.js");
    this._runPhase(phases, "thompson-selector", "node scripts/e2e/thompson-selector.js");

    // -----------------------------------------------------------------------
    // Phase 3.5: Intelligence subsystems
    // -----------------------------------------------------------------------

    this._runPhase(phases, "memory-consolidation", "node scripts/e2e/memory-consolidation.js");

    // Layer 1: parallel
    await this._runParallel(phases, [
      { name: "curiosity-engine", cmd: "node scripts/e2e/curiosity-engine.js" },
      { name: "homeostatic-update", cmd: "node scripts/e2e/homeostatic-update.js" },
      { name: "pattern-generalizer", cmd: "node scripts/e2e/pattern-generalizer.js" },
    ]);

    // Layer 2-3: parallel
    await this._runParallel(phases, [
      { name: "aco-paths", cmd: "node scripts/e2e/aco-path-selector.js" },
      { name: "marl-update", cmd: "node scripts/e2e/marl-update.js" },
      { name: "foraging-decisions", cmd: "node scripts/e2e/foraging-decisions.js" },
      { name: "waggle-broadcast", cmd: "node scripts/e2e/waggle-broadcast.js" },
    ]);

    this._runPhase(phases, "strategy-distillation", "node scripts/e2e/strategy-distillation.js");

    // -----------------------------------------------------------------------
    // Phase 4: Evolve & adapt
    // -----------------------------------------------------------------------

    this._runPhase(phases, "evolve-traits", "node scripts/e2e/claude-persona-evolve.js");
    this._runPhase(phases, "spec-compliance", "node scripts/e2e/spec-compliance.js");

    // Fuse test strategy (depends on thompson, curiosity, foraging)
    this._runPhase(phases, "fuse-test-strategy", "node scripts/e2e/fuse-test-strategy.js");
    this._runPhase(phases, "test-roi-scorer", "node scripts/e2e/test-roi-scorer.js");

    // Phase 4.5: Autonomous budget allocation + theme->spec connector
    this._runBudgetAllocation(phases);
    this._runThemeSpecConnector(phases);

    // -----------------------------------------------------------------------
    // Phase 5: Config auto-tuning
    // -----------------------------------------------------------------------

    this._autoTuneConfig(phases);

    // -----------------------------------------------------------------------
    // Phase 5.5: Meta-learning — track subsystem value
    // -----------------------------------------------------------------------

    this._runPhase(phases, "subsystem-value", "node scripts/e2e/subsystem-value-tracker.js");

    // Read value report and log summary
    try {
      const valueReport = this.readState("subsystem-value.json");
      if (valueReport?.meta) {
        this.log(`subsystem health: ${valueReport.meta.activeSubsystems}/${valueReport.meta.totalSubsystems} active, ${valueReport.meta.staleSubsystems} stale`);
        // Log warnings for subsystems that should be investigated
        for (const [id, data] of Object.entries(valueReport.subsystems || {})) {
          if (data.recommendation === "consider_disabling") {
            this.log(`  WARNING: ${id} subsystem has low value (${data.valueScore}) — consider disabling`);
          }
        }
      }
    } catch { /* non-fatal */ }

    // -----------------------------------------------------------------------
    // Phase 5.6: Extract concept-level patterns from code-level fixes
    // -----------------------------------------------------------------------

    this._runPhase(phases, "concept-extraction", "node scripts/e2e/lib/concept-extractor.js");

    // -----------------------------------------------------------------------
    // Phase 5.7: Cross-project pattern sync (import/export)
    // -----------------------------------------------------------------------

    this._runPhase(phases, "cross-project-sync", "node scripts/e2e/cross-project-sync.js");

    // Phase 5.8: Network heartbeat — report status to ChangePilot hub
    this._runPhase(phases, "daemon-heartbeat", "node scripts/e2e/daemon-network-heartbeat.js");

    // Log token spend from intelligence cycle
    try {
      const { getSpendSummary } = require("../lib/token-logger");
      const spend = getSpendSummary(0.5); // Last 30 minutes
      const intelligenceComponents = [
        "persona-evolve", "consolidate-themes", "finding-synthesizer",
        "root-cause", "pre-iteration-analysis", "test-strategy",
        "spec-decomposer", "spec-verifier", "stuck-diagnostics",
      ];
      let totalSpend = 0;
      for (const comp of intelligenceComponents) {
        totalSpend += spend.byComponent[comp] || 0;
      }
      if (totalSpend > 0) {
        this.addBudgetSpend(totalSpend);
        this.log(`token spend this cycle: $${totalSpend.toFixed(4)}`);
      }
    } catch { /* non-fatal */ }

    const failedCount = phases.filter((p) => !p.ok).length;
    const failedNames = phases.filter((p) => !p.ok).map((p) => p.name);

    // Emit signal for health-deploy claw
    this.emitSignal("intelligence-complete", {
      subsystems: phases.length,
      failed: failedCount,
    });

    if (failedCount > 0) {
      this.log(`failed subsystems: ${failedNames.join(", ")}`);
    }

    // Tolerate up to 20% subsystem failures — most are non-critical.
    // Only report error if more than 20% fail or a critical subsystem fails.
    const criticalSubsystems = ["fuse-test-strategy", "persona-roi-scorer", "feature-health"];
    const criticalFailed = failedNames.some((n) => criticalSubsystems.includes(n));
    const failureRate = failedCount / phases.length;

    return {
      ok: !criticalFailed && failureRate <= 0.2,
      summary: `${phases.length} subsystems, ${failedCount} failed${failedNames.length > 0 ? ` (${failedNames.join(", ")})` : ""}`,
    };
  }

  /**
   * Phase 4.5a: Compute ROI-driven budget allocations.
   * High-ROI personas get more oracle tokens, low-ROI get less.
   */
  _runBudgetAllocation(phases) {
    try {
      const { computeAllocations } = require("../lib/budget-allocator");
      const result = computeAllocations();
      if (result.computed) {
        this.log(`budget-allocator: ${result.personaCount} personas — ${result.tierBreakdown.high} high, ${result.tierBreakdown.medium} medium, ${result.tierBreakdown.low} low`);
        phases.push({ name: "budget-allocation", ok: true });
      } else {
        this.log("budget-allocator: no ROI data, using defaults");
        phases.push({ name: "budget-allocation", ok: true });
      }
    } catch (err) {
      this.log(`budget-allocator error: ${err.message}`);
      phases.push({ name: "budget-allocation", ok: false });
    }
  }

  /**
   * Phase 4.5b: Connect theme consolidation to spec decomposer.
   * Themes with enough findings -> spec gaps -> MOC entries.
   */
  _runThemeSpecConnector(phases) {
    try {
      const { findSpecGaps, generateMocEntries } = require("../lib/theme-spec-connector");
      const gaps = findSpecGaps();

      if (gaps.length > 0) {
        const mocs = generateMocEntries(gaps);
        this.log(`theme-spec: ${gaps.length} spec gaps -> ${mocs.length} MOC entries generated`);

        // Append generated MOCs to the queue
        if (mocs.length > 0) {
          const { STATE_DIR: stateDir } = require("../claw");
          const queuePath = path.join(stateDir, "moc-queue.json");

          try {
            let queue = { mocs: [] };
            if (fs.existsSync(queuePath)) {
              queue = JSON.parse(fs.readFileSync(queuePath, "utf-8"));
              if (!queue.mocs) { queue.mocs = []; }
            }

            // Dedup by themeId — don't add MOCs for themes already in queue
            const existingThemes = new Set(
              queue.mocs.filter((m) => m._themeId).map((m) => m._themeId)
            );

            let added = 0;
            for (const moc of mocs) {
              if (!existingThemes.has(moc.themeId)) {
                queue.mocs.push({
                  ...moc,
                  _themeId: moc.themeId,
                  status: moc.tier === "needs_approval" ? "pending_approval" : "approved",
                  createdAt: new Date().toISOString(),
                  source: "theme-spec-connector",
                });
                existingThemes.add(moc.themeId);
                added++;
              }
            }

            if (added > 0) {
              const tmpPath = queuePath + `.tmp.${process.pid}`;
              fs.writeFileSync(tmpPath, JSON.stringify(queue, null, 2) + "\n");
              fs.renameSync(tmpPath, queuePath);
              this.log(`theme-spec: added ${added} new MOCs to queue`);
              this.emitSignal("mocs-ready", { source: "intelligence-theme-spec", added });
            }
          } catch (err) {
            this.log(`theme-spec: queue write error — ${err.message}`);
          }
        }
      } else {
        this.log("theme-spec: no spec gaps found");
      }

      phases.push({ name: "theme-spec-connector", ok: true });
    } catch (err) {
      this.log(`theme-spec error: ${err.message}`);
      phases.push({ name: "theme-spec-connector", ok: false });
    }
  }

  /**
   * Phase 5: Auto-tune daemon-config.json based on 24h cycle history.
   * Rules have min/max guards to prevent runaway tuning.
   */
  _autoTuneConfig(phases) {
    const configPath = path.join(ROOT, "daemon-config.json");
    const tuningLogPath = path.join(STATE_DIR, "config-tuning-log.json");

    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      this.log("auto-tune: could not read daemon-config.json");
      phases.push({ name: "auto-tune", ok: false });
      return;
    }

    const autoTune = config.autoTune ?? {};
    if (autoTune.enabled === false) {
      this.log("auto-tune: disabled in config");
      phases.push({ name: "auto-tune", ok: true });
      return;
    }

    const minInterval = autoTune.minInterval ?? 15;
    const maxInterval = autoTune.maxInterval ?? 480;
    const maxBudget = autoTune.maxBudgetPerHour ?? 100;
    const changes = [];

    // Read cycle history for last 24h (tail-read to avoid loading huge file)
    const historyPath = path.join(STATE_DIR, "claw-history.jsonl");
    let history = [];
    try {
      if (fs.existsSync(historyPath)) {
        const { readFileTail } = require("../claw");
        const content = readFileTail(historyPath, 256 * 1024);
        const lines = content.split("\n").filter(Boolean);
        history = lines
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .filter((e) => Date.now() - new Date(e.at).getTime() < 86400000);
      }
    } catch { /* ignore */ }

    if (history.length < 3) {
      this.log("auto-tune: insufficient history (<3 cycles in 24h), skipping");
      phases.push({ name: "auto-tune", ok: true });
      return;
    }

    // Rule 1: test-runner interval adjustment based on pass rate
    const testRunnerCycles = history.filter((e) => e.claw === "test-runner");
    if (testRunnerCycles.length >= 3) {
      const passRate = testRunnerCycles.filter((e) => e.ok).length / testRunnerCycles.length;
      const currentInterval = config.claws?.["test-runner"]?.intervalMinutes ?? 30;

      if (passRate > 0.95 && testRunnerCycles.length >= 6) {
        const newInterval = Math.min(currentInterval + 10, maxInterval);
        if (newInterval !== currentInterval) {
          if (!config.claws["test-runner"]) { config.claws["test-runner"] = {}; }
          config.claws["test-runner"].intervalMinutes = newInterval;
          changes.push(`test-runner interval: ${currentInterval} -> ${newInterval}min (pass rate ${Math.round(passRate * 100)}%)`);
        }
      } else if (passRate < 0.80) {
        const newInterval = Math.max(currentInterval - 10, minInterval);
        if (newInterval !== currentInterval) {
          if (!config.claws["test-runner"]) { config.claws["test-runner"] = {}; }
          config.claws["test-runner"].intervalMinutes = newInterval;
          changes.push(`test-runner interval: ${currentInterval} -> ${newInterval}min (pass rate ${Math.round(passRate * 100)}%)`);
        }
      }
    }

    // Rule 2: fix-engine budget adjustment
    const fixCycles = history.filter((e) => e.claw === "fix-engine");
    if (fixCycles.length >= 3) {
      const budgetExhausted = fixCycles.filter((e) => e.summary?.includes("budget")).length;
      if (budgetExhausted >= 3) {
        const currentBudget = config.claws?.["fix-engine"]?.budgetPerHour ?? 25;
        const newBudget = Math.min(currentBudget + 5, maxBudget);
        if (newBudget !== currentBudget) {
          if (!config.claws["fix-engine"]) { config.claws["fix-engine"] = {}; }
          config.claws["fix-engine"].budgetPerHour = newBudget;
          changes.push(`fix-engine budgetPerHour: $${currentBudget} -> $${newBudget} (exhausted ${budgetExhausted}x)`);
        }
      }
    }

    // Rule 3: intelligence interval adjustment (near-zero findings = stretch)
    const findingPipeCycles = history.filter((e) => e.claw === "finding-pipeline");
    if (findingPipeCycles.length >= 3) {
      const allLowActivity = findingPipeCycles.every((e) => e.summary?.includes("0 findings") || e.summary?.includes("0 new"));
      if (allLowActivity) {
        const currentInterval = config.claws?.intelligence?.intervalMinutes ?? 120;
        const newInterval = Math.min(currentInterval + 60, maxInterval);
        if (newInterval !== currentInterval) {
          if (!config.claws.intelligence) { config.claws.intelligence = {}; }
          config.claws.intelligence.intervalMinutes = newInterval;
          changes.push(`intelligence interval: ${currentInterval} -> ${newInterval}min (low activity)`);
        }
      }
    }

    // Apply changes
    if (changes.length > 0) {
      try {
        const tmpPath = configPath + `.tmp.${process.pid}`;
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
        fs.renameSync(tmpPath, configPath);
        this.log(`auto-tune: ${changes.length} changes applied`);
        for (const change of changes) {
          this.log(`  ${change}`);
        }
      } catch (err) {
        this.log(`auto-tune: failed to write config — ${err.message}`);
        phases.push({ name: "auto-tune", ok: false });
        return;
      }

      // Log changes to tuning log (consumed by pipeline-integrity-check for runaway detection)
      try {
        let tuningLog = [];
        if (fs.existsSync(tuningLogPath)) {
          tuningLog = JSON.parse(fs.readFileSync(tuningLogPath, "utf-8"));
        }
        tuningLog.push({
          at: new Date().toISOString(),
          changes,
          historySize: history.length,
        });
        if (tuningLog.length > 100) {
          tuningLog = tuningLog.slice(-100);
        }
        fs.writeFileSync(tuningLogPath, JSON.stringify(tuningLog, null, 2) + "\n");
      } catch { /* non-fatal */ }

      // Config changed — trigger diagnostics to validate integrity
      this.emitSignal("diagnostics-requested", { reason: "config-changed", changes: changes.length });
    } else {
      this.log("auto-tune: no changes needed");
    }

    phases.push({ name: "auto-tune", ok: true });
  }

  _runPhase(phases, name, cmd, timeoutMs = 120000) {
    const result = this.exec(cmd, { label: name, timeoutMs });
    phases.push({ name, ok: result.ok });
    return result;
  }

  async _runParallel(phases, entries) {
    const promises = entries.map((e) =>
      this.execAsync(e.cmd, { label: e.name, timeoutMs: e.timeoutMs ?? 120000 })
    );
    const results = await Promise.allSettled(promises);
    for (let i = 0; i < entries.length; i++) {
      const ok = results[i].status === "fulfilled" && results[i].value?.ok;
      phases.push({ name: entries[i].name, ok });
    }
  }

  _getFindingsCount() {
    try {
      const fp = path.join(STATE_DIR, "findings", "findings.json");
      if (!fs.existsSync(fp)) { return 0; }
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      const findings = data.findings ?? data;
      return Array.isArray(findings) ? findings.length : 0;
    } catch {
      return 0;
    }
  }
}

// Direct execution
if (require.main === module) {
  const claw = new IntelligenceClaw();
  claw.start().catch((err) => {
    console.error(`intelligence fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { IntelligenceClaw };
