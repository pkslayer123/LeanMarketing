#!/usr/bin/env node

/**
 * Claw 11: Docs-Sync
 *
 * Keeps documentation coherent with codebase reality. Detects drift between
 * source-of-truth data (spec files, state files, migrations) and documentation
 * (BUILD-SPEC.md, CLAUDE.md, TESTING.md). Auto-fixes safe drift, tracks
 * improvement backlog, and reports unresolvable drift for observer alerting.
 *
 * Triggered by: fixes-applied, intelligence-complete, or periodic (6h default).
 *
 * Phases:
 *   Phase 1: Collect doc state — parse docs and state files for current counts/content
 *   Phase 2: Detect drift — compare source-of-truth vs documented values
 *   Phase 3: Auto-fix drift — update docs with correct values (max edits per cycle)
 *   Phase 4: Improvement backlog — track and lifecycle improvement suggestions
 *   Phase 5: Report — write docs-sync-state.json, emit docs-synced signal
 */

const fs = require("fs");
const path = require("path");
const { Claw, STATE_DIR, ROOT } = require("../claw");

const DOCS_DIR = ROOT;
const BUILD_SPEC_PATH = path.join(DOCS_DIR, "docs", "BUILD-SPEC.md");
const CLAUDE_MD_PATH = path.join(DOCS_DIR, "CLAUDE.md");
const TESTING_MD_PATH = path.join(DOCS_DIR, "e2e", "TESTING.md");
const PE_README_PATH = path.join(DOCS_DIR, "packages", "persona-engine", "README.md");
const E2E_DOCS_DIR = path.join(DOCS_DIR, "e2e", "docs");
const STATE_FILE = path.join(STATE_DIR, "docs-sync-state.json");
const BACKLOG_FILE = path.join(STATE_DIR, "improvement-backlog.json");
const DOCS_UPDATE_TRACKER = path.join(STATE_DIR, "docs-update-tracker.json");

class DocsSyncClaw extends Claw {
  constructor() {
    super("docs-sync");
    this._maxEditsPerCycle = 10;
    this._staleDays = 30;
  }

  async run() {
    const config = this.clawConfig;
    this._maxEditsPerCycle = config.maxEditsPerCycle ?? 10;
    this._staleDays = config.stalePatternsThresholdDays ?? 30;

    this.log("Phase 1: Collecting doc state...");
    const docState = this._collectDocState();

    this.log("Phase 2: Detecting drift...");
    const drifts = this._detectDrift(docState);
    this.log(`  Found ${drifts.length} drift(s)`);

    this.log("Phase 3: Auto-fixing drift...");
    const fixes = this._autoFixDrift(drifts, docState);
    this.log(`  Applied ${fixes.length} fix(es)`);

    this.log("Phase 4: Improvement backlog...");
    const backlogStats = this._updateImprovementBacklog();

    this.log("Phase 5: Writing report...");
    this._writeReport(drifts, fixes, backlogStats, docState);

    this.emitSignal("docs-synced", {
      driftCount: drifts.length,
      fixedCount: fixes.length,
    });

    // Clear stale circuit-broken signal if this claw emitted it previously.
    // After daemon restart, the in-memory circuit breaker resets but the persistent
    // signal remains in claw-signals.json, causing diagnostics to re-report it.
    this._clearStaleCircuitBrokenSignal();

    const fixedCount = fixes.filter((f) => f.result === "fixed").length;
    return {
      ok: true,
      summary: `${drifts.length} drift(s), ${fixedCount} fixed, backlog: ${backlogStats.total} items`,
      drifts: drifts.length,
      fixed: fixedCount,
      backlog: backlogStats,
    };
  }

  // ---------------------------------------------------------------------------
  // Circuit-breaker hygiene
  // ---------------------------------------------------------------------------

  /**
   * Clear a stale circuit-broken signal from claw-signals.json if this claw
   * emitted it. After a daemon restart the in-memory breaker resets, but the
   * persistent signal remains and causes diagnostics to keep re-reporting it.
   */
  _clearStaleCircuitBrokenSignal() {
    try {
      this._withSignalsLock((signals) => {
        const cb = signals.signals?.["circuit-broken"];
        if (cb && cb.emittedBy === this.name) {
          delete signals.signals["circuit-broken"];
          this.log("cleared stale circuit-broken signal");
        }
      });
    } catch { /* non-fatal — signal file may be locked */ }
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Collect doc state
  // ---------------------------------------------------------------------------

  _collectDocState() {
    const state = {
      personaCount: 0,
      testCount: 0,
      clawCount: 0,
      specFileCount: 0,
      claudeMdPersonaCount: null,
      claudeMdTestCount: null,
      claudeMdClawCount: null,
      testingMdPersonaCount: null,
      testingMdTestCount: null,
      errorPatterns: [],
      undocumentedMocs: [],
      improvementInsights: [],
    };

    // Count actual persona spec files
    try {
      const specsDir = path.join(ROOT, "e2e", "tests", "personas");
      if (fs.existsSync(specsDir)) {
        const files = fs.readdirSync(specsDir).filter((f) => f.endsWith(".spec.ts"));
        state.specFileCount = files.length;
      }
    } catch { /* non-fatal */ }

    // Count personas from manifest
    try {
      const manifest = this.readState("manifest.json");
      if (manifest?.personas) {
        state.personaCount = Object.keys(manifest.personas).length;
      }
    } catch { /* non-fatal */ }

    // Count tests from spec files
    try {
      const specsDir = path.join(ROOT, "e2e", "tests", "personas");
      if (fs.existsSync(specsDir)) {
        const files = fs.readdirSync(specsDir).filter((f) => f.endsWith(".spec.ts"));
        let testCount = 0;
        for (const file of files) {
          const content = fs.readFileSync(path.join(specsDir, file), "utf-8");
          const matches = content.match(/test\(/g);
          testCount += matches ? matches.length : 0;
        }
        state.testCount = testCount;
      }
    } catch { /* non-fatal */ }

    // Count claws from daemon.js
    try {
      const daemonPath = path.join(ROOT, "scripts", "e2e", "daemon.js");
      if (fs.existsSync(daemonPath)) {
        const content = fs.readFileSync(daemonPath, "utf-8");
        const match = content.match(/const CLAW_FILES\s*=\s*\{([^}]+)\}/s);
        if (match) {
          const entries = match[1].match(/"/g);
          // Each claw has 2 quotes for key, 2 for path value, but keys are on separate lines
          // Count lines with ":" pattern
          const clawLines = match[1].split("\n").filter((l) => l.includes(":"));
          state.clawCount = clawLines.length;
        }
      }
    } catch { /* non-fatal */ }

    // Parse CLAUDE.md for documented counts
    try {
      if (fs.existsSync(CLAUDE_MD_PATH)) {
        const content = fs.readFileSync(CLAUDE_MD_PATH, "utf-8");

        const personaMatch = content.match(/\*\*(\d+)\s+personas?,?\s*~?(\d+)\s+tests?\b/i);
        if (personaMatch) {
          state.claudeMdPersonaCount = parseInt(personaMatch[1], 10);
          state.claudeMdTestCount = parseInt(personaMatch[2], 10);
        }

        const clawMatch = content.match(/\*\*(\d+)\s+claws?\s+active/i);
        if (clawMatch) {
          state.claudeMdClawCount = parseInt(clawMatch[1], 10);
        }

        // Extract recurring error patterns
        const errorSection = content.match(/<!-- RECURRING_ERRORS_START -->([\s\S]*?)<!-- RECURRING_ERRORS_END -->/);
        if (errorSection) {
          const patterns = errorSection[1].match(/\*\*\w+\*\*\s+\((\d+)x\)/g) ?? [];
          for (const p of patterns) {
            const countMatch = p.match(/\((\d+)x\)/);
            state.errorPatterns.push({
              text: p,
              count: countMatch ? parseInt(countMatch[1], 10) : 0,
            });
          }
        }
      }
    } catch { /* non-fatal */ }

    // Parse TESTING.md for documented counts
    try {
      if (fs.existsSync(TESTING_MD_PATH)) {
        const content = fs.readFileSync(TESTING_MD_PATH, "utf-8");
        const personaMatch = content.match(/(\d+)\s+personas?/i);
        if (personaMatch) {
          state.testingMdPersonaCount = parseInt(personaMatch[1], 10);
        }
        const testMatch = content.match(/~?(\d+)\s+tests?/i);
        if (testMatch) {
          state.testingMdTestCount = parseInt(testMatch[1], 10);
        }
      }
    } catch { /* non-fatal */ }

    // Check for undocumented MOCs
    try {
      const tracker = this.readState("docs-update-tracker.json");
      const mocQueue = this.readState("moc-queue.json");
      const documented = new Set(tracker?.documentedMocs ?? []);
      const queue = mocQueue?.completed ?? mocQueue?.mocs ?? [];
      state.undocumentedMocs = queue
        .filter((m) => !documented.has(m.id ?? m.mocId))
        .slice(0, 20);
    } catch { /* non-fatal */ }

    // Read improvement insights
    try {
      const report = this.readState("improvement-report.json");
      if (report?.insights) {
        state.improvementInsights = report.insights.slice(0, 10);
      }
    } catch { /* non-fatal */ }

    // Parse persona-engine README for documented claw count
    state.peReadmeClawCount = null;
    try {
      if (fs.existsSync(PE_README_PATH)) {
        const content = fs.readFileSync(PE_README_PATH, "utf-8");
        // Count listed claws in the daemon section
        const clawSection = content.match(/### Daemon Claws([\s\S]*?)(?=###|$)/);
        if (clawSection) {
          const clawLines = clawSection[1].match(/^\s*\d+\.\s+/gm);
          state.peReadmeClawCount = clawLines ? clawLines.length : null;
        }
      }
    } catch { /* non-fatal */ }

    // Check e2e/docs staleness
    state.staleDocs = [];
    try {
      if (fs.existsSync(E2E_DOCS_DIR)) {
        const { execSync } = require("child_process");
        const docs = fs.readdirSync(E2E_DOCS_DIR).filter((f) => f.endsWith(".md"));
        for (const doc of docs) {
          const docPath = path.join(E2E_DOCS_DIR, doc);
          try {
            const lastCommit = execSync(
              `git log -1 --format=%aI -- "${docPath.replace(/\\/g, "/")}"`,
              { cwd: ROOT, encoding: "utf-8", timeout: 5000 }
            ).trim();
            if (lastCommit) {
              const daysSince = Math.round((Date.now() - new Date(lastCommit).getTime()) / (24 * 60 * 60 * 1000));
              if (daysSince > 14) {
                state.staleDocs.push({ file: doc, lastUpdated: lastCommit, daysSince });
              }
            }
          } catch { /* non-fatal */ }
        }
      }
    } catch { /* non-fatal */ }

    return state;
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Detect drift
  // ---------------------------------------------------------------------------

  _detectDrift(docState) {
    const drifts = [];

    // Persona count mismatch
    if (docState.personaCount > 0 && docState.claudeMdPersonaCount !== null) {
      if (docState.claudeMdPersonaCount !== docState.personaCount) {
        drifts.push({
          type: "persona-count",
          target: "CLAUDE.md",
          expected: docState.personaCount,
          documented: docState.claudeMdPersonaCount,
          detail: `CLAUDE.md says ${docState.claudeMdPersonaCount} personas, actual is ${docState.personaCount}`,
        });
      }
    }

    // Test count mismatch (allow ~5% tolerance)
    if (docState.testCount > 0 && docState.claudeMdTestCount !== null) {
      const diff = Math.abs(docState.testCount - docState.claudeMdTestCount);
      if (diff > Math.max(10, docState.testCount * 0.05)) {
        drifts.push({
          type: "test-count",
          target: "CLAUDE.md",
          expected: docState.testCount,
          documented: docState.claudeMdTestCount,
          detail: `CLAUDE.md says ~${docState.claudeMdTestCount} tests, actual is ${docState.testCount}`,
        });
      }
    }

    // Claw count mismatch
    if (docState.clawCount > 0 && docState.claudeMdClawCount !== null) {
      if (docState.claudeMdClawCount !== docState.clawCount) {
        drifts.push({
          type: "claw-count",
          target: "CLAUDE.md",
          expected: docState.clawCount,
          documented: docState.claudeMdClawCount,
          detail: `CLAUDE.md says ${docState.claudeMdClawCount} claws, actual is ${docState.clawCount}`,
        });
      }
    }

    // TESTING.md persona count mismatch
    if (docState.personaCount > 0 && docState.testingMdPersonaCount !== null) {
      if (docState.testingMdPersonaCount !== docState.personaCount) {
        drifts.push({
          type: "persona-count",
          target: "TESTING.md",
          expected: docState.personaCount,
          documented: docState.testingMdPersonaCount,
          detail: `TESTING.md says ${docState.testingMdPersonaCount} personas, actual is ${docState.personaCount}`,
        });
      }
    }

    // TESTING.md test count mismatch
    if (docState.testCount > 0 && docState.testingMdTestCount !== null) {
      const diff = Math.abs(docState.testCount - docState.testingMdTestCount);
      if (diff > Math.max(10, docState.testCount * 0.05)) {
        drifts.push({
          type: "test-count",
          target: "TESTING.md",
          expected: docState.testCount,
          documented: docState.testingMdTestCount,
          detail: `TESTING.md says ~${docState.testingMdTestCount} tests, actual is ${docState.testCount}`,
        });
      }
    }

    // Undocumented MOCs
    if (docState.undocumentedMocs.length > 0) {
      drifts.push({
        type: "undocumented-mocs",
        target: "BUILD-SPEC.md",
        count: docState.undocumentedMocs.length,
        detail: `${docState.undocumentedMocs.length} completed MOC(s) not in Change Attribution Log`,
      });
    }

    // Persona-engine README claw count mismatch
    if (docState.clawCount > 0 && docState.peReadmeClawCount !== null) {
      if (docState.peReadmeClawCount !== docState.clawCount) {
        drifts.push({
          type: "claw-count",
          target: "persona-engine/README.md",
          expected: docState.clawCount,
          documented: docState.peReadmeClawCount,
          detail: `persona-engine README lists ${docState.peReadmeClawCount} claws, actual is ${docState.clawCount}`,
        });
      }
    }

    // Stale e2e/docs
    if (docState.staleDocs?.length > 3) {
      drifts.push({
        type: "stale-docs",
        target: "e2e/docs/",
        count: docState.staleDocs.length,
        detail: `${docState.staleDocs.length} doc(s) in e2e/docs/ not updated in 14+ days: ${docState.staleDocs.map((d) => d.file).slice(0, 5).join(", ")}`,
      });
    }

    return drifts;
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Auto-fix drift
  // ---------------------------------------------------------------------------

  _autoFixDrift(drifts, docState) {
    const fixes = [];
    let editsApplied = 0;

    for (const drift of drifts) {
      if (editsApplied >= this._maxEditsPerCycle) {
        break;
      }

      try {
        if (drift.target === "CLAUDE.md" && drift.type === "persona-count") {
          const fixed = this._fixClaudeMdCount("personas", drift.documented, drift.expected);
          if (fixed) {
            fixes.push({ drift, result: "fixed" });
            editsApplied++;
          }
        } else if (drift.target === "CLAUDE.md" && drift.type === "test-count") {
          const fixed = this._fixClaudeMdCount("tests", drift.documented, drift.expected);
          if (fixed) {
            fixes.push({ drift, result: "fixed" });
            editsApplied++;
          }
        } else if (drift.target === "CLAUDE.md" && drift.type === "claw-count") {
          const fixed = this._fixClaudeMdClawCount(drift.documented, drift.expected);
          if (fixed) {
            fixes.push({ drift, result: "fixed" });
            editsApplied++;
          }
        } else if (drift.target === "TESTING.md" && (drift.type === "persona-count" || drift.type === "test-count")) {
          const fixed = this._fixTestingMdCount(drift.type, drift.documented, drift.expected);
          if (fixed) {
            fixes.push({ drift, result: "fixed" });
            editsApplied++;
          }
        } else if (drift.target === "persona-engine/README.md" && drift.type === "claw-count") {
          const fixed = this._fixPeReadmeClawCount(drift.documented, drift.expected);
          if (fixed) {
            fixes.push({ drift, result: "fixed" });
            editsApplied++;
          }
        } else if (drift.type === "undocumented-mocs") {
          // Don't auto-fix BUILD-SPEC — update-docs-from-mocs.js owns that
          fixes.push({ drift, result: "deferred-to-orchestrator" });
        } else if (drift.type === "stale-docs") {
          // Can't auto-fix stale docs — report for human awareness
          fixes.push({ drift, result: "needs-human" });
        }
      } catch (err) {
        this.log(`  fix error for ${drift.type}@${drift.target}: ${err.message}`);
        fixes.push({ drift, result: "error", error: err.message });
      }
    }

    // Update CLAUDE.md _Last updated_ timestamp if any fixes were applied
    if (fixes.some((f) => f.result === "fixed")) {
      this._updateClaudeMdTimestamp();
    }

    return fixes;
  }

  _fixClaudeMdCount(type, oldVal, newVal) {
    if (!fs.existsSync(CLAUDE_MD_PATH)) { return false; }
    let content = fs.readFileSync(CLAUDE_MD_PATH, "utf-8");

    // Match pattern like "**56 personas, ~1177 tests**"
    if (type === "personas") {
      const pattern = `\\*\\*${oldVal}\\s+personas?`;
      if (!new RegExp(pattern).test(content)) { return false; }
      content = content.replace(new RegExp(pattern, "g"), `**${newVal} personas`);
    } else if (type === "tests") {
      const pattern = `~?${oldVal}\\s+tests?`;
      if (!new RegExp(pattern).test(content)) { return false; }
      content = content.replace(new RegExp(pattern, "g"), `~${newVal} tests`);
    }

    const tmpPath = CLAUDE_MD_PATH + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, CLAUDE_MD_PATH);
    this.log(`  fixed CLAUDE.md ${type}: ${oldVal} → ${newVal}`);
    return true;
  }

  _fixClaudeMdClawCount(oldVal, newVal) {
    if (!fs.existsSync(CLAUDE_MD_PATH)) { return false; }
    let content = fs.readFileSync(CLAUDE_MD_PATH, "utf-8");

    const pattern = `\\*\\*${oldVal}\\s+claws?\\s+active`;
    if (!new RegExp(pattern).test(content)) { return false; }
    content = content.replace(new RegExp(pattern, "g"), `**${newVal} claws active`);

    const tmpPath = CLAUDE_MD_PATH + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, CLAUDE_MD_PATH);
    this.log(`  fixed CLAUDE.md claw count: ${oldVal} → ${newVal}`);
    return true;
  }

  _fixTestingMdCount(type, oldVal, newVal) {
    if (!fs.existsSync(TESTING_MD_PATH)) { return false; }
    let content = fs.readFileSync(TESTING_MD_PATH, "utf-8");

    if (type === "persona-count") {
      const pattern = `${oldVal}\\s+personas?`;
      if (!new RegExp(pattern).test(content)) { return false; }
      content = content.replace(new RegExp(pattern, "g"), `${newVal} personas`);
    } else if (type === "test-count") {
      const pattern = `~?${oldVal}\\s+tests?`;
      if (!new RegExp(pattern).test(content)) { return false; }
      content = content.replace(new RegExp(pattern, "g"), `~${newVal} tests`);
    }

    fs.writeFileSync(TESTING_MD_PATH, content);
    this.log(`  fixed TESTING.md ${type}: ${oldVal} → ${newVal}`);
    return true;
  }

  _fixPeReadmeClawCount(oldVal, newVal) {
    if (!fs.existsSync(PE_README_PATH)) { return false; }
    // The persona-engine README has a "### Daemon Claws" section with a numbered list.
    // We update the count in any summary line that mentions "N claws" or "N daemon claws".
    let content = fs.readFileSync(PE_README_PATH, "utf-8");

    const pattern = `${oldVal}\\s+(daemon\\s+)?claws?`;
    if (!new RegExp(pattern, "i").test(content)) { return false; }
    content = content.replace(new RegExp(pattern, "gi"), `${newVal} $1claws`);

    fs.writeFileSync(PE_README_PATH, content);
    this.log(`  fixed persona-engine README claw count: ${oldVal} → ${newVal}`);
    return true;
  }

  _updateClaudeMdTimestamp() {
    try {
      if (!fs.existsSync(CLAUDE_MD_PATH)) { return; }
      let content = fs.readFileSync(CLAUDE_MD_PATH, "utf-8");
      const today = new Date().toISOString().split("T")[0];
      content = content.replace(
        /_Last updated: \d{4}-\d{2}-\d{2}_/,
        `_Last updated: ${today}_`
      );
      fs.writeFileSync(CLAUDE_MD_PATH, content);
    } catch { /* non-fatal */ }
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Improvement backlog
  // ---------------------------------------------------------------------------

  _updateImprovementBacklog() {
    let backlog = { items: [], lastUpdated: null };
    try {
      if (fs.existsSync(BACKLOG_FILE)) {
        backlog = JSON.parse(fs.readFileSync(BACKLOG_FILE, "utf-8"));
        if (!Array.isArray(backlog.items)) { backlog.items = []; }
      }
    } catch {
      backlog = { items: [], lastUpdated: null };
    }

    // Read improvement report
    let insights = [];
    try {
      const report = this.readState("improvement-report.json");
      insights = report?.insights ?? [];
    } catch { /* non-fatal */ }

    const existingFingerprints = new Set(backlog.items.map((i) => i.fingerprint));

    // Fingerprint new insights and add/increment
    for (const insight of insights) {
      const fp = this._fingerprintInsight(insight);
      const existing = backlog.items.find((i) => i.fingerprint === fp);

      if (existing) {
        existing.seenCount = (existing.seenCount ?? 1) + 1;
        existing.lastSeen = new Date().toISOString();

        // Auto-promote quick_wins seen 5+ times
        if (
          existing.status === "suggested" &&
          insight.priority === "quick_win" &&
          existing.seenCount >= 5
        ) {
          existing.status = "backlogged";
          existing.promotedAt = new Date().toISOString();
        }
      } else {
        backlog.items.push({
          fingerprint: fp,
          description: (insight.description ?? insight.title ?? "").slice(0, 200),
          priority: insight.priority ?? "unknown",
          source: insight.source ?? "improvement-report",
          status: "suggested",
          seenCount: 1,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        });
      }
    }

    // Auto-mark implemented: check if linked MOC/finding resolved
    try {
      const findings = this.readState("findings/findings.json");
      const resolvedFindings = new Set(
        (findings ?? [])
          .filter((f) => f.resolved || f.status === "resolved")
          .map((f) => f.id ?? f.findingId)
      );

      for (const item of backlog.items) {
        if (
          item.status === "backlogged" &&
          item.linkedFinding &&
          resolvedFindings.has(item.linkedFinding)
        ) {
          item.status = "implemented";
          item.implementedAt = new Date().toISOString();
        }
      }
    } catch { /* non-fatal */ }

    // Keep backlog to a reasonable size (last 200 items)
    if (backlog.items.length > 200) {
      // Remove oldest completed/wontfix first
      const inactive = backlog.items.filter((i) => i.status === "implemented" || i.status === "wontfix");
      const active = backlog.items.filter((i) => i.status !== "implemented" && i.status !== "wontfix");
      backlog.items = [...active, ...inactive.slice(-50)].slice(-200);
    }

    backlog.lastUpdated = new Date().toISOString();

    try {
      fs.writeFileSync(BACKLOG_FILE, JSON.stringify(backlog, null, 2) + "\n");
    } catch (err) {
      this.log(`  backlog write error: ${err.message}`);
    }

    const stats = {
      total: backlog.items.length,
      suggested: backlog.items.filter((i) => i.status === "suggested").length,
      backlogged: backlog.items.filter((i) => i.status === "backlogged").length,
      implemented: backlog.items.filter((i) => i.status === "implemented").length,
      wontfix: backlog.items.filter((i) => i.status === "wontfix").length,
    };

    return stats;
  }

  _fingerprintInsight(insight) {
    const text = (insight.description ?? insight.title ?? "").toLowerCase().trim();
    // Simple hash: take first 50 chars + length
    const crypto = require("crypto");
    return crypto.createHash("md5").update(text.slice(0, 100)).digest("hex").slice(0, 12);
  }

  // ---------------------------------------------------------------------------
  // Phase 5: Report
  // ---------------------------------------------------------------------------

  _writeReport(drifts, fixes, backlogStats, docState) {
    // Load prior state for consecutive unfixed tracking
    let priorState = null;
    try {
      if (fs.existsSync(STATE_FILE)) {
        priorState = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      }
    } catch { /* ignore */ }

    const unfixedCount = drifts.length - fixes.filter((f) => f.result === "fixed").length;
    let consecutiveUnfixedCycles = priorState?.consecutiveUnfixedCycles ?? 0;

    if (unfixedCount > 0) {
      consecutiveUnfixedCycles++;
    } else {
      consecutiveUnfixedCycles = 0;
    }

    const state = {
      lastRun: new Date().toISOString(),
      cycle: this.currentCycle,
      driftCount: drifts.length,
      fixedCount: fixes.filter((f) => f.result === "fixed").length,
      consecutiveUnfixedCycles,
      drifts: drifts.map((d) => ({
        type: d.type,
        target: d.target,
        detail: d.detail,
      })),
      fixes: fixes.map((f) => ({
        type: f.drift.type,
        target: f.drift.target,
        result: f.result,
      })),
      docState: {
        personaCount: docState.personaCount,
        testCount: docState.testCount,
        clawCount: docState.clawCount,
        specFileCount: docState.specFileCount,
        undocumentedMocs: docState.undocumentedMocs.length,
        staleDocs: (docState.staleDocs ?? []).map((d) => d.file),
        peReadmeClawCount: docState.peReadmeClawCount,
      },
      backlog: backlogStats,
    };

    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
    } catch (err) {
      this.log(`  state write error: ${err.message}`);
    }

    this.log(`  Report: ${drifts.length} drifts, ${fixes.filter((f) => f.result === "fixed").length} fixed, backlog: ${backlogStats.total} items`);
  }
}

// ---------------------------------------------------------------------------
// Entry point — standalone or daemon-spawned
// ---------------------------------------------------------------------------

if (require.main === module) {
  const claw = new DocsSyncClaw();
  claw.start().catch((err) => {
    console.error("[docs-sync] Fatal:", err);
    process.exit(1);
  });
}

module.exports = DocsSyncClaw;
