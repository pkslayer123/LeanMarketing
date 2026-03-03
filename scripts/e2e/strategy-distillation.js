#!/usr/bin/env node

/**
 * Strategy Distillation — Cross-persona strategy transfer via distillation.
 *
 * When a persona discovers a productive pattern (high finding rate over
 * several iterations), the script extracts a reusable strategy template.
 * Other personas can adopt and adapt the strategy to their own specialties.
 *
 * Strategy lifecycle:
 *   1. Discovery: high-performing persona generates a novel pattern
 *   2. Template extraction: area + action pattern + finding types
 *   3. Adoption tracking: other personas using similar patterns
 *   4. Effectiveness scoring: weighted by recency and adoption success
 *   5. Aging: reduce effectiveness if no new adoptions
 *
 * Adaptation rules map strategies across persona archetypes:
 *   security -> session: replace auth with expired session
 *   security -> null-safety: replace org checks with null values
 *   performance -> any: apply timing thresholds
 *   accessibility -> accessibility: check different WCAG criteria
 *
 * Reads:
 *   - e2e/state/persona-learning.json
 *   - e2e/state/findings/findings.json
 *   - e2e/state/strategy-library.json (previous state)
 *
 * Writes:
 *   - e2e/state/strategy-library.json
 *
 * Usage:
 *   node scripts/e2e/strategy-distillation.js              # Human-readable
 *   node scripts/e2e/strategy-distillation.js --json        # Machine-readable
 *   node scripts/e2e/strategy-distillation.js --export      # Write to state file
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const PREVIOUS_FILE = path.join(ROOT, "e2e", "state", "strategy-library.json");
const OUTPUT_FILE = path.join(ROOT, "e2e", "state", "strategy-library.json");

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
// Config
// ---------------------------------------------------------------------------

const FINDING_RATE_THRESHOLD = 0.1; // Minimum rate to be considered "high-performing"
const MIN_RUNS_FOR_STRATEGY = 3;     // Minimum total runs before extracting strategies
const AGING_DECAY = 0.9;             // Effectiveness multiplier per iteration without adoption
const MAX_STRATEGIES = 50;           // Cap on total strategies in the library
const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Adaptation rules — how strategies transfer across persona archetypes
// ---------------------------------------------------------------------------

const DEFAULT_ADAPTATION_RULES = {
  "security->session": "replace auth-state preconditions with expired-session",
  "security->null-safety": "replace org-based checks with null-value checks",
  "performance->any": "apply timing thresholds to target areas",
  "accessibility->accessibility": "check same elements for different WCAG criteria",
  "bola->permission": "test same endpoint with different role contexts",
  "workflow->workflow": "apply same stage-transition checks to related stages",
  "ux->ux": "test similar UI patterns for the same usability issue",
};

// ---------------------------------------------------------------------------
// Persona archetype classification
// ---------------------------------------------------------------------------

const PERSONA_ARCHETYPE = {
  "oscar-outsider": "security",
  "rex-expired": "session",
  "norma-null": "null-safety",
  "frank-doorman": "permission",
  "wanda-walls": "permission",
  "cody-trust": "security",
  "daria-dark": "visual",
  "ally-access": "accessibility",
  "pete-performance": "performance",
  "cliff-patience": "ux",
  "drew-handoff": "ux",
  "cal-compliance": "compliance",
  "paige-turner": "workflow",
  "uma-unicode": "i18n",
  "saul-search": "data-retrieval",
  "max-manual": "automation",
  "rita-recover": "error-recovery",
  "terry-trial": "onboarding",
  "del-e-gate": "permission",
  "hank-horde": "load",
  "sid-site": "multitenancy",
  "kat-keys": "permission",
  "quinn-quest": "workflow",
  "alex-api": "api",
  "zara-zone": "timezone",
  "bella-builder": "ux",
  "devin-root": "admin",
  "connie-contractor": "external",
};

function getArchetype(personaId) {
  return PERSONA_ARCHETYPE[personaId] ?? "general";
}

// ---------------------------------------------------------------------------
// Step 1: Identify high-performing personas
// ---------------------------------------------------------------------------

function identifyHighPerformers(learning) {
  const personaData = learning?.personas ?? {};
  const highPerformers = [];

  for (const [pid, data] of Object.entries(personaData)) {
    const totalRuns = data.totalRuns ?? 0;
    const findingRate = data.findingRate ?? 0;
    const recentFindings = data.recentFindings ?? [];

    if (totalRuns >= MIN_RUNS_FOR_STRATEGY && findingRate >= FINDING_RATE_THRESHOLD) {
      highPerformers.push({
        personaId: pid,
        findingRate,
        totalRuns,
        totalFindings: data.totalFindings ?? 0,
        recentFindings,
        archetype: getArchetype(pid),
      });
    }
  }

  // Sort by finding rate descending
  highPerformers.sort((a, b) => b.findingRate - a.findingRate);
  return highPerformers;
}

// ---------------------------------------------------------------------------
// Step 2: Extract strategy patterns from high performers
// ---------------------------------------------------------------------------

function extractPatterns(highPerformers, findings, existingStrategies) {
  const allFindings = normalizeFindings(findings);
  const existingIds = new Set(existingStrategies.map((s) => s.id));
  const existingPatterns = new Set(
    existingStrategies.map((s) => `${s.source_persona}:${s.template?.area ?? ""}`)
  );

  const newStrategies = [];
  let nextId = existingStrategies.length + 1;

  for (const performer of highPerformers) {
    const pid = performer.personaId;
    const personaFindings = allFindings.filter((f) => {
      const normalized = normalizeName(f.persona ?? "");
      return normalized === pid;
    });

    if (personaFindings.length === 0) {
      continue;
    }

    // Group findings by page area to find patterns
    const areaGroups = {};
    for (const f of personaFindings) {
      const area = extractArea(f.page ?? "");
      if (!areaGroups[area]) {
        areaGroups[area] = [];
      }
      areaGroups[area].push(f);
    }

    // For each area with multiple findings, create a strategy if novel
    for (const [area, areaFindings] of Object.entries(areaGroups)) {
      if (areaFindings.length < 2) {
        continue;
      }

      const patternKey = `${pid}:${area}`;
      if (existingPatterns.has(patternKey)) {
        continue;
      }

      // Determine action pattern from finding types
      const findingTypes = [...new Set(areaFindings.map((f) => f.failureType ?? f.severity))];
      const testFocus = deriveTestFocus(areaFindings);

      // Compute effectiveness from recency and severity
      const now = Date.now();
      const recencyWeights = areaFindings.map((f) => {
        const age = now - new Date(f.timestamp ?? f.firstSeen ?? 0).getTime();
        return age < RECENCY_WINDOW_MS ? 1.0 : 0.5;
      });
      const avgRecency =
        recencyWeights.reduce((a, b) => a + b, 0) / recencyWeights.length;
      const severityScore =
        areaFindings.reduce(
          (sum, f) => sum + (SEVERITY_WEIGHT[f.severity] ?? 1),
          0
        ) / areaFindings.length;
      const effectiveness = Math.round(avgRecency * severityScore * 10 * 10) / 10;

      const stratId = `strat-${String(nextId).padStart(3, "0")}`;
      nextId++;

      newStrategies.push({
        id: stratId,
        source_persona: pid,
        name: `${pid}-${area}-probe`.replace(/[^a-z0-9-]/g, "-"),
        discovered_iteration: 0,
        effectiveness_score: Math.min(effectiveness, 10),
        times_shared: 0,
        times_adopted: 0,
        success_rate_when_adopted: 0,
        template: {
          area,
          action_pattern: deriveActionPattern(areaFindings),
          test_focus: testFocus,
          finding_types: findingTypes,
        },
        adaptations: {},
      });

      existingPatterns.add(patternKey);
    }
  }

  return newStrategies;
}

const SEVERITY_WEIGHT = {
  security: 10,
  bug: 7,
  ux: 3,
  suggestion: 2,
};

/**
 * Derive a test focus list from findings.
 */
function deriveTestFocus(findings) {
  const focus = new Set();

  for (const f of findings) {
    const desc = (f.description ?? "").toLowerCase();
    if (desc.includes("status") || desc.includes("response code")) {
      focus.add("status_code_check");
    }
    if (desc.includes("leak") || desc.includes("expose") || desc.includes("visible")) {
      focus.add("response_body_leak");
    }
    if (desc.includes("permission") || desc.includes("access")) {
      focus.add("permission_enforcement");
    }
    if (desc.includes("null") || desc.includes("undefined") || desc.includes("empty")) {
      focus.add("null_safety");
    }
    if (desc.includes("dark") || desc.includes("contrast")) {
      focus.add("visual_contrast");
    }
    if (desc.includes("loading") || desc.includes("slow") || desc.includes("timeout")) {
      focus.add("performance_timing");
    }
  }

  if (focus.size === 0) {
    focus.add("general_validation");
  }

  return [...focus];
}

/**
 * Derive an action pattern name from findings.
 */
function deriveActionPattern(findings) {
  const types = findings.map((f) => f.failureType ?? "");
  if (types.some((t) => t.includes("vision"))) {
    return "visual_inspection";
  }
  if (types.some((t) => t.includes("oracle"))) {
    return "oracle_validation";
  }
  if (types.some((t) => t.includes("permission") || t.includes("access"))) {
    return "navigate_then_mutate";
  }
  if (types.some((t) => t.includes("api"))) {
    return "api_probe";
  }
  return "navigate_and_observe";
}

// ---------------------------------------------------------------------------
// Step 3: Track adoptions
// ---------------------------------------------------------------------------

function trackAdoptions(strategies, findings, learning) {
  const allFindings = normalizeFindings(findings);
  const personaData = learning?.personas ?? {};

  for (const strategy of strategies) {
    const area = strategy.template?.area ?? "";
    const sourceArchetype = getArchetype(strategy.source_persona);

    // Check each persona (except source) for findings in the same area
    for (const [pid, data] of Object.entries(personaData)) {
      if (pid === strategy.source_persona) {
        continue;
      }

      const personaFindings = allFindings.filter((f) => {
        const normalized = normalizeName(f.persona ?? "");
        if (normalized !== pid) {
          return false;
        }
        if (f.status === "resolved") {
          return false;
        }
        const fArea = extractArea(f.page ?? "");
        return fArea === area;
      });

      if (personaFindings.length > 0) {
        const adopterArchetype = getArchetype(pid);

        // Check if there is a valid adaptation rule
        const ruleKey = `${sourceArchetype}->${adopterArchetype}`;
        const rule = DEFAULT_ADAPTATION_RULES[ruleKey];
        const modification = rule ?? `cross-archetype: ${sourceArchetype} to ${adopterArchetype}`;

        if (!strategy.adaptations[pid]) {
          strategy.times_adopted = (strategy.times_adopted ?? 0) + 1;
          strategy.adaptations[pid] = {
            modification,
            findings: personaFindings.length,
          };
        } else {
          // Update finding count for existing adaptation
          strategy.adaptations[pid].findings = personaFindings.length;
        }
      }
    }

    // Update shared count = total personas that could benefit
    strategy.times_shared = Object.keys(personaData).length - 1;

    // Update success rate
    const adopted = strategy.times_adopted ?? 0;
    const shared = strategy.times_shared ?? 1;
    strategy.success_rate_when_adopted =
      shared > 0 ? Math.round((adopted / shared) * 100) / 100 : 0;
  }
}

// ---------------------------------------------------------------------------
// Step 4: Update effectiveness scores
// ---------------------------------------------------------------------------

function updateEffectiveness(strategies) {
  for (const strategy of strategies) {
    const adopted = strategy.times_adopted ?? 0;
    const adaptations = Object.values(strategy.adaptations ?? {});
    const totalAdoptionFindings = adaptations.reduce(
      (sum, a) => sum + (a.findings ?? 0),
      0
    );

    if (adopted === 0 && strategy.effectiveness_score > 1) {
      // Age: reduce effectiveness if no adoptions
      strategy.effectiveness_score =
        Math.round(strategy.effectiveness_score * AGING_DECAY * 10) / 10;
    } else if (totalAdoptionFindings > 0) {
      // Boost: adoption with findings increases effectiveness
      const boost = Math.min(totalAdoptionFindings * 0.5, 2);
      strategy.effectiveness_score = Math.min(
        10,
        Math.round((strategy.effectiveness_score + boost) * 10) / 10
      );
    }
  }
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

function extractArea(pagePath) {
  if (!pagePath) {
    return "unknown";
  }
  return pagePath
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/\[.*?\]/g, "id")
    .slice(0, 40) || "unknown";
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function printReport(output) {
  console.log("\n--- Strategy Distillation (Cross-Persona Transfer) ---");
  console.log(
    `Strategies: ${output.meta.total_strategies} | ` +
      `Total adoptions: ${output.meta.total_adoptions} | ` +
      `Avg adoption success: ${(output.meta.avg_adoption_success * 100).toFixed(1)}%`
  );

  const strategies = output.strategies;

  if (strategies.length === 0) {
    console.log("\nNo strategies in library. Run more persona tests to discover patterns.");
    console.log("");
    return;
  }

  // Sort by effectiveness descending
  const sorted = [...strategies].sort(
    (a, b) => b.effectiveness_score - a.effectiveness_score
  );

  console.log("\nStrategy Library:");
  console.log(
    "  " +
      padRight("ID", 12) +
      padRight("Source", 18) +
      padRight("Area", 28) +
      padRight("Effect.", 9) +
      padRight("Adopted", 9) +
      padRight("Success", 9) +
      "Pattern"
  );
  console.log("  " + "-".repeat(100));

  for (const strat of sorted.slice(0, 15)) {
    console.log(
      "  " +
        padRight(strat.id, 12) +
        padRight(strat.source_persona, 18) +
        padRight(strat.template?.area ?? "?", 28) +
        padRight(strat.effectiveness_score.toFixed(1), 9) +
        padRight(String(strat.times_adopted), 9) +
        padRight(
          strat.times_adopted > 0
            ? `${(strat.success_rate_when_adopted * 100).toFixed(0)}%`
            : "-",
          9
        ) +
        (strat.template?.action_pattern ?? "?")
    );

    // Show adaptations if any
    const adaptEntries = Object.entries(strat.adaptations ?? {});
    if (adaptEntries.length > 0) {
      for (const [adopter, detail] of adaptEntries.slice(0, 3)) {
        console.log(
          "    " +
            padRight("", 10) +
            `-> ${padRight(adopter, 18)} ${detail.modification.slice(0, 50)} (${detail.findings} findings)`
        );
      }
      if (adaptEntries.length > 3) {
        console.log(`    ${padRight("", 10)}... and ${adaptEntries.length - 3} more adaptations`);
      }
    }
  }

  if (sorted.length > 15) {
    console.log(`  ... and ${sorted.length - 15} more strategies`);
  }

  // Adaptation rules
  console.log("\nAdaptation Rules:");
  for (const [rule, desc] of Object.entries(output.adaptation_rules)) {
    console.log(`  ${padRight(rule, 30)} ${desc}`);
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

  // Load existing strategies
  const existingStrategies = previous?.strategies ?? [];

  // Step 1: Identify high-performing personas
  const highPerformers = identifyHighPerformers(learning);

  // Step 2: Extract new strategy patterns
  const newStrategies = extractPatterns(highPerformers, findings, existingStrategies);

  // Merge existing + new strategies
  const allStrategies = [...existingStrategies, ...newStrategies];

  // Step 3: Track adoptions across all strategies
  trackAdoptions(allStrategies, findings, learning);

  // Step 4: Update effectiveness scores (age non-adopted, boost adopted)
  updateEffectiveness(allStrategies);

  // Cap total strategies: keep highest effectiveness
  const capped = allStrategies
    .sort((a, b) => b.effectiveness_score - a.effectiveness_score)
    .slice(0, MAX_STRATEGIES);

  // Compute meta
  const totalAdoptions = capped.reduce((sum, s) => sum + (s.times_adopted ?? 0), 0);
  const adoptionRates = capped
    .filter((s) => (s.times_adopted ?? 0) > 0)
    .map((s) => s.success_rate_when_adopted ?? 0);
  const avgAdoptionSuccess =
    adoptionRates.length > 0
      ? adoptionRates.reduce((a, b) => a + b, 0) / adoptionRates.length
      : 0;

  const output = {
    strategies: capped,
    adaptation_rules: previous?.adaptation_rules ?? DEFAULT_ADAPTATION_RULES,
    meta: {
      total_strategies: capped.length,
      total_adoptions: totalAdoptions,
      avg_adoption_success: Math.round(avgAdoptionSuccess * 100) / 100,
      generatedAt: new Date().toISOString(),
    },
  };

  if (EXPORT) {
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");
    console.log(`Strategy library written to: ${path.relative(ROOT, OUTPUT_FILE)}`);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printReport(output);
}

main();
