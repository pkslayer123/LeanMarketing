#!/usr/bin/env node

/**
 * Information Foraging Decisions — Pirolli & Card patch model.
 *
 * Models feature areas as "patches", bugs as "prey", personas as "predators".
 * Uses Marginal Value Theorem: a persona should leave its current patch when
 * the extraction rate drops below the environment's average rate minus the
 * travel cost of switching patches.
 *
 * Scent cues (error_rate, code_churn, open_findings, coverage_gap) guide
 * personas toward the richest patches. Diet breadth constrains which finding
 * types a persona is willing to pursue.
 *
 * Reads:
 *   - e2e/state/persona-learning.json
 *   - e2e/state/findings/findings.json
 *   - e2e/state/green-history.json
 *   - e2e/state/feature-health-scores.json
 *   - e2e/state/manifest.json
 *   - e2e/state/foraging-model.json (previous state)
 *
 * Writes:
 *   - e2e/state/foraging-model.json
 *
 * Usage:
 *   node scripts/e2e/foraging-decisions.js              # Human-readable
 *   node scripts/e2e/foraging-decisions.js --json        # Machine-readable
 *   node scripts/e2e/foraging-decisions.js --export      # Write to state file
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_FILE = path.join(ROOT, "e2e", "state", "manifest.json");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const GREEN_HISTORY_FILE = path.join(ROOT, "e2e", "state", "green-history.json");
const HEALTH_SCORES_FILE = path.join(ROOT, "e2e", "state", "feature-health-scores.json");
const PREVIOUS_FILE = path.join(ROOT, "e2e", "state", "foraging-model.json");
const OUTPUT_FILE = path.join(ROOT, "e2e", "state", "foraging-model.json");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const EXPORT = args.includes("--export");

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

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
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  scent_weights: {
    error_rate: 0.3,
    code_churn: 0.25,
    open_findings: 0.2,
    coverage_gap: 0.25,
  },
  marginal_threshold_factor: 0.5,
  travel_cost_base: 0.2,
};

// ---------------------------------------------------------------------------
// Diet breadth — maps persona archetypes to finding types they pursue
// ---------------------------------------------------------------------------

const DIET_BREADTH_MAP = {
  "oscar-outsider": ["permission", "bola", "access-control"],
  "rex-expired": ["session", "auth", "permission"],
  "norma-null": ["null-safety", "missing-data", "empty-state"],
  "daria-dark": ["contrast", "dark-mode", "visual"],
  "ally-access": ["accessibility", "wcag", "aria"],
  "pete-performance": ["performance", "timing", "loading"],
  "frank-doorman": ["access-control", "permission", "navigation"],
  "cal-compliance": ["compliance", "audit", "validation"],
  "cliff-patience": ["timeout", "loading", "ux"],
  "wanda-walls": ["authorization", "boundary", "permission"],
  "cody-trust": ["security", "data-leak", "code-quality"],
  "max-manual": ["agent", "internal-tools", "automation"],
  "drew-handoff": ["onboarding", "ux", "documentation"],
  "saul-search": ["search", "filtering", "data-retrieval"],
  "paige-turner": ["workflow", "navigation", "ux"],
  "uma-unicode": ["unicode", "i18n", "encoding"],
};

// ---------------------------------------------------------------------------
// Build patches from manifest features
// ---------------------------------------------------------------------------

function buildPatches(manifest, findings, learning, greenHistory, healthScores, previous) {
  const features = manifest?.features ?? {};
  const allFindings = normalizeFindings(findings);
  const openFindings = allFindings.filter((f) => f.status !== "resolved");
  const personaData = learning?.personas ?? {};
  const tests = greenHistory?.tests ?? {};
  const prevPatches = previous?.patches ?? {};
  const healthFeatures = healthScores?.features ?? healthScores ?? {};

  const patches = {};

  for (const [featureKey, config] of Object.entries(features)) {
    const personas = config.personas ?? [];
    const pages = config.pages ?? [];
    const codeAreas = config.codeAreas ?? [];

    // Count findings in this patch
    const patchFindings = openFindings.filter((f) => {
      if (pages.some((p) => f.page?.includes(p))) {
        return true;
      }
      if (codeAreas.some((a) => f.page?.includes(a) || f.description?.includes(a))) {
        return true;
      }
      if (f.persona && personas.some((p) => normalizeName(p) === normalizeName(f.persona))) {
        return true;
      }
      return false;
    });

    // Count total sessions (persona runs) in this patch
    let totalSessions = 0;
    for (const pid of personas) {
      const entry = personaData[pid];
      if (entry) {
        totalSessions += entry.totalRuns ?? 0;
      }
    }

    // Extraction rate = findings / max(sessions, 1)
    const extractionRate = patchFindings.length / Math.max(totalSessions, 1);

    // Richness = open findings as a raw count (higher = richer)
    const richness = patchFindings.length;

    // Scent cues
    const health = healthFeatures[featureKey];
    const errorRate = health
      ? (100 - (health.healthScore ?? health.breakdown?.findings ?? 100)) / 100
      : 0;

    // Code churn: count recently failed tests in this patch
    const relatedTests = Object.entries(tests).filter(([title]) => {
      const norm = title.toLowerCase();
      return personas.some((p) => norm.includes(p));
    });
    const failingTests = relatedTests.filter(
      ([, e]) => (e.consecutivePasses ?? 0) === 0
    ).length;
    const codeChurn = failingTests;

    // Coverage gap: personas that have never run
    const activePersonas = personas.filter(
      (p) => (personaData[p]?.totalRuns ?? 0) > 0
    ).length;
    const coverageGap =
      personas.length > 0 ? 1 - activePersonas / personas.length : 1;

    const scentCues = {
      error_rate: Math.round(errorRate * 100) / 100,
      code_churn: codeChurn,
      open_findings: patchFindings.length,
      coverage_gap: Math.round(coverageGap * 100) / 100,
    };

    // Weighted scent strength
    const weights = DEFAULT_CONFIG.scent_weights;
    const scentStrength =
      scentCues.error_rate * weights.error_rate +
      Math.min(scentCues.code_churn / 10, 1) * weights.code_churn +
      Math.min(scentCues.open_findings / 5, 1) * weights.open_findings +
      scentCues.coverage_gap * weights.coverage_gap;

    // Depletion history: carry forward from previous, append current
    const prevDepletion = prevPatches[featureKey]?.depletion_history ?? [];
    const currentIteration = prevDepletion.length > 0
      ? Math.max(...prevDepletion.map((d) => d.iteration)) + 1
      : 1;
    const depletion = [
      ...prevDepletion.slice(-19), // keep last 20 entries
      { iteration: currentIteration, rate: Math.round(extractionRate * 1000) / 1000 },
    ];

    patches[featureKey] = {
      richness: Math.round(richness * 100) / 100,
      extraction_rate: Math.round(extractionRate * 1000) / 1000,
      depletion_history: depletion,
      scent_cues: scentCues,
      scent_strength: Math.round(scentStrength * 1000) / 1000,
    };
  }

  return patches;
}

// ---------------------------------------------------------------------------
// Persona foraging decisions (Marginal Value Theorem)
// ---------------------------------------------------------------------------

function computePersonaAssignments(patches, manifest, learning, previous) {
  const features = manifest?.features ?? {};
  const personaData = learning?.personas ?? {};
  const prevAssignments = previous?.persona_assignments ?? {};

  // Global average extraction rate across all patches
  const patchValues = Object.values(patches);
  const avgRate =
    patchValues.length > 0
      ? patchValues.reduce((sum, p) => sum + p.extraction_rate, 0) / patchValues.length
      : 0;

  // Marginal threshold: leave when rate < avg * factor - travel cost
  const marginalThreshold =
    avgRate * DEFAULT_CONFIG.marginal_threshold_factor - DEFAULT_CONFIG.travel_cost_base;
  const threshold = Math.max(marginalThreshold, 0);

  // Build reverse mapping: persona -> features they belong to
  const personaFeatures = {};
  for (const [featureKey, config] of Object.entries(features)) {
    for (const pid of config.personas ?? []) {
      if (!personaFeatures[pid]) {
        personaFeatures[pid] = [];
      }
      personaFeatures[pid].push(featureKey);
    }
  }

  const assignments = {};

  for (const [pid, featureKeys] of Object.entries(personaFeatures)) {
    if (featureKeys.length === 0) {
      continue;
    }

    const prevAssignment = prevAssignments[pid];
    const currentPatch = prevAssignment?.current_patch ?? featureKeys[0];
    const iterationsInPatch = prevAssignment
      ? (prevAssignment.iterations_in_patch ?? 0) + 1
      : 1;

    // Current patch extraction rate
    const currentRate = patches[currentPatch]?.extraction_rate ?? 0;

    // Decide: STAY or LEAVE
    let decision = "STAY";
    let reason = "rate above marginal threshold";
    let recommendedNext = null;

    if (currentRate <= threshold && iterationsInPatch >= 2) {
      decision = "LEAVE";
      reason = "rate below marginal threshold";

      // Find best alternative patch by scent, filtered by diet breadth
      const diet = getDietBreadth(pid);
      const candidates = featureKeys
        .filter((fk) => fk !== currentPatch)
        .map((fk) => ({
          key: fk,
          scent: patches[fk]?.scent_strength ?? 0,
          rate: patches[fk]?.extraction_rate ?? 0,
        }))
        .sort((a, b) => b.scent - a.scent);

      if (candidates.length > 0) {
        recommendedNext = candidates[0].key;
      }
    } else if (iterationsInPatch < 2) {
      reason = "minimum exploration period (2 iterations)";
    }

    assignments[pid] = {
      current_patch: decision === "LEAVE" && recommendedNext ? recommendedNext : currentPatch,
      iterations_in_patch: decision === "LEAVE" ? 0 : iterationsInPatch,
      extraction_rate: Math.round(currentRate * 1000) / 1000,
      decision,
      recommended_next: recommendedNext,
      reason,
    };
  }

  return assignments;
}

// ---------------------------------------------------------------------------
// Diet breadth
// ---------------------------------------------------------------------------

function getDietBreadth(personaId) {
  return DIET_BREADTH_MAP[personaId] ?? ["general"];
}

function buildDietBreadthOutput(personaAssignments) {
  const diet = {};
  for (const pid of Object.keys(personaAssignments)) {
    diet[pid] = getDietBreadth(pid);
  }
  return diet;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeFindings(findings) {
  if (Array.isArray(findings)) {
    return findings;
  }
  return findings?.findings ?? [];
}

function normalizeName(name) {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function printReport(output) {
  console.log("\n--- Information Foraging Decisions (Pirolli & Card Patch Model) ---");
  console.log(
    `Patches: ${output.meta.total_patches} | Depleted: ${output.meta.depleted_patches} | ` +
      `Avg extraction rate: ${output.meta.avg_extraction_rate}`
  );

  // Top patches by scent
  const patchEntries = Object.entries(output.patches)
    .sort(([, a], [, b]) => b.scent_strength - a.scent_strength)
    .slice(0, 15);

  console.log("\nTop Patches by Scent Strength:");
  console.log(
    "  " +
      padRight("Patch", 30) +
      padRight("Scent", 8) +
      padRight("Rate", 8) +
      padRight("Rich", 6) +
      padRight("Err%", 6) +
      padRight("Open", 6) +
      padRight("Gap", 6)
  );
  console.log("  " + "-".repeat(70));

  for (const [key, patch] of patchEntries) {
    console.log(
      "  " +
        padRight(key, 30) +
        padRight(patch.scent_strength.toFixed(3), 8) +
        padRight(patch.extraction_rate.toFixed(3), 8) +
        padRight(String(patch.richness), 6) +
        padRight(patch.scent_cues.error_rate.toFixed(2), 6) +
        padRight(String(patch.scent_cues.open_findings), 6) +
        padRight(patch.scent_cues.coverage_gap.toFixed(2), 6)
    );
  }

  // Persona decisions
  const decisions = Object.entries(output.persona_assignments);
  const leaveCount = decisions.filter(([, a]) => a.decision === "LEAVE").length;
  const stayCount = decisions.filter(([, a]) => a.decision === "STAY").length;

  console.log(`\nPersona Foraging Decisions: ${stayCount} STAY, ${leaveCount} LEAVE`);
  console.log(
    "  " +
      padRight("Persona", 22) +
      padRight("Decision", 10) +
      padRight("Patch", 28) +
      padRight("Rate", 8) +
      padRight("Iters", 7) +
      "Next"
  );
  console.log("  " + "-".repeat(90));

  // Show LEAVE decisions first, then STAY
  const sorted = [...decisions].sort(([, a], [, b]) => {
    if (a.decision === "LEAVE" && b.decision !== "LEAVE") {
      return -1;
    }
    if (a.decision !== "LEAVE" && b.decision === "LEAVE") {
      return 1;
    }
    return 0;
  });

  for (const [pid, a] of sorted.slice(0, 20)) {
    const marker = a.decision === "LEAVE" ? ">> " : "   ";
    console.log(
      marker +
        padRight(pid, 22) +
        padRight(a.decision, 10) +
        padRight(a.current_patch, 28) +
        padRight(a.extraction_rate.toFixed(3), 8) +
        padRight(String(a.iterations_in_patch), 7) +
        (a.recommended_next ?? "-")
    );
  }

  if (sorted.length > 20) {
    console.log(`  ... and ${sorted.length - 20} more personas`);
  }

  console.log("");
}

function padRight(str, len) {
  return String(str).padEnd(len);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const manifest = loadJson(MANIFEST_FILE);
  if (!manifest) {
    console.error("Manifest not found. Run: node scripts/e2e/sync-manifest.js");
    process.exit(1);
  }

  const findings = loadJson(FINDINGS_FILE);
  const learning = loadJson(LEARNING_FILE);
  const greenHistory = loadJson(GREEN_HISTORY_FILE);
  const healthScores = loadJson(HEALTH_SCORES_FILE);
  const previous = loadJson(PREVIOUS_FILE);

  // Build patches from manifest features
  const patches = buildPatches(
    manifest, findings, learning, greenHistory, healthScores, previous
  );

  // Compute persona foraging decisions
  const personaAssignments = computePersonaAssignments(
    patches, manifest, learning, previous
  );

  // Build diet breadth output
  const dietBreadth = buildDietBreadthOutput(personaAssignments);

  // Compute meta stats
  const patchValues = Object.values(patches);
  const avgRate =
    patchValues.length > 0
      ? patchValues.reduce((sum, p) => sum + p.extraction_rate, 0) / patchValues.length
      : 0;
  const depletedCount = patchValues.filter(
    (p) => p.extraction_rate === 0 && p.richness === 0
  ).length;

  const config = previous?.config ?? DEFAULT_CONFIG;

  const output = {
    patches,
    persona_assignments: personaAssignments,
    diet_breadth: dietBreadth,
    config,
    meta: {
      total_patches: Object.keys(patches).length,
      depleted_patches: depletedCount,
      avg_extraction_rate: Math.round(avgRate * 1000) / 1000,
      generatedAt: new Date().toISOString(),
    },
  };

  if (EXPORT) {
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");
    console.log(`Foraging model written to: ${path.relative(ROOT, OUTPUT_FILE)}`);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printReport(output);
}

main();
