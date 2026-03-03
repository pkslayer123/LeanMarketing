#!/usr/bin/env node

/**
 * Claw 3: Fix Engine
 *
 * Owns: MOC auto-fix via Claude Code CLI, commit tracking, verification.
 * Schedule: Triggered by mocs-ready signal OR periodic (every 15min if approved MOCs exist).
 * Reads: moc-queue.json, auto-fix-log.json
 * Writes: Code commits, auto-fix-log.json, moc-queue.json (status updates)
 * Emits: fixes-applied signal
 * Budget: Respects AUTOFIX_BUDGET per cycle. Pauses when exhausted.
 *
 * Genericized from ChangePilot's fix-engine claw for use in any persona-engine project.
 */

const { Claw, STATE_DIR, remoteSignalBus } = require("../claw");
const fs = require("fs");
const path = require("path");

// Stack adapter — framework-aware path resolution
let StackAdapter;
try { ({ StackAdapter } = require("../lib/stack-adapter")); } catch { /* optional */ }

// Optional lib imports — gracefully degrade if not available
let findMatchingPattern, applyPattern, sharePattern, DistributedLock;
try { ({ findMatchingPattern, applyPattern, sharePattern } = require("../lib/pattern-matcher")); } catch { /* optional */ }
try { ({ DistributedLock } = require("../distributed-lock")); } catch {
  // Provide a no-op distributed lock for standalone mode
  DistributedLock = {
    claimMoc: async () => true,
    releaseMoc: async () => {},
  };
}

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

class FixEngineClaw extends Claw {
  constructor() {
    super("fix-engine");
    // No hardcoded fix cap — moc-auto-fix.js has its own budgeting,
    // and claw-level budgetPerCycle + budgetPerHour throttle spend.
    // maxFixesPerCycle is optional config for explicit override.
    this.maxFixes = this.clawConfig.maxFixesPerCycle ?? null;
    // Stack adapter for framework-aware git staging
    this.stackAdapter = StackAdapter ? new StackAdapter(ROOT) : null;
  }

  shouldRun() {
    // Check parent signals/timers first
    const base = super.shouldRun();
    if (base.run) { return base; }

    // Also run if there are approved MOCs waiting for fixes
    const queue = this.readState("moc-queue.json");
    if (queue?.mocs) {
      const fixable = queue.mocs.filter((m) =>
        ["approved", "pending_fix"].includes(m.status)
      );
      if (fixable.length > 0) {
        return { run: true, reason: `${fixable.length} MOCs awaiting fix` };
      }

      // Pick up deferred MOCs from other machines (if we have budget)
      if (remoteSignalBus.isNetworkMode && !this.isHourlyBudgetExhausted()) {
        const deferred = queue.mocs.filter((m) => m.status === "deferred_to_network");
        if (deferred.length > 0) {
          return { run: true, reason: `${deferred.length} network-deferred MOCs` };
        }
      }
    }

    return { run: false, reason: "no work" };
  }

  async run() {
    let applied = 0;
    let failed = 0;

    // Phase 0: Post-fix verification — check if committed fixes resolved findings
    this._writeStatusPhase("verify-fix-impact");
    const verifyResult = this.exec("node scripts/e2e/verify-fix-impact.js --json", {
      label: "verify-fix-impact",
      timeoutMs: 30000,
    });
    if (verifyResult.ok) {
      try {
        const vr = JSON.parse(verifyResult.stdout);
        if (vr.verified > 0 || vr.failed > 0) {
          this.log(`verify-fix-impact: ${vr.verified} verified, ${vr.failed} failed, ${vr.pending} pending`);
        }
      } catch { /* ignore parse error */ }
    }

    // Phase 0.5: Zero-shot pattern matching — apply known fixes without LLM
    this._writeStatusPhase("pattern-matching");
    const patternResults = this._applyPatternFixes();
    if (patternResults.applied > 0) {
      this.log(`pattern-matcher: ${patternResults.applied} fixes applied without LLM`);
      applied += patternResults.applied;
    }

    // Phase 1: Pre-iteration fixes (learned patterns)
    // Uses execAsync so the claw can respond to shutdown signals during the run
    // (execSync blocks the event loop and prevents IPC processing)
    this._writeStatusPhase("pre-iteration-fix");
    await this.execAsync("node scripts/e2e/pre-iteration-fix.js", {
      label: "pre-iteration-fix",
      timeoutMs: 120000,
    });

    // Phase 2: Run auto-fix for approved MOCs
    // Check hourly budget before starting expensive fixes
    if (this.isHourlyBudgetExhausted()) {
      this.log("hourly budget exhausted — deferring to network or skipping");

      // In network mode, defer unfixed MOCs to other machines
      if (remoteSignalBus.isNetworkMode) {
        await this._deferMocsToNetwork("hourly_budget");
        remoteSignalBus.reportTokenExhaustion("claude", new Date(Date.now() + 3600000).toISOString()).catch(() => {});
      }

      const budgetExhaustedPath = path.join(STATE_DIR, "budget-exhausted.json");
      fs.writeFileSync(
        budgetExhaustedPath,
        JSON.stringify(
          { at: new Date().toISOString(), reason: "hourly_budget" },
          null,
          2
        ) + "\n",
        "utf-8"
      );
      this.emitSignal("fixes-applied", { applied: 0, failed: 0, skipped: "hourly_budget" });
      return { ok: true, summary: "skipped — hourly budget exhausted, deferred to network" };
    }

    // Phase 1.5: Claim MOCs before fixing (distributed-safe for multi-machine)
    this._writeStatusPhase("claiming-mocs");
    const claimedMocIds = await this._claimNextMocs();

    this._writeStatusPhase("moc-auto-fix");
    const maxArg = this.maxFixes ? ` --max ${this.maxFixes}` : "";
    const mocFilter = claimedMocIds.length > 0 ? ` --moc-ids ${claimedMocIds.join(",")}` : "";
    // Use execAsync so heartbeat loop keeps ticking during long Claude CLI runs
    const fixResult = await this.execAsync(
      `node scripts/e2e/moc-auto-fix.js${maxArg}${mocFilter} --commit --json`,
      {
        label: "moc-auto-fix",
        timeoutMs: 600000,
      }
    );

    if (fixResult.ok) {
      try {
        const output = JSON.parse(fixResult.stdout);
        applied = output.fixApplied ?? output.applied ?? 0;
        failed = output.fixFailed ?? output.failed ?? 0;
      } catch {
        // Parse from log
        const log = this.readState("auto-fix-log.json");
        applied = log?.fixApplied ?? 0;
        failed = log?.fixFailed ?? 0;
      }
    }

    // Phase 3: Commit tracking — verify implemented MOCs via git history
    this._writeStatusPhase("commit-tracking");
    this.exec("node scripts/e2e/moc-commit-tracker.js", {
      label: "moc-commit-tracker",
      timeoutMs: 60000,
    });

    // Phase 4: Update docs from completed MOCs
    this._writeStatusPhase("docs-update");
    this.exec("node scripts/e2e/update-docs-from-mocs.js", {
      label: "update-docs-from-mocs",
      timeoutMs: 60000,
    });

    // Phase 5: Git commit state changes and push if code fixes were applied
    this._commitState(applied > 0);

    // Log token spend from the fix cycle
    try {
      const { getSpendSummary } = require("../lib/token-logger");
      const spend = getSpendSummary(0.5); // Last 30 minutes
      const fixSpend = (spend.byComponent["moc-auto-fix"] || 0) +
        (spend.byComponent["moc-auto-fix-verify"] || 0) +
        (spend.byComponent["claude-cli"] || 0);
      if (fixSpend > 0) {
        this.addBudgetSpend(fixSpend);
        this.log(`token spend this cycle: $${fixSpend.toFixed(4)}`);
      }
    } catch { /* non-fatal */ }

    // Release claimed MOC locks
    for (const mocId of claimedMocIds) {
      DistributedLock.releaseMoc(mocId).catch(() => {});
    }

    // Report token exhaustion to network if budget hit
    if (this.isBudgetExhausted() && remoteSignalBus.isNetworkMode) {
      remoteSignalBus.reportTokenExhaustion("claude", new Date(Date.now() + 3600000).toISOString()).catch(() => {});
    }

    // Emit signal for intelligence claw
    this.emitSignal("fixes-applied", { applied, failed });

    // Update convergence state (pass explicit count — includes pattern + moc-auto-fix)
    this.exec(`node scripts/e2e/convergence-tracker.js --fixes-applied ${applied}`, {
      label: "convergence-tracker",
      timeoutMs: 10000,
    });

    return {
      ok: true,
      summary: `${applied} fixes applied, ${failed} failed`,
    };
  }

  /**
   * Claim MOCs for this machine via distributed lock.
   * In single-machine mode, claims all fixable MOCs.
   * In network mode, only claims MOCs not held by another machine.
   */
  async _claimNextMocs() {
    const queue = this.readState("moc-queue.json");
    if (!queue?.mocs) { return []; }

    const isNetworkMode = remoteSignalBus.isNetworkMode;
    const fixable = queue.mocs.filter((m) => {
      if (["approved", "pending_fix"].includes(m.status)) { return true; }
      // Pick up network-deferred MOCs if we have budget
      if (isNetworkMode && m.status === "deferred_to_network" && !this.isHourlyBudgetExhausted()) {
        m.status = "pending_fix";
        return true;
      }
      return false;
    });

    const claimed = [];
    const limit = this.maxFixes ?? 10;

    for (const moc of fixable) {
      if (claimed.length >= limit) { break; }

      const acquired = await DistributedLock.claimMoc(moc.id, "fix-engine", 30);
      if (acquired) {
        claimed.push(moc.id);
      } else {
        this.log(`MOC ${moc.id} claimed by another machine — skipping`);
      }
    }

    if (claimed.length > 0) {
      this.log(`claimed ${claimed.length} MOCs for fixing`);
    }
    return claimed;
  }

  /**
   * Defer unfixed MOCs to the network when this machine's budget is exhausted.
   * Marks MOCs as deferred_to_network and signals other machines.
   */
  async _deferMocsToNetwork(reason) {
    const queue = this.readState("moc-queue.json");
    if (!queue?.mocs) { return; }

    let deferred = 0;
    for (const moc of queue.mocs) {
      if (["approved", "pending_fix"].includes(moc.status)) {
        moc.status = "deferred_to_network";
        moc._deferredAt = new Date().toISOString();
        moc._deferReason = reason;
        deferred++;
      }
    }

    if (deferred > 0) {
      this.writeState("moc-queue.json", queue);
      this.log(`deferred ${deferred} MOCs to network (${reason})`);
      remoteSignalBus.emitSignal("fix-needed", { deferred_count: deferred, reason },
        (name, data) => {
          this._withSignalsLock((signals) => {
            signals.signals[name] = { at: new Date().toISOString(), emittedBy: this.name, ...data };
          });
        }
      ).catch(() => {});
    }
  }

  /**
   * Apply zero-shot fixes from pattern matching.
   * For findings with _patternMatch and hasAutoFix, apply the fix directly.
   * No LLM call needed — instant fix from learned patterns.
   */
  _applyPatternFixes() {
    if (!findMatchingPattern || !applyPattern) {
      return { applied: 0, skipped: 0 };
    }

    let applied = 0;
    let skipped = 0;

    try {
      const findingsPath = path.join(STATE_DIR, "findings", "findings.json");
      if (!fs.existsSync(findingsPath)) { return { applied: 0, skipped: 0 }; }

      const data = JSON.parse(fs.readFileSync(findingsPath, "utf-8"));
      const findings = data.findings ?? data;
      if (!Array.isArray(findings)) { return { applied: 0, skipped: 0 }; }

      for (const finding of findings) {
        if (!finding._patternMatch?.hasAutoFix) { continue; }
        if (finding.status === "resolved") { continue; }

        const match = findMatchingPattern(finding);
        if (!match || !match.pattern.autoFix) {
          skipped++;
          continue;
        }

        const result = applyPattern(match);
        if (result.applied) {
          applied++;
          finding.status = "resolved";
          finding._resolvedBy = "pattern-matcher";
          finding._resolvedAt = new Date().toISOString();

          // Share successful patterns cross-project
          if (sharePattern && match.source === "local" && match.pattern.effectiveness?.timesApplied >= 3) {
            try { sharePattern(match.pattern); } catch {}
          }
        } else {
          skipped++;
        }
      }

      // Write back if we resolved any
      if (applied > 0) {
        const tmpPath = findingsPath + `.tmp.${process.pid}`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
        fs.renameSync(tmpPath, findingsPath);
      }
    } catch (err) {
      this.log(`pattern-matcher error: ${err.message}`);
    }

    return { applied, skipped };
  }

  _getSourceDirectories() {
    if (this.stackAdapter) {
      const dirs = new Set([
        this.stackAdapter.stack.routeDir,
        this.stackAdapter.stack.componentDir,
        this.stackAdapter.stack.libDir,
      ]);
      for (const d of ["supabase/", "prisma/", "drizzle/"]) {
        if (fs.existsSync(path.join(ROOT, d))) {
          dirs.add(d);
        }
      }
      return [...dirs].map((d) => d.endsWith("/") ? d : `${d}/`);
    }
    // Fallback: detect from filesystem
    const candidates = ["app/", "src/", "components/", "lib/", "supabase/", "pages/"];
    return candidates.filter((d) => fs.existsSync(path.join(ROOT, d)));
  }

  _writeStatusPhase(phase) {
    this._withSignalsLock((signals) => {
      if (signals.claws[this.name]) {
        signals.claws[this.name].phase = phase;
      }
    });
  }

  _commitState(pushCodeChanges = false) {
    if (!this.acquireGitLock()) { return; }
    try {
      // Stage state files + any framework-specific source dirs if code was changed
      const stagePaths = ["e2e/state/", "e2e/reports/", "docs/BUILD-SPEC.md"];
      if (pushCodeChanges) {
        // Add framework-aware source directories
        stagePaths.push(...this._getSourceDirectories());
      }
      const addResult = this.exec(
        `git add ${stagePaths.join(" ")} 2>/dev/null || true`,
        { label: "git-add-state" }
      );

      if (addResult.ok) {
        this.exec(
          `git diff --cached --quiet || git commit -m "chore: E2E state sync — claw fix-engine cycle ${this.currentCycle}"`,
          { label: "git-commit-state" }
        );
      }

      // Only push when code fixes were applied — triggers deploy
      // so the next test run verifies the fix on production.
      // State-only commits accumulate locally until the next push.
      if (pushCodeChanges) {
        this.log("code fixes applied — pushing to deploy");
        this.exec("git push --no-verify 2>/dev/null || true", { label: "git-push-fixes" });
      }
    } finally {
      this.releaseGitLock();
    }
  }
}

// Direct execution
if (require.main === module) {
  const claw = new FixEngineClaw();
  claw.start().catch((err) => {
    console.error(`fix-engine fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { FixEngineClaw };
