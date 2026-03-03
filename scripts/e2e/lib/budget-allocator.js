/**
 * Autonomous Budget Allocator
 *
 * Dynamically allocates oracle token budget based on persona ROI scores.
 * High-ROI personas (find real bugs, fixes get applied) get more budget.
 * Low-ROI personas (noise, FPs) get reduced budget.
 *
 * Reads: persona-roi.json, daemon-config.json
 * Writes: budget-allocation.json (consumed by token-budget.ts)
 *
 * Integration: Called by intelligence claw after ROI scoring.
 * Also consulted by discovery-sampler.ts for sample rate adjustment.
 *
 * Usage:
 *   const { computeAllocations, getPersonaBudgetMultiplier } = require("./lib/budget-allocator");
 *   const allocations = computeAllocations();
 *   const multiplier = getPersonaBudgetMultiplier("alice-admin"); // 1.5x
 */

const fs = require("fs");
const path = require("path");

const STATE_DIR = path.resolve(__dirname, "..", "..", "..", "e2e", "state");
const ROI_PATH = path.join(STATE_DIR, "persona-roi.json");
const ALLOCATION_PATH = path.join(STATE_DIR, "budget-allocation.json");

const DEFAULTS = {
  baseBudgetTokens: 400000, // 400K tokens total per run
  // Multiplier ranges
  highRoiMultiplier: 1.5,     // 50% more budget
  mediumRoiMultiplier: 1.0,   // Normal budget
  lowRoiMultiplier: 0.5,      // 50% less budget
  noDataMultiplier: 0.8,      // Slight reduction for unscored personas
  // Thresholds (from persona-roi-scorer.js)
  highRoiThreshold: 0.6,
  lowRoiThreshold: 0.2,
  // High fix contribution bonus
  fixContributionBonus: 0.3,  // +30% for personas with >20% fix contribution
  fixContributionThreshold: 0.2,
  // Noise penalty
  noisePenalty: 0.2,          // -20% for personas with >50% noise rate
  noiseThreshold: 0.5,
};

function loadRoi() {
  try {
    if (fs.existsSync(ROI_PATH)) {
      return JSON.parse(fs.readFileSync(ROI_PATH, "utf-8"));
    }
  } catch {}
  return null;
}

function loadExistingAllocations() {
  try {
    if (fs.existsSync(ALLOCATION_PATH)) {
      return JSON.parse(fs.readFileSync(ALLOCATION_PATH, "utf-8"));
    }
  } catch {}
  return null;
}

/**
 * Compute budget multiplier for a single persona based on ROI data.
 */
function computeMultiplier(personaRoi) {
  if (!personaRoi || !personaRoi.roiScore) {
    return DEFAULTS.noDataMultiplier;
  }

  let multiplier;
  const score = personaRoi.roiScore;

  if (score >= DEFAULTS.highRoiThreshold) {
    multiplier = DEFAULTS.highRoiMultiplier;
  } else if (score <= DEFAULTS.lowRoiThreshold) {
    multiplier = DEFAULTS.lowRoiMultiplier;
  } else {
    // Linear interpolation between low and high
    const range = DEFAULTS.highRoiThreshold - DEFAULTS.lowRoiThreshold;
    const progress = (score - DEFAULTS.lowRoiThreshold) / range;
    multiplier = DEFAULTS.lowRoiMultiplier + progress * (DEFAULTS.highRoiMultiplier - DEFAULTS.lowRoiMultiplier);
  }

  // Fix contribution bonus
  if ((personaRoi.fixContribution ?? 0) > DEFAULTS.fixContributionThreshold) {
    multiplier += DEFAULTS.fixContributionBonus;
  }

  // Noise penalty
  if ((personaRoi.noiseRate ?? 0) > DEFAULTS.noiseThreshold) {
    multiplier -= DEFAULTS.noisePenalty;
  }

  // Clamp to reasonable range
  return Math.max(0.3, Math.min(2.0, multiplier));
}

/**
 * Compute allocations for all personas.
 * Returns an object mapping personaId → { multiplier, tier, budgetTokens }.
 */
function computeAllocations() {
  const roi = loadRoi();
  if (!roi?.personas) {
    return { personas: {}, totalBudget: DEFAULTS.baseBudgetTokens, computed: false };
  }

  const allocations = {};
  let totalWeight = 0;

  // Compute raw multipliers
  for (const [personaId, personaRoi] of Object.entries(roi.personas)) {
    const multiplier = computeMultiplier(personaRoi);
    const tier = multiplier >= DEFAULTS.highRoiMultiplier * 0.9 ? "high"
      : multiplier <= DEFAULTS.lowRoiMultiplier * 1.1 ? "low"
      : "medium";

    allocations[personaId] = {
      multiplier,
      tier,
      roiScore: personaRoi.roiScore ?? 0,
      fixContribution: personaRoi.fixContribution ?? 0,
      noiseRate: personaRoi.noiseRate ?? 0,
    };
    totalWeight += multiplier;
  }

  // Normalize to total budget
  const personaCount = Object.keys(allocations).length;
  const budgetPerUnitWeight = DEFAULTS.baseBudgetTokens / (totalWeight || 1);

  for (const [personaId, alloc] of Object.entries(allocations)) {
    alloc.budgetTokens = Math.round(budgetPerUnitWeight * alloc.multiplier);
  }

  const result = {
    personas: allocations,
    totalBudget: DEFAULTS.baseBudgetTokens,
    personaCount,
    computed: true,
    computedAt: new Date().toISOString(),
    tierBreakdown: {
      high: Object.values(allocations).filter((a) => a.tier === "high").length,
      medium: Object.values(allocations).filter((a) => a.tier === "medium").length,
      low: Object.values(allocations).filter((a) => a.tier === "low").length,
    },
  };

  // Write to file
  try {
    const tmpPath = ALLOCATION_PATH + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2) + "\n");
    fs.renameSync(tmpPath, ALLOCATION_PATH);
  } catch {}

  return result;
}

/**
 * Get budget multiplier for a specific persona.
 * Fast path: reads cached allocations instead of recomputing.
 */
function getPersonaBudgetMultiplier(personaId) {
  const existing = loadExistingAllocations();
  if (existing?.personas?.[personaId]) {
    return existing.personas[personaId].multiplier;
  }

  // Fallback: compute from ROI directly
  const roi = loadRoi();
  if (roi?.personas?.[personaId]) {
    return computeMultiplier(roi.personas[personaId]);
  }

  return DEFAULTS.noDataMultiplier;
}

/**
 * Get the recommended oracle model tier for a persona.
 * High-ROI → use premium model; low-ROI → use cheapest.
 */
function getRecommendedModelTier(personaId) {
  const multiplier = getPersonaBudgetMultiplier(personaId);
  if (multiplier >= DEFAULTS.highRoiMultiplier * 0.9) { return "premium"; }
  if (multiplier <= DEFAULTS.lowRoiMultiplier * 1.1) { return "economy"; }
  return "standard";
}

// CLI mode
if (require.main === module) {
  const result = computeAllocations();
  if (result.computed) {
    console.log(`Budget allocated for ${result.personaCount} personas:`);
    console.log(`  High ROI: ${result.tierBreakdown.high}`);
    console.log(`  Medium ROI: ${result.tierBreakdown.medium}`);
    console.log(`  Low ROI: ${result.tierBreakdown.low}`);
    console.log(`  Total budget: ${result.totalBudget} tokens`);
  } else {
    console.log("No ROI data available — using default allocations");
  }
}

module.exports = {
  computeAllocations,
  getPersonaBudgetMultiplier,
  getRecommendedModelTier,
  computeMultiplier,
  DEFAULTS,
};
