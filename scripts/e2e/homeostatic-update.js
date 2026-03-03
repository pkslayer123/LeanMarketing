#!/usr/bin/env node

/**
 * Homeostatic Drive Update — Self-regulating persona drive system.
 *
 * Each persona maintains 5 internal drives with setpoints. Drives drift based
 * on activity (findings, false positives, test runs, area variety) and are
 * restored toward setpoints by specific actions. Drive conflicts create emergent
 * behavior: a persona that is simultaneously hungry AND fatigued will switch to
 * a new area aggressively rather than grinding the same tests.
 *
 * Drives:
 *   discovery_hunger   — rises when idle, drops on finding. Drives aggressiveness.
 *   repetition_fatigue — rises on same-area runs, drops on area switch. Drives area switching.
 *   social_need        — rises each iteration, drops when following shared signals.
 *   confidence         — boosted by confirmed findings, reduced by false positives.
 *   energy             — drains per test run, recovers on idle. Below 0.2 = voluntary hibernation.
 *
 * Usage:
 *   node scripts/e2e/homeostatic-update.js              # Preview drive states
 *   node scripts/e2e/homeostatic-update.js --export     # Write to persona-drives.json
 *   node scripts/e2e/homeostatic-update.js --json       # Machine-readable output
 *   node scripts/e2e/homeostatic-update.js --reset      # Re-initialize all drives at setpoints
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DRIVES_FILE = path.join(ROOT, "e2e", "state", "persona-drives.json");
const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const HIBERNATION_FILE = path.join(ROOT, "e2e", "state", "persona-hibernation.json");
const TRIAGE_FILE = path.join(ROOT, "e2e", "state", "auto-triage-results.json");
const ROI_FILE = path.join(ROOT, "e2e", "state", "persona-roi.json");

const args = process.argv.slice(2);
const exportMode = args.includes("--export");
const jsonMode = args.includes("--json");
const resetMode = args.includes("--reset");

// ---------------------------------------------------------------------------
// Configuration — drive dynamics
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  decay_rates: {
    discovery_hunger: 0.1,
    repetition_fatigue: 0.15,
    social_need: 0.08,
    confidence: 0.03,
    energy: 0.02,
  },
  satiation_rates: {
    discovery_hunger: 0.4,
    repetition_fatigue: 0.2,
    social_need: 0.3,
    confidence: 0.15,
    energy: 0.3,
  },
  energy_hibernation_threshold: 0.2,
};

const SETPOINTS = {
  discovery_hunger: 0.5,
  repetition_fatigue: 0.3,
  social_need: 0.5,
  confidence: 0.6,
  energy: 0.7,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function makeDefaultDrives() {
  const drives = {};
  for (const [key, setpoint] of Object.entries(SETPOINTS)) {
    drives[key] = { current: setpoint, setpoint };
  }
  return drives;
}

/**
 * Convert display name ("Frank Doorman") to slug ("frank-doorman").
 */
function toSlug(displayName) {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

function loadLearningData() {
  const data = loadJson(LEARNING_FILE);
  if (!data || !data.personas) {
    return {};
  }
  return data.personas;
}

function loadFindings() {
  const data = loadJson(FINDINGS_FILE);
  if (!Array.isArray(data)) {
    return [];
  }
  return data;
}

function loadHibernation() {
  const data = loadJson(HIBERNATION_FILE);
  if (!data) {
    return {};
  }
  return data;
}

function loadTriageResults() {
  const data = loadJson(TRIAGE_FILE);
  if (!data) {
    return {};
  }
  return data;
}

function loadPreviousDrives() {
  if (resetMode) {
    return null;
  }
  return loadJson(DRIVES_FILE);
}

/**
 * Load persona ROI tiers. Returns slug-keyed map of tier strings.
 * Converts display names to slugs for matching with learning data.
 */
function loadPersonaRoiTiers() {
  const data = loadJson(ROI_FILE);
  if (!data || !data.personas) {
    return {};
  }
  const tiers = {};
  for (const [displayName, entry] of Object.entries(data.personas)) {
    const slug = toSlug(displayName);
    tiers[slug] = entry.tier || "no-data";
  }
  return tiers;
}

// ---------------------------------------------------------------------------
// Aggregate signals per persona
// ---------------------------------------------------------------------------

function aggregateSignals(learningData, findings, triageResults) {
  const signals = {};

  // From learning data: run counts, finding rates
  for (const [personaId, data] of Object.entries(learningData)) {
    if (!signals[personaId]) {
      signals[personaId] = {
        totalRuns: 0,
        recentFindingCount: 0,
        focusAreas: [],
        falsePositiveCount: 0,
      };
    }
    signals[personaId].totalRuns = data.totalRuns || 0;
    signals[personaId].recentFindingCount = (data.recentFindings || []).length;
    signals[personaId].focusAreas = data.focusAreas || [];
  }

  // From findings: count recent unresolved findings per persona (slug)
  const now = Date.now();
  const recentWindow = 24 * 60 * 60 * 1000; // 24 hours
  for (const finding of findings) {
    if (!finding.persona) {
      continue;
    }
    const slug = toSlug(finding.persona);
    if (!signals[slug]) {
      signals[slug] = {
        totalRuns: 0,
        recentFindingCount: 0,
        focusAreas: [],
        falsePositiveCount: 0,
      };
    }
    const ts = finding.timestamp ? new Date(finding.timestamp).getTime() : 0;
    if (now - ts < recentWindow && finding.status !== "resolved") {
      signals[slug].recentFindingCount += 1;
    }
  }

  // From auto-triage: count false positives per persona
  if (triageResults && triageResults.results && Array.isArray(triageResults.results)) {
    for (const result of triageResults.results) {
      if (result.classification === "false_positive" && result.persona) {
        const slug = toSlug(result.persona);
        if (!signals[slug]) {
          signals[slug] = {
            totalRuns: 0,
            recentFindingCount: 0,
            focusAreas: [],
            falsePositiveCount: 0,
          };
        }
        signals[slug].falsePositiveCount += 1;
      }
    }
  }

  // Alternate triage structure: per-persona counts
  if (triageResults && triageResults.personas) {
    for (const [personaId, data] of Object.entries(triageResults.personas)) {
      const slug = toSlug(personaId);
      if (!signals[slug]) {
        signals[slug] = {
          totalRuns: 0,
          recentFindingCount: 0,
          focusAreas: [],
          falsePositiveCount: 0,
        };
      }
      signals[slug].falsePositiveCount += (data.falsePositives || data.false_positives || 0);
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Drive update logic
// ---------------------------------------------------------------------------

function updateDrives(personaId, prevDrives, signal, config, roiTier) {
  const drives = {};

  for (const [key, setpoint] of Object.entries(SETPOINTS)) {
    const prev = prevDrives[key] ? prevDrives[key].current : setpoint;
    drives[key] = { current: prev, setpoint };
  }

  const decay = config.decay_rates;
  const satiation = config.satiation_rates;
  const hasFindings = signal.recentFindingCount > 0;
  const hasFalsePositives = signal.falsePositiveCount > 0;
  const hasRuns = signal.totalRuns > 0;

  // --- discovery_hunger ---
  // Rises naturally (decay toward hunger); drops when findings are made
  if (hasFindings) {
    // Satiate: drop toward setpoint
    drives.discovery_hunger.current -= satiation.discovery_hunger * Math.min(signal.recentFindingCount, 3) * 0.33;
  } else {
    // No findings: hunger grows
    drives.discovery_hunger.current += decay.discovery_hunger;
  }

  // --- repetition_fatigue ---
  // Rises when focus areas are few (same area repeatedly); drops on area variety
  const areaCount = signal.focusAreas.length;
  if (areaCount <= 1) {
    // Same area or no area data — fatigue grows
    drives.repetition_fatigue.current += decay.repetition_fatigue;
  } else {
    // Multiple areas — fatigue drops
    drives.repetition_fatigue.current -= satiation.repetition_fatigue * Math.min(areaCount / 5, 1);
  }

  // --- social_need ---
  // Rises naturally each iteration (personas are independent by default)
  drives.social_need.current += decay.social_need;

  // --- confidence ---
  // Boosted by confirmed findings, decreased by false positives
  if (hasFindings) {
    drives.confidence.current += satiation.confidence * Math.min(signal.recentFindingCount, 5) * 0.2;
  }
  if (hasFalsePositives) {
    drives.confidence.current -= decay.confidence * signal.falsePositiveCount;
  }
  // Slow natural decay toward setpoint if above it
  if (!hasFindings && !hasFalsePositives) {
    const drift = (drives.confidence.current - SETPOINTS.confidence) * 0.05;
    drives.confidence.current -= drift;
  }

  // --- energy ---
  // Drains proportional to test runs, recovers if idle
  if (hasRuns) {
    const drainFactor = Math.min(signal.totalRuns / 50, 1);
    drives.energy.current -= decay.energy + (drainFactor * 0.08);
  } else {
    // Idle recovery
    drives.energy.current += satiation.energy;
  }

  // ROI-driven energy adjustment: high-value personas stay active longer,
  // low-value personas conserve cycles, unknown personas get mild exploration boost
  if (roiTier === "high-value") {
    drives.energy.current += 0.1;
  } else if (roiTier === "low-value") {
    drives.energy.current -= 0.1;
  } else if (roiTier === "no-data") {
    drives.energy.current += 0.05;
  }

  // Clamp all drives to [0, 1]
  for (const key of Object.keys(drives)) {
    drives[key].current = clamp(drives[key].current, 0, 1);
  }

  return drives;
}

// ---------------------------------------------------------------------------
// Behavioral output computation
// ---------------------------------------------------------------------------

function computeBehavior(drives, config) {
  const dh = drives.discovery_hunger.current;
  const rf = drives.repetition_fatigue.current;
  const sn = drives.social_need.current;
  const conf = drives.confidence.current;
  const en = drives.energy.current;

  return {
    aggressiveness: clamp(dh, 0.2, 0.95),
    area_switching_urgency: clamp(rf, 0.1, 0.9),
    onlooker_probability: clamp(sn * 0.6, 0.05, 0.8),
    report_threshold: clamp(1.0 - conf, 0.3, 0.9),
    session_intensity: clamp(en, 0.2, 1.0),
  };
}

function computeHomeostaticUrgency(drives) {
  let sum = 0;
  for (const [, drive] of Object.entries(drives)) {
    sum += Math.abs(drive.current - drive.setpoint);
  }
  return Math.round(sum * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const learningData = loadLearningData();
  const findings = loadFindings();
  const hibernation = loadHibernation();
  const triageResults = loadTriageResults();
  const previousState = loadPreviousDrives();
  const roiTiers = loadPersonaRoiTiers();

  const signals = aggregateSignals(learningData, findings, triageResults);
  const config = (previousState && previousState.config) || DEFAULT_CONFIG;

  // Collect all known persona IDs from learning data
  const allPersonaIds = new Set(Object.keys(learningData));
  // Also include any personas from previous drive state
  if (previousState && previousState.personas) {
    for (const id of Object.keys(previousState.personas)) {
      allPersonaIds.add(id);
    }
  }

  const personas = {};
  let hungryCount = 0;
  let fatiguedCount = 0;
  let lowEnergyCount = 0;
  let lowConfidenceCount = 0;

  for (const personaId of allPersonaIds) {
    // Get previous drives or initialize at setpoints
    const prevDrives =
      previousState && previousState.personas && previousState.personas[personaId]
        ? previousState.personas[personaId].drives
        : makeDefaultDrives();

    const signal = signals[personaId] || {
      totalRuns: 0,
      recentFindingCount: 0,
      focusAreas: [],
      falsePositiveCount: 0,
    };

    // Update drives (with ROI-driven energy adjustment)
    const roiTier = roiTiers[personaId] || "no-data";
    const drives = updateDrives(personaId, prevDrives, signal, config, roiTier);

    // Compute behavioral output
    const behavior = computeBehavior(drives, config);

    // Compute homeostatic urgency
    const urgency = computeHomeostaticUrgency(drives);

    // Check voluntary hibernation
    const isHibernating = drives.energy.current < config.energy_hibernation_threshold;

    personas[personaId] = {
      drives,
      behavioral_output: behavior,
      homeostatic_urgency: urgency,
      voluntary_hibernation: isHibernating,
    };

    // Tally stats
    if (drives.discovery_hunger.current > 0.7) {
      hungryCount++;
    }
    if (drives.repetition_fatigue.current > 0.6) {
      fatiguedCount++;
    }
    if (drives.energy.current < config.energy_hibernation_threshold) {
      lowEnergyCount++;
    }
    if (drives.confidence.current < 0.35) {
      lowConfidenceCount++;
    }
  }

  const output = {
    personas,
    config,
    meta: {
      total_personas: allPersonaIds.size,
      hungry_count: hungryCount,
      fatigued_count: fatiguedCount,
      low_energy_count: lowEnergyCount,
      low_confidence_count: lowConfidenceCount,
      generatedAt: new Date().toISOString(),
    },
  };

  // --export: write state file
  if (exportMode) {
    try {
      const dir = path.dirname(DRIVES_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(DRIVES_FILE, JSON.stringify(output, null, 2));
      if (!jsonMode) {
        console.log("[homeostatic] Wrote drive state to " + path.relative(ROOT, DRIVES_FILE));
      }

      // Also generate persona-hibernation.json for the intelligence API
      const hibernationFile = path.join(ROOT, "e2e", "state", "persona-hibernation.json");
      const hibernationData = { personas: {}, lastUpdated: new Date().toISOString() };
      for (const [pid, pdata] of Object.entries(personas)) {
        const energy = pdata.drives?.energy?.current ?? 0.7;
        const isHib = pdata.voluntary_hibernation === true;
        // drySpell = iterations since last finding (estimated from energy drain)
        const drySpell = isHib ? Math.round((1 - energy) * 10) : 0;
        hibernationData.personas[pid] = {
          status: isHib ? "hibernated" : "active",
          drySpell,
          sampleProbability: isHib ? 0.1 : 1.0,
          wakeReason: isHib ? null : "energy_above_threshold",
        };
      }
      fs.writeFileSync(hibernationFile, JSON.stringify(hibernationData, null, 2));
    } catch (err) {
      console.error("[homeostatic] Failed to write drives file:", err.message);
      process.exit(1);
    }
  }

  // --json: machine-readable output
  if (jsonMode) {
    console.log(JSON.stringify(output));
    return;
  }

  // Human-readable summary
  console.log("\n[homeostatic] Persona Drive Summary");
  console.log("  Total personas:    " + output.meta.total_personas);
  console.log("  Hungry (>0.7):     " + output.meta.hungry_count);
  console.log("  Fatigued (>0.6):   " + output.meta.fatigued_count);
  console.log("  Low energy (<0.2): " + output.meta.low_energy_count);
  console.log("  Low confidence:    " + output.meta.low_confidence_count);
  console.log("");

  // Show top-urgency personas
  const sorted = Object.entries(personas)
    .sort((a, b) => b[1].homeostatic_urgency - a[1].homeostatic_urgency)
    .slice(0, 10);

  console.log("  Top 10 by homeostatic urgency:");
  for (const [id, data] of sorted) {
    const flags = [];
    if (data.drives.discovery_hunger.current > 0.7) {
      flags.push("hungry");
    }
    if (data.drives.repetition_fatigue.current > 0.6) {
      flags.push("fatigued");
    }
    if (data.voluntary_hibernation) {
      flags.push("hibernating");
    }
    if (data.drives.confidence.current < 0.35) {
      flags.push("low-conf");
    }
    const flagStr = flags.length > 0 ? "  [" + flags.join(", ") + "]" : "";
    console.log(
      "    " +
        id.padEnd(22) +
        " urgency=" +
        data.homeostatic_urgency.toFixed(2) +
        "  energy=" +
        data.drives.energy.current.toFixed(2) +
        flagStr
    );
  }

  // Show hibernating personas
  const hibernating = Object.entries(personas).filter(([, d]) => d.voluntary_hibernation);
  if (hibernating.length > 0) {
    console.log("\n  Voluntarily hibernating (" + hibernating.length + "):");
    for (const [id, data] of hibernating) {
      console.log(
        "    " + id.padEnd(22) + " energy=" + data.drives.energy.current.toFixed(2)
      );
    }
  }

  // Show emergent conflicts (hungry + fatigued = aggressive area switch)
  const conflicted = Object.entries(personas).filter(
    ([, d]) =>
      d.drives.discovery_hunger.current > 0.7 &&
      d.drives.repetition_fatigue.current > 0.6
  );
  if (conflicted.length > 0) {
    console.log("\n  Drive conflicts (hungry + fatigued -> aggressive area switch):");
    for (const [id, data] of conflicted) {
      console.log(
        "    " +
          id.padEnd(22) +
          " hunger=" +
          data.drives.discovery_hunger.current.toFixed(2) +
          "  fatigue=" +
          data.drives.repetition_fatigue.current.toFixed(2) +
          "  switch_urgency=" +
          data.behavioral_output.area_switching_urgency.toFixed(2)
      );
    }
  }

  if (!exportMode) {
    console.log("\n  Run with --export to persist drive state.");
  }
  console.log("");
}

main();
