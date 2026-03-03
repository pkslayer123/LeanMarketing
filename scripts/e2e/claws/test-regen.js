#!/usr/bin/env node

/**
 * Claw 10: Test Regen — Test Regeneration Pipeline
 *
 * Takes tests that are stuck beyond repair-agent's 3-attempt limit and
 * regenerates them from scratch using Claude CLI — reading current page
 * source to produce tests that match the current app state.
 *
 * Schedule: Triggered by regen-requested, observer-alert. Fallback: every 2h.
 * Reads:   test-quarantine.json, stuck-diagnostics.json, regen-state.json,
 *          manifest.json, persona spec files, app source files
 * Writes:  regen-state.json, test spec files (regenerated)
 * Emits:   tests-regenerated signal
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Claw, ROOT, STATE_DIR } = require("../claw");

const REGEN_STATE_PATH = path.join(STATE_DIR, "regen-state.json");
const QUARANTINE_PATH = path.join(STATE_DIR, "test-quarantine.json");
const SPEC_DIR = path.join(ROOT, "e2e", "tests", "personas");

class TestRegenClaw extends Claw {
  constructor() {
    super("test-regen");
  }

  async run() {
    // Budget gate
    if (this.isHourlyBudgetExhausted()) {
      this.log("hourly budget exhausted — deferring regen");
      return { ok: true, summary: "budget exhausted — deferred" };
    }

    // Phase 1: Identify candidates
    this.log("phase 1: identifying regen candidates");
    const candidates = this._identifyCandidates();

    if (candidates.length === 0) {
      this.log("no regen candidates found");
      return { ok: true, summary: "no candidates" };
    }

    this.log(`found ${candidates.length} regen candidates`);

    // Phase 2: Regenerate
    this.log("phase 2: regenerating tests");
    const results = { succeeded: 0, failed: 0, skipped: 0, totalCost: 0 };

    const maxPerCycle = this.clawConfig.maxRegensPerCycle ?? 3;
    for (let i = 0; i < Math.min(maxPerCycle, candidates.length); i++) {
      // Check budget before each regen
      if (this.isHourlyBudgetExhausted()) {
        this.log("budget exhausted mid-cycle — stopping");
        break;
      }

      const candidate = candidates[i];
      const result = await this._regenerateTest(candidate);

      if (result.success) {
        results.succeeded++;
      } else if (result.skipped) {
        results.skipped++;
      } else {
        results.failed++;
      }
      results.totalCost += result.cost ?? 0;
    }

    // Phase 3: Report
    this.log("phase 3: reporting results");
    this._updateRegenState(results);

    if (results.succeeded > 0) {
      this.emitSignal("tests-regenerated", {
        count: results.succeeded,
        source: "test-regen",
      });
    }

    return {
      ok: true,
      summary: `${results.succeeded} regen'd, ${results.failed} failed, ${results.skipped} skipped ($${results.totalCost.toFixed(2)})`,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Identify candidates
  // ---------------------------------------------------------------------------

  _identifyCandidates() {
    const regenState = this._loadRegenState();
    const minStuckDays = this.clawConfig.minStuckDays ?? 3;
    const maxAttempts = this.clawConfig.maxRegenAttempts ?? 2;

    // Get quarantine entries with "pending" regen status
    let quarantine;
    try {
      const { getRegenCandidates } = require("../test-quarantine");
      quarantine = getRegenCandidates();
    } catch {
      quarantine = [];
    }

    const candidates = [];
    const now = Date.now();

    for (const entry of quarantine) {
      const key = entry.key;

      // Skip if already at max regen attempts
      const regenEntry = regenState.candidates?.[key];
      if (regenEntry && regenEntry.attempts >= maxAttempts) {
        continue;
      }

      // Check minimum stuck days
      const quarantinedAt = new Date(entry.quarantinedAt).getTime();
      const daysSince = (now - quarantinedAt) / (24 * 60 * 60 * 1000);
      if (daysSince < minStuckDays) {
        continue;
      }

      candidates.push({
        key,
        specFile: entry.specFile,
        testTitle: entry.testTitle,
        failureType: entry.failureType,
        lastError: entry.lastError,
        attempts: regenEntry?.attempts ?? 0,
      });
    }

    // Sort by longest quarantined first
    candidates.sort((a, b) => {
      const aEntry = quarantine.find((q) => q.key === a.key);
      const bEntry = quarantine.find((q) => q.key === b.key);
      return new Date(aEntry?.quarantinedAt ?? 0).getTime() - new Date(bEntry?.quarantinedAt ?? 0).getTime();
    });

    return candidates;
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Regenerate a single test
  // ---------------------------------------------------------------------------

  async _regenerateTest(candidate) {
    const { key, specFile, testTitle, failureType, lastError } = candidate;
    this.log(`regenerating: ${specFile} — ${testTitle?.slice(0, 60)}`);

    // Determine the full spec file path
    const specPath = path.join(SPEC_DIR, specFile.replace(/^personas\//, ""));
    if (!fs.existsSync(specPath)) {
      this.log(`  spec file not found: ${specPath}`);
      return { success: false, skipped: true, cost: 0 };
    }

    // Read current spec file
    let specContent;
    try {
      specContent = fs.readFileSync(specPath, "utf-8");
    } catch (err) {
      this.log(`  failed to read spec: ${err.message}`);
      return { success: false, cost: 0 };
    }

    // Extract persona ID from spec file name
    const personaId = path.basename(specFile, ".spec.ts");

    // Read manifest entry for this persona
    let manifestPages = [];
    try {
      const manifest = this.readState("manifest.json");
      if (manifest?.features) {
        for (const feat of Object.values(manifest.features)) {
          if ((feat.personas || []).includes(personaId)) {
            manifestPages.push(...(feat.pages || []));
          }
        }
      }
    } catch { /* non-fatal */ }

    // Read page source files (first 200 lines of each)
    const pageSourceSnippets = this._readPageSources(specContent);

    // Read git diff for recent changes to page sources
    let gitDiff = "";
    try {
      gitDiff = execSync(
        `git diff HEAD~5 -- app/ lib/ components/ 2>/dev/null | head -200`,
        { cwd: ROOT, encoding: "utf-8", timeout: 10000, stdio: "pipe" }
      ).slice(0, 3000);
    } catch { /* non-fatal */ }

    // Load persona evolution recommendations (produced by claude-persona-evolve.js)
    let evolutionRecommendations = "";
    try {
      const evoPath = path.join(STATE_DIR, "persona-evolution-recommendations.json");
      if (fs.existsSync(evoPath)) {
        const evoData = JSON.parse(fs.readFileSync(evoPath, "utf-8"));
        const personaRecs = (evoData.recommendations ?? []).filter(
          (r) => r.personaId === personaId || r.persona === personaId
        );
        if (personaRecs.length > 0) {
          const recTexts = personaRecs.map((r) =>
            `- ${r.type ?? "trait"}: ${r.description ?? r.recommendation ?? JSON.stringify(r).slice(0, 200)}`
          ).slice(0, 5);
          evolutionRecommendations = `\n## Evolution Recommendations for ${personaId}\nThese adaptive changes were identified by the intelligence system:\n${recTexts.join("\n")}`;
        }
      }
    } catch { /* non-fatal */ }

    // Build regen prompt
    const prompt = this._buildRegenPrompt({
      specContent,
      personaId,
      testTitle,
      failureType,
      lastError,
      pageSourceSnippets,
      manifestPages,
      gitDiff,
      evolutionRecommendations,
    });

    // Call Claude CLI
    const promptPath = path.join(STATE_DIR, `regen-prompt-${process.pid}.md`);
    fs.writeFileSync(promptPath, prompt);

    const isSecuritySpec = specFile.includes("penny") || specFile.includes("gina") || specFile.includes("oscar");
    const model = isSecuritySpec ? "opus" : "sonnet";
    const budget = isSecuritySpec ? 5.0 : 2.0;

    let result;
    try {
      result = await this.execAsync(
        `claude --print --dangerously-skip-permissions --model ${model} --max-budget-usd ${budget} < "${promptPath}"`,
        { label: "regen-test", timeoutMs: 180000 }
      );
    } catch (err) {
      this.log(`  claude CLI failed: ${(err.message || "").slice(0, 200)}`);
      try { fs.unlinkSync(promptPath); } catch { /* ignore */ }
      this._recordRegenAttempt(key, "failed", model, 0);
      return { success: false, cost: 0 };
    }
    try { fs.unlinkSync(promptPath); } catch { /* ignore */ }

    // Estimate cost
    let cost = 0;
    try {
      const tokenLogger = require("../lib/token-logger");
      cost = tokenLogger.estimateClaudeCost(prompt.length, (result.stdout || "").length, model);
      this.addBudgetSpend(cost);

      // Detect budget exhaustion
      const exhaustion = tokenLogger.detectBudgetExhaustion(result.stdout || "", result.ok ? 0 : 1);
      if (exhaustion.exhausted || exhaustion.partial) {
        this.log(`  budget exhausted/partial — discarding output`);
        tokenLogger.logBudgetOutcome("test-regen", `regen-${personaId}`, model, cost, "budget_exceeded", false);
        // Don't count as failure — defer
        return { success: false, skipped: true, cost };
      }
    } catch { /* non-fatal */ }

    if (!result.ok || !result.stdout) {
      this.log(`  regen failed (no output)`);
      this._recordRegenAttempt(key, "failed", model, cost);
      try {
        const tokenLogger = require("../lib/token-logger");
        tokenLogger.logBudgetOutcome("test-regen", `regen-${personaId}`, model, cost, "failure", false);
      } catch { /* non-fatal */ }
      return { success: false, cost };
    }

    // Validate output
    const output = result.stdout;
    if (!output.includes('from "../../fixtures/test"') && !output.includes("from '../../fixtures/test'")) {
      this.log(`  regen output missing fixture import — invalid`);
      this._recordRegenAttempt(key, "failed", model, cost);
      return { success: false, cost };
    }

    if (!output.includes("test(") && !output.includes("test.describe(")) {
      this.log(`  regen output missing test() calls — invalid`);
      this._recordRegenAttempt(key, "failed", model, cost);
      return { success: false, cost };
    }

    // Extract code block if wrapped in markdown
    let newSpec = output;
    const codeBlockMatch = output.match(/```(?:typescript|ts)?\n([\s\S]+?)```/);
    if (codeBlockMatch) {
      newSpec = codeBlockMatch[1];
    }

    // Backup current spec
    const backupPath = `${specPath}.bak-regen-${new Date().toISOString().slice(0, 10)}`;
    try {
      fs.copyFileSync(specPath, backupPath);
    } catch { /* non-fatal */ }

    // Write new spec
    fs.writeFileSync(specPath, newSpec);

    // Validate by running a quick test (1 worker, 2-minute timeout)
    let testPassed = false;
    try {
      const testResult = this.exec(
        `npx playwright test "${specFile}" --workers=1 --reporter=list --timeout=60000`,
        { label: "validate-regen", timeoutMs: 120000 }
      );
      testPassed = testResult.ok;
    } catch {
      testPassed = false;
    }

    if (testPassed) {
      // Success — keep new spec, recover from quarantine
      this.log(`  regen SUCCEEDED for ${personaId}`);
      try { fs.unlinkSync(backupPath); } catch { /* ignore */ }

      this._recordRegenAttempt(key, "regenerated", model, cost);

      // Auto-recover from quarantine
      try {
        const { recoverTest } = require("../test-quarantine");
        recoverTest(key, "regen");
      } catch { /* non-fatal */ }

      try {
        const tokenLogger = require("../lib/token-logger");
        tokenLogger.logBudgetOutcome("test-regen", `regen-${personaId}`, model, cost, "success", true);
      } catch { /* non-fatal */ }

      return { success: true, cost };
    } else {
      // Failed — revert from backup
      this.log(`  regen test validation FAILED — reverting`);
      try {
        if (fs.existsSync(backupPath)) {
          fs.copyFileSync(backupPath, specPath);
          fs.unlinkSync(backupPath);
        } else {
          this.log(`  WARNING: backup missing at ${backupPath}, spec may be corrupted — restoring from git`);
          try {
            require("child_process").execSync(`git checkout -- "${specPath}"`, { cwd: path.resolve(__dirname, "..", "..", ".."), timeout: 10000 });
          } catch { /* git restore failed — spec stays corrupted, test will re-enter quarantine */ }
        }
      } catch { /* non-fatal */ }

      const attempts = (candidate.attempts ?? 0) + 1;
      const status = attempts >= (this.clawConfig.maxRegenAttempts ?? 2) ? "needs-human" : "failed";
      this._recordRegenAttempt(key, status, model, cost);

      try {
        const tokenLogger = require("../lib/token-logger");
        tokenLogger.logBudgetOutcome("test-regen", `regen-${personaId}`, model, cost, "failure", false);
      } catch { /* non-fatal */ }

      return { success: false, cost };
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt building
  // ---------------------------------------------------------------------------

  _buildRegenPrompt({ specContent, personaId, testTitle, failureType, lastError, pageSourceSnippets, manifestPages, gitDiff, evolutionRecommendations }) {
    return `You are regenerating a Playwright E2E test that has been persistently failing.

## Context

**Persona:** ${personaId}
**Failing test:** ${testTitle || "unknown"}
**Failure type:** ${failureType || "unknown"}
**Last error:** ${(lastError || "no error recorded").slice(0, 500)}

## Current Spec File (BROKEN — needs regeneration)

\`\`\`typescript
${specContent.slice(0, 4000)}
\`\`\`

## Current Page Source (what the app actually renders)

${pageSourceSnippets.slice(0, 3000)}

## Manifest Pages for This Persona

${manifestPages.slice(0, 10).join("\n") || "none"}

## Recent Code Changes (git diff)

\`\`\`diff
${gitDiff.slice(0, 2000)}
\`\`\`
${evolutionRecommendations || ""}
## Instructions

1. Regenerate the test to match the CURRENT application state.
2. Keep the same persona, fixture imports, and test structure pattern.
3. Use the EXACT import: \`import { test, expect } from "../../fixtures/test"\`
4. Update selectors to match current page HTML.
5. Preserve the persona's testing focus (security, accessibility, dark mode, etc).
6. Only output the TypeScript test file — no explanations.
7. Use test() and test.describe() from the fixture.
8. Include sim.navigateTo() calls for navigation.
`;
  }

  /**
   * Read page source files referenced in the spec.
   */
  _readPageSources(specContent) {
    const snippets = [];
    const gotoRegex = /(?:page\.goto|sim\.navigateTo)\s*\(\s*['"`]([^'"`$]+)/g;
    let match;
    const seen = new Set();

    while ((match = gotoRegex.exec(specContent)) !== null) {
      const pagePath = match[1].replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
      if (seen.has(pagePath)) { continue; }
      seen.add(pagePath);

      // Map URL path to filesystem path
      const fsPath = pagePath.replace(/^\//, "").replace(/\[([^\]]+)\]/g, "[$1]");
      const candidates = [
        path.join(ROOT, "app", fsPath, "page.tsx"),
        path.join(ROOT, "app", fsPath, "page.ts"),
        path.join(ROOT, "app", fsPath + ".tsx"),
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          try {
            const content = fs.readFileSync(candidate, "utf-8");
            const lines = content.split("\n").slice(0, 150);
            snippets.push(`### ${pagePath} (${path.relative(ROOT, candidate)})\n\`\`\`tsx\n${lines.join("\n")}\n\`\`\``);
          } catch { /* skip */ }
          break;
        }
      }
    }

    return snippets.join("\n\n");
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  _loadRegenState() {
    try {
      if (fs.existsSync(REGEN_STATE_PATH)) {
        return JSON.parse(fs.readFileSync(REGEN_STATE_PATH, "utf-8"));
      }
    } catch { /* fresh start */ }
    return {
      candidates: {},
      stats: { total: 0, succeeded: 0, failed: 0, needsHuman: 0, totalCost: 0 },
      lastRun: null,
    };
  }

  _recordRegenAttempt(key, status, model, cost) {
    const state = this._loadRegenState();
    if (!state.candidates) { state.candidates = {}; }

    const existing = state.candidates[key] || {
      status: "pending",
      attempts: 0,
      firstQueued: new Date().toISOString(),
      model: null,
      cost: 0,
    };

    existing.status = status;
    existing.attempts = (existing.attempts ?? 0) + 1;
    existing.lastAttempt = new Date().toISOString();
    existing.model = model;
    existing.cost = (existing.cost ?? 0) + cost;

    state.candidates[key] = existing;

    // Update quarantine regen status
    try {
      const { updateRegenStatus } = require("../test-quarantine");
      updateRegenStatus(key, status, existing.attempts);
    } catch { /* non-fatal */ }

    // Prune old candidates (keep max 500, remove oldest completed/needs-human first)
    const candidateKeys = Object.keys(state.candidates ?? {});
    if (candidateKeys.length > 500) {
      const sortable = candidateKeys.map((k) => ({ key: k, ...state.candidates[k] }));
      // Remove terminal-state candidates first (needs-human, succeeded), oldest first
      const removable = sortable
        .filter((c) => c.status === "needs-human" || c.status === "succeeded")
        .sort((a, b) => new Date(a.lastAttempt || 0).getTime() - new Date(b.lastAttempt || 0).getTime());
      const toRemove = removable.slice(0, candidateKeys.length - 500);
      for (const r of toRemove) { delete state.candidates[r.key]; }
    }

    fs.writeFileSync(REGEN_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  }

  _updateRegenState(results) {
    const state = this._loadRegenState();
    state.stats = state.stats ?? {};
    state.stats.total = Object.keys(state.candidates ?? {}).length;
    state.stats.succeeded = (state.stats.succeeded ?? 0) + results.succeeded;
    state.stats.failed = (state.stats.failed ?? 0) + results.failed;
    state.stats.needsHuman = Object.values(state.candidates ?? {})
      .filter((c) => c.status === "needs-human").length;
    state.stats.totalCost = (state.stats.totalCost ?? 0) + results.totalCost;
    state.lastRun = new Date().toISOString();

    fs.writeFileSync(REGEN_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  }
}

// Direct execution
if (require.main === module) {
  const claw = new TestRegenClaw();
  claw.start().catch((err) => {
    console.error(`test-regen fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = TestRegenClaw;
