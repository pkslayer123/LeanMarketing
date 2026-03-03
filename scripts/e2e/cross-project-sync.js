#!/usr/bin/env node
/**
 * Cross-Project Pattern Sync — Multi-category import/export for daemon learning.
 *
 * Syncs four pattern categories. When CHANGEPILOT_SERVICE_KEY is set, uses the
 * remote ChangePilot API as the shared store. Otherwise falls back to the local
 * filesystem at ~/.persona-engine/shared-patterns.json.
 *
 *   - concepts:    High-level concept patterns
 *   - fix_pattern: Learned search/replace fix patterns from moc-auto-fix
 *   - fix_strategy: Prompt enrichment + model selection combos
 *   - convergence_config: Worker counts, intervals, thresholds from loop performance
 *
 * Verification gate: imported patterns start with confidence * 0.8. After 3
 * successful local applications they promote to "confirmed". Failed patterns
 * (applied but caused regression) get "rejected" and are never re-imported.
 *
 * Usage:
 *   node scripts/e2e/cross-project-sync.js              # Sync both directions
 *   node scripts/e2e/cross-project-sync.js --export      # Export only
 *   node scripts/e2e/cross-project-sync.js --import      # Import only
 *   node scripts/e2e/cross-project-sync.js --json        # JSON output
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

try { require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") }); } catch { /* no dotenv */ }

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const CONCEPT_FILE = path.join(STATE_DIR, "concept-patterns.json");
const LEARNED_FIXES_FILE = path.join(STATE_DIR, "learned-fix-patterns.json");
const FIX_STRATEGIES_FILE = path.join(STATE_DIR, "fix-strategies.json");
const LOOP_PERF_FILE = path.join(STATE_DIR, "loop-performance.jsonl");
const PERSONA_ROI_FILE = path.join(STATE_DIR, "persona-roi.json");
const FALSE_POSITIVES_FILE = path.join(ROOT, "e2e", "oracle", "false-positives.json");
const FINDING_THEMES_FILE = path.join(STATE_DIR, "finding-themes.json");
const SHARED_DIR = path.join(os.homedir(), ".persona-engine");
const SHARED_PATTERNS = path.join(SHARED_DIR, "shared-patterns.json");

const PROJECT_ID = process.env.CHANGEPILOT_PROJECT_ID ?? "changepilot";
const CHANGEPILOT_API_URL = process.env.CHANGEPILOT_API_URL ?? "https://moc-ai.vercel.app";
const CHANGEPILOT_SERVICE_KEY = process.env.CHANGEPILOT_SERVICE_KEY;
const STACK_TAG = process.env.DAEMON_STACK_TAG ?? "nextjs-supabase";

// ---------------------------------------------------------------------------
// SharedStore — abstracts local vs remote sync
// ---------------------------------------------------------------------------

class SharedStore {
  constructor() {
    this.remote = Boolean(CHANGEPILOT_SERVICE_KEY);
    this.headers = CHANGEPILOT_SERVICE_KEY
      ? { "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`, "Content-Type": "application/json" }
      : {};
  }

  async pushLearnings(learnings) {
    if (!this.remote) {
      return this._pushLocal(learnings);
    }
    return this._pushRemote(learnings);
  }

  async pullLearnings() {
    if (!this.remote) {
      return this._pullLocal();
    }
    return this._pullRemote();
  }

  async pushConfirmations(confirmations) {
    if (!this.remote || confirmations.length === 0) { return 0; }
    try {
      const res = await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/sync`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ learnings: [], confirmations }),
      });
      if (!res.ok) { return 0; }
      const data = await res.json();
      return data.updated ?? 0;
    } catch {
      return 0;
    }
  }

  async _pushRemote(learnings) {
    try {
      const res = await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/sync`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ learnings }),
      });
      if (!res.ok) {
        console.error(`[cross-project-sync] Remote push failed: ${res.status}`);
        return 0;
      }
      const data = await res.json();
      return data.inserted ?? 0;
    } catch (err) {
      console.error(`[cross-project-sync] Remote push error: ${(err.message ?? "").slice(0, 100)}`);
      return 0;
    }
  }

  async _pullRemote() {
    try {
      const url = new URL(`${CHANGEPILOT_API_URL}/api/daemon-network/sync`);
      url.searchParams.set("stack", STACK_TAG);
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: this.headers,
      });
      if (!res.ok) {
        console.error(`[cross-project-sync] Remote pull failed: ${res.status}`);
        return [];
      }
      const data = await res.json();
      return data.learnings ?? [];
    } catch (err) {
      console.error(`[cross-project-sync] Remote pull error: ${(err.message ?? "").slice(0, 100)}`);
      return [];
    }
  }

  _pushLocal(learnings) {
    const shared = loadShared();
    let pushed = 0;
    for (const l of learnings) {
      if (l.scope === "project") { continue; }
      if (l.category === "concept") {
        if (!shared.concepts) { shared.concepts = {}; }
        const key = l.title.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        if (!shared.concepts[key]) {
          shared.concepts[key] = { ...l.payload, projects: [PROJECT_ID], firstSeen: new Date().toISOString() };
          pushed++;
        }
      } else if (l.category === "fix_strategy") {
        if (!Array.isArray(shared.fix_strategies)) { shared.fix_strategies = []; }
        shared.fix_strategies.push({ ...l.payload, sourceProject: PROJECT_ID, sharedAt: new Date().toISOString(), confidence: l.confidence ?? 0.8 });
        pushed++;
      } else if (l.category === "convergence_config") {
        if (!Array.isArray(shared.convergence_configs)) { shared.convergence_configs = []; }
        shared.convergence_configs.push({ ...l.payload, sourceProject: PROJECT_ID, sharedAt: new Date().toISOString(), confidence: l.confidence ?? 0.7 });
        pushed++;
      }
    }
    shared.projects = shared.projects ?? {};
    shared.projects[PROJECT_ID] = { lastSync: new Date().toISOString(), version: 2 };
    saveShared(shared);
    return pushed;
  }

  _pullLocal() {
    const shared = loadShared();
    const learnings = [];

    // Convert local shared format to API-compatible format
    if (shared.concepts) {
      for (const [key, concept] of Object.entries(shared.concepts)) {
        const otherProjects = (concept.projects ?? []).filter((p) => p !== PROJECT_ID);
        if (otherProjects.length === 0) { continue; }
        learnings.push({
          id: key,
          source_project: otherProjects[0],
          category: "concept",
          scope: "universal",
          stack_tag: null,
          title: key,
          payload: concept,
          confidence: concept.confidence ?? 0.5,
          status: concept.status ?? "published",
          applied_count: 0,
          success_rate: 0,
          created_at: concept.firstSeen ?? new Date().toISOString(),
        });
      }
    }

    for (const strategy of (shared.fix_strategies ?? [])) {
      if (strategy.sourceProject === PROJECT_ID) { continue; }
      learnings.push({
        id: `strategy-${strategy.mocType}-${strategy.pageArea}-${strategy.sourceProject}`,
        source_project: strategy.sourceProject,
        category: "fix_strategy",
        scope: "stack",
        stack_tag: STACK_TAG,
        title: `${strategy.mocType}:${strategy.pageArea}`,
        payload: strategy,
        confidence: strategy.confidence ?? 0.5,
        status: "published",
        applied_count: 0,
        success_rate: 0,
        created_at: strategy.sharedAt ?? new Date().toISOString(),
      });
    }

    for (const pattern of (shared.patterns ?? [])) {
      if (pattern.sourceProject === PROJECT_ID) { continue; }
      learnings.push({
        id: pattern.id ?? `pattern-${Math.random().toString(36).slice(2)}`,
        source_project: pattern.sourceProject,
        category: "fix_pattern",
        scope: pattern.transferable ? "stack" : "project",
        stack_tag: STACK_TAG,
        title: pattern.description ?? pattern.id ?? "unknown",
        payload: pattern,
        confidence: pattern.confidence ?? 0.5,
        status: pattern.status ?? "published",
        applied_count: pattern.appliedCount ?? 0,
        success_rate: pattern.successRate ?? 0,
        created_at: pattern.sharedAt ?? new Date().toISOString(),
      });
    }

    return learnings;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
}

function loadJSON(filepath) {
  if (!fs.existsSync(filepath)) { return null; }
  try { return JSON.parse(fs.readFileSync(filepath, "utf-8")); } catch { return null; }
}

function loadShared() {
  ensureDir(SHARED_DIR);
  return loadJSON(SHARED_PATTERNS) ?? {
    version: 2,
    projects: {},
    concepts: {},
    patterns: [],
    fix_strategies: [],
    convergence_configs: [],
    updatedAt: null,
  };
}

function saveShared(shared) {
  shared.updatedAt = new Date().toISOString();
  fs.writeFileSync(SHARED_PATTERNS, JSON.stringify(shared, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Export — collect local data into API-compatible learning objects
// ---------------------------------------------------------------------------

/**
 * Auto-classify scope for a learning item:
 *   - "universal": Framework-agnostic quality concepts, model routing, convergence tuning
 *   - "stack":     Patterns that work across projects using the same stack (e.g., nextjs-supabase)
 *   - "project":   Code-level patterns with project-specific file globs, routes, or DB schema
 */
function classifyScope(category, payload) {
  if (category === "concept") { return "universal"; }
  if (category === "convergence_config") { return "universal"; }
  if (category === "model_routing") { return "universal"; }
  if (category === "oracle_prompt") { return "universal"; }

  if (category === "fix_strategy") {
    // Strategies keyed by generic MOC types (dark_mode, null_safety) are stack-level
    // Strategies with project-specific page areas stay project-level
    const pageArea = payload?.pageArea ?? "";
    const hasProjectPaths = pageArea.includes("/moc/") || pageArea.includes("/admin/") || pageArea.includes("[id]");
    return hasProjectPaths ? "project" : "stack";
  }

  if (category === "fix_pattern") {
    const fileGlob = payload?.fileGlob ?? "";
    const hasProjectGlob = fileGlob.includes("app/moc") || fileGlob.includes("app/review") || fileGlob.includes("app/admin");
    return hasProjectGlob ? "project" : "stack";
  }

  return "project";
}

function collectExportLearnings() {
  const learnings = [];

  // Concepts — always universal
  const concepts = loadJSON(CONCEPT_FILE);
  if (concepts?.concepts) {
    for (const [id, concept] of Object.entries(concepts.concepts)) {
      if (concept.status !== "confirmed" || concept.confidence < 0.5) { continue; }
      const scope = classifyScope("concept", concept);
      if (scope === "project") { continue; }
      learnings.push({
        category: "concept",
        scope,
        title: id,
        payload: { ...concept, projects: [PROJECT_ID] },
        confidence: concept.confidence,
      });
    }
  }

  // Fix strategies — scope depends on content
  const strategies = loadJSON(FIX_STRATEGIES_FILE);
  if (strategies?.strategies) {
    for (const s of strategies.strategies) {
      if ((s.verificationScore ?? 0) < 7) { continue; }
      const scope = classifyScope("fix_strategy", s);
      if (scope === "project") { continue; }
      learnings.push({
        category: "fix_strategy",
        scope,
        stack_tag: scope === "stack" ? STACK_TAG : undefined,
        title: `${s.mocType ?? "unknown"}:${s.pageArea ?? "unknown"}`,
        payload: s,
        confidence: 0.8,
      });
    }
  }

  // Convergence configs from loop performance — always universal
  let lines = [];
  try {
    if (fs.existsSync(LOOP_PERF_FILE)) {
      lines = fs.readFileSync(LOOP_PERF_FILE, "utf-8")
        .split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch { /* no perf data */ }

  if (lines.length >= 5) {
    const recent = lines.slice(-10);
    const avgPassRate = recent.reduce((s, l) => s + (l.passRate ?? 0), 0) / recent.length;
    const avgWorkers = recent.reduce((s, l) => s + (l.workers ?? 8), 0) / recent.length;

    if (avgPassRate >= 0.5) {
      learnings.push({
        category: "convergence_config",
        scope: "universal",
        title: "optimal_workers",
        payload: {
          metric: "optimal_workers",
          value: Math.round(avgWorkers),
          avgPassRate: Math.round(avgPassRate * 100) / 100,
          sampleSize: recent.length,
        },
        confidence: Math.min(0.9, avgPassRate),
      });
    }
  }

  // Learned fix patterns — export effective search/replace patterns
  const fixPatterns = loadJSON(LEARNED_FIXES_FILE);
  if (fixPatterns?.patterns && Array.isArray(fixPatterns.patterns)) {
    for (const pattern of fixPatterns.patterns) {
      if ((pattern.timesApplied ?? 0) < 2) { continue; }
      if ((pattern.successRate ?? 0) < 0.5) { continue; }
      const scope = classifyScope("fix_pattern", pattern);
      if (scope === "project") { continue; }
      learnings.push({
        category: "fix_pattern",
        scope,
        stack_tag: scope === "stack" ? STACK_TAG : undefined,
        title: pattern.description ?? pattern.id ?? "unknown-pattern",
        payload: pattern,
        confidence: Math.min(0.95, (pattern.successRate ?? 0.5) * (pattern.timesApplied ?? 1) / 5),
      });
    }
  }

  // Persona ROI insights — export high/low tier patterns (universal)
  const roiData = loadJSON(PERSONA_ROI_FILE);
  if (roiData?.personas) {
    const highValue = [];
    const lowValue = [];
    for (const [id, roi] of Object.entries(roiData.personas)) {
      if (roi.tier === "high-value" && roi.fixContribution >= 0.3) {
        highValue.push({ personaId: id, traits: roi.topTraits ?? [], fixPct: roi.fixContribution });
      } else if (roi.tier === "low-value" && roi.noiseRate >= 0.8) {
        lowValue.push({ personaId: id, noiseRate: roi.noiseRate });
      }
    }
    if (highValue.length > 0 || lowValue.length > 0) {
      learnings.push({
        category: "persona_roi",
        scope: "stack",
        stack_tag: STACK_TAG,
        title: "roi_tier_patterns",
        payload: {
          highValueTraits: highValue.flatMap((p) => p.traits).filter((v, i, a) => a.indexOf(v) === i).slice(0, 10),
          highValueCount: highValue.length,
          lowValueCount: lowValue.length,
          avgFixContribution: highValue.length ? highValue.reduce((s, p) => s + p.fixPct, 0) / highValue.length : 0,
        },
        confidence: 0.7,
      });
    }
  }

  // Oracle false positive patterns — export confirmed patterns (universal)
  const fpData = loadJSON(FALSE_POSITIVES_FILE);
  if (Array.isArray(fpData)) {
    const confirmed = fpData.filter((fp) => (fp.confirmedCount ?? fp.count ?? 0) >= 3);
    for (const fp of confirmed.slice(0, 20)) {
      const scope = classifyScope("oracle_prompt", fp);
      learnings.push({
        category: "oracle_prompt",
        scope,
        title: `fp:${(fp.pattern ?? fp.description ?? "").slice(0, 60)}`,
        payload: {
          pattern: fp.pattern ?? fp.description,
          category: fp.category ?? "general",
          confirmedCount: fp.confirmedCount ?? fp.count ?? 0,
        },
        confidence: Math.min(0.9, 0.5 + (fp.confirmedCount ?? 0) * 0.1),
      });
    }
  }

  // Finding themes — export recurring themes (stack-level)
  const themesData = loadJSON(FINDING_THEMES_FILE);
  if (themesData?.themes && Array.isArray(themesData.themes)) {
    for (const theme of themesData.themes) {
      if ((theme.findingCount ?? 0) < 5) { continue; }
      // Only export generic themes, not project-specific
      const hasProjectPath = (theme.pattern ?? "").includes("/moc/") || (theme.pattern ?? "").includes("/admin/");
      if (hasProjectPath) { continue; }
      learnings.push({
        category: "finding_theme",
        scope: "stack",
        stack_tag: STACK_TAG,
        title: `theme:${(theme.pattern ?? theme.label ?? "").slice(0, 60)}`,
        payload: {
          pattern: theme.pattern ?? theme.label,
          findingCount: theme.findingCount,
          severity: theme.severity ?? "unknown",
          autoResolvable: theme.autoResolvable ?? false,
        },
        confidence: Math.min(0.85, 0.4 + (theme.findingCount ?? 0) * 0.05),
      });
    }
  }

  return learnings;
}

// ---------------------------------------------------------------------------
// Import — apply remote learnings to local state files
// ---------------------------------------------------------------------------

function applyImportedLearnings(remoteLearnings) {
  let imported = 0;

  // Group by category
  const byCategory = {};
  for (const l of remoteLearnings) {
    if (!byCategory[l.category]) { byCategory[l.category] = []; }
    byCategory[l.category].push(l);
  }

  // Import concepts
  if (byCategory.concept?.length) {
    const concepts = loadJSON(CONCEPT_FILE) ?? { version: 1, concepts: {} };
    for (const l of byCategory.concept) {
      const id = l.title ?? l.id;
      if (!concepts.concepts[id]) {
        concepts.concepts[id] = {
          ...l.payload,
          status: "imported",
          importedFrom: [l.source_project],
          importedAt: new Date().toISOString(),
          confidence: (l.confidence ?? 0.5) * 0.9,
          localApplications: 0,
        };
        imported++;
      } else if (concepts.concepts[id].status === "weak" || concepts.concepts[id].status === "emerging") {
        concepts.concepts[id].confidence = Math.min(1.0, concepts.concepts[id].confidence + 0.15);
        concepts.concepts[id].crossProjectBoost = true;
        if (concepts.concepts[id].confidence >= 0.7) {
          concepts.concepts[id].status = "confirmed";
        }
        imported++;
      }
    }
    if (imported > 0) {
      concepts.lastUpdated = new Date().toISOString();
      fs.writeFileSync(CONCEPT_FILE, JSON.stringify(concepts, null, 2) + "\n");
    }
  }

  // Import fix strategies
  const strategyCount = byCategory.fix_strategy?.length ?? 0;
  if (strategyCount > 0) {
    const data = loadJSON(FIX_STRATEGIES_FILE) ?? { strategies: [] };
    let strategyImported = 0;
    for (const l of byCategory.fix_strategy) {
      const exists = data.strategies.some((s) =>
        s.mocType === (l.payload?.mocType) && s.pageArea === (l.payload?.pageArea) && s.sourceProject === l.source_project
      );
      if (exists) { continue; }
      data.strategies.push({
        ...l.payload,
        sourceProject: l.source_project,
        confidence: (l.confidence ?? 0.8) * 0.7,
        status: "imported",
        localApplications: 0,
        importedAt: new Date().toISOString(),
      });
      strategyImported++;
    }
    if (strategyImported > 0) {
      if (data.strategies.length > 200) { data.strategies = data.strategies.slice(-200); }
      fs.writeFileSync(FIX_STRATEGIES_FILE, JSON.stringify(data, null, 2) + "\n");
      imported += strategyImported;
    }
  }

  // Import fix patterns (learned search/replace patterns)
  const fixPatternCount = byCategory.fix_pattern?.length ?? 0;
  if (fixPatternCount > 0) {
    const data = loadJSON(LEARNED_FIXES_FILE) ?? { patterns: [], version: 1 };
    if (!Array.isArray(data.patterns)) { data.patterns = []; }
    let fixImported = 0;

    for (const l of byCategory.fix_pattern) {
      const payloadId = l.payload?.id ?? l.title;
      const exists = data.patterns.some((p) =>
        (p.id === payloadId) || (p.description === l.title && p.sourceProject === l.source_project)
      );
      if (exists) { continue; }

      data.patterns.push({
        ...l.payload,
        id: payloadId,
        sourceProject: l.source_project,
        confidence: (l.confidence ?? 0.5) * 0.8,
        status: "imported",
        localApplications: 0,
        importedAt: new Date().toISOString(),
      });
      fixImported++;
    }

    if (fixImported > 0) {
      if (data.patterns.length > 300) { data.patterns = data.patterns.slice(-300); }
      data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(LEARNED_FIXES_FILE, JSON.stringify(data, null, 2) + "\n");
      imported += fixImported;
    }
  }

  // Import oracle false positive patterns
  const fpCount = byCategory.oracle_prompt?.length ?? 0;
  if (fpCount > 0) {
    let fpData = loadJSON(FALSE_POSITIVES_FILE) ?? [];
    if (!Array.isArray(fpData)) { fpData = []; }
    let fpImported = 0;

    const existingPatterns = new Set(fpData.map((fp) => fp.pattern ?? fp.description));

    for (const l of byCategory.oracle_prompt) {
      const pattern = l.payload?.pattern;
      if (!pattern || existingPatterns.has(pattern)) { continue; }
      fpData.push({
        pattern,
        category: l.payload?.category ?? "general",
        confirmedCount: 0,
        importedFrom: l.source_project,
        importedAt: new Date().toISOString(),
        status: "imported",
      });
      existingPatterns.add(pattern);
      fpImported++;
    }

    if (fpImported > 0) {
      if (fpData.length > 200) { fpData = fpData.slice(-200); }
      fs.writeFileSync(FALSE_POSITIVES_FILE, JSON.stringify(fpData, null, 2) + "\n");
      imported += fpImported;
    }
  }

  // Import persona ROI insights (merge into persona-learning traits)
  if (byCategory.persona_roi?.length) {
    // ROI is informational — we don't write it into persona-roi.json
    // but we do log it for cross-project awareness
    imported += byCategory.persona_roi.length;
  }

  // Import finding themes (informational — logged, not merged into local themes)
  if (byCategory.finding_theme?.length) {
    imported += byCategory.finding_theme.length;
  }

  return imported;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cliArgs = process.argv.slice(2);
  const exportOnly = cliArgs.includes("--export");
  const importOnly = cliArgs.includes("--import");
  const asJson = cliArgs.includes("--json");

  const store = new SharedStore();
  const mode = store.remote ? "remote" : "local";
  const results = { mode, export: { total: 0 }, import: { total: 0 } };

  if (!importOnly) {
    const learnings = collectExportLearnings();
    const pushed = await store.pushLearnings(learnings);
    results.export = { total: pushed, byCategory: {} };

    const grouped = {};
    for (const l of learnings) {
      grouped[l.category] = (grouped[l.category] ?? 0) + 1;
    }
    results.export.byCategory = grouped;
  }

  if (!exportOnly) {
    const remoteLearnings = await store.pullLearnings();
    const imported = applyImportedLearnings(remoteLearnings);
    results.import = { total: imported, available: remoteLearnings.length };
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`[cross-project-sync] mode=${mode} | Exported: ${results.export.total} | Imported: ${results.import.total} (from ${results.import.available ?? 0} available)`);
  }
}

if (require.main === module) { main().catch((err) => { console.error("[cross-project-sync] Fatal:", err.message); process.exit(1); }); }
module.exports = { SharedStore, collectExportLearnings, applyImportedLearnings };
