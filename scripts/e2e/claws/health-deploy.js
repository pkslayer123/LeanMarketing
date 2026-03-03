#!/usr/bin/env node

/**
 * Claw 5: Health & Deploy
 *
 * Owns: Health checks, spec compliance, visual spec, iteration reports, deploy verification.
 * Schedule: Periodic (every 4h) + triggered by deploy-detected signal.
 * Reads: All state files (read-only sweep)
 * Writes: iteration-health.json, reports, spec compliance
 * Maps to: Orchestrator Phase 5 (report) + after-deploy hook
 *
 * Genericized from ChangePilot's health-deploy claw for use in any persona-engine project.
 * Vercel-specific checks are optional (only run when VERCEL_TOKEN is set).
 * ChangePilot heartbeat is optional (only run when CHANGEPILOT_SERVICE_KEY is set).
 */

const path = require("path");
const fs = require("fs");
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

class HealthDeployClaw extends Claw {
  constructor() {
    super("health-deploy");
  }

  async run() {
    const phases = [];
    const isDeployTriggered = this._isDeployTriggered();

    // Phase 1: Health checks (informational — non-critical failures don't gate the claw)
    const health = this.exec("node scripts/e2e/health.js", {
      label: "health-check",
      timeoutMs: 60000,
    });
    if (!health.ok) {
      this.log("health.js reported failures (see output for details — non-blocking)");
    }
    phases.push({ name: "health", ok: true });

    // Phase 1.1: Fetch production telemetry (optional — project may not have telemetry)
    try {
      this.exec("node scripts/e2e/fetch-production-telemetry.js", {
        label: "production-telemetry",
        timeoutMs: 60000,
      });
    } catch { /* optional — telemetry script may not exist */ }
    phases.push({ name: "production-telemetry", ok: true });

    // Phase 1.5: Pipeline integrity check (validates correctness, consumed by diagnostics heartbeat)
    const integrity = this.exec("node scripts/e2e/pipeline-integrity-check.js --json", {
      label: "pipeline-integrity",
      timeoutMs: 30000,
    });
    if (integrity.ok) {
      try {
        const parsed = JSON.parse(integrity.stdout);
        if (parsed.failedCount > 0) {
          this.log(`pipeline integrity: ${parsed.failedCount} failures`);
          this.emitSignal("diagnostics-requested", { reason: "integrity-failure", failures: parsed.failedCount });
        }
      } catch { /* parse error — results still written to file */ }
    }
    phases.push({ name: "pipeline-integrity", ok: integrity.ok });

    // Phase 2: Visual spec (on deploy or if stale)
    if (isDeployTriggered || this._isVisualSpecStale()) {
      const visual = await this.execAsync("node scripts/e2e/visual-spec-generator.js --max-pages 20", {
        label: "visual-spec",
        timeoutMs: 180000,
      });
      phases.push({ name: "visual-spec", ok: visual.ok });
    }

    // Phase 3: Spec compliance
    const spec = this.exec("node scripts/e2e/spec-compliance.js", {
      label: "spec-compliance",
      timeoutMs: 120000,
    });
    phases.push({ name: "spec-compliance", ok: spec.ok });

    // Phase 3.5: BUILD-SPEC compliance scoring (route coverage + test pass rate + oracle + errors)
    const compScorer = this.exec("node scripts/e2e/spec-compliance-scorer.js", {
      label: "compliance-scorer",
      timeoutMs: 30000,
    });
    phases.push({ name: "compliance-scorer", ok: compScorer.ok });

    // Check for phase transition and log it
    try {
      const compReport = this.readState("spec-compliance-report.json");
      if (compReport?.phaseChanged) {
        this.log(`PHASE TRANSITION: ${compReport.previousPhase} -> ${compReport.phase} (score: ${compReport.score})`);
        this.emitSignal("phase-transition", {
          from: compReport.previousPhase,
          to: compReport.phase,
          score: compReport.score,
        });
      }
    } catch { /* non-fatal */ }

    // Phase 4: Build spec to page context
    this.exec("node scripts/e2e/build-spec-to-page-context.js", {
      label: "page-context",
      timeoutMs: 60000,
    });

    // Phase 5: Improvement report
    this.exec("node scripts/e2e/improvement-report.js", {
      label: "improvement-report",
      timeoutMs: 60000,
    });

    // Phase 6: Iteration report
    const report = this.exec(
      `node scripts/e2e/iteration-report.js --iteration ${this.currentCycle}`,
      { label: "iteration-report", timeoutMs: 60000 }
    );
    phases.push({ name: "report", ok: report.ok });

    // Phase 7: Audit docs
    this.exec("node scripts/e2e/audit-docs.js", {
      label: "audit-docs",
      timeoutMs: 60000,
    });

    // Phase 8: Verify iteration health gates
    this.exec(
      `node scripts/e2e/verify-iteration.js --phase after-iteration --iteration ${this.currentCycle}`,
      { label: "verify-iteration", timeoutMs: 60000 }
    );

    // Phase 9: Push heartbeat to ChangePilot (optional — only when service key is configured)
    await this._pushHeartbeat(phases);

    // Phase 10: Git commit reports
    this._commitReports();

    // Log token spend from health/deploy scripts
    try {
      const { getSpendSummary } = require("../lib/token-logger");
      const spend = getSpendSummary(1); // Last hour
      const healthComponents = ["spec-verifier", "spec-decomposer", "improvement-report", "sage-summary"];
      let totalSpend = 0;
      for (const comp of healthComponents) {
        totalSpend += spend.byComponent[comp] || 0;
      }
      if (totalSpend > 0) {
        this.addBudgetSpend(totalSpend);
        this.log(`token spend this cycle: $${totalSpend.toFixed(4)}`);
      }
    } catch { /* non-fatal */ }

    const failedCount = phases.filter((p) => !p.ok).length;
    return {
      ok: failedCount === 0,
      summary: `${phases.length} checks, ${failedCount} failed${isDeployTriggered ? " (deploy)" : ""}`,
    };
  }

  /**
   * Push daemon status heartbeat to ChangePilot API for cross-project visibility.
   * Only runs when CHANGEPILOT_SERVICE_KEY is configured (network mode).
   */
  async _pushHeartbeat(phases) {
    // Try to load remote-signal-bus for network mode detection
    let isNetworkMode = false;
    let machineId = "unknown";
    try {
      const rsb = require("../remote-signal-bus");
      isNetworkMode = rsb.instance?.isNetworkMode ?? false;
      machineId = rsb.MACHINE_ID ?? "unknown";
    } catch {
      // remote-signal-bus not available — check env directly
      isNetworkMode = !!process.env.CHANGEPILOT_SERVICE_KEY;
      const os = require("os");
      machineId = `${os.hostname()}-${os.userInfo().username}`;
    }

    if (!isNetworkMode) { return; }

    try {
      const signals = this._loadSignals();
      const claws = signals.claws ?? {};

      // Build claw summary for metadata
      const clawSummary = {};
      for (const [name, state] of Object.entries(claws)) {
        clawSummary[name] = {
          status: state.status ?? "unknown",
          cycle: state.cycle ?? 0,
          lastRun: state.lastRun ?? null,
        };
      }

      // Read pass rate from loop-performance
      let lastTestPassRate = null;
      try {
        const { readFileTail } = require("../claw");
        const perfPath = path.join(STATE_DIR, "loop-performance.jsonl");
        const content = readFileTail(perfPath, 64 * 1024);
        const lines = content.split("\n").filter(Boolean);
        if (lines.length > 0) {
          const last = JSON.parse(lines[lines.length - 1]);
          lastTestPassRate = last.passRate ?? last.pass_rate ?? null;
        }
      } catch { /* non-fatal */ }

      // Read findings count
      let findingsOpen = 0;
      let findingsResolved = 0;
      try {
        const findingsData = this.readState("findings/findings.json");
        const findings = Array.isArray(findingsData?.findings) ? findingsData.findings : [];
        findingsOpen = findings.filter((f) => f.status === "open" || !f.status).length;
        findingsResolved = findings.filter((f) => f.status === "resolved").length;
      } catch { /* non-fatal */ }

      // Read MOC queue
      let mocsApproved = 0;
      let mocsImplemented = 0;
      try {
        const queue = this.readState("moc-queue.json");
        const mocs = Array.isArray(queue?.mocs) ? queue.mocs : [];
        mocsApproved = mocs.filter((m) => m.status === "approved" || m.status === "pending_fix").length;
        mocsImplemented = mocs.filter((m) => m.status === "implemented" || m.status === "completed").length;
      } catch { /* non-fatal */ }

      // Read convergence state
      let convergenceState = "unknown";
      try {
        const conv = this.readState("daemon-convergence.json");
        convergenceState = conv?.state ?? "unknown";
      } catch { /* non-fatal */ }

      // Read spec compliance score
      let specScore = 0;
      try {
        const spec = this.readState("spec-compliance-report.json");
        specScore = spec?.score ?? 0;
      } catch { /* non-fatal */ }

      // Read health check results from diagnostics
      const healthChecks = {};
      try {
        const healthSummary = this.readState("daemon-health-summary.json");
        if (healthSummary?.healthChecks) {
          Object.assign(healthChecks, healthSummary.healthChecks);
        }
      } catch { /* non-fatal */ }

      const CHANGEPILOT_API_URL = process.env.CHANGEPILOT_API_URL ?? "https://moc-ai.vercel.app";
      const CHANGEPILOT_SERVICE_KEY = process.env.CHANGEPILOT_SERVICE_KEY;

      const payload = {
        machine_id: machineId,
        status: "active",
        daemon_version: "1.0.0",
        convergence_state: convergenceState,
        spec_compliance_score: specScore,
        metadata: {
          claws: clawSummary,
          lastTestPassRate,
          findings: { open: findingsOpen, resolved: findingsResolved },
          mocs: { approved: mocsApproved, implemented: mocsImplemented },
          healthChecks,
          phasesThisCycle: phases.length,
        },
      };

      const res = await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/heartbeat`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        this.log("heartbeat pushed to ChangePilot");
      } else {
        this.log(`heartbeat push failed: ${res.status}`);
      }
    } catch (err) {
      this.log(`heartbeat push error: ${err.message}`);
    }
  }

  _isDeployTriggered() {
    const signals = this._loadSignals();
    const deploy = signals.signals?.["deploy-detected"];
    if (!deploy?.at) { return false; }
    // Consider deploy signal "fresh" if within last 30 minutes
    const age = Date.now() - new Date(deploy.at).getTime();
    return age < 30 * 60 * 1000;
  }

  _isVisualSpecStale() {
    const state = this.readState("visual-spec.json");
    if (!state?.generatedAt) { return true; }
    const age = Date.now() - new Date(state.generatedAt).getTime();
    return age > 20 * 60 * 60 * 1000; // 20 hours
  }

  _commitReports() {
    if (!this.acquireGitLock()) { return; }
    try {
      this.exec(
        'git add e2e/state/ e2e/reports/ docs/ 2>/dev/null || true',
        { label: "git-add-reports" }
      );
      this.exec(
        `git diff --cached --quiet || git commit -m "chore: E2E health report — claw cycle ${this.currentCycle}"`,
        { label: "git-commit-reports" }
      );
      // No push — state file commits accumulate locally and get pushed
      // with actual code changes. Pushing here triggers a deploy build
      // every cycle which wastes compute.
    } finally {
      this.releaseGitLock();
    }
  }
}

// Direct execution
if (require.main === module) {
  const claw = new HealthDeployClaw();
  claw.start().catch((err) => {
    console.error(`health-deploy fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { HealthDeployClaw };
