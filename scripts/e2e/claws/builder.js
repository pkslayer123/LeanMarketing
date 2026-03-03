#!/usr/bin/env node

/**
 * Claw 6: Builder
 *
 * Owns: Reading BUILD-SPEC, detecting unbuilt features, scaffolding new code via LLM.
 * Schedule: Triggered by mocs-ready signal OR periodic (every 2h). Only runs when enabled.
 * Reads: BUILD-SPEC.md, manifest.json, moc-queue.json
 * Writes: moc-queue.json (build MOCs), area-convergence.json
 * Emits: build-complete signal
 *
 * Reads BUILD-SPEC, detects features not yet built, and scaffolds them via LLM.
 * Works for any project with a BUILD-SPEC.md (including ChangePilot itself).
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Claw, ROOT, STATE_DIR } = require("../claw");

const QUEUE_PATH = path.join(STATE_DIR, "moc-queue.json");
const MANIFEST_PATH = path.join(STATE_DIR, "manifest.json");
const BUILDER_STATE_PATH = path.join(STATE_DIR, "builder-state.json");

class BuilderClaw extends Claw {
  constructor() {
    super("builder");
    this.specPath = this.clawConfig.specPath ?? path.join(ROOT, "docs", "BUILD-SPEC.md");
  }

  async run() {
    const phases = [];

    // Budget gate: skip expensive work if hourly budget exhausted
    if (this.isHourlyBudgetExhausted()) {
      this.log("hourly budget exhausted — deferring scaffold");
      return { ok: true, summary: "budget exhausted — deferred" };
    }

    // Phase 0: Compute compliance score and determine build phase
    const compResult = this.exec("node scripts/e2e/spec-compliance-scorer.js", {
      label: "compliance-score",
      timeoutMs: 30000,
    });
    phases.push({ name: "compliance-score", ok: compResult.ok });
    const complianceReport = this.readState("spec-compliance-report.json");
    const buildPhase = complianceReport?.phase ?? "build";
    const complianceScore = complianceReport?.score ?? 0;

    this.log(`Compliance: ${complianceScore} — phase: ${buildPhase}`);

    // Converged/polish phases still scan for gaps — just at slower intervals.
    // Never fully suspend: spec can change, regressions can appear.
    if (buildPhase === "converged") {
      this.log("Converged — scanning for regressions/new gaps (slow interval)");
      this._adaptInterval(0, "converged");
      // Don't return early — fall through to gap detection
    }

    if (buildPhase === "polish") {
      this.log("Polish phase — slow builds, prioritizing gap closure");
      this._adaptInterval(0, "polish");
      // Don't return early — fall through to gap detection
    }

    // Phase 1: Load and parse BUILD-SPEC
    const specSections = this._parseSpec();
    if (!specSections || specSections.length === 0) {
      this.log("No spec sections found — nothing to build");
      return { ok: true, summary: "no spec sections" };
    }

    // Phase 2: Detect unbuilt features by comparing spec to filesystem/manifest
    const manifest = this._loadManifest();
    const gaps = this._detectGaps(specSections, manifest);
    this.log(`Spec analysis: ${specSections.length} sections, ${gaps.length} unbuilt`);

    // In converged/polish/stabilize phases, cap builds to 1 per cycle
    // BUT: override to "build" phase when most features are unbuilt (>70% gaps)
    const gapRatio = gaps.length / specSections.length;
    const effectivePhase = gapRatio > 0.7 ? "build" : buildPhase;
    if (effectivePhase !== buildPhase) {
      this.log(`Phase override: ${buildPhase} → ${effectivePhase} (${gaps.length}/${specSections.length} features unbuilt)`);
    }
    const slowPhase = ["converged", "polish", "stabilize"].includes(effectivePhase);
    const stabilizeCap = slowPhase ? 1 : undefined;

    if (gaps.length === 0) {
      this._updateBuilderState(specSections.length, 0);
      this._adaptInterval(0, buildPhase);
      this.log("All spec features built — builder idle");
      this.emitSignal("build-complete", {
        iteration: this.currentCycle,
        specCompletionRate: 1.0,
        gapsRemaining: 0,
      });
      return { ok: true, summary: "spec complete (100%)" };
    }
    phases.push({ name: "gap-detection", ok: true });

    // Phase 3: Create build MOCs for unbuilt features (one per gap, capped per cycle)
    const maxPerCycle = stabilizeCap ?? (this.clawConfig.maxBuildsPerCycle ?? 3);
    const mocsCreated = this._createBuildMocs(gaps.slice(0, maxPerCycle));
    this.log(`Created ${mocsCreated} build MOCs from ${gaps.length} gaps`);
    phases.push({ name: "create-build-mocs", ok: mocsCreated >= 0 });

    // Phase 4: Attempt to scaffold the highest-priority gap via LLM
    const scaffolded = await this._scaffoldFeature(gaps[0]);
    if (scaffolded) {
      phases.push({ name: "scaffold", ok: true });

      // Phase 4.5: Update manifest with new routes and generate tests
      this._updateManifestFromGap(gaps[0]);
      this._generateTestsForGap(gaps[0]);
      this.emitSignal("tests-regenerated", {
        feature: gaps[0].featureKey,
        routes: gaps[0].routes,
      });
    }

    // Phase 4.6: Read findings to identify regressions from last build
    this._checkFindingsForBuildRegressions(gaps[0]);

    // Phase 5: Commit and push (if files changed)
    const committed = this._commitAndPush(scaffolded ? gaps[0] : null);
    phases.push({ name: "commit", ok: committed });

    // Update state and emit signal
    const completionRate = (specSections.length - gaps.length) / specSections.length;
    this._updateBuilderState(specSections.length, gaps.length);
    this.emitSignal("build-complete", {
      iteration: this.currentCycle,
      specCompletionRate: Math.round(completionRate * 100) / 100,
      complianceScore,
      phase: buildPhase,
      gapsRemaining: gaps.length,
      mocsCreated,
      scaffolded: scaffolded ? 1 : 0,
    });

    // Adapt interval based on remaining work
    this._adaptInterval(gaps.length, buildPhase);

    const failedPhases = phases.filter((p) => !p.ok).map((p) => p.name);
    return {
      ok: failedPhases.length === 0,
      summary: `${completionRate * 100}% complete, ${gaps.length} gaps, ${mocsCreated} MOCs${failedPhases.length ? ` [failed: ${failedPhases.join(",")}]` : ""}`,
    };
  }

  _updateManifestFromGap(gap) {
    try {
      const manifest = this._loadManifest();
      if (!manifest.features) { manifest.features = {}; }

      manifest.features[gap.featureKey] = {
        name: gap.name,
        routes: gap.routes,
        builtAt: new Date().toISOString(),
        builtBy: "builder-claw",
        status: "scaffolded",
      };

      fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
      this.log(`Updated manifest with feature: ${gap.featureKey}`);
    } catch (err) {
      this.log(`Manifest update failed: ${(err.message ?? "").slice(0, 100)}`);
    }
  }

  _generateTestsForGap(gap) {
    try {
      const genScript = path.join(ROOT, "scripts", "e2e", "generate-tests.js");
      if (!fs.existsSync(genScript)) {
        this.log("generate-tests.js not found — skipping test generation");
        return;
      }

      const result = this.exec(
        `node scripts/e2e/generate-tests.js --feature ${gap.featureKey}`,
        { label: "generate-tests", timeoutMs: 60000 }
      );

      if (result.ok) {
        this.log(`Tests generated for feature: ${gap.featureKey}`);
      }
    } catch (err) {
      this.log(`Test generation failed: ${(err.message ?? "").slice(0, 100)}`);
    }
  }

  _checkFindingsForBuildRegressions(gap) {
    try {
      const findingsPath = path.join(STATE_DIR, "findings", "findings.json");
      if (!fs.existsSync(findingsPath)) { return; }

      const data = JSON.parse(fs.readFileSync(findingsPath, "utf-8"));
      const findings = data.findings ?? data;
      if (!Array.isArray(findings)) { return; }

      const relatedFindings = findings.filter((f) => {
        if (f.status === "resolved") { return false; }
        const matchesRoute = gap.routes.some((r) => f.page?.includes(r) || f.url?.includes(r));
        const matchesFeature = f.featureKey === gap.featureKey;
        return matchesRoute || matchesFeature;
      });

      if (relatedFindings.length > 0) {
        this.log(`Found ${relatedFindings.length} open findings related to ${gap.featureKey} — builder should address these`);
      }
    } catch { /* non-fatal */ }
  }

  _parseSpec() {
    if (!fs.existsSync(this.specPath)) {
      this.log(`BUILD-SPEC not found: ${this.specPath}`);
      return [];
    }

    const content = fs.readFileSync(this.specPath, "utf-8");

    // Find the "## Feature Areas" section — all buildable features are H3 headers under it
    const featureAreasMatch = content.match(/^## Feature Areas\s*$/m);
    if (!featureAreasMatch) {
      this.log("BUILD-SPEC has no '## Feature Areas' section");
      return [];
    }

    const featureAreasStart = featureAreasMatch.index + featureAreasMatch[0].length;
    // Feature Areas ends at the next H2 header or EOF
    const nextH2 = content.slice(featureAreasStart).match(/^## [^#]/m);
    const featureAreasEnd = nextH2 ? featureAreasStart + nextH2.index : content.length;
    const featureContent = content.slice(featureAreasStart, featureAreasEnd);

    // Parse H3 headers within Feature Areas
    const sections = [];
    const headerRegex = /^### (.+)$/gm;
    const matches = [];
    let match;
    while ((match = headerRegex.exec(featureContent)) !== null) {
      matches.push({ name: match[1].trim(), index: match.index, length: match[0].length });
    }

    // Skip non-feature sections (reference/meta content)
    const skipSections = new Set([
      "active persona coverage (57 personas)",
      "code area mapping",
    ]);

    for (let i = 0; i < matches.length; i++) {
      const { name, index, length } = matches[i];
      if (skipSections.has(name.toLowerCase())) { continue; }

      const start = index + length;
      const end = i + 1 < matches.length ? matches[i + 1].index : featureContent.length;
      const body = featureContent.slice(start, end).trim();

      // Extract codeAreas from the structured field (e.g., **codeAreas:** `app/moc/new/`, `lib/...`)
      const codeAreas = [];
      const codeAreasMatch = body.match(/\*\*codeAreas:\*\*\s*(.+)/i);
      if (codeAreasMatch) {
        const areaStr = codeAreasMatch[1];
        const areaRegex = /`([^`]+)`/g;
        let areaMatch;
        while ((areaMatch = areaRegex.exec(areaStr)) !== null) {
          codeAreas.push(areaMatch[1].replace(/\/+$/, "")); // trim trailing slash
        }
      }

      // Extract Gap column values from the spec table
      // Only parse tables with the standard header: | Aspect | ... | Gap |
      const gapValues = [];
      const lines = body.split("\n");
      let inGapTable = false;
      let gapColIndex = -1;
      for (const line of lines) {
        if (!line.trim().startsWith("|")) {
          inGapTable = false;
          gapColIndex = -1;
          continue;
        }
        const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
        if (!inGapTable) {
          // Look for header row containing "Gap" column
          gapColIndex = cells.findIndex((c) => c === "Gap");
          if (gapColIndex >= 0) {
            inGapTable = true;
          }
          continue;
        }
        // Skip separator row (---)
        if (cells[0] && cells[0].match(/^-+$/)) { continue; }
        // Extract gap value from the identified column
        if (gapColIndex >= 0 && gapColIndex < cells.length) {
          const gap = cells[gapColIndex].trim();
          if (gap && gap !== "None" && !gap.match(/^-+$/)) {
            gapValues.push(gap);
          }
        }
      }

      // Extract URL routes from the body (patterns like /path in backticks)
      const routes = [];
      const routeRegex = /`(\/[a-z0-9[\]/-]+)`/gi;
      let routeMatch;
      while ((routeMatch = routeRegex.exec(body)) !== null) {
        routes.push(routeMatch[1]);
      }

      sections.push({
        name,
        body: body.slice(0, 1000),
        codeAreas,
        routes,
        gapValues,
      });
    }

    return sections;
  }

  _loadManifest() {
    if (!fs.existsSync(MANIFEST_PATH)) {
      return { features: {} };
    }
    try {
      return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    } catch {
      return { features: {} };
    }
  }

  _detectGaps(specSections, manifest) {
    const gaps = [];

    for (const section of specSections) {
      const featureKey = section.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

      // 1. Check Gap column from BUILD-SPEC table — the spec itself says what's missing
      const specGaps = (section.gapValues ?? []).filter((g) =>
        g !== "None" && g !== "--" && g !== ""
      );
      const hasSpecGaps = specGaps.length > 0;

      // 2. Check if codeAreas files exist on disk — primary signal for "is this built?"
      let codeAreasMissing = 0;
      const codeAreasTotal = (section.codeAreas ?? []).length;
      for (const area of section.codeAreas ?? []) {
        const fullPath = path.join(ROOT, area);
        // Check as file (with common extensions) or directory
        const exists = fs.existsSync(fullPath) ||
          fs.existsSync(fullPath + ".ts") ||
          fs.existsSync(fullPath + ".tsx") ||
          fs.existsSync(fullPath + "/page.tsx") ||
          fs.existsSync(fullPath + "/route.ts");
        if (!exists) {
          codeAreasMissing++;
        }
      }

      const codeAreaCoverage = codeAreasTotal > 0 ? (codeAreasTotal - codeAreasMissing) / codeAreasTotal : 1;

      // A section is "built" if: no spec-declared gaps AND code areas mostly exist (>=80%)
      // Code area existence is the primary signal — this is a live production app,
      // so if the files are on disk, the feature is built. Manifest is informational only.
      if (!hasSpecGaps && codeAreaCoverage >= 0.8) {
        continue;
      }

      // Determine gap severity for prioritization
      let severity = "minor";
      if (codeAreasMissing > 0 && codeAreaCoverage < 0.5) {
        severity = "major"; // Most code areas missing — feature largely unbuilt
      } else if (hasSpecGaps && specGaps.some((g) => /major|critical/i.test(g))) {
        severity = "major";
      }

      gaps.push({
        featureKey,
        name: section.name,
        description: section.body,
        routes: section.routes ?? [],
        codeAreas: section.codeAreas ?? [],
        specGaps,
        codeAreasMissing,
        codeAreasTotal,
        codeAreaCoverage,
        severity,
      });
    }

    return gaps;
  }

  _createBuildMocs(gaps) {
    let created = 0;
    this.withStateLock("moc-queue.json", (queue) => {
      if (!Array.isArray(queue.mocs)) {
        queue.mocs = [];
      }

      for (const gap of gaps) {
        // Dedup: skip if build MOC for this feature already exists
        const exists = queue.mocs.some((m) =>
          m.tier === "build" && m.featureKey === gap.featureKey && !["archived", "implemented"].includes(m.status)
        );
        if (exists) {
          continue;
        }

        queue.mocs.push({
          id: `build-${gap.featureKey}-${Date.now()}`,
          title: `Build feature: ${gap.name}`,
          description: `**Feature:** ${gap.name}\n**Routes:** ${gap.routes.join(", ") || "TBD"}\n\n${gap.description}`,
          tier: "build",
          status: "approved",
          featureKey: gap.featureKey,
          createdAt: new Date().toISOString(),
          source: "builder-claw",
        });
        created++;
      }
    }, { mocs: [] });
    return created;
  }

  async _scaffoldFeature(gap) {
    if (!gap) {
      return false;
    }

    // Check for Claude CLI availability
    const claudeAvailable = this._isClaudeAvailable();
    if (!claudeAvailable) {
      this.log("Claude CLI not available — emitting cursor fix prompt for builder");
      this._emitCursorBuildPrompt(gap);
      return false;
    }

    const prompt = this._buildScaffoldPrompt(gap);

    // Write prompt to temp file so we can pipe it to Claude CLI
    const promptPath = path.join(STATE_DIR, `builder-prompt-${process.pid}.md`);
    fs.writeFileSync(promptPath, prompt);

    try {
      this.log(`Scaffolding feature: ${gap.name} via Claude CLI`);
      // Use execAsync so the claw can respond to shutdown signals
      const result = await this.execAsync(
        `claude --print --dangerously-skip-permissions --model sonnet --max-budget-usd 3.00 < "${promptPath}"`,
        { label: "claude-scaffold", timeoutMs: 300000, env: { CLAUDECODE: "", CLAUDE_CODE: "", CLAUDE_CODE_ENTRYPOINT: "builder" } }
      );
      try { fs.unlinkSync(promptPath); } catch {}

      // Track budget spend
      const promptSize = fs.existsSync(promptPath) ? 0 : prompt.length;
      const outputSize = (result.stdout || "").length;
      try {
        const tokenLogger = require("../lib/token-logger");
        const estimated = tokenLogger.estimateClaudeCost(promptSize || prompt.length, outputSize, "sonnet");
        this.addBudgetSpend(estimated);

        // Detect truncated output
        const exhaustion = tokenLogger.detectBudgetExhaustion(result.stdout || "", result.ok ? 0 : 1);
        const outcome = exhaustion.exhausted ? "budget_exceeded"
          : exhaustion.partial ? "partial"
          : result.ok ? "success" : "failure";
        tokenLogger.logBudgetOutcome("builder", `scaffold-${gap.featureKey}`, "sonnet", estimated, outcome, result.ok && !exhaustion.partial);
      } catch { /* non-fatal */ }

      if (result.ok) {
        this.log(`Claude scaffolding complete: ${result.stdout.slice(0, 200)}`);
      } else {
        this.log(`Scaffold failed: ${result.stderr.slice(0, 200)}`);
      }
      return result.ok;
    } catch (err) {
      try { fs.unlinkSync(promptPath); } catch {}
      this.log(`Scaffold failed: ${(err.message ?? "").slice(0, 200)}`);
      return false;
    }
  }

  _buildScaffoldPrompt(gap) {
    return `You are building a new feature for a Next.js application based on a BUILD-SPEC.

## Feature to Build: ${gap.name}

${gap.description}

## Expected Routes
${gap.routes.length > 0 ? gap.routes.map((r) => `- ${r}`).join("\n") : "- Determine appropriate routes from the feature description"}

## Instructions
1. Create the necessary page routes under app/ (page.tsx files)
2. Create any needed API routes under app/api/ (route.ts files)
3. Create shared components under components/
4. If the feature needs database tables, create a Supabase migration file
5. Use the project's existing patterns: Tailwind CSS for styling, Supabase for DB, handleGET/handlePOST for API routes
6. After creating files, run \`npx tsc --noEmit\` to verify no type errors

## Project Structure
- app/ — Next.js App Router pages and API routes
- components/ — Shared UI components
- lib/ — Utilities, services, hooks
- supabase/migrations/ — Database migrations (numbered sequentially)

Keep the implementation minimal but functional. Focus on getting the route and basic UI working so persona tests can validate it.
`;
  }

  _emitCursorBuildPrompt(gap) {
    const promptPath = path.join(STATE_DIR, "builder-fix-prompt.md");
    const content = `# Builder Prompt — Scaffold Feature: ${gap.name}

${this._buildScaffoldPrompt(gap)}

---
*Generated by builder claw at ${new Date().toISOString()}*
`;
    fs.writeFileSync(promptPath, content);
    this.log(`Cursor build prompt written to: ${promptPath}`);
  }

  _isClaudeAvailable() {
    try {
      execSync("claude --version", { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  _commitAndPush(scaffoldedGap) {
    if (!this.acquireGitLock()) { return false; }
    try {
      // Only stage app/, components/, lib/, supabase/, e2e/state/ — never use git add -A
      this.exec(
        'git add app/ components/ lib/ supabase/ e2e/state/ e2e/reports/ docs/ 2>/dev/null || true',
        { label: "git-add-scaffold" }
      );

      const diffResult = this.exec(
        'git diff --cached --quiet',
        { label: "git-diff-check" }
      );
      // exit 0 = no changes staged
      if (diffResult.ok) {
        return false;
      }

      // Build detailed commit message
      const commitMsg = this._buildCommitMessage(scaffoldedGap);
      const commitMsgFile = path.join(STATE_DIR, `.builder-commit-msg-${process.pid}`);
      fs.writeFileSync(commitMsgFile, commitMsg);

      this.exec(
        `git commit --no-verify -F "${commitMsgFile}"`,
        { label: "git-commit-scaffold" }
      );
      try { fs.unlinkSync(commitMsgFile); } catch { /* ignore */ }

      // Only push when actual code was scaffolded — triggers Vercel deploy.
      // State-only commits (no scaffoldedGap) accumulate locally.
      if (!scaffoldedGap) {
        this.log("state-only commit — skipping push (no Vercel build needed)");
        return true;
      }

      // Builder created code — push to trigger Vercel deploy
      // Squash accumulated chore commits so deploy title shows the scaffold, not a health report
      this._squashChoreCommitsBeforePush();
      // Pull first to avoid divergence
      const pullResult = this.exec("git pull --rebase --autostash 2>&1 || true", { label: "git-pull-rebase" });
      if (pullResult.stderr && pullResult.stderr.includes("CONFLICT")) {
        this.log("CONFLICT: git pull --rebase found conflicts, aborting rebase");
        this.exec("git rebase --abort 2>/dev/null || true", { label: "git-rebase-abort" });
        this.emitSignal("git-conflict", { claw: this.name, detail: "rebase conflict on push" });
        return true; // commit succeeded, push failed
      }
      const pushResult = this.exec("git push --no-verify 2>&1", { label: "git-push-scaffold" });
      if (!pushResult.ok) {
        this.log(`git push failed: ${(pushResult.stderr || "").slice(0, 200)}`);
        this.emitSignal("git-conflict", { claw: this.name, detail: "push failed" });
      } else {
        this.log("Committed and pushed scaffold changes");
      }
      return true;
    } catch (err) {
      this.log(`Commit/push failed: ${(err.message ?? "").slice(0, 100)}`);
      try { fs.unlinkSync(path.join(STATE_DIR, `.builder-commit-msg-${process.pid}`)); } catch { /* ignore */ }
      return false;
    } finally {
      this.releaseGitLock();
    }
  }

  _buildCommitMessage(scaffoldedGap) {
    // Get list of staged files for the body
    let stagedFiles = [];
    try {
      const result = this.exec('git diff --cached --name-only', { label: "git-diff-names" });
      if (result.ok) {
        stagedFiles = result.stdout.trim().split("\n").filter(Boolean);
      }
    } catch { /* ignore */ }

    // Subject line: include feature name if available
    let subject;
    if (scaffoldedGap) {
      subject = `feat: scaffold "${scaffoldedGap.name}" from BUILD-SPEC [builder-claw]`;
    } else {
      subject = `chore: builder state sync [builder-claw]`;
    }
    // Keep subject under 120 chars
    if (subject.length > 120) {
      subject = subject.slice(0, 117) + "...";
    }

    const lines = [""];

    if (scaffoldedGap) {
      lines.push(`Feature: ${scaffoldedGap.name}`);
      if (scaffoldedGap.featureKey) {
        lines.push(`Key: ${scaffoldedGap.featureKey}`);
      }
      if (scaffoldedGap.routes && scaffoldedGap.routes.length > 0) {
        lines.push(`Routes: ${scaffoldedGap.routes.join(", ")}`);
      }
      if (scaffoldedGap.description) {
        lines.push(`\n${scaffoldedGap.description.slice(0, 300)}`);
      }
    }

    // List files changed
    if (stagedFiles.length > 0) {
      lines.push("");
      lines.push("Files changed:");
      const appFiles = stagedFiles.filter((f) => !f.startsWith("e2e/state/") && !f.startsWith("e2e/reports/") && !f.startsWith("docs/"));
      const stateFiles = stagedFiles.filter((f) => f.startsWith("e2e/state/") || f.startsWith("e2e/reports/") || f.startsWith("docs/"));

      for (const f of appFiles.slice(0, 15)) {
        lines.push(`  * ${f}`);
      }
      if (appFiles.length > 15) {
        lines.push(`  * ... and ${appFiles.length - 15} more`);
      }
      if (stateFiles.length > 0) {
        lines.push(`  + ${stateFiles.length} state/report/doc file(s)`);
      }
    }

    return subject + "\n" + lines.join("\n");
  }

  /**
   * Adapt run interval based on remaining gaps and build phase.
   * Many gaps → run frequently (30min). Few gaps → slow down. No gaps → 6h idle.
   */
  _adaptInterval(gapCount, phase) {
    const configInterval = (this.clawConfig.intervalMinutes ?? 120) * 60 * 1000;
    let newInterval;

    if (phase === "converged" || phase === "polish") {
      // Done building — check infrequently in case spec changes
      newInterval = 6 * 60 * 60 * 1000; // 6 hours
    } else if (gapCount === 0) {
      // All built but not converged yet — moderate check rate
      newInterval = 4 * 60 * 60 * 1000; // 4 hours
    } else if (gapCount >= 5) {
      // Lots of work — run frequently
      newInterval = 30 * 60 * 1000; // 30 minutes
    } else if (gapCount >= 3) {
      // Moderate work
      newInterval = 60 * 60 * 1000; // 1 hour
    } else {
      // 1-2 gaps — use config default
      newInterval = configInterval;
    }

    if (newInterval !== this.intervalMs) {
      const oldMin = Math.round(this.intervalMs / 60000);
      const newMin = Math.round(newInterval / 60000);
      this.log(`adaptive interval: ${oldMin}min → ${newMin}min (${gapCount} gaps, phase: ${phase})`);
      this.intervalMs = newInterval;
    }
  }

  _updateBuilderState(totalSections, gapCount) {
    const state = {
      totalSections,
      gapsRemaining: gapCount,
      specCompletionRate: totalSections > 0 ? (totalSections - gapCount) / totalSections : 1,
      lastUpdated: new Date().toISOString(),
      cycle: this.currentCycle,
    };
    try {
      fs.writeFileSync(BUILDER_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    } catch { /* non-fatal */ }
  }
}

if (require.main === module) {
  const claw = new BuilderClaw();
  claw.start();
}

module.exports = { BuilderClaw };
