#!/usr/bin/env node

/**
 * Waggle Broadcast — Bee Foraging waggle dance discovery sharing protocol.
 *
 * Top-performing personas publish "dance signals" (compact hints about
 * productive areas). Other personas are classified as:
 *   - Employed: actively exploiting a productive area (keep going)
 *   - Onlooker: following a signal from a top performer
 *   - Scout: random exploration after dry spell
 *
 * Signal quality determines how many onlookers follow it (probability
 * proportional to quality^exponent). Signals decay over iterations.
 *
 * Reads:
 *   - e2e/state/persona-learning.json
 *   - e2e/state/findings/findings.json
 *   - e2e/state/waggle-signals.json (previous state)
 *
 * Writes:
 *   - e2e/state/waggle-signals.json
 *
 * Usage:
 *   node scripts/e2e/waggle-broadcast.js              # Human-readable
 *   node scripts/e2e/waggle-broadcast.js --json        # Machine-readable
 *   node scripts/e2e/waggle-broadcast.js --export      # Write to state file
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const PREVIOUS_FILE = path.join(ROOT, "e2e", "state", "waggle-signals.json");
const OUTPUT_FILE = path.join(ROOT, "e2e", "state", "waggle-signals.json");

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
  signal_lifetime: 5,
  onlooker_quality_exponent: 2.0,
  scout_dry_threshold: 3,
  employed_fraction: 0.4,
  onlooker_fraction: 0.4,
  scout_fraction: 0.2,
};

// ---------------------------------------------------------------------------
// Severity weights for signal quality
// ---------------------------------------------------------------------------

const SEVERITY_QUALITY = {
  security: 10,
  bug: 7,
  ux: 3,
  suggestion: 2,
};

// ---------------------------------------------------------------------------
// Step 1: Age existing signals, remove expired
// ---------------------------------------------------------------------------

function ageSignals(previousSignals, config) {
  if (!previousSignals || !Array.isArray(previousSignals)) {
    return [];
  }

  return previousSignals
    .map((sig) => ({
      ...sig,
      staleness: (sig.staleness ?? 0) + 1,
    }))
    .filter((sig) => sig.staleness < config.signal_lifetime);
}

// ---------------------------------------------------------------------------
// Step 2: Create new signals from top-performing personas
// ---------------------------------------------------------------------------

function createNewSignals(learning, findings) {
  const personaData = learning?.personas ?? {};
  const allFindings = normalizeFindings(findings);

  // Find recent, unresolved findings grouped by persona
  const recentByPersona = {};
  for (const f of allFindings) {
    if (f.status === "resolved") {
      continue;
    }
    const pid = normalizeName(f.persona ?? "");
    if (!pid) {
      continue;
    }
    if (!recentByPersona[pid]) {
      recentByPersona[pid] = [];
    }
    recentByPersona[pid].push(f);
  }

  const signals = [];

  for (const [pid, pFindings] of Object.entries(recentByPersona)) {
    if (pFindings.length === 0) {
      continue;
    }

    // Pick the highest-severity finding as the signal
    const sorted = [...pFindings].sort(
      (a, b) => (SEVERITY_QUALITY[b.severity] ?? 1) - (SEVERITY_QUALITY[a.severity] ?? 1)
    );
    const topFinding = sorted[0];

    // Signal quality based on finding count and severity
    const quality = Math.min(
      10,
      pFindings.reduce((sum, f) => sum + (SEVERITY_QUALITY[f.severity] ?? 1), 0)
    );

    // Extract the area from the page path
    const area = extractArea(topFinding.page ?? "");

    // Build a compact pattern hint
    const pattern = buildPatternHint(topFinding);

    signals.push({
      dancer: pid,
      quality: Math.round(quality * 10) / 10,
      area,
      hint: (topFinding.description ?? "").slice(0, 80),
      pattern,
      staleness: 0,
      iteration_created: 0, // will be set by caller if needed
    });
  }

  return signals;
}

/**
 * Extract a readable area name from a page path.
 */
function extractArea(pagePath) {
  if (!pagePath) {
    return "unknown";
  }
  // e.g., "/admin/developer/permissions" -> "admin-developer-permissions"
  return pagePath
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/\[.*?\]/g, "id")
    .slice(0, 40) || "unknown";
}

/**
 * Build a compact pattern hint from a finding.
 */
function buildPatternHint(finding) {
  const parts = [];
  if (finding.failureType) {
    parts.push(`type=${finding.failureType}`);
  }
  if (finding.severity) {
    parts.push(`severity=${finding.severity}`);
  }
  if (finding.page) {
    parts.push(`page=${finding.page}`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Step 3: Classify personas into employed / onlooker / scout
// ---------------------------------------------------------------------------

function classifyPersonas(learning, signals, config) {
  const personaData = learning?.personas ?? {};
  const allPersonas = Object.keys(personaData);

  if (allPersonas.length === 0) {
    return {};
  }

  // Compute each persona's recent productivity (findings in last few runs)
  const productivity = {};
  for (const [pid, data] of Object.entries(personaData)) {
    const recentFindings = (data.recentFindings ?? []).length;
    const findingRate = data.findingRate ?? 0;
    productivity[pid] = { recentFindings, findingRate };
  }

  // Sort by productivity descending
  const sorted = [...allPersonas].sort(
    (a, b) => (productivity[b]?.recentFindings ?? 0) - (productivity[a]?.recentFindings ?? 0)
  );

  // Split into employed / onlooker / scout based on fractions
  const total = sorted.length;
  const employedCount = Math.max(1, Math.round(total * config.employed_fraction));
  const scoutCount = Math.max(1, Math.round(total * config.scout_fraction));

  const roleAssignments = {};

  for (let i = 0; i < sorted.length; i++) {
    const pid = sorted[i];
    const prod = productivity[pid];

    // Personas with recent findings = employed (regardless of fraction)
    if (prod.recentFindings > 0) {
      roleAssignments[pid] = {
        role: "employed",
        reason: `found ${prod.recentFindings} bug${prod.recentFindings === 1 ? "" : "s"} recently`,
      };
      continue;
    }

    // Personas with zero finding rate for a while = scout
    const totalRuns = personaData[pid]?.totalRuns ?? 0;
    const totalFindings = personaData[pid]?.totalFindings ?? 0;
    const drySpell = totalRuns > 0 && totalFindings === 0;
    const longDry = totalRuns >= config.scout_dry_threshold && prod.findingRate === 0;

    if (drySpell || longDry) {
      roleAssignments[pid] = {
        role: "scout",
        reason: `${totalRuns} runs with ${totalFindings} findings, random exploration`,
      };
      continue;
    }

    // Everyone else = onlooker, pick a signal to follow
    const followedSignal = pickSignal(signals, config);
    roleAssignments[pid] = {
      role: "onlooker",
      following_signal: followedSignal,
      reason: followedSignal !== null
        ? `following signal from ${signals[followedSignal]?.dancer ?? "unknown"}`
        : "no active signals, idle",
    };
  }

  return roleAssignments;
}

// ---------------------------------------------------------------------------
// Step 4: Probabilistic signal selection for onlookers
// ---------------------------------------------------------------------------

function pickSignal(signals, config) {
  if (signals.length === 0) {
    return null;
  }

  // Probability proportional to quality^exponent
  const exponent = config.onlooker_quality_exponent;
  const weights = signals.map((s) => Math.pow(Math.max(s.quality, 0.1), exponent));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  if (totalWeight === 0) {
    return 0;
  }

  // Weighted random selection
  let rand = Math.random() * totalWeight;
  for (let i = 0; i < weights.length; i++) {
    rand -= weights[i];
    if (rand <= 0) {
      return i;
    }
  }

  return signals.length - 1;
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
  console.log("\n--- Waggle Broadcast (Bee Foraging Discovery Protocol) ---");
  console.log(
    `Signals: ${output.meta.total_signals} | ` +
      `Employed: ${output.meta.employed_count} | ` +
      `Onlooker: ${output.meta.onlooker_count} | ` +
      `Scout: ${output.meta.scout_count}`
  );

  // Active signals
  if (output.signals.length > 0) {
    console.log("\nActive Signals:");
    console.log(
      "  " +
        padRight("#", 4) +
        padRight("Dancer", 22) +
        padRight("Quality", 9) +
        padRight("Area", 30) +
        padRight("Age", 5) +
        "Hint"
    );
    console.log("  " + "-".repeat(90));

    for (let i = 0; i < output.signals.length; i++) {
      const sig = output.signals[i];
      console.log(
        "  " +
          padRight(String(i), 4) +
          padRight(sig.dancer, 22) +
          padRight(sig.quality.toFixed(1), 9) +
          padRight(sig.area, 30) +
          padRight(String(sig.staleness), 5) +
          (sig.hint ?? "").slice(0, 50)
      );
    }
  } else {
    console.log("\nNo active signals.");
  }

  // Role assignments
  const roles = Object.entries(output.role_assignments);
  if (roles.length > 0) {
    console.log("\nPersona Roles:");
    console.log(
      "  " +
        padRight("Persona", 22) +
        padRight("Role", 12) +
        "Reason"
    );
    console.log("  " + "-".repeat(80));

    // Sort: employed first, then onlooker, then scout
    const roleOrder = { employed: 0, onlooker: 1, scout: 2 };
    const sorted = [...roles].sort(
      ([, a], [, b]) => (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3)
    );

    for (const [pid, assignment] of sorted.slice(0, 25)) {
      const marker =
        assignment.role === "employed" ? ">> " :
        assignment.role === "scout" ? "?? " : "   ";
      console.log(
        marker +
          padRight(pid, 22) +
          padRight(assignment.role, 12) +
          (assignment.reason ?? "").slice(0, 60)
      );
    }

    if (sorted.length > 25) {
      console.log(`  ... and ${sorted.length - 25} more personas`);
    }
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
  const learning = loadJson(LEARNING_FILE);
  const findings = loadJson(FINDINGS_FILE);
  const previous = loadJson(PREVIOUS_FILE);

  if (!learning) {
    console.error("persona-learning.json not found. Run persona tests first.");
    process.exit(1);
  }

  const config = previous?.config ?? DEFAULT_CONFIG;

  // Step 1: Age existing signals, remove expired
  const agedSignals = ageSignals(previous?.signals, config);

  // Step 2: Create new signals from top-performing personas
  const newSignals = createNewSignals(learning, findings);

  // Merge: avoid duplicate dancers (keep newer signal)
  const dancerSet = new Set(newSignals.map((s) => s.dancer));
  const mergedSignals = [
    ...agedSignals.filter((s) => !dancerSet.has(s.dancer)),
    ...newSignals,
  ];

  // Sort by quality descending
  mergedSignals.sort((a, b) => b.quality - a.quality);

  // Step 3: Classify personas
  const roleAssignments = classifyPersonas(learning, mergedSignals, config);

  // Compute meta counts
  const roles = Object.values(roleAssignments);
  const employedCount = roles.filter((r) => r.role === "employed").length;
  const onlookerCount = roles.filter((r) => r.role === "onlooker").length;
  const scoutCount = roles.filter((r) => r.role === "scout").length;

  const output = {
    signals: mergedSignals,
    role_assignments: roleAssignments,
    config,
    meta: {
      total_signals: mergedSignals.length,
      employed_count: employedCount,
      onlooker_count: onlookerCount,
      scout_count: scoutCount,
      generatedAt: new Date().toISOString(),
    },
  };

  if (EXPORT) {
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");
    console.log(`Waggle signals written to: ${path.relative(ROOT, OUTPUT_FILE)}`);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printReport(output);
}

main();
