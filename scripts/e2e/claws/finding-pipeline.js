#!/usr/bin/env node

/**
 * Claw 2: Finding Pipeline
 *
 * Owns: Classification, clustering, findings->MOCs, theme consolidation, synthesizer.
 * Schedule: Triggered by tests-complete signal OR periodic (every 30min if idle).
 * Reads: findings/findings.json, finding-clusters.json
 * Writes: moc-queue.json, finding-themes.json, finding-clusters.json
 * Emits: mocs-ready signal
 * Maps to: Orchestrator Phase 1 (classify)
 *
 * Genericized from ChangePilot's finding-pipeline claw for use in any persona-engine project.
 */

const { Claw, STATE_DIR } = require("../claw");
const fs = require("fs");
const path = require("path");

// Optional lib imports — gracefully degrade if not available
let batchClassify, findMatchingPattern;
try { ({ batchClassify } = require("../lib/rule-classifier")); } catch { /* optional */ }
try { ({ findMatchingPattern } = require("../lib/pattern-matcher")); } catch { /* optional */ }

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

class FindingPipelineClaw extends Claw {
  constructor() {
    super("finding-pipeline");
  }

  async run() {
    let newMocs = 0;
    const results = { ok: true, phases: [] };

    // --- Pre-Phase: Rule-based pre-classification (skip LLM for obvious patterns) ---
    const preClassified = this._preClassifyFindings();
    if (preClassified) {
      results.phases.push({ name: "pre-classify", ok: true });
      this.log(`pre-classify: ${preClassified.classified} rule-classified, ${preClassified.needsLlm} need LLM, ${preClassified.patternMatches} pattern matches`);
    }

    // --- Sequential Phase: Aggregate + Correlate + Triage ---

    // Step 1: Aggregate findings
    const agg = this.exec("node scripts/e2e/aggregate-findings.js", {
      label: "aggregate-findings",
      timeoutMs: 60000,
    });
    results.phases.push({ name: "aggregate", ok: agg.ok });

    // Step 2: Error correlation
    const corr = this.exec("node scripts/e2e/correlate-errors.js", {
      label: "correlate-errors",
      timeoutMs: 60000,
    });
    results.phases.push({ name: "correlate", ok: corr.ok });

    // Step 3: Auto-triage
    const triage = this.exec("node scripts/e2e/auto-triage.js", {
      label: "auto-triage",
      timeoutMs: 300000,
    });
    results.phases.push({ name: "auto-triage", ok: triage.ok });

    // --- Parallel Phase: Synthesizer + Themes + Findings-to-MOCs ---

    const parallelResults = await Promise.allSettled([
      this.execAsync("node scripts/e2e/claude-finding-synthesizer.js", {
        label: "finding-synthesizer",
        timeoutMs: 180000,
      }),
      this.execAsync("node scripts/e2e/consolidate-themes.js", {
        label: "consolidate-themes",
        timeoutMs: 180000,
      }),
      this.execAsync("node scripts/e2e/findings-to-mocs.js --iteration " + this.currentCycle, {
        label: "findings-to-mocs",
        timeoutMs: 300000,
      }),
    ]);

    results.phases.push({ name: "synthesizer", ok: parallelResults[0].status === "fulfilled" && parallelResults[0].value?.ok });
    results.phases.push({ name: "themes", ok: parallelResults[1].status === "fulfilled" && parallelResults[1].value?.ok });
    results.phases.push({ name: "findings-to-mocs", ok: parallelResults[2].status === "fulfilled" && parallelResults[2].value?.ok });

    // Step 3.5: Refresh oracle feedback patterns for next test run
    this.exec("node scripts/e2e/oracle-feedback-loader.js", {
      label: "oracle-feedback-loader",
      timeoutMs: 10000,
    });

    // Step 4: Triage findings (prioritize)
    this.exec("node scripts/e2e/triage-findings.js", {
      label: "triage-findings",
      timeoutMs: 60000,
    });

    // Step 5: Dedup queue
    this.exec("node scripts/e2e/dedup-queue.js --auto", {
      label: "dedup-queue",
      timeoutMs: 60000,
    });

    // Count new MOCs
    const queue = this.readState("moc-queue.json");
    if (queue?.mocs) {
      newMocs = queue.mocs.filter((m) => m.status === "approved" || m.status === "pending_approval").length;
    }

    // Log token spend from finding pipeline LLM calls
    try {
      const { getSpendSummary } = require("../lib/token-logger");
      const spend = getSpendSummary(0.5); // Last 30 minutes
      const pipelineComponents = ["finding-synthesizer", "consolidate-themes", "auto-triage", "findings-to-mocs"];
      let totalSpend = 0;
      for (const comp of pipelineComponents) {
        totalSpend += spend.byComponent[comp] || 0;
      }
      if (totalSpend > 0) {
        this.addBudgetSpend(totalSpend);
        this.log(`token spend this cycle: $${totalSpend.toFixed(4)}`);
      }
    } catch { /* non-fatal */ }

    // Emit signal for fix-engine
    this.emitSignal("mocs-ready", { newMocs });

    // When fix-engine disabled, emit fix prompt (moc-queue.json remains canonical)
    const fixEngineEnabled = this.config?.claws?.["fix-engine"]?.enabled === true;
    if (!fixEngineEnabled && newMocs > 0) {
      this.exec("node scripts/e2e/emit-cursor-fix-prompt.js", { label: "emit-cursor-fix-prompt", timeoutMs: 10000 });
    }

    // Update coverage-suspend for automatic test suspension when fix-engine off
    this._updateCoverageSuspend();

    // Update convergence state for test-runner behavior (extended interval when converged)
    this.exec("node scripts/e2e/convergence-tracker.js", {
      label: "convergence-tracker",
      timeoutMs: 10000,
    });

    const failedPhases = results.phases.filter((p) => !p.ok).map((p) => p.name);
    if (failedPhases.length > 0) {
      this.log(`failed phases: ${failedPhases.join(", ")}`);
    }

    // Synthesizer and themes use Claude (may be unavailable) — tolerate their failure.
    // Only gate on critical phases: aggregate, auto-triage, findings-to-mocs.
    const criticalPhases = ["aggregate", "auto-triage", "findings-to-mocs"];
    const criticalFailed = failedPhases.some((n) => criticalPhases.includes(n));

    return {
      ok: !criticalFailed,
      summary: `${results.phases.length} phases, ${failedPhases.length} failed, ${newMocs} MOCs queued`,
    };
  }

  /**
   * Update coverage-suspend state for automatic test suspension.
   * Reads findings-to-mocs-last.json (written by findings-to-mocs) to get submitted count.
   * When fix-engine is off and we've had N consecutive runs with 0 new MOCs,
   * test-runner can skip to save compute.
   */
  _updateCoverageSuspend() {
    try {
      const lastPath = path.join(STATE_DIR, "findings-to-mocs-last.json");
      let submitted = 0;
      if (fs.existsSync(lastPath)) {
        const raw = JSON.parse(fs.readFileSync(lastPath, "utf-8"));
        submitted = raw.submitted ?? 0;
      }

      const coveragePath = path.join(STATE_DIR, "coverage-suspend.json");
      let state = { consecutiveZeroActionable: 0, lastRunAt: null, updatedAt: new Date().toISOString() };
      if (fs.existsSync(coveragePath)) {
        try {
          const prev = JSON.parse(fs.readFileSync(coveragePath, "utf-8"));
          state = { ...state, ...prev };
        } catch {}
      }

      if (submitted === 0) {
        state.consecutiveZeroActionable = (state.consecutiveZeroActionable ?? 0) + 1;
      } else {
        state.consecutiveZeroActionable = 0;
      }
      state.lastRunAt = new Date().toISOString();
      state.updatedAt = new Date().toISOString();

      fs.writeFileSync(coveragePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    } catch (err) {
      this.log(`coverage-suspend update error: ${err.message}`);
    }
  }

  /**
   * Pre-classify findings using rule-based classifier and pattern matcher.
   * Adds _ruleSeverity, _ruleTheme, _patternMatch fields to findings
   * so downstream scripts can skip LLM calls for these items.
   */
  _preClassifyFindings() {
    if (!batchClassify) { return null; }

    try {
      const findingsPath = path.join(STATE_DIR, "findings", "findings.json");
      if (!fs.existsSync(findingsPath)) { return null; }

      const data = JSON.parse(fs.readFileSync(findingsPath, "utf-8"));
      const findings = data.findings ?? data;
      if (!Array.isArray(findings) || findings.length === 0) { return null; }

      // Only pre-classify unclassified findings
      const unclassified = findings.filter((f) => !f._ruleSeverity && f.status !== "resolved");
      if (unclassified.length === 0) { return null; }

      const { classified, needsLlm } = batchClassify(unclassified);

      // Pattern matching for instant fixes
      let patternMatches = 0;
      if (findMatchingPattern) {
        for (const finding of unclassified) {
          const match = findMatchingPattern(finding);
          if (match) {
            finding._patternMatch = {
              patternId: match.pattern.id,
              source: match.source,
              confidence: match.confidence,
              hasAutoFix: !!match.pattern.autoFix,
            };
            patternMatches++;
          }
        }
      }

      // Write back enriched findings
      const tmpPath = findingsPath + `.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
      fs.renameSync(tmpPath, findingsPath);

      return { classified: classified.length, needsLlm: needsLlm.length, patternMatches };
    } catch (err) {
      this.log(`pre-classify error: ${err.message}`);
      return null;
    }
  }
}

// Direct execution
if (require.main === module) {
  const claw = new FindingPipelineClaw();
  claw.start().catch((err) => {
    console.error(`finding-pipeline fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { FindingPipelineClaw };
