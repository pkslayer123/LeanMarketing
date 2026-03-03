#!/usr/bin/env node

/**
 * Subsystem Value Tracker — Meta-learning on intelligence subsystem effectiveness.
 *
 * Measures whether each intelligence subsystem actually changes test selection
 * outcomes and contributes to finding quality. Disables/deprioritizes subsystems
 * that cost tokens but don't improve outcomes.
 *
 * Tracked subsystems:
 *   - thompson: Multi-armed bandit persona selection
 *   - curiosity: Forward model surprise-driven exploration
 *   - foraging: Patch richness assignment
 *   - marl: Q-value state-action learning
 *   - aco: Ant colony pheromone path selection
 *   - homeostatic: Energy/drive regulation
 *   - strategy: Strategy distillation and adoption
 *   - patterns: Pattern generalizer cross-persona detection
 *   - roi: ROI scorer impact tracking
 *
 * Metrics per subsystem:
 *   1. selectionDelta — Did the subsystem's output change which tests ran?
 *      Compare: test-strategy with subsystem vs without it (ablation)
 *   2. findingAttribution — Did tests influenced by this subsystem find things?
 *      Correlate: subsystem's top-ranked personas vs actual finding producers
 *   3. stateChurn — Is the subsystem's state actually changing between iterations?
 *      Compare: state file hash this iteration vs last iteration
 *   4. costEfficiency — Computation cost vs value generated
 *
 * Output: e2e/state/subsystem-value.json
 *
 * Usage:
 *   node scripts/e2e/subsystem-value-tracker.js
 *   node scripts/e2e/subsystem-value-tracker.js --json
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const VALUE_FILE = path.join(STATE_DIR, "subsystem-value.json");

// ---------------------------------------------------------------------------
// Subsystem definitions
// Each entry maps to a state file, the weight it carries in fuse-test-strategy,
// and the component field name used in test-strategy.json's persona scores.
// ---------------------------------------------------------------------------

const SUBSYSTEMS = [
  { id: "thompson", stateFile: "thompson-selection.json", weight: 0.30, componentField: "thompson" },
  { id: "curiosity", stateFile: "curiosity-model.json", weight: 0.15, componentField: "curiosity" },
  { id: "foraging", stateFile: "foraging-model.json", weight: 0.10, componentField: "foraging" },
  { id: "marl", stateFile: "marl-qtable.json", weight: 0.00, componentField: null },
  { id: "aco", stateFile: "aco-graph.json", weight: 0.00, componentField: null },
  { id: "homeostatic", stateFile: "persona-drives.json", weight: 0.00, componentField: null },
  { id: "strategy", stateFile: "strategy-library.json", weight: 0.00, componentField: null },
  { id: "patterns", stateFile: "check-patterns.json", weight: 0.00, componentField: null },
  { id: "roi", stateFile: "persona-roi.json", weight: 0.15, componentField: "roiBoost" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashFile(filepath) {
  if (!fs.existsSync(filepath)) {
    return null;
  }
  const content = fs.readFileSync(filepath, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function loadJSON(filename) {
  const filepath = path.join(STATE_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

function loadPreviousValue() {
  if (!fs.existsSync(VALUE_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(VALUE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Metric 1: State Churn — has the state file changed since last measurement?
// ---------------------------------------------------------------------------

function computeStateChurn(subsystem, previous) {
  const filepath = path.join(STATE_DIR, subsystem.stateFile);
  const currentHash = hashFile(filepath);
  const prevHash = previous?.subsystems?.[subsystem.id]?.stateHash ?? null;
  return {
    stateHash: currentHash,
    changed: currentHash !== null && currentHash !== prevHash,
    prevHash,
  };
}

// ---------------------------------------------------------------------------
// Metric 2: Selection Delta — does this subsystem's signal change test selection?
//
// Reads test-strategy.json (output of fuse-test-strategy.js) and checks whether
// the subsystem's component contributes non-zero values for the prioritized
// personas. A subsystem that always outputs zero has no selection influence.
// ---------------------------------------------------------------------------

function computeSelectionDelta(subsystem) {
  const strategy = loadJSON("test-strategy.json");
  if (!strategy?.prioritizedPersonas) {
    return { delta: 0, influence: "none", nonZeroCount: 0, totalCount: 0 };
  }

  const prioritized = strategy.prioritizedPersonas;
  const field = subsystem.componentField;

  // Subsystems without a direct strategy field (marl, aco, homeostatic, strategy, patterns)
  // contribute indirectly. We measure them by checking if their state file has meaningful
  // content that downstream consumers read.
  if (!field) {
    return computeIndirectInfluence(subsystem);
  }

  let nonZeroCount = 0;
  let totalCount = 0;
  let cumulativeContribution = 0;

  for (const entry of prioritized) {
    const components = entry.components || {};
    totalCount++;
    const value = components[field] ?? 0;
    if (value > 0) {
      nonZeroCount++;
    }
    cumulativeContribution += value;
  }

  const delta = totalCount > 0 ? nonZeroCount / totalCount : 0;

  // Would removing this subsystem change the top-N ranking?
  // Calculate: if we zero out this subsystem's weight, how many personas swap in/out?
  let rankChanges = 0;
  if (strategy.skipRecommendations && strategy.prioritizedPersonas.length > 0) {
    const borderScore = prioritized[prioritized.length - 1]?.priority ?? 0;
    for (const entry of prioritized) {
      const compVal = (entry.components || {})[field] ?? 0;
      const reducedScore = (entry.priority || 0) - compVal * subsystem.weight;
      // If removing this subsystem would drop this persona below the border, it matters
      if (reducedScore < borderScore * 0.9) {
        rankChanges++;
      }
    }
  }

  const influence = rankChanges > 2 ? "high" :
    nonZeroCount > totalCount * 0.5 ? "high" :
    nonZeroCount > 0 ? "medium" : "none";

  return {
    delta: Math.round(delta * 1000) / 1000,
    influence,
    nonZeroCount,
    totalCount,
    cumulativeContribution: Math.round(cumulativeContribution * 1000) / 1000,
    rankChanges,
  };
}

/**
 * For subsystems without direct strategy fields, check if their state file
 * has meaningful, non-trivial content (not just empty structures).
 */
function computeIndirectInfluence(subsystem) {
  const data = loadJSON(subsystem.stateFile);
  if (!data) {
    return { delta: 0, influence: "none", nonZeroCount: 0, totalCount: 0, indirect: true };
  }

  let meaningfulEntries = 0;

  if (subsystem.id === "marl") {
    // MARL: count personas with Q-values
    const personas = data.personas || {};
    meaningfulEntries = Object.keys(personas).filter((p) => {
      const qv = personas[p]?.q_values;
      return qv && Object.keys(qv).length > 0;
    }).length;
  } else if (subsystem.id === "aco") {
    // ACO: count nodes with non-zero visit counts
    const nodes = data.nodes || {};
    meaningfulEntries = Object.values(nodes).filter((n) => (n?.visit_count ?? 0) > 0).length;
  } else if (subsystem.id === "homeostatic") {
    // Homeostatic: count personas with active drives
    const personas = data.personas || data;
    if (typeof personas === "object") {
      meaningfulEntries = Object.keys(personas).filter((p) => {
        const drives = personas[p]?.drives || personas[p];
        return drives && typeof drives === "object" && Object.keys(drives).length > 0;
      }).length;
    }
  } else if (subsystem.id === "strategy") {
    // Strategy library: count strategies with adoption
    const strategies = data.strategies || [];
    meaningfulEntries = strategies.filter((s) => (s.times_adopted ?? 0) > 0).length;
  } else if (subsystem.id === "patterns") {
    // Check patterns: count confirmed patterns
    const patterns = data.patterns || [];
    meaningfulEntries = patterns.filter((p) => p.status === "confirmed").length;
  }

  const influence = meaningfulEntries > 10 ? "high" :
    meaningfulEntries > 0 ? "medium" : "none";

  return {
    delta: meaningfulEntries > 0 ? 1 : 0,
    influence,
    nonZeroCount: meaningfulEntries,
    totalCount: meaningfulEntries,
    indirect: true,
  };
}

// ---------------------------------------------------------------------------
// Metric 3: Finding Attribution — do subsystem-favored personas produce findings?
//
// For direct subsystems (with componentField), personas with high component
// scores should correlate with high finding production. For indirect subsystems,
// we check if their state references finding-producing personas.
// ---------------------------------------------------------------------------

function computeFindingAttribution(subsystem) {
  const roi = loadJSON("persona-roi.json");
  const findings = loadJSON("findings/findings.json");
  if (!findings) {
    return { correlation: 0, attributedFindings: 0, totalFindings: 0 };
  }

  const allFindings = Array.isArray(findings) ? findings : (findings.findings || []);
  const totalFindings = allFindings.length;

  // Build finding counts per persona (slug form)
  const findingCounts = {};
  for (const f of allFindings) {
    const pid = f.persona || f.personaId || "";
    const slug = pid.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (slug) {
      findingCounts[slug] = (findingCounts[slug] || 0) + 1;
    }
  }

  let attributedFindings = 0;

  if (subsystem.id === "roi" && roi?.tiers) {
    // For ROI: high-ROI personas should produce more findings
    const highValue = (roi.tiers["high-value"] || []).map((n) =>
      n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
    );
    for (const slug of highValue) {
      attributedFindings += findingCounts[slug] || 0;
    }
  } else if (subsystem.componentField) {
    // For direct subsystems: check if personas with high component scores find things
    const strategy = loadJSON("test-strategy.json");
    if (strategy?.prioritizedPersonas) {
      // Take top 10 personas by this component
      const sorted = [...strategy.prioritizedPersonas]
        .filter((p) => (p.components || {})[subsystem.componentField] > 0)
        .sort((a, b) => ((b.components || {})[subsystem.componentField] || 0) - ((a.components || {})[subsystem.componentField] || 0))
        .slice(0, 10);

      for (const entry of sorted) {
        const slug = entry.persona || "";
        attributedFindings += findingCounts[slug] || 0;
      }
    }
  } else {
    // Indirect subsystems: count findings from personas who appear in this subsystem's state
    const data = loadJSON(subsystem.stateFile);
    if (data) {
      let referencedPersonas = [];
      if (subsystem.id === "marl" && data.personas) {
        referencedPersonas = Object.keys(data.personas);
      } else if (subsystem.id === "homeostatic" && (data.personas || typeof data === "object")) {
        referencedPersonas = Object.keys(data.personas || data);
      } else if (subsystem.id === "strategy" && data.strategies) {
        // Get personas who have adopted strategies
        const adopters = new Set();
        for (const s of data.strategies) {
          if (s.adaptations) {
            for (const p of Object.keys(s.adaptations)) {
              adopters.add(p);
            }
          }
        }
        referencedPersonas = [...adopters];
      }

      for (const persona of referencedPersonas) {
        const slug = persona.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        attributedFindings += findingCounts[slug] || 0;
      }
    }
  }

  return {
    correlation: totalFindings > 0 ? Math.round((attributedFindings / totalFindings) * 1000) / 1000 : 0,
    attributedFindings,
    totalFindings,
  };
}

// ---------------------------------------------------------------------------
// Metric 4: State Depth — how much data has the subsystem accumulated?
// A richer state suggests the subsystem is actively learning.
// ---------------------------------------------------------------------------

function computeStateDepth(subsystem) {
  const data = loadJSON(subsystem.stateFile);
  if (!data) {
    return { entries: 0, sizeBytes: 0 };
  }

  const filepath = path.join(STATE_DIR, subsystem.stateFile);
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(filepath).size;
  } catch {
    // ignore
  }

  let entries = 0;

  if (subsystem.id === "thompson") {
    const selection = data.selection || [];
    entries = selection.length;
  } else if (subsystem.id === "curiosity") {
    entries = Object.keys(data.forward_model || {}).length;
  } else if (subsystem.id === "foraging") {
    entries = Object.keys(data.patches || {}).length;
  } else if (subsystem.id === "marl") {
    entries = Object.keys(data.personas || {}).length;
  } else if (subsystem.id === "aco") {
    entries = Object.keys(data.nodes || {}).length;
  } else if (subsystem.id === "homeostatic") {
    entries = Object.keys(data.personas || data).length;
  } else if (subsystem.id === "strategy") {
    entries = (data.strategies || []).length;
  } else if (subsystem.id === "patterns") {
    entries = (data.patterns || []).length;
  } else if (subsystem.id === "roi") {
    entries = Object.keys(data.personas || {}).length;
  }

  return { entries, sizeBytes };
}

// ---------------------------------------------------------------------------
// Value score computation
// ---------------------------------------------------------------------------

function computeValueScore(churn, selection, attribution, depth) {
  const stateActive = churn.changed ? 1 : 0;
  const selectionInfluence =
    selection.influence === "high" ? 1 :
    selection.influence === "medium" ? 0.5 : 0;
  const findingCorrelation = attribution.correlation;
  const hasDepth = depth.entries > 0 ? 0.5 : 0;

  // Weighted value score (0-1 range)
  // - 30% weight on whether state is changing (not stale)
  // - 35% weight on whether it influences test selection
  // - 25% weight on whether favored personas produce findings
  // - 10% weight on accumulated data depth
  const valueScore =
    stateActive * 0.30 +
    selectionInfluence * 0.35 +
    findingCorrelation * 0.25 +
    hasDepth * 0.10;

  return Math.round(valueScore * 100) / 100;
}

function computeRecommendation(valueScore, stateActive, weight) {
  // Subsystems with strategy weight > 0 that score well should be kept
  if (valueScore > 0.5) {
    return "keep";
  }
  if (valueScore > 0.2) {
    return "monitor";
  }
  // Zero-weight subsystems with low value are candidates for disabling
  if (weight === 0 && !stateActive) {
    return "consider_disabling";
  }
  if (stateActive) {
    return "investigate";
  }
  return "consider_disabling";
}

// ---------------------------------------------------------------------------
// Trend analysis — compare current value scores to history
// ---------------------------------------------------------------------------

function computeTrend(subsystemId, currentValue, previous) {
  const prevValue = previous?.subsystems?.[subsystemId]?.valueScore;
  if (typeof prevValue !== "number") {
    return { direction: "new", delta: 0 };
  }
  const delta = Math.round((currentValue - prevValue) * 100) / 100;
  const direction = delta > 0.05 ? "improving" :
    delta < -0.05 ? "declining" : "stable";
  return { direction, delta };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const previous = loadPreviousValue();
  const results = { subsystems: {}, meta: {} };

  let activeCount = 0;
  let staleCount = 0;
  let influentialCount = 0;
  let keepCount = 0;
  let disableCount = 0;

  for (const sub of SUBSYSTEMS) {
    const churn = computeStateChurn(sub, previous);
    const selection = computeSelectionDelta(sub);
    const attribution = computeFindingAttribution(sub);
    const depth = computeStateDepth(sub);

    const valueScore = computeValueScore(churn, selection, attribution, depth);
    const recommendation = computeRecommendation(valueScore, churn.changed, sub.weight);
    const trend = computeTrend(sub.id, valueScore, previous);

    if (churn.changed) {
      activeCount++;
    }
    if (!churn.changed && previous?.subsystems?.[sub.id]) {
      staleCount++;
    }
    if (selection.influence === "high" || selection.influence === "medium") {
      influentialCount++;
    }
    if (recommendation === "keep") {
      keepCount++;
    }
    if (recommendation === "consider_disabling") {
      disableCount++;
    }

    results.subsystems[sub.id] = {
      stateHash: churn.stateHash,
      stateChanged: churn.changed,
      stateDepth: depth.entries,
      stateSizeBytes: depth.sizeBytes,
      selectionDelta: selection.delta,
      selectionInfluence: selection.influence,
      selectionNonZero: selection.nonZeroCount,
      selectionTotal: selection.totalCount,
      rankChanges: selection.rankChanges ?? 0,
      findingCorrelation: attribution.correlation,
      attributedFindings: attribution.attributedFindings,
      totalFindings: attribution.totalFindings,
      valueScore,
      recommendation,
      trend: trend.direction,
      trendDelta: trend.delta,
      strategyWeight: sub.weight,
    };
  }

  results.meta = {
    timestamp: new Date().toISOString(),
    activeSubsystems: activeCount,
    staleSubsystems: staleCount,
    influentialSubsystems: influentialCount,
    keepRecommendations: keepCount,
    disableRecommendations: disableCount,
    totalSubsystems: SUBSYSTEMS.length,
    healthScore: SUBSYSTEMS.length > 0
      ? Math.round((activeCount / SUBSYSTEMS.length) * 100) / 100
      : 0,
    effectivenessScore: SUBSYSTEMS.length > 0
      ? Math.round((influentialCount / SUBSYSTEMS.length) * 100) / 100
      : 0,
  };

  // Write state (atomic)
  const tmpPath = VALUE_FILE + `.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(results, null, 2) + "\n");
  fs.renameSync(tmpPath, VALUE_FILE);

  // Output
  const AS_JSON = process.argv.includes("--json");
  if (AS_JSON) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log("\n--- Subsystem Value Report ---");
    console.log(`Active: ${activeCount}/${SUBSYSTEMS.length} | Stale: ${staleCount} | Influential: ${influentialCount}`);
    console.log(`Keep: ${keepCount} | Monitor: ${SUBSYSTEMS.length - keepCount - disableCount} | Consider disabling: ${disableCount}`);
    console.log("");
    for (const [id, data] of Object.entries(results.subsystems)) {
      const status = data.stateChanged ? "ACTIVE" : "STALE ";
      const badge = data.recommendation === "keep" ? "+" :
        data.recommendation === "monitor" ? "~" :
        data.recommendation === "investigate" ? "?" : "-";
      const trendArrow = data.trend === "improving" ? "^" :
        data.trend === "declining" ? "v" :
        data.trend === "new" ? "*" : "=";
      console.log(
        `  [${badge}] ${id.padEnd(12)} value=${String(data.valueScore).padEnd(5)} ` +
        `state=${status} influence=${data.selectionInfluence.padEnd(6)} ` +
        `findings=${String(data.attributedFindings).padEnd(4)} ` +
        `depth=${String(data.stateDepth).padEnd(4)} ` +
        `trend=${trendArrow} -> ${data.recommendation}`
      );
    }
    console.log(`\nHealth: ${results.meta.healthScore} | Effectiveness: ${results.meta.effectivenessScore}`);
    console.log("");
  }
}

main();
