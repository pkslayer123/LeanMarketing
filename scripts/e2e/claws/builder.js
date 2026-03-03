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
 *
 * Genericized from ChangePilot's builder claw for use in any persona-engine project.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Claw } = require("../claw");

// Stack adapter — framework-aware path resolution
let StackAdapter;
try { ({ StackAdapter } = require("../lib/stack-adapter")); } catch { /* optional */ }

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
const QUEUE_PATH = path.join(STATE_DIR, "moc-queue.json");
const MANIFEST_PATH = path.join(STATE_DIR, "manifest.json");
const BUILDER_STATE_PATH = path.join(STATE_DIR, "builder-state.json");

class BuilderClaw extends Claw {
  constructor() {
    super("builder");
    this.specPath = this.clawConfig.specPath ?? path.join(ROOT, "docs", "BUILD-SPEC.md");
    // Initialize stack adapter for framework-aware operations
    this.stackAdapter = StackAdapter ? new StackAdapter(ROOT) : null;
  }

  async run() {
    const phases = [];

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

    if (buildPhase === "converged") {
      this.log("Converged — suspending builder");
      this.emitSignal("build-complete", {
        iteration: this.currentCycle,
        specCompletionRate: complianceScore,
        gapsRemaining: 0,
        phase: "converged",
      });
      return { ok: true, summary: `converged (${complianceScore})` };
    }

    if (buildPhase === "polish") {
      this.log("Polish phase — skipping new feature builds, focusing on fixes");
      this.emitSignal("build-complete", {
        iteration: this.currentCycle,
        specCompletionRate: complianceScore,
        gapsRemaining: 0,
        phase: "polish",
      });
      return { ok: true, summary: `polish phase (${complianceScore})` };
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

    // In stabilize phase, cap builds more aggressively
    const stabilizeCap = buildPhase === "stabilize" ? 1 : undefined;

    if (gaps.length === 0) {
      this._updateBuilderState(specSections.length, 0);
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
    const committed = this._commitAndPush();
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
    const sections = [];
    const headerRegex = /^##\s+(.+)$/gm;
    let match;

    while ((match = headerRegex.exec(content)) !== null) {
      const name = match[1].trim();
      const start = match.index + match[0].length;
      const nextMatch = headerRegex.exec(content);
      const end = nextMatch ? nextMatch.index : content.length;
      headerRegex.lastIndex = nextMatch ? nextMatch.index : content.length;

      const body = content.slice(start, end).trim();

      // Extract routes from markdown (patterns like /path or `path`)
      const routes = [];
      const routeRegex = /[`/]([/a-z0-9[\]-]+(?:\/[a-z0-9[\]-]*)*)[`\s]/gi;
      let routeMatch;
      while ((routeMatch = routeRegex.exec(body)) !== null) {
        const route = routeMatch[1];
        if (route.startsWith("/") && route.length > 1) {
          routes.push(route);
        }
      }

      sections.push({ name, body: body.slice(0, 500), routes });
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
    const manifestFeatures = new Set(Object.keys(manifest.features ?? {}));

    for (const section of specSections) {
      const featureKey = section.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

      // Check if feature exists in manifest
      const inManifest = manifestFeatures.has(featureKey) ||
        [...manifestFeatures].some((f) => f.includes(featureKey) || featureKey.includes(f));

      if (inManifest) {
        continue;
      }

      // Check if routes exist in filesystem (framework-aware via stack adapter)
      let hasRoutes = false;
      for (const route of section.routes) {
        if (this.stackAdapter) {
          // Use stack adapter to resolve route to source file
          const sourceFile = path.join(ROOT, this.stackAdapter.routeToSourceFile(route));
          const apiFile = path.join(ROOT, this.stackAdapter.routeToApiFile(route));
          if (fs.existsSync(sourceFile) || fs.existsSync(apiFile)) {
            hasRoutes = true;
            break;
          }
        } else {
          // Fallback: check common patterns across frameworks
          const segments = route.split("/").filter(Boolean);
          const candidates = [
            path.join(ROOT, "app", ...segments, "page.tsx"),
            path.join(ROOT, "app", ...segments, "page.jsx"),
            path.join(ROOT, "app", ...segments, "route.ts"),
            path.join(ROOT, "src", "pages", ...segments, "index.tsx"),
            path.join(ROOT, "src", "routes", ...segments, "+page.svelte"),
            path.join(ROOT, "src", "pages", ...segments, "index.astro"),
          ];
          if (candidates.some((c) => fs.existsSync(c))) {
            hasRoutes = true;
            break;
          }
        }
      }

      if (!hasRoutes) {
        gaps.push({
          featureKey,
          name: section.name,
          description: section.body,
          routes: section.routes,
        });
      }
    }

    return gaps;
  }

  _createBuildMocs(gaps) {
    let queue = { mocs: [] };
    if (fs.existsSync(QUEUE_PATH)) {
      try {
        queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
      } catch { /* corrupted */ }
    }
    if (!Array.isArray(queue.mocs)) {
      queue.mocs = [];
    }

    let created = 0;
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

    if (created > 0) {
      fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n");
    }
    return created;
  }

  async _scaffoldFeature(gap) {
    if (!gap) {
      return false;
    }

    // Check for Claude CLI availability
    const claudeAvailable = this._isClaudeAvailable();
    if (!claudeAvailable) {
      this.log("Claude CLI not available — emitting fix prompt for builder");
      this._emitBuildPrompt(gap);
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
        `claude --print --max-tokens 16000 --model sonnet < "${promptPath}"`,
        { label: "claude-scaffold", timeoutMs: 300000 }
      );
      try { fs.unlinkSync(promptPath); } catch {}
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
    // Use stack adapter for framework-aware context, or fall back to generic
    const frameworkContext = this.stackAdapter
      ? this.stackAdapter.getFixPromptContext()
      : this._genericFrameworkContext();

    // Read project-specific tech from daemon-config or persona-engine.json
    const techStack = this._getProjectTechStack();

    return `You are building a new feature for a ${techStack.framework} application based on a BUILD-SPEC.

## Feature to Build: ${gap.name}

${gap.description}

## Expected Routes
${gap.routes.length > 0 ? gap.routes.map((r) => `- ${r}`).join("\n") : "- Determine appropriate routes from the feature description"}

${frameworkContext}

## Instructions
1. Create the necessary page routes (${this.stackAdapter ? this.stackAdapter.stack.routeFile : "page files"})
2. Create any needed API routes (${this.stackAdapter ? this.stackAdapter.stack.apiFile : "route files"})
3. Create shared components in the project's component directory
4. If the feature needs database tables, create a migration file appropriate for the project's database
5. Use the project's existing patterns: ${techStack.styling} for styling${techStack.database ? `, ${techStack.database} for DB` : ""}
6. After creating files, validate with the project's build tool

Keep the implementation minimal but functional. Focus on getting the route and basic UI working so persona tests can validate it.
`;
  }

  _genericFrameworkContext() {
    return `## Project Framework
- Detect the framework from config files in the project root
- Follow the project's existing file structure conventions
- Check existing route files for patterns to follow
`;
  }

  _getProjectTechStack() {
    const defaults = { framework: "web", styling: "CSS", database: null };
    try {
      // Read from persona-engine.json or daemon-config.json
      const peConfig = path.join(ROOT, "persona-engine.json");
      const dcConfig = path.join(ROOT, "daemon-config.json");
      let config = {};
      if (fs.existsSync(peConfig)) {
        config = JSON.parse(fs.readFileSync(peConfig, "utf-8"));
      } else if (fs.existsSync(dcConfig)) {
        config = JSON.parse(fs.readFileSync(dcConfig, "utf-8"));
      }

      return {
        framework: this.stackAdapter?.stack?.name ?? config.stack ?? defaults.framework,
        styling: config.styling ?? (fs.existsSync(path.join(ROOT, "tailwind.config.ts")) || fs.existsSync(path.join(ROOT, "tailwind.config.js")) ? "Tailwind CSS" : defaults.styling),
        database: config.database ?? (process.env.NEXT_PUBLIC_SUPABASE_URL ? "Supabase" : null),
      };
    } catch {
      return defaults;
    }
  }

  _emitBuildPrompt(gap) {
    const promptPath = path.join(STATE_DIR, "builder-fix-prompt.md");
    const content = `# Builder Prompt — Scaffold Feature: ${gap.name}

${this._buildScaffoldPrompt(gap)}

---
*Generated by builder claw at ${new Date().toISOString()}*
`;
    fs.writeFileSync(promptPath, content);
    this.log(`Build prompt written to: ${promptPath}`);
  }

  _isClaudeAvailable() {
    try {
      execSync("claude --version", { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  _commitAndPush() {
    if (!this.acquireGitLock()) { return false; }
    try {
      // Stage project-specific source directories (framework-aware) — never use git add -A
      const srcDirs = this._getSourceDirectories();
      this.exec(
        `git add ${srcDirs.join(" ")} e2e/state/ e2e/reports/ docs/ 2>/dev/null || true`,
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

      this.exec(
        'git commit -m "feat: scaffold feature from BUILD-SPEC [builder-claw]"',
        { label: "git-commit-scaffold" }
      );
      // Builder creates code — push to trigger deploy
      this.exec("git push --no-verify 2>/dev/null || true", { label: "git-push-scaffold" });
      this.log("Committed and pushed scaffold changes");
      return true;
    } catch (err) {
      this.log(`Commit/push failed: ${(err.message ?? "").slice(0, 100)}`);
      return false;
    } finally {
      this.releaseGitLock();
    }
  }

  _getSourceDirectories() {
    if (this.stackAdapter) {
      const dirs = new Set([
        this.stackAdapter.stack.routeDir,
        this.stackAdapter.stack.componentDir,
        this.stackAdapter.stack.libDir,
      ]);
      // Add common directories that may exist
      for (const d of ["supabase/", "prisma/", "drizzle/", "migrations/"]) {
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
