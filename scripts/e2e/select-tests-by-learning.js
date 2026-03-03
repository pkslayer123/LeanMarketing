#!/usr/bin/env node

/**
 * Select tests by learning data — Phase D.
 *
 * Uses persona-learning.json to:
 * - Prioritize personas with high finding rates (focus areas)
 * - Expand coverage for personas with 0 findings in last 2 runs
 * - Output test selection for loop or manual runs
 *
 * Usage:
 *   node scripts/e2e/select-tests-by-learning.js
 *   node scripts/e2e/select-tests-by-learning.js --json
 *   E2E_LEARNING_DRIVEN=1 node scripts/e2e/select-tests-by-learning.js
 */

const fs = require("fs");
const path = require("path");
const { isExpansionCandidate } = require("./lib/persona-nuance.js");

const ROOT = path.resolve(__dirname, "..", "..");
const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const HISTORY_DIR = path.join(ROOT, "e2e", "state", "history");
const FIX_EFFECTIVENESS_FILE = path.join(ROOT, "e2e", "state", "fix-effectiveness.json");
const FEATURE_HEALTH_FILE = path.join(ROOT, "e2e", "state", "feature-health-scores.json");
const MANIFEST_FILE = path.join(ROOT, "e2e", "state", "manifest.json");
const THOMPSON_FILE = path.join(ROOT, "e2e", "state", "thompson-selection.json");
const DRIVES_FILE = path.join(ROOT, "e2e", "state", "persona-drives.json");
const HIBERNATION_FILE = path.join(ROOT, "e2e", "state", "persona-hibernation.json");
const CAUSAL_FILE = path.join(ROOT, "e2e", "state", "causal-analysis.json");
const COVERAGE_MATRIX_FILE = path.join(ROOT, "e2e", "state", "coverage-matrix.json");
const MUTATION_FILE = path.join(ROOT, "e2e", "state", "mutation-plan.json");
const FORAGING_FILE = path.join(ROOT, "e2e", "state", "foraging-model.json");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const INCREMENTAL = args.includes("--incremental");
const EXPLORATORY_FIRST = args.includes("--exploratory-first");
const PRIORITIZED = args.includes("--prioritized");
const FEATURE_USAGE_PRIORITY =
  process.env.E2E_FEATURE_USAGE_PRIORITY === "1" || process.env.FEATURE_USAGE_PRIORITY === "1";

function loadLearning() {
  if (!fs.existsSync(LEARNING_FILE)) {
    return { personas: {}, lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(LEARNING_FILE, "utf-8"));
  } catch {
    return { personas: {}, lastUpdated: null };
  }
}

function loadFixEffectiveness() {
  if (!fs.existsSync(FIX_EFFECTIVENESS_FILE)) {
    return { lastResolved: false, entries: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(FIX_EFFECTIVENESS_FILE, "utf-8"));
    const entries = data.entries ?? [];
    const withAfter = entries.filter((e) => e.findingsAfter != null);
    const last = withAfter[withAfter.length - 1];
    return {
      lastResolved: last?.resolved === true,
      entries,
    };
  } catch {
    return { lastResolved: false, entries: [] };
  }
}

function getRecentRunHistory() {
  if (!fs.existsSync(HISTORY_DIR)) {
    return [];
  }
  const files = fs
    .readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f,
      path: path.join(HISTORY_DIR, f),
      mtime: fs.statSync(path.join(HISTORY_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 5);

  return files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(f.path, "utf-8"));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function shouldExpand(personaId, learningData, history) {
  const entry = learningData.personas[personaId];
  if (!entry || entry.totalRuns < 2) {
    return true; // No data — include for expansion
  }

  const recentRuns = history.filter((h) => h.personaResults?.[personaId]);
  if (recentRuns.length < 2) {
    return true;
  }

  const lastTwo = recentRuns.slice(0, 2);
  return lastTwo.every((r) => {
    const stats = r.personaResults[personaId];
    return stats && stats.findings === 0;
  });
}

/**
 * Load usage-based persona priority from feature-usage-to-persona-priority.
 * Maps feature_key to manifest features → personas. Returns persona IDs to boost.
 */
function loadUsageBasedPersonas() {
  if (!FEATURE_USAGE_PRIORITY) {
    return [];
  }
  try {
    const { execSync } = require("child_process");
    const out = execSync("node scripts/e2e/feature-usage-to-persona-priority.js --json --days 30", {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const data = JSON.parse(out);
    const features = data.features ?? [];
    if (features.length === 0) return [];

    const manifestPath = path.join(ROOT, "e2e", "state", "manifest.json");
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const manifestFeatures = manifest.features ?? {};

    const featureKeyToManifestKey = {
      risk_tracking: "moc_hotspots",
      workflow_intelligence: "workflow_intelligence",
      workflow_automation: "workflow_automation",
      custom_reports: "admin_monitoring",
      compliance_frameworks: "compliance",
      marketplace: "marketplace",
      multitenancy: "multitenancy",
      moc_workflow: "moc_workflow",
      moc_frame: "moc_frame",
      moc_review: "moc_review",
      coaching_feedback: "coaching_feedback",
    };

    const personas = new Set();
    for (const f of features.slice(0, 10)) {
      const key = f.feature_key ?? "";
      const manifestKey = featureKeyToManifestKey[key] ?? key;
      const feat = manifestFeatures[manifestKey];
      if (feat?.personas) {
        for (const p of feat.personas) {
          personas.add(p);
        }
      }
    }
    return [...personas];
  } catch {
    return [];
  }
}

/**
 * Load Thompson sampling scores for persona prioritization.
 * Combines Thompson score with homeostatic drives and hibernation state.
 */
function loadIntelligencePriority() {
  const priorities = {};

  // Thompson sampling scores
  try {
    if (fs.existsSync(THOMPSON_FILE)) {
      const data = JSON.parse(fs.readFileSync(THOMPSON_FILE, "utf-8"));
      const selection = data.selection ?? [];
      for (const entry of selection) {
        priorities[entry.personaId] = {
          thompsonScore: entry.score ?? 1.0,
          urgency: 0,
          hibernated: false,
        };
      }
    }
  } catch {
    // Non-fatal
  }

  // Homeostatic drives — boost hungry personas
  try {
    if (fs.existsSync(DRIVES_FILE)) {
      const data = JSON.parse(fs.readFileSync(DRIVES_FILE, "utf-8"));
      const personas = data.personas ?? {};
      for (const [id, drive] of Object.entries(personas)) {
        if (!priorities[id]) {
          priorities[id] = { thompsonScore: 1.0, urgency: 0, hibernated: false };
        }
        priorities[id].urgency = (drive.homeostatic_urgency ?? 0) * 0.3;
      }
    }
  } catch {
    // Non-fatal
  }

  // Hibernation state — mark dormant personas
  try {
    if (fs.existsSync(HIBERNATION_FILE)) {
      const data = JSON.parse(fs.readFileSync(HIBERNATION_FILE, "utf-8"));
      const personas = data.personas ?? {};
      for (const [id, entry] of Object.entries(personas)) {
        if (!priorities[id]) {
          priorities[id] = { thompsonScore: 1.0, urgency: 0, hibernated: false };
        }
        if (entry.status === "hibernated") {
          priorities[id].hibernated = true;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return priorities;
}

/**
 * Load feature health scores and return persona IDs that cover low-health features.
 * Low health = score < 60 (bugs, security issues, low pass rate).
 * Uses manifest to map features → personas.
 */
function loadFeatureHealthBoost() {
  if (!fs.existsSync(FEATURE_HEALTH_FILE) || !fs.existsSync(MANIFEST_FILE)) {
    return [];
  }
  try {
    const healthData = JSON.parse(fs.readFileSync(FEATURE_HEALTH_FILE, "utf-8"));
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8"));
    const features = healthData.features ?? healthData;
    const manifestFeatures = manifest.features ?? {};
    const LOW_HEALTH_THRESHOLD = 60;

    const boostPersonas = new Set();
    for (const [featureKey, health] of Object.entries(features)) {
      const score = typeof health === "number" ? health : (health?.composite ?? health?.score ?? 100);
      if (score >= LOW_HEALTH_THRESHOLD) {
        continue;
      }
      // Find personas that cover this feature
      const feat = manifestFeatures[featureKey];
      if (feat?.personas) {
        for (const p of feat.personas) {
          boostPersonas.add(p);
        }
      }
    }
    return [...boostPersonas];
  } catch {
    return [];
  }
}

/**
 * Load causal analysis — boost personas covering suspicious code areas.
 * Uses Ochiai fault localization to prioritize personas near likely bugs.
 */
function loadCausalBoost() {
  if (!fs.existsSync(CAUSAL_FILE)) {
    return [];
  }
  try {
    const causal = JSON.parse(fs.readFileSync(CAUSAL_FILE, "utf-8"));
    const ochiai = causal.ochiai ?? [];
    const boostPersonas = new Set();
    // Top 10 most suspicious areas → boost their personas
    for (const area of ochiai.slice(0, 10)) {
      for (const persona of area.personas ?? []) {
        boostPersonas.add(persona);
      }
    }
    return [...boostPersonas];
  } catch {
    return [];
  }
}

/**
 * Load coverage matrix — boost personas covering uncovered permissions and low-coverage features.
 */
function loadCoverageGapBoost() {
  if (!fs.existsSync(COVERAGE_MATRIX_FILE) || !fs.existsSync(MANIFEST_FILE)) {
    return [];
  }
  try {
    const matrix = JSON.parse(fs.readFileSync(COVERAGE_MATRIX_FILE, "utf-8"));
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8"));
    const manifestFeatures = manifest.features ?? {};
    const boostPersonas = new Set();

    // Personas covering uncovered permissions
    const permToPersonas = matrix.permToPersonas ?? {};
    for (const perm of matrix.uncoveredPermissions ?? []) {
      for (const p of permToPersonas[perm] ?? []) {
        boostPersonas.add(p);
      }
    }

    // Personas in features with < 50% coverage
    for (const [featureKey, cov] of Object.entries(matrix.featureCoverage ?? {})) {
      if ((cov.coveragePct ?? 100) < 50) {
        const feat = manifestFeatures[featureKey];
        if (feat?.personas) {
          for (const p of feat.personas) {
            boostPersonas.add(p);
          }
        }
      }
    }
    return [...boostPersonas];
  } catch {
    return [];
  }
}

/**
 * Load mutation plan — boost personas expected to detect critical/high mutations.
 */
function loadMutationTargetBoost() {
  if (!fs.existsSync(MUTATION_FILE)) {
    return [];
  }
  try {
    const plan = JSON.parse(fs.readFileSync(MUTATION_FILE, "utf-8"));
    const mutations = plan.mutations ?? [];
    const boostPersonas = new Set();
    for (const m of mutations) {
      if (m.severity === "critical" || m.severity === "high") {
        if (m.expectedDetector) {
          boostPersonas.add(m.expectedDetector);
        }
        for (const p of m.allDetectors ?? []) {
          boostPersonas.add(p);
        }
      }
    }
    return [...boostPersonas];
  } catch {
    return [];
  }
}

/**
 * Load foraging model — boost personas exploring new patches, deprioritize depleted ones.
 */
function loadForagingSignals() {
  if (!fs.existsSync(FORAGING_FILE)) {
    return { exploring: [], depleted: [] };
  }
  try {
    const model = JSON.parse(fs.readFileSync(FORAGING_FILE, "utf-8"));
    const assignments = model.persona_assignments ?? {};
    const exploring = [];
    const depleted = [];
    for (const [personaId, assignment] of Object.entries(assignments)) {
      if (assignment.decision === "LEAVE" && assignment.recommended_next) {
        exploring.push(personaId);
      } else if (assignment.decision === "LEAVE") {
        depleted.push(personaId);
      }
    }
    return { exploring, depleted };
  } catch {
    return { exploring: [], depleted: [] };
  }
}

const GRADE_HISTORY_FILE = path.join(ROOT, "e2e", "state", "product-grade-history.json");
const SPEC_CONTEXT_FILE = path.join(ROOT, "e2e", "state", "page-spec-context.json");

/**
 * Load product grade history and coverage gaps — boost personas covering:
 * - Pages with low grades (D, F)
 * - Pages in spec context that haven't been graded yet
 * Uses persona-learning focusAreas to match personas to pages.
 */
function loadProductQualityBoost() {
  const lowGradePages = new Set();
  const ungradedPages = new Set();

  // Find low-grade pages from history
  try {
    if (fs.existsSync(GRADE_HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(GRADE_HISTORY_FILE, "utf-8"));
      const entries = history.entries ?? [];
      // Get latest grade per page
      const latestByPage = {};
      for (const e of entries) {
        if (!latestByPage[e.page] || e.timestamp > latestByPage[e.page].timestamp) {
          latestByPage[e.page] = e;
        }
      }
      for (const [page, entry] of Object.entries(latestByPage)) {
        if (entry.overallGrade === "D" || entry.overallGrade === "F") {
          lowGradePages.add(page);
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Find ungraded pages (in spec context but never graded)
  try {
    if (fs.existsSync(SPEC_CONTEXT_FILE)) {
      const specContext = JSON.parse(fs.readFileSync(SPEC_CONTEXT_FILE, "utf-8"));
      const gradedPages = new Set();
      if (fs.existsSync(GRADE_HISTORY_FILE)) {
        const history = JSON.parse(fs.readFileSync(GRADE_HISTORY_FILE, "utf-8"));
        for (const e of history.entries ?? []) {
          gradedPages.add(e.page);
        }
      }
      for (const page of Object.keys(specContext)) {
        if (!gradedPages.has(page)) {
          ungradedPages.add(page);
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return { lowGradePages: [...lowGradePages], ungradedPages: [...ungradedPages] };
}

function discoverPersonaSpecs() {
  const personasDir = path.join(ROOT, "e2e", "tests", "personas");
  if (!fs.existsSync(personasDir)) {
    return ["cliff-patience", "frank-doorman", "sue-pervisor", "paige-turner", "penny-tester"];
  }
  const ids = fs
    .readdirSync(personasDir)
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => f.replace(/\.spec\.ts$/, ""))
    .sort();
  return ids.length > 0 ? ids : ["cliff-patience", "frank-doorman", "sue-pervisor"];
}

function main() {
  const learning = loadLearning();
  const history = getRecentRunHistory();

  const personaIds = Object.keys(learning.personas ?? {});
  const allPersonas = discoverPersonaSpecs();

  const toExpand = allPersonas.filter((id) => shouldExpand(id, learning, history));
  const fixEff = loadFixEffectiveness();

  // Phase 5.1: Expansion candidates — graduated score (nuance: isExpansionCandidate)
  const expansionCandidates = Object.entries(learning.personas ?? {})
    .filter(([id, e]) => allPersonas.includes(id) && isExpansionCandidate(e, learning.personas ?? {}))
    .map(([id]) => id);

  // Under-covered: personas with spec but 0 runs in learning (coverage gap bootstrap)
  const underCoveredPersonas = allPersonas.filter(
    (id) => !learning.personas?.[id] || (learning.personas[id]?.totalRuns ?? 0) === 0
  );

  const topFinders = Object.entries(learning.personas ?? {})
    .sort(([, a], [, b]) => (b.findingRate ?? 0) - (a.findingRate ?? 0))
    .slice(0, 5)
    .map(([id]) => id);

  const usageBasedPersonas = loadUsageBasedPersonas();
  const usageBoostPersonas = usageBasedPersonas.filter((p) => allPersonas.includes(p));

  // Phase 5.2: Feature health boost — prioritize personas that cover unhealthy features
  const healthBoostPersonas = loadFeatureHealthBoost().filter((p) => allPersonas.includes(p));

  // Deprioritize when last fix resolved findings (synergy with fix-effectiveness)
  const lastResolved = fixEff.lastResolved ?? false;

  // Phase E: focusAreasByPersona — pages where each persona finds issues
  const focusAreasByPersona = {};
  for (const [id, entry] of Object.entries(learning.personas ?? {})) {
    const areas = entry.focusAreas ?? [];
    if (areas.length > 0) {
      focusAreasByPersona[id] = areas;
    }
  }

  // Phase E: learningStats — summary for reports
  const entries = Object.entries(learning.personas ?? {});
  const rates = entries.map(([, e]) => e.findingRate ?? 0);
  const avgFindingRate =
    rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const learningStats = {
    totalPersonas: entries.length,
    avgFindingRate: Math.round(avgFindingRate * 100) / 100,
    topFinders: topFinders.slice(0, 5).map((id) => {
      const e = learning.personas[id];
      return {
        id,
        rate: e ? Math.round((e.findingRate ?? 0) * 100) / 100 : 0,
        focusAreas: (e?.focusAreas ?? []).slice(0, 3),
      };
    }),
  };

  // J3: Incremental = focusPersonas (findings) + expandPersonas (0 in last 2) + 2 random from rest
  let incrementalFilter = "full";
  if (INCREMENTAL) {
    const focusPersonas =
      topFinders.length > 0
        ? topFinders
        : Object.keys(learning.personas ?? {}).slice(0, 3).length > 0
          ? Object.keys(learning.personas ?? {}).slice(0, 3)
          : ["cliff-patience", "frank-doorman", "sue-pervisor"];
    const expandPersonas = toExpand.filter((p) => !focusPersonas.includes(p));
    const rest = allPersonas.filter(
      (p) => !focusPersonas.includes(p) && !expandPersonas.includes(p)
    );
    const random = rest.sort(() => Math.random() - 0.5).slice(0, 2);
    const combined = [...new Set([...focusPersonas, ...expandPersonas, ...random])];
    incrementalFilter =
      combined.length > 0
        ? [
            "tests/pre-login.spec.ts",
            "tests/00-smoke.spec.ts",
            ...combined.map((p) => `tests/personas/${p}.spec.ts`),
          ].join(" ")
        : "full";
  }

  // exploratory-first: top 5 personas for exploratory mode (probing + security + learning)
  const probingPersonas = [
    "quinn-quest",
    "frank-doorman",
    "maria-steadman",
    "penny-tester",
    "gina-guard",
    "cody-trust",
    "oscar-outsider",
    "sage-sparks",
  ];
  const exploratoryPersonas =
    topFinders.length >= 5
      ? topFinders.slice(0, 5)
      : [...new Set([...topFinders, ...probingPersonas])].slice(0, 5);

  // Phase 5.3: Intelligence-driven priority — Thompson sampling + drives + health + usage + finders
  const intelligencePriority = loadIntelligencePriority();

  // Phase 5.4: Multi-signal data sources — causal, coverage, mutation, foraging, quality
  const causalBoostPersonas = loadCausalBoost().filter((p) => allPersonas.includes(p));
  const coverageGapPersonas = loadCoverageGapBoost().filter((p) => allPersonas.includes(p));
  const mutationTargetPersonas = loadMutationTargetBoost().filter((p) => allPersonas.includes(p));
  const foragingSignals = loadForagingSignals();
  const productQuality = loadProductQualityBoost();

  // Map low-grade and ungraded pages → personas via focusAreas
  const lowGradePersonas = new Set();
  const ungradedPersonas = new Set();
  for (const [id, entry] of Object.entries(learning.personas ?? {})) {
    const areas = entry.focusAreas ?? [];
    for (const area of areas) {
      const normalizedArea = area.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[id]");
      if (productQuality.lowGradePages.some((p) => normalizedArea.includes(p) || p.includes(normalizedArea))) {
        lowGradePersonas.add(id);
      }
      if (productQuality.ungradedPages.some((p) => normalizedArea.includes(p) || p.includes(normalizedArea))) {
        ungradedPersonas.add(id);
      }
    }
  }

  // Sort all personas by composite intelligence score
  const scoredPersonas = allPersonas.map((id) => {
    const intel = intelligencePriority[id];
    let score = 0;
    // Thompson sampling score (Bayesian bandit — higher = more likely to find bugs)
    score += (intel?.thompsonScore ?? 1.0) * 2;
    // Homeostatic urgency (hungry personas explore more)
    score += intel?.urgency ?? 0;
    // Health boost (personas covering unhealthy features)
    if (healthBoostPersonas.includes(id)) { score += 1.5; }
    // Causal boost (personas covering fault-localized suspicious areas)
    if (causalBoostPersonas.includes(id)) { score += 1.2; }
    // Coverage gap boost (personas covering untested permissions/features)
    if (coverageGapPersonas.includes(id)) { score += 1.0; }
    // Usage boost (personas covering high-usage features)
    if (usageBoostPersonas.includes(id)) { score += 1.0; }
    // Mutation target boost (personas expected to catch injected bugs)
    if (mutationTargetPersonas.includes(id)) { score += 0.8; }
    // Top finder boost
    if (topFinders.includes(id)) { score += 1.0; }
    // Expansion candidate boost
    if (expansionCandidates.includes(id)) { score += 0.5; }
    // Foraging: exploring new patches = boost, depleted patches = slight penalty
    if (foragingSignals.exploring.includes(id)) { score += 1.0; }
    if (foragingSignals.depleted.includes(id)) { score -= 0.5; }
    // Product quality: boost personas visiting low-grade pages (needs improvement)
    if (lowGradePersonas.has(id)) { score += 1.5; }
    // Product quality: boost personas visiting ungraded pages (needs initial assessment)
    if (ungradedPersonas.has(id)) { score += 0.8; }
    // Hibernation penalty
    if (intel?.hibernated) { score -= 3.0; }
    return { id, score, hibernated: intel?.hibernated ?? false };
  });
  scoredPersonas.sort((a, b) => b.score - a.score);

  const priorityPersonas = scoredPersonas
    .filter((p) => !p.hibernated)
    .slice(0, 20)
    .map((p) => p.id);
  const prioritizedOrder =
    priorityPersonas.length > 0 || expansionCandidates.length > 0
      ? [
          ...priorityPersonas.map((p) => `tests/personas/${p}.spec.ts`),
          ...expansionCandidates
            .filter((p) => !priorityPersonas.includes(p))
            .map((p) => `tests/personas/${p}.spec.ts`),
          ...toExpand.filter((p) => !priorityPersonas.includes(p) && !expansionCandidates.includes(p)).map((p) => `tests/personas/${p}.spec.ts`),
          ...allPersonas
            .filter((p) => !priorityPersonas.includes(p) && !expansionCandidates.includes(p) && !toExpand.includes(p))
            .map((p) => `tests/personas/${p}.spec.ts`),
        ]
      : allPersonas.map((p) => `tests/personas/${p}.spec.ts`);
  const prioritizedFilter =
    prioritizedOrder.length > 0
      ? ["tests/pre-login.spec.ts", "tests/00-smoke.spec.ts", ...prioritizedOrder].join(" ")
      : "full";

  // Intelligence summary for reports
  const hibernatedCount = scoredPersonas.filter((p) => p.hibernated).length;
  const intelligenceStats = {
    thompsonActive: Object.keys(intelligencePriority).length,
    hibernated: hibernatedCount,
    topScored: scoredPersonas.slice(0, 5).map((p) => ({ id: p.id, score: Math.round(p.score * 100) / 100 })),
  };

  const output = {
    expandPersonas: toExpand,
    expansionCandidates: expansionCandidates,
    underCoveredPersonas: underCoveredPersonas,
    focusPersonas: topFinders,
    usageBoostPersonas: usageBoostPersonas.length > 0 ? usageBoostPersonas : null,
    healthBoostPersonas: healthBoostPersonas.length > 0 ? healthBoostPersonas : null,
    causalBoostPersonas: causalBoostPersonas.length > 0 ? causalBoostPersonas : null,
    coverageGapPersonas: coverageGapPersonas.length > 0 ? coverageGapPersonas : null,
    mutationTargetPersonas: mutationTargetPersonas.length > 0 ? mutationTargetPersonas : null,
    foragingExploring: foragingSignals.exploring.length > 0 ? foragingSignals.exploring : null,
    lastFixResolved: lastResolved,
    exploratoryPersonas: EXPLORATORY_FIRST ? exploratoryPersonas : null,
    focusAreasByPersona,
    learningStats,
    intelligenceStats,
    suggestedFilter:
      INCREMENTAL
        ? incrementalFilter
        : PRIORITIZED
          ? prioritizedFilter
          : toExpand.length > 0
            ? toExpand.map((p) => `tests/personas/${p}.spec.ts`).join(" ")
            : "full",
    prioritizedFilter: PRIORITIZED ? prioritizedFilter : null,
    priorityOrder: PRIORITIZED ? priorityPersonas : null,
    incrementalFilter: INCREMENTAL ? incrementalFilter : null,
    learningPersonaCount: personaIds.length,
    generatedAt: new Date().toISOString(),
  };

  if (EXPLORATORY_FIRST && JSON_OUT) {
    console.log(JSON.stringify({ exploratoryPersonas: output.exploratoryPersonas }));
  } else if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log("\n--- Learning-Driven Test Selection ---");
    console.log("Expand (0 findings in last 2 runs):", output.expandPersonas.join(", ") || "none");
    console.log("Expansion candidates (stable, findingRate<0.1):", output.expansionCandidates?.join(", ") || "none");
    console.log("Focus (high finding rate):", output.focusPersonas.join(", ") || "none");
    if (PRIORITIZED && output.priorityOrder?.length) {
      console.log("Priority order:", output.priorityOrder.join(", "));
    }
    if (usageBoostPersonas.length > 0) {
      console.log("Usage boost personas:", usageBoostPersonas.join(", "));
    }
    if (healthBoostPersonas.length > 0) {
      console.log("Health boost personas:", healthBoostPersonas.join(", "));
    }
    console.log("Focus areas by persona:", Object.keys(focusAreasByPersona).length, "personas");
    console.log("Learning stats:", JSON.stringify(learningStats));
    console.log("Suggested filter:", output.suggestedFilter);
    console.log("Personas in learning:", output.learningPersonaCount);
    if (EXPLORATORY_FIRST) {
      console.log("Exploratory-first personas:", output.exploratoryPersonas?.join(", ") ?? "none");
    }
    console.log("Intelligence:", JSON.stringify(intelligenceStats));
  }
}

main();
