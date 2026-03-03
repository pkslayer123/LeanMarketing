#!/usr/bin/env node

/**
 * Claw 8: Diagnostics
 *
 * Self-healing diagnostics with 6 proactive health checks.
 *
 * Triggered by: claw-crashed, circuit-broken, diagnostics-requested, or periodic (6h default).
 *
 * Phases:
 *   Phase 0: Signal handling (claw-crashed, circuit-broken, diagnostics-requested)
 *   Phase 1: Health checks (pass rate collapse, signal flow, convergence, MOC stagnation,
 *            pool account health, finding pipeline liveness)
 *   Phase 2: Periodic self-test + pipeline integrity (every 12h)
 *   Phase 3: Health heartbeat (every 6h, includes check results)
 *
 * Genericized from ChangePilot's diagnostics claw for use in any persona-engine project.
 * ChangePilot-specific imports (notify, health-checks) are wrapped in try/catch.
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

// Optional lib imports — gracefully degrade if not available
let notify, writeToFile, runAllChecks;
try { ({ notify, writeToFile } = require("../lib/notify")); } catch {
  // Provide no-op stubs if notify module is not available
  notify = async () => {};
  writeToFile = () => {};
}
try { ({ runAllChecks } = require("../lib/health-checks")); } catch {
  // Provide no-op stub if health-checks module is not available
  runAllChecks = () => [];
}

const LOG_FILE = path.join(STATE_DIR, "daemon.log");
const HEALTH_SUMMARY_PATH = path.join(STATE_DIR, "daemon-health-summary.json");

class DiagnosticsClaw extends Claw {
  constructor() {
    super("diagnostics");
    this._lastSelfTest = 0;
    this._lastHeartbeat = 0;
    this._lastPoolCheck = 0;
    this._lastHealthCheckResults = [];
  }

  async run() {
    const actions = [];

    // -- Phase 0: Signal handling --
    const crashedSignal = this._getSignal("claw-crashed");
    const circuitSignal = this._getSignal("circuit-broken");
    const diagRequestedSignal = this._getSignal("diagnostics-requested");

    if (crashedSignal && this._isRecent(crashedSignal.at)) {
      const result = await this._diagnoseCrashedClaw(crashedSignal);
      actions.push(...result);
    }

    if (circuitSignal && this._isRecent(circuitSignal.at)) {
      actions.push(`circuit-broken: ${circuitSignal.claw ?? "unknown"} — ${circuitSignal.reason ?? "unknown reason"}`);
      writeToFile(`Circuit breaker tripped: ${circuitSignal.claw} — ${circuitSignal.reason}`, "warning");
    }

    if (diagRequestedSignal && this._isRecent(diagRequestedSignal.at)) {
      this.log(`diagnostics-requested: reason=${diagRequestedSignal.reason ?? "unspecified"}`);
      actions.push(`diagnostics-requested: ${diagRequestedSignal.reason ?? "unspecified"}`);
    }

    // -- Phase 1: Health checks --
    this.log("running health checks...");
    const diagConfig = this.clawConfig.diagnostics ?? this.clawConfig;
    const checkResults = runAllChecks(diagConfig);
    this._lastHealthCheckResults = checkResults;

    for (const check of checkResults) {
      if (check.ok) {
        this.log(`  OK ${check.name}: ${check.detail}`);
        continue;
      }

      this.log(`  FAIL ${check.name}: ${check.detail}`);
      actions.push(`health-check [${check.name}]: ${check.detail}`);

      // Execute remediation based on check action
      switch (check.action) {
        case "force-trigger-test-runner": {
          this.log("  -> force-triggering test-runner");
          this._forceTriggerClaw("test-runner");
          await notify(`CRITICAL: ${check.detail}`, "critical");
          break;
        }
        case "force-trigger-stalled": {
          const claws = check.stalledClaws ?? [];
          for (const clawName of claws) {
            this.log(`  -> force-triggering stalled claw: ${clawName}`);
            this._forceTriggerClaw(clawName);
          }
          break;
        }
        case "force-trigger-fix-engine": {
          this.log("  -> force-triggering fix-engine");
          this._forceTriggerClaw("fix-engine");
          break;
        }
        case "force-trigger-finding-pipeline": {
          this.log("  -> force-triggering finding-pipeline");
          this._forceTriggerClaw("finding-pipeline");
          break;
        }
        case "escalate-stale-mocs": {
          this._escalateStaleMocs(check.retryLimitMocIds ?? []);
          break;
        }
        case "verify-pool-accounts": {
          const poolCheckIntervalMs = (diagConfig.poolCheckIntervalHours ?? 12) * 3600000;
          if (Date.now() - this._lastPoolCheck > poolCheckIntervalMs) {
            await this._verifyPoolAccounts(check.accountEmails ?? []);
            this._lastPoolCheck = Date.now();
          }
          break;
        }
        case "log-stuck": {
          writeToFile(`Convergence stuck: ${check.detail}`, "warning");
          break;
        }
        default:
          break;
      }
    }

    const failedChecks = checkResults.filter((c) => !c.ok);
    if (failedChecks.length > 0) {
      this.log(`health checks: ${failedChecks.length}/${checkResults.length} failing`);
    } else {
      this.log(`health checks: all ${checkResults.length} passing`);
    }

    // -- Phase 2: Self-test + pipeline integrity (every 12h) --
    const selfTestIntervalMs = (this.clawConfig.selfTestIntervalHours ?? 12) * 3600000;
    if (Date.now() - this._lastSelfTest > selfTestIntervalMs) {
      this.log("running periodic self-test...");
      const result = this.exec("node scripts/e2e/self-test.js --json", { label: "self-test", timeoutMs: 180000 });
      this._lastSelfTest = Date.now();
      if (result.ok) {
        try {
          const parsed = JSON.parse(result.stdout);
          if (parsed.failed?.length > 0) {
            actions.push(`self-test: ${parsed.failed.length} failures — ${parsed.failed.join("; ")}`);
          }
          if (parsed.fixed?.length > 0) {
            actions.push(`self-test: auto-fixed ${parsed.fixed.length} issues`);
          }
        } catch { /* ignore parse error */ }
      } else {
        actions.push("self-test: failed to run");
      }

      // Pipeline integrity: validates correctness, not just liveness
      this.log("running pipeline integrity check...");
      const integrity = this.exec("node scripts/e2e/pipeline-integrity-check.js --json", { label: "integrity-check", timeoutMs: 60000 });
      if (integrity.ok) {
        try {
          const parsed = JSON.parse(integrity.stdout);
          if (parsed.failedCount > 0) {
            actions.push(`integrity: ${parsed.failedCount} failures — ${parsed.failed.join("; ")}`);
            writeToFile(`Pipeline integrity: ${parsed.failedCount} failures detected`, "warning");
            this._createRepairMocs(parsed.failed);
          }
          if (parsed.warningCount > 0) {
            actions.push(`integrity: ${parsed.warningCount} warnings`);
          }
        } catch { /* ignore parse error */ }
      } else {
        actions.push("integrity: check failed to run");
      }
    }

    // -- Phase 3: Health heartbeat (every 6h, now includes check results) --
    const heartbeatIntervalMs = (this.clawConfig.healthHeartbeatHours ?? 6) * 3600000;
    if (Date.now() - this._lastHeartbeat > heartbeatIntervalMs) {
      await this._sendHealthHeartbeat();
      this._lastHeartbeat = Date.now();
    }

    this.emitSignal("diagnostics-complete", {
      actions: actions.length,
      healthChecks: checkResults.length,
      healthChecksFailing: failedChecks.length,
    });

    return {
      ok: failedChecks.length === 0,
      summary: `${actions.length} actions, ${failedChecks.length}/${checkResults.length} checks failing`,
    };
  }

  /**
   * Force-trigger a claw by resetting its lastRun timestamp.
   */
  _forceTriggerClaw(clawName) {
    this._withSignalsLock((signals) => {
      if (signals.claws[clawName]) {
        signals.claws[clawName].lastRun = null;
        this.log(`  reset lastRun for ${clawName}`);
      }
    });
  }

  /**
   * Escalate MOCs that hit retry limit to needs_human status.
   */
  _escalateStaleMocs(mocIds) {
    if (mocIds.length === 0) { return; }
    try {
      const queuePath = path.join(STATE_DIR, "moc-queue.json");
      const queue = JSON.parse(fs.readFileSync(queuePath, "utf-8"));
      const mocs = Array.isArray(queue?.mocs) ? queue.mocs : [];
      let escalated = 0;
      for (const moc of mocs) {
        if (mocIds.includes(moc.id)) {
          moc.status = "needs_human";
          moc.escalatedAt = new Date().toISOString();
          moc.escalationReason = "retry limit + stale approval";
          escalated++;
        }
      }
      if (escalated > 0) {
        queue.mocs = mocs;
        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
        this.log(`  escalated ${escalated} stale MOCs to needs_human`);
      }
    } catch (err) {
      this.log(`  failed to escalate stale MOCs: ${err.message}`);
    }
  }

  /**
   * Verify pool dev accounts have correct role/flags.
   * Adapts to the project's auth system and profile table.
   * - Supabase: queries user_profiles or profiles table
   * - Other: delegates to project-specific verify-accounts script if present
   */
  async _verifyPoolAccounts(emails) {
    if (emails.length === 0) { return; }
    this.log(`  verifying ${emails.length} pool accounts...`);

    // Option 1: Project provides a custom account verification script
    const customScript = path.join(ROOT, "scripts", "e2e", "verify-accounts.js");
    if (fs.existsSync(customScript)) {
      const result = this.exec(
        `node "${customScript}" --emails ${emails.join(",")} --json`,
        { label: "pool-verify-custom", timeoutMs: 30000 }
      );
      if (result.ok) {
        try {
          const parsed = JSON.parse(result.stdout.trim());
          if (parsed.fixed?.length > 0) {
            this.log(`  auto-repaired pool accounts: ${parsed.fixed.join(", ")}`);
            await notify(`Pool accounts auto-repaired: ${parsed.fixed.join(", ")}`, "warning");
          } else {
            this.log("  all pool accounts healthy");
          }
        } catch { /* parse error */ }
      }
      return;
    }

    // Option 2: Supabase — auto-detect profile table
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      this.log("  pool account verification skipped — no Supabase credentials and no custom script");
      return;
    }

    // Try both table names (user_profiles for ChangePilot, profiles for most others)
    const profileTable = this.clawConfig.profileTable ?? "user_profiles";
    const roleField = this.clawConfig.roleField ?? "role";
    const expectedRole = this.clawConfig.poolExpectedRole ?? "developer";

    const result = this.exec(
      `node -e "const {createClient}=require('@supabase/supabase-js');` +
      `const c=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);` +
      `(async()=>{` +
      `let tbl='${profileTable}';` +
      `let{data,error}=await c.from(tbl).select('email,${roleField}').in('email',${JSON.stringify(emails)});` +
      `if(error&&error.message.includes('does not exist')){tbl='profiles';({data,error}=await c.from(tbl).select('email,${roleField}').in('email',${JSON.stringify(emails)}));}` +
      `if(error){console.log(JSON.stringify({error:error.message}));return;}` +
      `const bad=(data||[]).filter(r=>r['${roleField}']!=='${expectedRole}');` +
      `if(bad.length>0){` +
      `for(const b of bad){await c.from(tbl).update({['${roleField}']:'${expectedRole}'}).eq('email',b.email);}` +
      `console.log(JSON.stringify({fixed:bad.map(b=>b.email),table:tbl}));}` +
      `else{console.log(JSON.stringify({fixed:[],table:tbl}));}})()"`,
      { label: "pool-verify", timeoutMs: 30000 }
    );
    if (result.ok) {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed.error) {
          this.log(`  pool verify error: ${parsed.error}`);
        } else if (parsed.fixed?.length > 0) {
          this.log(`  auto-repaired pool accounts (${parsed.table}): ${parsed.fixed.join(", ")}`);
          await notify(`Pool accounts auto-repaired: ${parsed.fixed.join(", ")}`, "warning");
        } else {
          this.log(`  all pool accounts healthy (${parsed.table})`);
        }
      } catch { /* parse error */ }
    } else {
      this.log("  pool account verification failed");
    }
  }

  /**
   * Create pipeline_repair MOCs from integrity check failures.
   * These get processed by fix-engine with a restricted file allowlist.
   */
  _createRepairMocs(failures) {
    if (!Array.isArray(failures) || failures.length === 0) { return; }
    try {
      const queuePath = path.join(STATE_DIR, "moc-queue.json");
      const queue = fs.existsSync(queuePath)
        ? JSON.parse(fs.readFileSync(queuePath, "utf-8"))
        : { version: 2, mocs: [] };
      const mocs = Array.isArray(queue?.mocs) ? queue.mocs : [];

      // Dedup: skip failures that already have an open pipeline_repair MOC
      const existingRepairs = mocs
        .filter((m) => m.tier === "pipeline_repair" && !["archived", "implemented", "needs_human"].includes(m.status))
        .map((m) => m.title);

      let created = 0;
      for (const failure of failures.slice(0, 5)) {
        const title = `[PIPELINE-REPAIR] ${failure.slice(0, 120)}`;
        if (existingRepairs.some((t) => t === title)) {
          this.log(`  repair MOC already exists: ${title.slice(0, 80)}`);
          continue;
        }

        const id = `moc-repair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const now = new Date().toISOString();
        const repairMoc = {
          id,
          title,
          description: `**Tier:** pipeline_repair\n**Source:** pipeline-integrity-check\n\n### Failure:\n${failure}\n\n### Scope\nOnly modify files matching the pipeline repair allowlist:\n- scripts/e2e/*.js (not claws/ subdirectory)\n- daemon-config.json\n- e2e/state/*.json\n\n### Validation\nAfter fix, must pass both:\n1. node scripts/e2e/pipeline-integrity-check.js\n2. node scripts/e2e/self-test.js`,
          tier: "pipeline_repair",
          category: "pipeline",
          status: "approved",
          source: "diagnostics",
          changeType: "bug_fix",
          riskLevel: "medium",
          findings: [],
          affectedFiles: [],
          submittedAt: now,
          iteration: this.currentCycle,
          approvedAt: now,
        };
        mocs.push(repairMoc);
        created++;
      }

      if (created > 0) {
        queue.mocs = mocs;
        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
        this.log(`created ${created} pipeline_repair MOCs`);
        this.emitSignal("mocs-ready", { source: "diagnostics-repair", added: created });
      }
    } catch (err) {
      this.log(`failed to create repair MOCs: ${err.message}`);
    }
  }

  /**
   * Diagnose a crashed claw: analyze logs, classify, attempt fix.
   */
  async _diagnoseCrashedClaw(signal) {
    const clawName = signal.claw ?? "unknown";
    const actions = [];
    this.log(`diagnosing crashed claw: ${clawName}`);

    // Phase 1: Log analysis
    const errorLines = this._extractRecentErrors(clawName, 50);
    const errorText = errorLines.join("\n");
    this.log(`  found ${errorLines.length} recent error lines for ${clawName}`);

    // Phase 2: Classify root cause
    const classification = this._classifyError(errorText);
    this.log(`  classification: ${classification.type} — ${classification.detail}`);
    actions.push(`diagnosed ${clawName}: ${classification.type}`);

    // Phase 3: Attempt fix
    const fixResult = await this._attemptFix(classification);
    if (fixResult.fixed) {
      actions.push(`fixed ${clawName}: ${fixResult.action}`);
      this.log(`  fix applied: ${fixResult.action}`);

      // Phase 4: Verify and restart
      const selfTest = this.exec("node scripts/e2e/self-test.js --json", { label: "post-fix-verify", timeoutMs: 120000 });
      if (selfTest.ok) {
        // Un-crash the claw by resetting its status
        this._withSignalsLock((signals) => {
          if (signals.claws[clawName]) {
            signals.claws[clawName].status = "idle";
            signals.claws[clawName].lastError = null;
          }
        });
        actions.push(`restarted ${clawName} after successful fix`);
        this.log(`  ${clawName} un-crashed and set to idle`);
      } else {
        actions.push(`fix applied but self-test still failing for ${clawName}`);
        this.log(`  self-test still failing after fix`);
      }
    } else {
      // Unknown or unfixable — create needs_human entry
      this.log(`  could not auto-fix: ${fixResult.reason}`);
      actions.push(`${clawName}: needs human — ${classification.detail}`);
      await notify(
        `Claw "${clawName}" crashed and auto-diagnosis could not fix it. Classification: ${classification.type}. Detail: ${classification.detail}`,
        "critical"
      );
    }

    return actions;
  }

  /**
   * Extract recent error lines from daemon.log for a specific claw.
   * Only reads the last 512KB to avoid loading huge log files into memory.
   */
  _extractRecentErrors(clawName, lineCount) {
    if (!fs.existsSync(LOG_FILE)) { return []; }
    try {
      const { readFileTail } = require("../claw");
      const content = readFileTail(LOG_FILE, 512 * 1024);
      const lines = content.split("\n");
      return lines
        .filter((l) => l.includes(`[${clawName}]`) && (l.includes("error") || l.includes("fail") || l.includes("Error") || l.includes("FATAL")))
        .slice(-lineCount);
    } catch {
      return [];
    }
  }

  /**
   * Classify an error pattern into a remediable category.
   */
  _classifyError(errorText) {
    const lower = errorText.toLowerCase();

    if (lower.includes("cannot find module") || lower.includes("module not found")) {
      return { type: "missing-dependency", detail: "Node module not found", fix: "npm-install" };
    }
    if (lower.includes("playwright") && (lower.includes("not found") || lower.includes("executable"))) {
      return { type: "missing-dependency", detail: "Playwright browser not installed", fix: "playwright-install" };
    }
    if (lower.includes("api key") || lower.includes("unauthorized") || lower.includes("401") || lower.includes("invalid_api_key")) {
      return { type: "api-key", detail: "API key expired or missing", fix: "notify" };
    }
    if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many requests")) {
      return { type: "rate-limit", detail: "Rate limited by external API", fix: "increase-interval" };
    }
    if (lower.includes("enospc") || lower.includes("no space") || lower.includes("disk full")) {
      return { type: "disk-full", detail: "Disk space exhausted", fix: "prune-reports" };
    }
    if (lower.includes(".lock") || lower.includes("lock file") || lower.includes("ebusy")) {
      return { type: "stale-lock", detail: "Stale lock file preventing operations", fix: "remove-locks" };
    }
    if (lower.includes("unexpected token") || lower.includes("json parse") || lower.includes("syntaxerror")) {
      return { type: "corrupt-state", detail: "Corrupt JSON state file", fix: "rebuild-state" };
    }
    if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("fetch failed")) {
      return { type: "network", detail: "Network connectivity issue", fix: "notify" };
    }
    if (lower.includes("timeout") || lower.includes("etimedout")) {
      return { type: "timeout", detail: "Operation timed out", fix: "increase-timeout" };
    }

    return { type: "unknown", detail: errorText.slice(0, 200), fix: "needs-human" };
  }

  /**
   * Attempt to fix based on classification.
   */
  async _attemptFix(classification) {
    switch (classification.fix) {
      case "npm-install": {
        // Detect package manager from lock files
        let installCmd = "npm install";
        if (fs.existsSync(path.join(ROOT, "bun.lockb")) || fs.existsSync(path.join(ROOT, "bun.lock"))) { installCmd = "bun install"; }
        else if (fs.existsSync(path.join(ROOT, "pnpm-lock.yaml"))) { installCmd = "pnpm install"; }
        else if (fs.existsSync(path.join(ROOT, "yarn.lock"))) { installCmd = "yarn install"; }
        const result = this.exec(installCmd, { label: "install-deps", timeoutMs: 120000 });
        return result.ok ? { fixed: true, action: `ran ${installCmd}` } : { fixed: false, reason: `${installCmd} failed` };
      }
      case "playwright-install": {
        const result = this.exec("npx playwright install chromium", { label: "playwright-install", timeoutMs: 120000 });
        return result.ok ? { fixed: true, action: "installed Playwright chromium" } : { fixed: false, reason: "playwright install failed" };
      }
      case "increase-interval": {
        // Double the interval for the affected claw in daemon-config.json
        try {
          const configPath = path.join(ROOT, "daemon-config.json");
          const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          // Find which claw was affected from the signal
          const signals = this._loadSignals();
          const crashedClaw = Object.entries(signals.claws ?? {}).find(([, v]) => v.status === "crashed")?.[0];
          if (crashedClaw && config.claws?.[crashedClaw]) {
            const current = config.claws[crashedClaw].intervalMinutes ?? 60;
            const newInterval = Math.min(current * 2, 480);
            config.claws[crashedClaw].intervalMinutes = newInterval;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
            return { fixed: true, action: `increased ${crashedClaw} interval to ${newInterval}min` };
          }
        } catch {}
        return { fixed: false, reason: "could not update config" };
      }
      case "prune-reports": {
        this.exec(
          'find e2e/reports -name "iteration-*.md" -mtime +3 -delete 2>/dev/null; git gc --auto 2>/dev/null',
          { label: "prune-disk", timeoutMs: 60000 }
        );
        return { fixed: true, action: "pruned old reports and ran git gc" };
      }
      case "remove-locks": {
        let removed = 0;
        const lockFiles = [
          path.join(STATE_DIR, ".git-commit.lock"),
          path.join(STATE_DIR, "claw-signals.json.lock"),
          path.join(ROOT, ".git", "index.lock"),
        ];
        for (const lockFile of lockFiles) {
          if (fs.existsSync(lockFile)) {
            try {
              fs.unlinkSync(lockFile);
              removed++;
            } catch {}
          }
        }
        return removed > 0
          ? { fixed: true, action: `removed ${removed} stale lock file(s)` }
          : { fixed: false, reason: "no lock files found" };
      }
      case "rebuild-state": {
        // Run self-test which handles corrupt JSON files
        const result = this.exec("node scripts/e2e/self-test.js", { label: "rebuild-state", timeoutMs: 120000 });
        return result.ok ? { fixed: true, action: "rebuilt corrupt state files via self-test" } : { fixed: false, reason: "self-test failed" };
      }
      case "notify": {
        // Can't auto-fix — just notify
        return { fixed: false, reason: `${classification.type}: requires manual intervention` };
      }
      default:
        return { fixed: false, reason: "unknown fix type" };
    }
  }

  /**
   * Generate and send health heartbeat.
   */
  async _sendHealthHeartbeat() {
    this.log("generating health heartbeat...");

    const signals = this._loadSignals();
    const claws = signals.claws ?? {};
    const clawNames = Object.keys(claws);

    // Collect stats
    const statuses = {};
    let healthyCount = 0;
    for (const name of clawNames) {
      const claw = claws[name];
      statuses[name] = claw.status ?? "unknown";
      if (claw.status === "idle" || claw.status === "running") {
        healthyCount++;
      }
    }

    // Read cycle history once for both pass rate and budget usage
    let recentPassRate = null;
    let budgetToday = 0;
    try {
      const historyPath = path.join(STATE_DIR, "claw-history.jsonl");
      if (fs.existsSync(historyPath)) {
        const { readFileTail } = require("../claw");
        const content = readFileTail(historyPath, 256 * 1024);
        const lines = content.split("\n").filter(Boolean);
        const entries = lines
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
        const last24h = entries.filter((e) => Date.now() - new Date(e.at).getTime() < 86400000);
        const testRuns = last24h.filter((e) => e.claw === "test-runner");
        if (testRuns.length > 0) {
          const passed = testRuns.filter((e) => e.ok).length;
          recentPassRate = Math.round((passed / testRuns.length) * 100);
        }
        budgetToday = last24h.filter((e) => e.claw === "fix-engine").length;
      }
    } catch {}

    // MOC queue depth
    let mocQueueDepth = 0;
    try {
      const queue = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "moc-queue.json"), "utf-8"));
      const mocs = Array.isArray(queue?.mocs) ? queue.mocs : [];
      mocQueueDepth = mocs.filter((m) => m.status === "pending_approval" || m.status === "awaiting_approval").length;
    } catch {}

    // Pipeline integrity status (from most recent check)
    let integrityStatus = "unknown";
    let integrityFailures = 0;
    try {
      const integrity = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "pipeline-integrity.json"), "utf-8"));
      integrityStatus = integrity.healthy ? "healthy" : "degraded";
      integrityFailures = integrity.failedCount ?? 0;
    } catch { /* no integrity data yet */ }

    // Build summary
    const statusLine = clawNames.map((n) => `${n}:${statuses[n]}`).join(", ");
    const passRateStr = recentPassRate !== null ? `${recentPassRate}% pass rate` : "no test data";
    const integrityStr = integrityStatus === "unknown" ? "" : ` Pipeline: ${integrityStatus}${integrityFailures > 0 ? ` (${integrityFailures} failures)` : ""}.`;
    const summary = `${healthyCount}/${clawNames.length} claws healthy (${statusLine}). ${passRateStr}. ${mocQueueDepth} MOCs pending approval.${integrityStr}`;

    // Health check results (from most recent Phase 1 run)
    const healthCheckSummary = {};
    for (const check of this._lastHealthCheckResults) {
      healthCheckSummary[check.name] = check.ok;
    }

    // Write to file
    const heartbeat = {
      at: new Date().toISOString(),
      summary,
      claws: statuses,
      passRate: recentPassRate,
      mocQueueDepth,
      healthyClaws: healthyCount,
      totalClaws: clawNames.length,
      pipelineIntegrity: integrityStatus,
      pipelineIntegrityFailures: integrityFailures,
      healthChecks: healthCheckSummary,
    };
    this.writeState("daemon-health-summary.json", heartbeat);

    // Send notification
    const severity = healthyCount < clawNames.length ? "warning" : "info";
    await notify(summary, severity);

    this.log(`heartbeat sent: ${summary}`);
  }

  /**
   * Check if a timestamp is recent enough to act on (within signal expiry).
   */
  _isRecent(isoTimestamp) {
    if (!isoTimestamp) { return false; }
    return Date.now() - new Date(isoTimestamp).getTime() < this._signalExpiryMs;
  }
}

// Direct execution
if (require.main === module) {
  const claw = new DiagnosticsClaw();
  claw.start().catch((err) => {
    console.error(`diagnostics fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { DiagnosticsClaw };
