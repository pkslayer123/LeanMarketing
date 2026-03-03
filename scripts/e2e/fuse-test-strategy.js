#!/usr/bin/env node

/**
 * fuse-test-strategy.js — Pure algorithmic test strategy fusion.
 *
 * Replaces the broken Claude-dependent fusion in claude-test-strategy.js with
 * deterministic math. Reads 7 data sources (Thompson sampling, feature health,
 * curiosity engine, foraging model, BUILD-SPEC, persona learning, persona ROI)
 * and combines them into a weighted score per persona.
 *
 * Fusion formula per persona (12 signals):
 *   score = thompson_norm      x 0.20
 *         + health_need        x 0.12
 *         + curiosity_norm     x 0.10
 *         + foraging_norm      x 0.06
 *         + spec_gap_boost     x 0.06
 *         + roi_boost          x 0.10
 *         + failure_boost      (additive)
 *         + coverage_gap       (additive)
 *         + coverage_diversity x 0.04
 *         + production_risk    x 0.06
 *         + cold_start_boost   x 0.10
 *
 * Output: e2e/state/test-strategy.json (same format as claude-test-strategy.js)
 *
 * Safety:
 *   - All JSON reads wrapped in try/catch with defaults
 *   - Single file write at end
 *   - No Claude CLI calls (pure algorithmic, no corruption risk)
 *   - No code edits
 *
 * Usage:
 *   node scripts/e2e/fuse-test-strategy.js
 *   node scripts/e2e/fuse-test-strategy.js --max-personas 20
 *   node scripts/e2e/fuse-test-strategy.js --dry-run
 *   node scripts/e2e/fuse-test-strategy.js --json
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..");
const THOMPSON_PATH = path.join(ROOT, "e2e", "state", "thompson-selection.json");
const HEALTH_PATH = path.join(ROOT, "e2e", "state", "feature-health-scores.json");
const CURIOSITY_PATH = path.join(ROOT, "e2e", "state", "curiosity-model.json");
const FORAGING_PATH = path.join(ROOT, "e2e", "state", "foraging-model.json");
const PERSONA_LEARNING_PATH = path.join(ROOT, "e2e", "state", "persona-learning.json");
const PERSONA_ROI_PATH = path.join(ROOT, "e2e", "state", "persona-roi.json");
const COVERAGE_MATRIX_PATH = path.join(ROOT, "e2e", "state", "coverage-matrix.json");
const MANIFEST_PATH = path.join(ROOT, "e2e", "state", "manifest.json");
const FIX_FAILURE_BOOST_PATH = path.join(ROOT, "e2e", "state", "fix-failure-boost.json");
const PRODUCTION_TELEMETRY_PATH = path.join(ROOT, "e2e", "state", "production-telemetry.json");
const PRODUCTION_TEST_GAPS_PATH = path.join(ROOT, "e2e", "state", "production-test-gaps.json");
const OUTPUT_PATH = path.join(ROOT, "e2e", "state", "test-strategy.json");
const ADAPTIVE_WEIGHTS_PATH = path.join(ROOT, "e2e", "state", "fusion-weights.json");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const PERSONA_LAST_RUN_PATH = path.join(ROOT, "e2e", "state", "persona-last-run.json");
const QUARANTINE_PATH = path.join(ROOT, "e2e", "state", "test-quarantine.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const JSON_OUT = args.includes("--json");
let MAX_PERSONAS = parseInt(
  args[args.indexOf("--max-personas") + 1] || "20",
  10
) || 20;

// ---------------------------------------------------------------------------
// Safe JSON loader
// ---------------------------------------------------------------------------

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Data source loaders
// ---------------------------------------------------------------------------

function loadThompsonScores() {
  const data = loadJson(THOMPSON_PATH, { selection: [] });
  const selection = Array.isArray(data.selection) ? data.selection : [];
  const scores = {};
  for (const entry of selection) {
    if (entry.personaId && typeof entry.score === "number") {
      scores[entry.personaId] = entry.score;
    }
  }
  return scores;
}

function loadFixFailureBoosts() {
  const data = loadJson(FIX_FAILURE_BOOST_PATH, { boosts: [] });
  const boosts = data.boosts ?? [];
  const byPersona = {};
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
  for (const b of boosts) {
    const at = new Date(b.at || 0).getTime();
    if (at < cutoff) continue;
    const key = (b.persona || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (key) {
      byPersona[key] = (byPersona[key] ?? 0) + 1;
    }
  }
  return byPersona;
}

function loadFeatureHealth() {
  const data = loadJson(HEALTH_PATH, { features: {} });
  const features = data.features || {};
  const healthMap = {};
  for (const [feature, info] of Object.entries(features)) {
    if (info && typeof info.healthScore === "number") {
      healthMap[feature] = info.healthScore;
    }
  }
  return healthMap;
}

function loadCuriosityBonuses() {
  const data = loadJson(CURIOSITY_PATH, { forward_model: {} });
  const model = data.forward_model || {};
  const bonuses = {};
  for (const [key, entry] of Object.entries(model)) {
    if (entry && typeof entry.curiosity_bonus === "number") {
      // Key format: "/page|check_type" — extract just the page
      const page = key.split("|")[0] || key;
      bonuses[page] = (bonuses[page] || 0) + entry.curiosity_bonus;
    }
  }
  return bonuses;
}

function loadForagingScents() {
  const data = loadJson(FORAGING_PATH, { patches: {} });
  const patches = data.patches || {};
  const scents = {};
  for (const [feature, patch] of Object.entries(patches)) {
    if (patch && typeof patch.scent_strength === "number") {
      scents[feature] = patch.scent_strength;
    }
  }
  return scents;
}

function loadManifest() {
  return loadJson(MANIFEST_PATH, { features: {} });
}

function loadPersonaLearning() {
  const data = loadJson(PERSONA_LEARNING_PATH, { personas: {} });
  return data.personas || {};
}

const EXPLORED_PATHS_PATH = path.join(ROOT, "e2e", "state", "explored-paths.json");
const COVERAGE_GAP_DAYS = 7;

/**
 * Load coverage gaps for exploration — routes/personas with 0 or low coverage in last 7 days.
 * Returns a map of personaId -> coverageGapBoost (0-0.3).
 */
function loadCoverageGapsForExploration() {
  const boosts = {};
  try {
    const data = loadJson(EXPLORED_PATHS_PATH, { perPersona: {} });
    const perPersona = data.perPersona ?? {};
    const cutoff = Date.now() - COVERAGE_GAP_DAYS * 24 * 60 * 60 * 1000;

    for (const [personaId, entry] of Object.entries(perPersona)) {
      const paths = entry?.paths ?? {};
      let underTested = 0;
      let total = 0;
      for (const [, pathInfo] of Object.entries(paths)) {
        total++;
        const lastVisited = pathInfo?.lastVisited ? new Date(pathInfo.lastVisited).getTime() : 0;
        const visitCount = pathInfo?.visitCount ?? 0;
        if (visitCount === 0 || lastVisited < cutoff || visitCount < 2) {
          underTested++;
        }
      }
      if (total > 0 && underTested > 0) {
        const ratio = underTested / total;
        boosts[personaId] = Math.min(0.3, ratio * 0.3);
      }
    }
  } catch {
    // non-fatal
  }
  return boosts;
}

/**
 * Load coverage matrix data (uncovered permissions → pages with gaps).
 * Returns a set of feature keys that have coverage gaps.
 */
function loadCoverageMatrixGaps() {
  const data = loadJson(COVERAGE_MATRIX_PATH, { featureCoverage: {} });
  const gapFeatures = new Set();
  const featureCoverage = data.featureCoverage || {};
  for (const [featureKey, info] of Object.entries(featureCoverage)) {
    if (!info) {
      continue;
    }
    // Features with uncovered permissions or low coverage percentage are gaps
    const uncoveredPerms = info.uncoveredPermissions || [];
    const coveragePct = info.coveragePct ?? 100;
    if (uncoveredPerms.length > 0 || coveragePct < 50) {
      gapFeatures.add(featureKey);
    }
  }
  return gapFeatures;
}

/**
 * Load persona ROI data. Keys are display names; returns a slug-keyed map.
 */
function loadPersonaRoi() {
  const data = loadJson(PERSONA_ROI_PATH, { personas: {}, tiers: {} });
  const roiBySlug = {};
  for (const [displayName, entry] of Object.entries(data.personas || {})) {
    const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    roiBySlug[slug] = {
      tier: entry.tier || "no-data",
      roiScore: entry.roiScore || 0,
      fixContribution: entry.fixContribution || 0,
      noiseRate: entry.noiseRate || 0,
    };
  }
  return roiBySlug;
}

/**
 * Load production telemetry risk scores per page.
 * Returns a map of normalized page path -> riskScore (0-1).
 */
function loadProductionRiskScores() {
  const data = loadJson(PRODUCTION_TELEMETRY_PATH, { pages: {} });
  const pages = data.pages ?? {};
  const riskMap = {};
  for (const [page, info] of Object.entries(pages)) {
    if (info && typeof info.riskScore === "number") {
      riskMap[page] = Math.min(1, info.riskScore);
    }
  }
  return riskMap;
}

/**
 * Load production-test-gaps: pages with high production traffic but low test coverage.
 * Written by learn-from-production.js in the intelligence claw.
 * Returns a map of page path -> gap score (0-1).
 */
function loadProductionTestGaps() {
  const data = loadJson(PRODUCTION_TEST_GAPS_PATH, { gaps: [] });
  const gapMap = {};
  const gaps = Array.isArray(data.gaps) ? data.gaps : (Array.isArray(data) ? data : []);
  for (const gap of gaps) {
    if (gap && gap.page && typeof gap.gapScore === "number") {
      gapMap[gap.page] = Math.min(1, gap.gapScore);
    } else if (gap && gap.route) {
      // Alternative format: { route, coverage, traffic }
      const score = gap.traffic && gap.coverage !== undefined ? Math.min(1, (1 - gap.coverage) * (gap.traffic / 100)) : 0.5;
      gapMap[gap.route] = Math.min(1, score);
    }
  }
  return gapMap;
}

// ---------------------------------------------------------------------------
// BUILD-SPEC gap detection (reuses same logic as claude-test-strategy.js)
// ---------------------------------------------------------------------------

function loadBuildSpecGaps() {
  const { summarizeBuildSpec } = require("./claude-test-strategy");
  const spec = summarizeBuildSpec();
  const gapAreas = new Set();
  for (const area of spec.featureAreas || []) {
    if (area.hasGaps) {
      for (const ca of area.codeAreas || []) {
        gapAreas.add(ca);
      }
      // Also store the area name itself for matching
      gapAreas.add(area.name);
    }
  }
  return gapAreas;
}

// ---------------------------------------------------------------------------
// Build persona → features mapping from manifest
// ---------------------------------------------------------------------------

function buildPersonaFeatureMap(manifest) {
  const features = manifest.features || {};
  const personaFeatures = {};
  const personaPages = {};
  for (const [featureKey, featureDef] of Object.entries(features)) {
    const def = featureDef || {};
    for (const personaId of def.personas || []) {
      if (!personaFeatures[personaId]) {
        personaFeatures[personaId] = [];
      }
      personaFeatures[personaId].push(featureKey);
      if (!personaPages[personaId]) {
        personaPages[personaId] = [];
      }
      for (const page of def.pages || []) {
        personaPages[personaId].push(page);
      }
    }
  }
  return { personaFeatures, personaPages };
}

// ---------------------------------------------------------------------------
// Area convergence — suppress testing for pages that are green + no pending MOCs
// ---------------------------------------------------------------------------

const GREEN_HISTORY_PATH = path.join(ROOT, "e2e", "state", "green-history.json");
const MOC_QUEUE_PATH = path.join(ROOT, "e2e", "state", "moc-queue.json");
const AREA_CONVERGENCE_PATH = path.join(ROOT, "e2e", "state", "area-convergence.json");
const FINDINGS_PATH = path.join(ROOT, "e2e", "state", "findings", "findings.json");

function computeAreaConvergence() {
  const greenHistory = loadJson(GREEN_HISTORY_PATH, { tests: {} });
  const queueRaw = loadJson(MOC_QUEUE_PATH, { mocs: [] });
  const mocs = queueRaw.mocs ?? [];
  const findings = loadJson(FINDINGS_PATH, []);
  const findingsList = Array.isArray(findings) ? findings : findings.findings ?? [];

  // Pages with pending (unfixed) MOCs
  const pendingPages = new Set();
  for (const m of mocs) {
    if (["approved", "pending_fix", "pending_review", "pending_approval"].includes(m.status)) {
      const page = m.page ?? m.description?.match(/\*\*Page:\*\*\s*(\S+)/)?.[1] ?? "";
      if (page) {
        const normalPage = page.replace(/^https?:\/\/[^/]+/, "");
        pendingPages.add(normalPage);
      }
    }
  }

  // Pages with open findings
  const openFindingPages = new Set();
  for (const f of findingsList) {
    if (f.status === "open" || !f.status) {
      const page = (f.page ?? "").replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
      if (page) {
        openFindingPages.add(page);
      }
    }
  }

  // Green pages: passed 3+ consecutive runs without findings
  const greenPages = new Set();
  const tests = greenHistory.tests ?? {};
  for (const [testId, info] of Object.entries(tests)) {
    const consecutivePasses = info.consecutivePasses ?? 0;
    if (consecutivePasses >= 3) {
      const page = info.page ?? testId.split("|")[0] ?? "";
      if (page) {
        greenPages.add(page);
      }
    }
  }

  // A page is area-converged if: green AND no pending MOCs AND no open findings
  const convergedPages = new Set();
  for (const page of greenPages) {
    if (!pendingPages.has(page) && !openFindingPages.has(page)) {
      convergedPages.add(page);
    }
  }

  // Write state for other consumers
  const state = {
    convergedPages: [...convergedPages],
    pendingPages: [...pendingPages],
    openFindingPages: [...openFindingPages],
    greenPages: [...greenPages],
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(AREA_CONVERGENCE_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch { /* non-fatal */ }

  return convergedPages;
}

// ---------------------------------------------------------------------------
// Fusion algorithm
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Adaptive fusion weights — learn from finding correlations
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS = {
  thompson: 0.18, healthNeed: 0.12, curiosity: 0.10, foraging: 0.06,
  specGap: 0.06, roi: 0.10, coverageDiversity: 0.04, productionRisk: 0.06,
  productionTestGaps: 0.06, coldStart: 0.10,
};

function loadAdaptiveWeights() {
  try {
    if (fs.existsSync(ADAPTIVE_WEIGHTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(ADAPTIVE_WEIGHTS_PATH, "utf-8"));
      if (data.weights && typeof data.weights === "object") {
        // Merge with defaults (new signals get default weight)
        return { ...DEFAULT_WEIGHTS, ...data.weights };
      }
    }
  } catch { /* non-fatal */ }
  return { ...DEFAULT_WEIGHTS };
}

/**
 * Update adaptive weights based on which signal components correlated with findings.
 * Called by intelligence claw after test results are in.
 *
 * Method: For each persona that found issues, look at which signal components were high.
 * Nudge those weights up (EMA with alpha=0.1). For personas that found nothing, nudge down.
 * Normalize weights to sum to ~0.84 (excluding additive signals: failureBoost, coverageGap).
 *
 * @param {Array} results — Array of { persona, foundFindings: boolean, components: { ... } }
 */
function updateAdaptiveWeights(results) {
  if (!results || results.length === 0) { return; }

  const weights = loadAdaptiveWeights();
  const EMA_ALPHA = 0.1; // Learning rate
  const adjustableKeys = Object.keys(DEFAULT_WEIGHTS);

  // Compute correlation: how much each signal contributed to finding-producing personas
  const signalCorrelation = {};
  for (const key of adjustableKeys) { signalCorrelation[key] = 0; }

  let findingCount = 0;
  let cleanCount = 0;

  for (const r of results) {
    if (!r.components) { continue; }
    if (r.foundFindings) {
      findingCount++;
      for (const key of adjustableKeys) {
        signalCorrelation[key] += (r.components[key] ?? 0);
      }
    } else {
      cleanCount++;
      for (const key of adjustableKeys) {
        signalCorrelation[key] -= (r.components[key] ?? 0) * 0.3; // Weaker penalty
      }
    }
  }

  if (findingCount === 0) { return; } // No signal to learn from

  // Normalize correlation scores
  const maxCorr = Math.max(...Object.values(signalCorrelation).map(Math.abs), 1);
  for (const key of adjustableKeys) {
    const direction = signalCorrelation[key] / maxCorr; // -1 to +1
    // EMA update: nudge weight toward direction
    weights[key] = weights[key] * (1 - EMA_ALPHA) + (weights[key] + direction * 0.05) * EMA_ALPHA;
    // Clamp: never go below 0.01 or above 0.40
    weights[key] = Math.max(0.01, Math.min(0.40, weights[key]));
  }

  // Normalize so adjustable weights sum to ~0.84 (preserving relative proportions)
  const TARGET_SUM = 0.84;
  const currentSum = adjustableKeys.reduce((s, k) => s + weights[k], 0);
  if (currentSum > 0) {
    const scale = TARGET_SUM / currentSum;
    for (const key of adjustableKeys) {
      weights[key] = parseFloat((weights[key] * scale).toFixed(4));
    }
  }

  try {
    const state = {
      weights,
      updatedAt: new Date().toISOString(),
      sampleSize: results.length,
      findingPersonas: findingCount,
      cleanPersonas: cleanCount,
    };
    fs.writeFileSync(ADAPTIVE_WEIGHTS_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch { /* non-fatal */ }
}

function fuseStrategy() {
  // Load all data sources
  const thompsonScores = loadThompsonScores();
  const featureHealth = loadFeatureHealth();
  const curiosityBonuses = loadCuriosityBonuses();
  const foragingScents = loadForagingScents();
  const manifest = loadManifest();
  const personaLearning = loadPersonaLearning();
  const personaRoi = loadPersonaRoi();
  const fixFailureBoosts = loadFixFailureBoosts();
  const coverageGapBoosts = loadCoverageGapsForExploration();
  const productionRiskScores = loadProductionRiskScores();
  const productionTestGaps = loadProductionTestGaps();

  // Area convergence: identify pages that are green, have no pending MOCs, and need no testing
  const areaConvergence = computeAreaConvergence();

  let specGaps;
  try {
    specGaps = loadBuildSpecGaps();
  } catch {
    specGaps = new Set();
  }

  // Enrich specGaps from coverage-matrix.json (features with uncovered permissions)
  let coverageMatrixGaps;
  try {
    coverageMatrixGaps = loadCoverageMatrixGaps();
  } catch {
    coverageMatrixGaps = new Set();
  }

  const { personaFeatures, personaPages } = buildPersonaFeatureMap(manifest);

  // Collect all known persona IDs from all sources
  const allPersonas = new Set([
    ...Object.keys(thompsonScores),
    ...Object.keys(personaLearning),
    ...Object.keys(personaFeatures),
    ...Object.keys(coverageGapBoosts),
  ]);

  // Compute normalizers (max values across all personas)
  const maxThompson = Math.max(1, ...Object.values(thompsonScores));
  const maxCuriosity = Math.max(
    1,
    ...Object.values(curiosityBonuses)
  );
  const maxScent = Math.max(1, ...Object.values(foragingScents));

  // Score each persona
  const scored = [];
  for (const personaId of allPersonas) {
    // 1. Thompson normalized (0-1)
    const thompsonRaw = thompsonScores[personaId] ?? 0;
    const thompsonNorm = thompsonRaw / maxThompson;

    // 2. Health need: 1 - min health of covered features / 100
    const coveredFeatures = personaFeatures[personaId] || [];
    let minHealth = 100;
    for (const feat of coveredFeatures) {
      const h = featureHealth[feat];
      if (typeof h === "number" && h < minHealth) {
        minHealth = h;
      }
    }
    const healthNeed = 1 - minHealth / 100;

    // 3. Curiosity normalized (sum of bonuses for persona's pages)
    const pages = personaPages[personaId] || [];
    let curiositySum = 0;
    for (const page of pages) {
      curiositySum += curiosityBonuses[page] || 0;
    }
    const curiosityNorm = curiositySum / maxCuriosity;

    // 4. Foraging normalized (max scent of covered features)
    let maxPersonaScent = 0;
    for (const feat of coveredFeatures) {
      const s = foragingScents[feat];
      if (typeof s === "number" && s > maxPersonaScent) {
        maxPersonaScent = s;
      }
    }
    const foragingNorm = maxPersonaScent / maxScent;

    // 5. Spec gap boost: 1.0 if persona covers a BUILD-SPEC area with gaps
    let specGapBoost = 0;
    for (const feat of coveredFeatures) {
      if (specGaps.has(feat)) {
        specGapBoost = 1.0;
        break;
      }
    }
    // Also check code areas from manifest
    if (specGapBoost === 0) {
      const features = manifest.features || {};
      for (const feat of coveredFeatures) {
        const featureDef = features[feat];
        if (featureDef) {
          for (const ca of featureDef.codeAreas || []) {
            if (specGaps.has(ca)) {
              specGapBoost = 1.0;
              break;
            }
          }
        }
        if (specGapBoost > 0) {
          break;
        }
      }
    }
    // Enrich specGap from coverage-matrix.json (features with uncovered permissions get boost)
    if (specGapBoost < 1.0) {
      for (const feat of coveredFeatures) {
        if (coverageMatrixGaps.has(feat)) {
          specGapBoost = Math.min(1.0, specGapBoost + 0.2);
          break;
        }
      }
    }

    // 6. ROI boost: high-value personas get more test cycles
    const roi = personaRoi[personaId] || { tier: "no-data", roiScore: 0, fixContribution: 0 };
    let roiBoost;
    switch (roi.tier) {
      case "high-value": roiBoost = 1.0; break;
      case "medium-value": roiBoost = 0.5; break;
      case "low-value": roiBoost = 0.1; break;
      default: roiBoost = 0.3; // no-data — explore to learn
    }
    // Extra boost for personas with >20% fix contribution
    if (roi.fixContribution > 0.2) {
      roiBoost = Math.min(1.0, roiBoost + 0.15);
    }

    // 7. Fix failure boost: prioritize personas where fixes recently failed
    const failCount = fixFailureBoosts[personaId] ?? 0;
    const failureBoost = Math.min(0.5, failCount * 0.15);

    // 8. Coverage gap boost: prioritize personas covering under-tested routes (0 or low coverage in last 7 days)
    const coverageGapBoost = coverageGapBoosts[personaId] ?? 0;

    // 9. Coverage diversity: boost personas with many untested code areas (from manifest vs coverage profile)
    let coverageDiversity = 0;
    const pl = personaLearning[personaId];
    if (pl) {
      const coverageProfile = pl.coverageProfile ?? [];
      const coveredSet = new Set(coverageProfile);
      const features = manifest.features ?? {};
      let totalAreas = 0;
      let untestedAreas = 0;
      for (const feat of coveredFeatures) {
        const featureDef = features[feat];
        for (const ca of featureDef?.codeAreas ?? []) {
          totalAreas++;
          let isCovered = false;
          for (const cf of coveredSet) {
            if (cf.startsWith(ca) || ca.startsWith(cf)) { isCovered = true; break; }
          }
          if (!isCovered) { untestedAreas++; }
        }
      }
      if (totalAreas > 0) {
        coverageDiversity = untestedAreas / totalAreas;
      }
    }

    // 10. Production risk: prioritize personas covering high-traffic, high-error pages
    let productionRisk = 0;
    for (const page of pages) {
      const normalPage = page.replace(/^https?:\/\/[^/]+/, "");
      const risk = productionRiskScores[normalPage] ?? productionRiskScores[page] ?? 0;
      if (risk > productionRisk) {
        productionRisk = risk;
      }
    }

    // 11. Production test gaps: prioritize personas covering routes with high traffic but low coverage
    let testGapScore = 0;
    for (const page of pages) {
      const normalPage = page.replace(/^https?:\/\/[^/]+/, "");
      const gap = productionTestGaps[normalPage] ?? productionTestGaps[page] ?? 0;
      if (gap > testGapScore) {
        testGapScore = gap;
      }
    }

    // 12. Cold-start boost: never-run personas get a strong boost to break into top-N
    let coldStartBoost = 0;
    const hasEverRun = (personaLearning[personaId]?.totalRuns ?? 0) > 0;
    if (!hasEverRun) {
      coldStartBoost = 0.8; // Strong enough to break into top-20
    }

    // 12. Area convergence: suppress personas whose pages are all converged (green + no pending MOCs)
    let areaConvergenceMultiplier = 1.0;
    if (pages.length > 0 && areaConvergence.size > 0) {
      const normalPages = pages.map((p) => p.replace(/^https?:\/\/[^/]+/, ""));
      const convergedCount = normalPages.filter((p) => areaConvergence.has(p)).length;
      const convergedRatio = convergedCount / normalPages.length;
      if (convergedRatio >= 1.0) {
        areaConvergenceMultiplier = 0.05;
      } else if (convergedRatio >= 0.8) {
        areaConvergenceMultiplier = 0.3;
      }
    }

    // Adaptive fusion weights — learn from past finding correlations
    const w = loadAdaptiveWeights();
    const rawScore =
      thompsonNorm * w.thompson +
      healthNeed * w.healthNeed +
      curiosityNorm * w.curiosity +
      foragingNorm * w.foraging +
      specGapBoost * w.specGap +
      roiBoost * w.roi +
      failureBoost +
      coverageGapBoost +
      coverageDiversity * w.coverageDiversity +
      productionRisk * w.productionRisk +
      testGapScore * (w.productionTestGaps ?? 0.06) +
      coldStartBoost * w.coldStart;
    const score = rawScore * areaConvergenceMultiplier;

    scored.push({
      persona: personaId,
      score: Math.round(score * 1000) / 1000,
      components: {
        thompson: Math.round(thompsonNorm * 1000) / 1000,
        healthNeed: Math.round(healthNeed * 1000) / 1000,
        curiosity: Math.round(curiosityNorm * 1000) / 1000,
        foraging: Math.round(foragingNorm * 1000) / 1000,
        specGap: specGapBoost,
        roiBoost: Math.round(roiBoost * 1000) / 1000,
        failureBoost: Math.round(failureBoost * 1000) / 1000,
        coverageGap: Math.round(coverageGapBoost * 1000) / 1000,
        coverageDiversity: Math.round(coverageDiversity * 1000) / 1000,
        productionRisk: Math.round(productionRisk * 1000) / 1000,
        productionTestGaps: Math.round(testGapScore * 1000) / 1000,
        coldStart: Math.round(coldStartBoost * 1000) / 1000,
      },
      roiTier: roi.tier,
      features: coveredFeatures.slice(0, 5),
      findingRate: personaLearning[personaId]?.findingRate ?? 0,
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Dynamic MAX_PERSONAS: expand if many never-run personas exist
  const neverRunCount = scored.filter((p) => p.components.coldStart > 0).length;
  if (neverRunCount > 5) {
    const expandedMax = Math.min(30, MAX_PERSONAS + 5);
    if (!JSON_OUT) {
      console.log(`[fuse-test-strategy] Expanding MAX_PERSONAS ${MAX_PERSONAS} → ${expandedMax} (${neverRunCount} never-run personas)`);
    }
    MAX_PERSONAS = expandedMax;
  }

  // Rotation guarantee: reserve 2 slots for longest-unrun personas
  const ROTATION_SLOTS = 2;
  const MAX_UNRUN_CYCLES = 10;
  let lastRunData = {};
  try {
    if (fs.existsSync(PERSONA_LAST_RUN_PATH)) {
      lastRunData = JSON.parse(fs.readFileSync(PERSONA_LAST_RUN_PATH, "utf-8"));
    }
  } catch { /* non-fatal */ }

  // Build initial prioritized list
  let prioritized = scored.slice(0, MAX_PERSONAS);

  // Find overdue personas (unrun for MAX_UNRUN_CYCLES+ or never recorded)
  const currentCycle = prioritized[0]?.cycle ?? 0; // approximate
  const overdue = scored
    .filter((p) => {
      const lr = lastRunData[p.persona];
      if (!lr) { return true; } // Never recorded
      const cyclesSince = lr.cycle ? (currentCycle - lr.cycle) : MAX_UNRUN_CYCLES + 1;
      return cyclesSince > MAX_UNRUN_CYCLES;
    })
    .filter((p) => !prioritized.some((pr) => pr.persona === p.persona))
    .sort((a, b) => {
      // Sort by last-run age descending (oldest first)
      const aAge = lastRunData[a.persona]?.lastRun ? new Date(lastRunData[a.persona].lastRun).getTime() : 0;
      const bAge = lastRunData[b.persona]?.lastRun ? new Date(lastRunData[b.persona].lastRun).getTime() : 0;
      return aAge - bAge; // oldest (smallest timestamp) first
    });

  // Replace lowest-scored slots with overdue personas
  for (let i = 0; i < Math.min(ROTATION_SLOTS, overdue.length); i++) {
    const replaceIdx = prioritized.length - 1 - i;
    if (replaceIdx >= 0) {
      prioritized[replaceIdx] = overdue[i];
    }
  }

  // Epsilon-greedy exploration: reserve ~10% of slots for random personas
  // This prevents the system from converging on local optima
  const EPSILON = 0.10;
  const epsilonSlots = Math.max(1, Math.round(prioritized.length * EPSILON));
  const nonPrioritized = scored.filter((p) => !prioritized.some((pr) => pr.persona === p.persona));
  if (nonPrioritized.length > 0) {
    for (let i = 0; i < Math.min(epsilonSlots, nonPrioritized.length); i++) {
      // Random selection from non-prioritized (true exploration)
      const randIdx = Math.floor(Math.random() * nonPrioritized.length);
      const explorer = nonPrioritized.splice(randIdx, 1)[0];
      // Replace lowest-scored non-rotation slot
      const replaceIdx = prioritized.length - 1 - ROTATION_SLOTS - i;
      if (replaceIdx >= 0 && replaceIdx < prioritized.length) {
        if (!JSON_OUT) {
          console.log(`[fuse-test-strategy] ε-exploration: ${explorer.persona} replaces slot ${replaceIdx}`);
        }
        prioritized[replaceIdx] = explorer;
      }
    }
  }

  const skipped = scored.filter((p) => !prioritized.some((pr) => pr.persona === p.persona));

  // Detect existing spec files for personas
  const personaSpecDir = path.join(ROOT, "e2e", "tests", "personas");
  let existingSpecs = new Set();
  try {
    if (fs.existsSync(personaSpecDir)) {
      const files = fs.readdirSync(personaSpecDir);
      for (const f of files) {
        if (f.endsWith(".spec.ts")) {
          existingSpecs.add(f.replace(".spec.ts", ""));
        }
      }
    }
  } catch {
    // non-fatal
  }

  // Build output in the same format as claude-test-strategy.js normalizeStrategy()
  const strategy = {
    generatedAt: new Date().toISOString(),
    mode: "fused",
    maxPersonas: MAX_PERSONAS,
    prioritizedPersonas: prioritized.map((p) => ({
      persona: p.persona,
      priority: p.score,
      reason: formatReason(p),
      specPath: `tests/personas/${p.persona}.spec.ts`,
    })),
    coverageGaps: detectCoverageGaps(featureHealth, manifest),
    focusPages: detectFocusPages(curiosityBonuses, specGaps),
    skipRecommendations: skipped.map((p) => ({
      persona: p.persona,
      reason: `Low fusion score (${p.score})`,
    })),
    testMode: "balanced",
    estimatedDuration: "unknown",
    effectiveMaxPersonas: MAX_PERSONAS,
    neverRunPersonas: neverRunCount,
    rotationSlotsUsed: Math.min(ROTATION_SLOTS, overdue.length),
    reasoning: `Algorithmic fusion of ${allPersonas.size} personas across 7 data sources (incl. ROI + cold-start). Top scorer: ${scored[0]?.persona ?? "none"} (${scored[0]?.score ?? 0}). ${neverRunCount} never-run, ${overdue.length} overdue.`,
    _source: "algorithmic",
    recommendedFilter: prioritized
      .map((p) => `tests/personas/${p.persona}.spec.ts`)
      .filter((spec) => {
        const id = spec.replace("tests/personas/", "").replace(".spec.ts", "");
        return existingSpecs.has(id);
      }),
    skipFilter: skipped
      .map((p) => p.persona)
      .filter((id) => existingSpecs.has(id)),
  };

  return strategy;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatReason(p) {
  const parts = [];
  if (p.components.thompson > 0.5) {
    parts.push("high Thompson score");
  }
  if (p.components.healthNeed > 0.3) {
    parts.push("covers unhealthy features");
  }
  if (p.components.curiosity > 0.3) {
    parts.push("high curiosity areas");
  }
  if (p.components.foraging > 0.3) {
    parts.push("rich foraging patch");
  }
  if (p.components.specGap > 0) {
    parts.push("BUILD-SPEC gap coverage");
  }
  if (p.components.roiBoost > 0.7) {
    parts.push("high ROI persona");
  }
  if (p.components.coverageGap > 0) {
    parts.push("covers under-tested routes");
  }
  if (parts.length === 0) {
    parts.push("balanced coverage");
  }
  return parts.join(", ");
}

function detectCoverageGaps(featureHealth, manifest) {
  const gaps = [];
  const features = manifest.features || {};
  for (const [feat, health] of Object.entries(featureHealth)) {
    if (typeof health === "number" && health < 60) {
      const featureDef = features[feat] || {};
      gaps.push({
        feature: feat,
        healthScore: health,
        pages: (featureDef.pages || []).slice(0, 3),
        personas: (featureDef.personas || []).slice(0, 3),
      });
    }
  }
  gaps.sort((a, b) => a.healthScore - b.healthScore);
  return gaps.slice(0, 10);
}

function detectFocusPages(curiosityBonuses, specGaps) {
  const pages = [];
  for (const [page, bonus] of Object.entries(curiosityBonuses)) {
    if (bonus > 2) {
      pages.push({ page, curiosityBonus: bonus, inSpecGap: specGaps.has(page) });
    }
  }
  pages.sort((a, b) => b.curiosityBonus - a.curiosityBonus);
  return pages.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const strategy = fuseStrategy();

  if (!JSON_OUT) {
    console.log(`[fuse-test-strategy] Scored ${strategy.prioritizedPersonas.length + strategy.skipRecommendations.length} personas`);
    console.log(`  Top ${Math.min(5, strategy.prioritizedPersonas.length)}:`);
    for (const p of strategy.prioritizedPersonas.slice(0, 5)) {
      console.log(`    ${p.persona}: ${p.priority} — ${p.reason}`);
    }
    console.log(`  Coverage gaps: ${strategy.coverageGaps.length}`);
    console.log(`  Focus pages: ${strategy.focusPages.length}`);
    console.log(`  Skip: ${strategy.skipRecommendations.length} personas`);
  }

  if (DRY_RUN) {
    if (JSON_OUT) {
      console.log(JSON.stringify(strategy, null, 2));
    } else {
      console.log("[fuse-test-strategy] Dry run — not writing output");
    }
    return;
  }

  // Single write at end
  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(strategy, null, 2) + "\n");

  if (JSON_OUT) {
    console.log(JSON.stringify(strategy, null, 2));
  } else {
    console.log(`[fuse-test-strategy] Strategy written to ${path.relative(ROOT, OUTPUT_PATH)}`);
  }
}

main();
