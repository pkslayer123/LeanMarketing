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
const { execSync, spawnSync } = require("child_process");
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
    // Skip gaps that Claude already said "nothing to do" — rotate to next gap
    const skipState = this._loadSkipState();
    let targetGap = null;
    for (const gap of gaps) {
      const skipInfo = skipState[gap.featureKey];
      if (skipInfo && skipInfo.failCount >= 2 && (Date.now() - skipInfo.lastAttempt) < 3600000) {
        this.log(`Skipping ${gap.name} (${skipInfo.failCount} consecutive no-ops, retry in ${Math.round((3600000 - (Date.now() - skipInfo.lastAttempt)) / 60000)}min)`);
        continue;
      }
      targetGap = gap;
      break;
    }

    if (!targetGap) {
      // All gaps skipped — reset skip state and try again next cycle
      this.log("All gaps skipped — resetting skip state");
      this._saveSkipState({});
      targetGap = gaps[0];
    }

    const scaffolded = await this._scaffoldFeature(targetGap);
    if (scaffolded) {
      phases.push({ name: "scaffold", ok: true });
      // Clear skip state on success
      delete skipState[targetGap.featureKey];
      this._saveSkipState(skipState);

      // Phase 4.5: Update manifest with new routes and generate tests
      this._updateManifestFromGap(targetGap);
      this._generateTestsForGap(targetGap);
      this.emitSignal("tests-regenerated", {
        feature: targetGap.featureKey,
        routes: targetGap.routes,
      });
    } else {
      // Track failed attempt for skip rotation
      const prev = skipState[targetGap.featureKey] || { failCount: 0 };
      skipState[targetGap.featureKey] = { failCount: prev.failCount + 1, lastAttempt: Date.now() };
      this._saveSkipState(skipState);
      this.log(`Gap "${targetGap.name}" produced no files (attempt ${skipState[targetGap.featureKey].failCount})`);
    }

    // Phase 4.6: Read findings to identify regressions from last build
    this._checkFindingsForBuildRegressions(targetGap);

    // Phase 5: Commit and push (if files changed)
    const committed = this._commitAndPush(scaffolded ? targetGap : null);
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

      // 2. Deep file-level scan of each codeArea — don't just check if directory exists,
      //    enumerate actual files expected and check content quality.
      const fileReport = this._deepScanCodeAreas(section.codeAreas ?? []);

      // A section is "complete" only when ALL expected files exist AND have real content.
      // Previous bug: directory-level checks at 80% threshold falsely marked features as
      // "built" when a directory existed but most files inside were missing or stubs.
      if (fileReport.completionScore >= 0.95 && fileReport.thinFiles.length === 0) {
        continue;
      }

      // Determine gap severity for prioritization
      let severity = "minor";
      if (fileReport.completionScore < 0.5) {
        severity = "major"; // Feature is largely unbuilt
      } else if (fileReport.thinFiles.length > 2) {
        severity = "major"; // Many stub/thin files need substantial work
      }

      gaps.push({
        featureKey,
        name: section.name,
        description: section.body,
        routes: section.routes ?? [],
        codeAreas: section.codeAreas ?? [],
        specGaps,
        codeAreasMissing: fileReport.missingFiles.length,
        codeAreasTotal: fileReport.totalExpected,
        codeAreaCoverage: fileReport.completionScore,
        severity,
        missingFiles: fileReport.missingFiles,
        thinFiles: fileReport.thinFiles,
        existingFiles: fileReport.existingFiles,
      });
    }

    // Sort: least-built features first (lowest coverage), then by severity
    gaps.sort((a, b) => {
      if (a.codeAreaCoverage !== b.codeAreaCoverage) {
        return a.codeAreaCoverage - b.codeAreaCoverage; // 0% before 50%
      }
      const sevOrder = { major: 0, minor: 1 };
      return (sevOrder[a.severity] ?? 1) - (sevOrder[b.severity] ?? 1);
    });

    return gaps;
  }

  /**
   * Deep scan code areas: enumerate actual files inside directories, check content
   * quality, and report missing/thin/complete files.
   */
  _deepScanCodeAreas(codeAreas) {
    const missingFiles = [];
    const thinFiles = [];     // exist but <30 lines (likely stubs)
    const existingFiles = [];
    let totalExpected = 0;

    for (const area of codeAreas) {
      const fullPath = path.join(ROOT, area);

      // If codeArea is a single file (e.g. components/AuthForm.tsx)
      if (area.endsWith(".tsx") || area.endsWith(".ts") || area.endsWith(".js") || area.endsWith(".sql")) {
        totalExpected++;
        if (fs.existsSync(fullPath)) {
          const lines = this._countFileLines(fullPath);
          if (lines < 30) {
            thinFiles.push({ path: area, lines });
          } else {
            existingFiles.push({ path: area, lines });
          }
        } else {
          missingFiles.push(area);
        }
        continue;
      }

      // codeArea is a directory — enumerate expected files inside
      const expectedFiles = this._getExpectedFilesForArea(area);
      totalExpected += expectedFiles.length;

      for (const file of expectedFiles) {
        const filePath = path.join(ROOT, file);
        if (fs.existsSync(filePath)) {
          const lines = this._countFileLines(filePath);
          if (lines < 30) {
            thinFiles.push({ path: file, lines });
          } else {
            existingFiles.push({ path: file, lines });
          }
        } else {
          missingFiles.push(file);
        }
      }
    }

    // If no expected files were derived, fall back to checking directory existence
    if (totalExpected === 0) {
      totalExpected = codeAreas.length;
      for (const area of codeAreas) {
        const fullPath = path.join(ROOT, area);
        if (fs.existsSync(fullPath)) {
          existingFiles.push({ path: area, lines: -1 });
        } else {
          missingFiles.push(area);
        }
      }
    }

    const completionScore = totalExpected > 0
      ? (existingFiles.length) / totalExpected
      : 1;

    return { missingFiles, thinFiles, existingFiles, totalExpected, completionScore };
  }

  /**
   * Given a codeArea directory path (e.g. "app/dashboard/", "components/Dashboard/"),
   * return the list of specific files expected inside it based on conventions.
   */
  _getExpectedFilesForArea(area) {
    const fullPath = path.join(ROOT, area);
    const files = [];

    // Determine valid file extensions for this area
    const isMigrations = area.includes("migrations");
    const validExts = isMigrations
      ? [".sql", ".ts"]
      : [".ts", ".tsx"];

    // If directory exists, enumerate its actual files
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      try {
        const entries = this._walkDir(fullPath, 2); // max depth 2
        for (const entry of entries) {
          if (validExts.some(ext => entry.endsWith(ext))) {
            files.push(path.relative(ROOT, entry).replace(/\\/g, "/"));
          }
        }
      } catch { /* ignore */ }
    }

    // If directory doesn't exist or is empty, infer expected files from conventions
    if (files.length === 0) {
      const cleanArea = area.replace(/\/$/, "");
      if (cleanArea.startsWith("app/api/")) {
        files.push(`${cleanArea}/route.ts`);
      } else if (cleanArea.startsWith("app/")) {
        files.push(`${cleanArea}/page.tsx`);
      } else if (cleanArea.startsWith("components/")) {
        files.push(`${cleanArea}/index.tsx`);
      } else if (cleanArea.startsWith("lib/")) {
        files.push(`${cleanArea}/index.ts`);
      } else if (isMigrations) {
        // Migrations: expect at least one .sql file — don't infer index.ts
        files.push(`${cleanArea}/001_initial.sql`);
      } else {
        files.push(`${cleanArea}/index.ts`);
      }
    }

    return files;
  }

  _walkDir(dir, maxDepth, currentDepth = 0) {
    if (currentDepth >= maxDepth) return [];
    const results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this._walkDir(fullPath, maxDepth, currentDepth + 1));
        } else {
          results.push(fullPath);
        }
      }
    } catch { /* ignore */ }
    return results;
  }

  _countFileLines(filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return content.split("\n").length;
    } catch {
      return 0;
    }
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

    // Write prompt to temp file (same pattern as fix-engine)
    const promptPath = path.join(STATE_DIR, `builder-prompt-${process.pid}.md`);
    fs.writeFileSync(promptPath, prompt);

    try {
      this.log(`Scaffolding feature: ${gap.name} via Claude CLI`);

      // Snapshot git state before Claude runs (fix-engine pattern)
      let diffBefore = "";
      try {
        diffBefore = execSync("git diff --name-only", { cwd: ROOT, stdio: "pipe" }).toString().trim();
      } catch { /* ignore */ }

      // Use spawnSync with shell:false — proven pattern from fix-engine.
      // --print + --dangerously-skip-permissions: Claude writes files via Edit tool,
      // budget-controlled, non-interactive. Input via stdin, not shell redirection.
      const result = spawnSync(
        "claude",
        ["--print", "--dangerously-skip-permissions", "--model", "sonnet", "--max-budget-usd", "3.00"],
        {
          cwd: ROOT,
          input: fs.readFileSync(promptPath),
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 300000, // 5 min
          windowsHide: true,
          shell: false, // Direct spawn — no bash intermediary
          env: {
            ...process.env,
            CLAUDE_CODE_ENTRYPOINT: "builder",
            CLAUDECODE: "",
            CLAUDE_CODE: "",
          },
        }
      );
      try { fs.unlinkSync(promptPath); } catch {}

      const stdout = (result.stdout || "").toString();
      const stderr = (result.stderr || "").toString();
      const ok = result.status === 0;

      this.log(`Claude exit=${result.status} signal=${result.signal} stdout=${stdout.length}b stderr=${stderr.length}b cwd=${ROOT}`);
      if (stderr) this.log(`Claude stderr: ${stderr.slice(0, 500)}`);
      if (stdout) this.log(`Claude stdout preview: ${stdout.slice(0, 300)}`);

      // Track budget spend
      try {
        const tokenLogger = require("../lib/token-logger");
        const estimated = tokenLogger.estimateClaudeCost(prompt.length, stdout.length, "sonnet");
        this.addBudgetSpend(estimated);
        const outcome = ok ? "success" : "failure";
        tokenLogger.logBudgetOutcome("builder", `scaffold-${gap.featureKey}`, "sonnet", estimated, outcome, ok);
      } catch { /* non-fatal */ }

      // Check what Claude changed (fix-engine pattern: git diff before/after)
      let diffAfter = "";
      try {
        diffAfter = execSync("git diff --name-only", { cwd: ROOT, stdio: "pipe" }).toString().trim();
      } catch { /* ignore */ }

      const beforeSet = new Set(diffBefore.split("\n").filter(Boolean));
      const afterSet = new Set(diffAfter.split("\n").filter(Boolean));
      const newlyChanged = [...afterSet].filter((f) => !beforeSet.has(f));

      // Also check for untracked new files
      let untrackedFiles = [];
      try {
        const untracked = execSync("git ls-files --others --exclude-standard app/ components/ lib/ supabase/", { cwd: ROOT, stdio: "pipe" }).toString().trim();
        untrackedFiles = untracked.split("\n").filter(Boolean);
      } catch { /* ignore */ }

      const allNewFiles = [...new Set([...newlyChanged, ...untrackedFiles])];
      const codeChanges = allNewFiles.filter((f) =>
        f.startsWith("app/") || f.startsWith("lib/") || f.startsWith("components/") || f.startsWith("supabase/")
      );

      if (codeChanges.length > 0) {
        this.log(`Claude scaffolding complete: ${codeChanges.length} files changed (${codeChanges.slice(0, 5).join(", ")})`);
        return true;
      }

      // Claude ran but didn't write files — log output for debugging
      if (ok && stdout.trim()) {
        this.log(`Claude completed but no file changes detected. Output: ${stdout.slice(0, 300)}`);
        // Save raw output for debugging
        const debugPath = path.join(STATE_DIR, `builder-raw-output-${Date.now()}.md`);
        try { fs.writeFileSync(debugPath, stdout.slice(0, 50000)); } catch {}
      } else {
        this.log(`Scaffold failed (exit ${result.status}): ${stderr.slice(0, 200)}`);
      }
      return false;
    } catch (err) {
      try { fs.unlinkSync(promptPath); } catch {}
      this.log(`Scaffold failed: ${(err.message ?? "").slice(0, 200)}`);
      return false;
    }
  }

  _buildScaffoldPrompt(gap) {
    // Build detailed file lists from gap detection
    const missingFiles = gap.missingFiles || [];
    const thinFiles = gap.thinFiles || [];
    const existingFiles = gap.existingFiles || [];

    // Missing files section
    const missingSection = missingFiles.length > 0
      ? `\n## Files to Create (MUST CREATE THESE)\n${missingFiles.map(f => `- ${typeof f === 'string' ? f : f.path}`).join("\n")}\n`
      : "";

    // Thin/stub files that need substantial content
    let thinSection = "";
    if (thinFiles.length > 0) {
      thinSection = `\n## Files That Need Rewriting (too thin — currently stubs)\nThese files exist but are incomplete stubs. REWRITE them with full, production-quality implementations:\n`;
      for (const f of thinFiles) {
        const filePath = typeof f === 'string' ? f : f.path;
        const lineCount = typeof f === 'object' ? f.lines : '?';
        // Read the thin file content so Claude can see what needs improvement
        let preview = "";
        try {
          const content = fs.readFileSync(path.join(ROOT, filePath), "utf-8");
          preview = content.slice(0, 500);
        } catch { /* ignore */ }
        thinSection += `\n### ${filePath} (${lineCount} lines — needs full rewrite)\n\`\`\`\n${preview}\n\`\`\`\n`;
      }
    }

    // Completed files — just list them so Claude knows what exists
    const existingSection = existingFiles.length > 0
      ? `\n## Already Complete (reference only — do not recreate)\n${existingFiles.map(f => `- ${typeof f === 'string' ? f : f.path} (${typeof f === 'object' ? f.lines : '?'} lines)`).join("\n")}\n`
      : "";

    const gapItems = (gap.specGaps || []).length > 0
      ? `\n## Specification Requirements (from BUILD-SPEC)\nThe spec says these aspects need implementation:\n${gap.specGaps.map(g => `- ${g}`).join("\n")}\n`
      : "";

    return `You are building a feature for a production Next.js application called "LeanMarketing".
This is an AI-assisted marketing governance tool for lean startups. It manages marketing campaigns
across a 6-layer validation funnel: Idea → Audience → Conversations → Conversion → Proof → Review.

## YOUR TASK: Build/Improve "${gap.name}"

${gap.description}
${missingSection}${thinSection}${existingSection}${gapItems}
## Expected Routes
${gap.routes.length > 0 ? gap.routes.map((r) => `- ${r}`).join("\n") : "- Determine appropriate routes from the feature description"}

## CRITICAL INSTRUCTIONS
1. You MUST create or edit files. Do not just describe what should be done — actually write the code.
2. If a file is listed under "Files to Create" — create it with a full implementation.
3. If a file is listed under "Files That Need Rewriting" — rewrite it completely with production-quality code.
4. Every component must be fully functional with real data fetching, forms, and error handling.
5. You MUST write at least 50 lines per page component and 30 lines per utility/lib file.

## Tech Stack
- Next.js App Router with TypeScript (use .tsx for components, .ts for utilities)
- Tailwind CSS for ALL styling (no CSS files)
- Supabase for database and auth (use \`@supabase/ssr\` createBrowserClient/createServerClient)
- React Server Components by default; add "use client" only when needed (hooks, interactivity)
- API routes: app/api/.../route.ts with GET/POST/PATCH/DELETE exports

## Design Requirements (MANDATORY)
- Navigation: Import the sidebar from components/Dashboard/Sidebar.tsx or create it if missing.
  It must show "LeanMarketing" branding and links to Dashboard, Settings, plus a logout button.
- Color scheme: indigo-600 primary, gray-50 page backgrounds, white cards with border and shadow-sm.
- Layout: max-w-4xl mx-auto with p-6 padding. Use flex layouts with the sidebar.
- Cards: rounded-lg border border-gray-200 p-6 shadow-sm bg-white dark:bg-gray-800
- Forms: labeled inputs with focus:ring-indigo-500, error states in red, success in green.
- Typography: text-2xl font-bold for page titles, text-sm for labels, text-gray-500 for hints.
- Empty states: centered text with a helpful message and an action button.
- Responsive: grid-cols-1 md:grid-cols-2 lg:grid-cols-3 for card grids.
- Dark mode: include dark: variants for all colors.
- This MUST look like a professional SaaS product. No unstyled HTML. No placeholder text.

## File Conventions
- app/[route]/page.tsx — Server component that fetches data and renders the page
- app/api/[route]/route.ts — API handler with proper error responses
- components/[Feature]/index.tsx — Client component with "use client" directive
- lib/[feature].ts — Pure types, validators, helpers (no React)
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

  _loadSkipState() {
    const skipPath = path.join(STATE_DIR, "builder-skip-state.json");
    try { return JSON.parse(fs.readFileSync(skipPath, "utf-8")); } catch { return {}; }
  }

  _saveSkipState(state) {
    const skipPath = path.join(STATE_DIR, "builder-skip-state.json");
    try { fs.writeFileSync(skipPath, JSON.stringify(state, null, 2) + "\n"); } catch {}
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
      // Stage each directory individually — git add aborts entirely if ANY pathspec
      // doesn't match, so a missing dir (e.g. supabase/) would prevent ALL files from staging.
      const stageDirs = ["app/", "components/", "lib/", "supabase/", "e2e/state/", "e2e/reports/", "docs/"];
      for (const dir of stageDirs) {
        this.exec(`git add ${dir} 2>/dev/null || true`, { label: `git-add-${dir.replace(/\//g, "")}` });
      }

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

      // Builder created code — verify build before pushing to avoid broken Vercel deploys
      const buildCheck = this.exec("npx next build 2>&1", { label: "pre-push-build-check", timeoutMs: 180000 });
      if (!buildCheck.ok) {
        // Build failed — revert the commit so we don't accumulate broken code
        const buildErr = (buildCheck.stderr || buildCheck.stdout || "").slice(0, 500);
        this.log(`PRE-PUSH BUILD FAILED — reverting commit. Error:\n${buildErr}`);
        this.exec("git reset --soft HEAD~1 2>/dev/null || true", { label: "git-reset-failed-build" });
        this.exec("git reset HEAD . 2>/dev/null || true", { label: "git-unstage-failed-build" });
        this.emitSignal("build-failed", { claw: this.name, error: buildErr.slice(0, 200) });
        return false;
      }
      this.log("Pre-push build check passed");

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
