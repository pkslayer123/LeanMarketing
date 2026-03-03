#!/usr/bin/env node

/**
 * Thompson Sampling Persona Selector — Multi-armed bandit test selection.
 *
 * Each persona is an "arm" with a Beta(alpha, beta) prior:
 *   alpha = findings + 1 (successes = found bugs)
 *   beta = (runs - findings) + 1 (failures = clean runs)
 *
 * Thompson Sampling draws from each arm's Beta distribution.
 * Higher draws = more likely to find bugs = selected first.
 *
 * Feature health weighting: arms covering low-health features get a boost.
 * Hotspot weighting: personas exploring high-pheromone pages get a boost.
 *
 * Usage:
 *   node scripts/e2e/thompson-selector.js                    # Human-readable
 *   node scripts/e2e/thompson-selector.js --json              # Machine-readable
 *   node scripts/e2e/thompson-selector.js --top 10            # Top N personas
 *   node scripts/e2e/thompson-selector.js --export            # Write to state file
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const HEALTH_FILE = path.join(ROOT, "e2e", "state", "feature-health-scores.json");
const MANIFEST_FILE = path.join(ROOT, "e2e", "state", "manifest.json");
const HOTSPOT_FILE = path.join(ROOT, "e2e", "state", "hotspot-map.json");
const OUTPUT_FILE = path.join(ROOT, "e2e", "state", "thompson-selection.json");
const PERSONAS_DIR = path.join(ROOT, "e2e", "tests", "personas");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const EXPORT = args.includes("--export");
const topNIdx = args.indexOf("--top");
const TOP_N = topNIdx >= 0 ? parseInt(args[topNIdx + 1] ?? "10", 10) : 10;

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Beta distribution sampling (Box-Muller approximation for small alpha/beta)
// ---------------------------------------------------------------------------

/**
 * Sample from Beta(alpha, beta) using the gamma distribution method.
 * For small alpha/beta, this is efficient and accurate.
 */
function sampleBeta(alpha, beta) {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  if (x + y === 0) {
    return 0.5;
  }
  return x / (x + y);
}

/**
 * Sample from Gamma(shape, 1) using Marsaglia & Tsang's method.
 */
function sampleGamma(shape) {
  if (shape < 1) {
    // Boost shape < 1 using power transform
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let x, v;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1 - 0.0331 * (x * x) * (x * x)) {
      return d * v;
    }

    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/** Standard normal random via Box-Muller. */
function randn() {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Feature health & hotspot weighting
// ---------------------------------------------------------------------------

function buildFeatureHealthWeights(manifest, healthScores) {
  if (!manifest || !healthScores) {
    return {};
  }

  const features = manifest.features ?? {};
  const weights = {};

  for (const [featureKey, config] of Object.entries(features)) {
    const personas = config.personas ?? [];
    const health = healthScores[featureKey];
    const score = typeof health === "number" ? health : (health?.composite ?? health?.score ?? 100);

    // Lower health = higher weight (inverse relationship)
    // Health 0 → weight 2.0, Health 50 → weight 1.5, Health 100 → weight 1.0
    const featureWeight = 1.0 + (1.0 - Math.min(score, 100) / 100);

    for (const p of personas) {
      // Take the max weight across all features a persona covers
      weights[p] = Math.max(weights[p] ?? 1.0, featureWeight);
    }
  }

  return weights;
}

function buildHotspotWeights(hotspotMap, manifest) {
  if (!hotspotMap || !manifest) {
    return {};
  }

  const hotspots = hotspotMap.hotspots ?? {};
  const features = manifest.features ?? {};
  const weights = {};

  // Map hotspot pages back to personas via manifest page mappings
  for (const [page, entry] of Object.entries(hotspots)) {
    if (entry.pheromone < 0.5) {
      continue;
    }

    // Directly attributed personas from the hotspot
    for (const pid of entry.personas ?? []) {
      weights[pid] = (weights[pid] ?? 0) + entry.pheromone * 0.1;
    }

    // Also boost personas that cover this page's feature area
    for (const [, config] of Object.entries(features)) {
      const pages = config.pages ?? [];
      const codeAreas = config.codeAreas ?? [];
      const matchesPage = pages.some((p) => page.includes(p));
      const matchesArea = codeAreas.some((a) => page.includes(a));

      if (matchesPage || matchesArea) {
        for (const p of config.personas ?? []) {
          weights[p] = (weights[p] ?? 0) + entry.pheromone * 0.05;
        }
      }
    }
  }

  // Normalize: convert to multiplier (1.0 + clamp(weight, 0, 1))
  const maxW = Math.max(...Object.values(weights), 1);
  for (const p of Object.keys(weights)) {
    weights[p] = 1.0 + Math.min(weights[p] / maxW, 1.0);
  }

  return weights;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const learning = loadJson(LEARNING_FILE) ?? { personas: {} };
  const healthScores = loadJson(HEALTH_FILE);
  const manifest = loadJson(MANIFEST_FILE);
  const hotspotMap = loadJson(HOTSPOT_FILE);

  // Discover all persona spec files
  const allPersonas = fs.existsSync(PERSONAS_DIR)
    ? fs
        .readdirSync(PERSONAS_DIR)
        .filter((f) => f.endsWith(".spec.ts"))
        .map((f) => f.replace(/\.spec\.ts$/, ""))
        .sort()
    : [];

  const featureWeights = buildFeatureHealthWeights(manifest, healthScores?.features ?? healthScores);
  const hotspotWeights = buildHotspotWeights(hotspotMap, manifest);

  // Severity weights for finding types (security findings worth more than cosmetic)
  const SEVERITY_WEIGHTS = { security: 5.0, bug: 3.0, ux: 1.5, suggestion: 0.5 };
  // Recency half-life in runs (observations older than this contribute less)
  const RECENCY_HALF_LIFE = 30;

  // Build Thompson Sampling scores for each persona
  const samples = allPersonas.map((personaId) => {
    const entry = learning.personas?.[personaId];

    // Severity-weighted, recency-decayed alpha/beta
    const totalRuns = entry?.totalRuns ?? 0;
    const totalFindings = entry?.totalFindings ?? 0;

    // If we have triage history, use severity-weighted recency-decayed priors
    const triageHistory = entry?.triageHistory ?? [];
    let alpha, beta;

    if (triageHistory.length > 0) {
      // Compute severity-weighted alpha from recent triage history
      let weightedFindings = 0;
      let weightedClean = 0;
      for (let i = 0; i < triageHistory.length; i++) {
        const age = triageHistory.length - 1 - i; // 0 = most recent
        const recencyDecay = Math.pow(0.5, age / RECENCY_HALF_LIFE);
        const sevWeight = SEVERITY_WEIGHTS[triageHistory[i].severity] ?? 1.0;
        const isActionable = triageHistory[i].action === "fix" || triageHistory[i].action === "analyst_fix";
        if (isActionable) {
          weightedFindings += sevWeight * recencyDecay;
        } else {
          weightedClean += recencyDecay;
        }
      }
      // Scale up to match run count, blend with raw counts
      const historyRatio = Math.min(triageHistory.length / Math.max(totalRuns, 1), 1);
      alpha = historyRatio * (weightedFindings + 1) + (1 - historyRatio) * (totalFindings + 1);
      beta = historyRatio * (weightedClean + 1) + (1 - historyRatio) * (Math.max(totalRuns - totalFindings, 0) + 1);
    } else {
      // Fallback: simple counts with recency decay based on run count
      const recencyFactor = totalRuns > RECENCY_HALF_LIFE * 2
        ? Math.pow(0.5, (totalRuns - RECENCY_HALF_LIFE * 2) / RECENCY_HALF_LIFE)
        : 1.0;
      alpha = totalFindings * recencyFactor + 1;
      beta = Math.max(totalRuns - totalFindings, 0) * recencyFactor + 1;
    }

    // Draw from Beta distribution
    const thompsonDraw = sampleBeta(alpha, beta);

    // Apply feature health weight
    const fWeight = featureWeights[personaId] ?? 1.0;

    // Apply hotspot weight
    const hWeight = hotspotWeights[personaId] ?? 1.0;

    // Exploration bonus for under-tested personas (< 3 runs)
    const explorationBonus = totalRuns < 3 ? 0.2 : 0;

    // Final score
    const score = (thompsonDraw + explorationBonus) * fWeight * hWeight;

    return {
      personaId,
      score: Math.round(score * 1000) / 1000,
      thompsonDraw: Math.round(thompsonDraw * 1000) / 1000,
      alpha: Math.round(alpha * 100) / 100,
      beta: Math.round(beta * 100) / 100,
      featureWeight: Math.round(fWeight * 100) / 100,
      hotspotWeight: Math.round(hWeight * 100) / 100,
      explorationBonus,
      totalRuns,
      totalFindings,
      findingRate: entry?.findingRate ?? 0,
    };
  });

  // Sort by score descending
  samples.sort((a, b) => b.score - a.score);

  const topPersonas = samples.slice(0, TOP_N);
  const output = {
    selection: topPersonas,
    allScores: samples,
    meta: {
      totalPersonas: allPersonas.length,
      featureHealthLoaded: healthScores != null,
      hotspotMapLoaded: hotspotMap != null,
      generatedAt: new Date().toISOString(),
    },
  };

  if (EXPORT) {
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");
    console.log(`Thompson selection written to: ${OUTPUT_FILE}`);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Human-readable output
  console.log("\n--- Thompson Sampling Persona Selection ---");
  console.log(`Personas: ${allPersonas.length} | Feature health: ${healthScores ? "yes" : "no"} | Hotspot map: ${hotspotMap ? "yes" : "no"}\n`);

  console.log("Rank  Persona                Score  Thompson  α/β      FH   HS   Runs  Findings");
  console.log("─".repeat(90));

  for (let i = 0; i < topPersonas.length; i++) {
    const s = topPersonas[i];
    const rank = String(i + 1).padStart(4);
    const name = s.personaId.padEnd(22);
    const score = s.score.toFixed(3).padStart(6);
    const draw = s.thompsonDraw.toFixed(3).padStart(9);
    const ab = `${s.alpha}/${s.beta}`.padStart(8);
    const fh = s.featureWeight.toFixed(1).padStart(4);
    const hs = s.hotspotWeight.toFixed(1).padStart(4);
    const runs = String(s.totalRuns).padStart(5);
    const findings = String(s.totalFindings).padStart(9);
    console.log(`${rank}  ${name}${score}${draw}  ${ab}${fh}${hs}${runs}${findings}`);
  }

  if (samples.length > TOP_N) {
    console.log(`\n... and ${samples.length - TOP_N} more personas (use --top N to see more)`);
  }
}

main();
