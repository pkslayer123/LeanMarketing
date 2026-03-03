#!/usr/bin/env node

/**
 * Feature Health Dashboard — Unified health scores per feature area.
 *
 * Joins data from:
 *   - e2e/state/manifest.json (feature→persona→permission mapping)
 *   - e2e/state/findings/findings.json (open/resolved findings by feature)
 *   - e2e/state/green-history.json (test pass/fail history)
 *   - e2e/state/persona-learning.json (persona effectiveness)
 *   - e2e/state/learned-fix-patterns.json (fix pattern effectiveness)
 *
 * Outputs a per-feature health score (0-100) with breakdown.
 *
 * Usage:
 *   node scripts/e2e/feature-health.js           # Human-readable table
 *   node scripts/e2e/feature-health.js --json     # Machine-readable JSON
 *   node scripts/e2e/feature-health.js --export   # Write to e2e/state/feature-health-scores.json
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(ROOT, "e2e", "state", "manifest.json");
const FINDINGS_PATH = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const GREEN_HISTORY_PATH = path.join(ROOT, "e2e", "state", "green-history.json");
const PERSONA_LEARNING_PATH = path.join(ROOT, "e2e", "state", "persona-learning.json");
const FIX_PATTERNS_PATH = path.join(ROOT, "e2e", "state", "learned-fix-patterns.json");
const OUTPUT_PATH = path.join(ROOT, "e2e", "state", "feature-health-scores.json");

const args = process.argv.slice(2);
const isJson = args.includes("--json");
const doExport = args.includes("--export");

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
// Health score computation
// ---------------------------------------------------------------------------

function computeFeatureHealth() {
  const manifest = loadJson(MANIFEST_PATH);
  if (!manifest || !manifest.features) {
    console.error("Manifest not found. Run: node scripts/e2e/sync-manifest.js");
    process.exit(1);
  }

  const findingsData = loadJson(FINDINGS_PATH);
  const allFindings = findingsData
    ? Array.isArray(findingsData)
      ? findingsData
      : findingsData.findings ?? []
    : [];

  const greenHistory = loadJson(GREEN_HISTORY_PATH) ?? { tests: {} };
  const personaLearning = loadJson(PERSONA_LEARNING_PATH) ?? { personas: {} };
  const fixPatterns = loadJson(FIX_PATTERNS_PATH) ?? { patterns: [] };

  const features = manifest.features;
  const healthScores = {};

  for (const [featureKey, config] of Object.entries(features)) {
    const personas = config.personas ?? [];
    const permissions = config.permissions ?? [];
    const pages = config.pages ?? [];
    const codeAreas = config.codeAreas ?? [];

    // 1. Finding score (0-100): fewer open bugs = better
    const featureFindings = allFindings.filter((f) => {
      if (f.status === "resolved") {
        return false;
      }
      // Match by page
      if (pages.some((p) => f.page?.includes(p))) {
        return true;
      }
      // Match by code area
      if (codeAreas.some((a) => f.page?.includes(a) || f.description?.includes(a))) {
        return true;
      }
      // Match by persona
      if (f.persona && personas.includes(f.persona)) {
        return true;
      }
      return false;
    });

    const openBugs = featureFindings.filter((f) => f.severity === "bug").length;
    const openSecurity = featureFindings.filter((f) => f.severity === "security").length;
    const openSuggestions = featureFindings.filter(
      (f) => f.severity === "suggestion" || f.severity === "ux"
    ).length;

    // Bugs: -15 each, Security: -25 each, Suggestions: -3 each (capped at 0)
    const findingScore = Math.max(0, 100 - openBugs * 15 - openSecurity * 25 - openSuggestions * 3);

    // 2. Test pass rate (0-100): from green history
    const relatedTests = Object.entries(greenHistory.tests).filter(([title]) => {
      const normalizedTitle = title.toLowerCase();
      // Match tests by persona name or feature-related keywords
      for (const persona of personas) {
        if (normalizedTitle.includes(persona)) {
          return true;
        }
      }
      return false;
    });

    let passScore = 100;
    if (relatedTests.length > 0) {
      const passing = relatedTests.filter(([, e]) => e.consecutivePasses > 0).length;
      passScore = Math.round((passing / relatedTests.length) * 100);
    }

    // 3. Coverage score (0-100): personas assigned, permissions tested
    const activePersonas = personas.filter(
      (p) => personaLearning.personas?.[p]?.totalRuns > 0
    ).length;
    const coverageScore =
      personas.length > 0 ? Math.round((activePersonas / personas.length) * 100) : 0;

    // 4. Persona effectiveness (0-100): average finding rate of assigned personas
    let personaEffectiveness = 50; // neutral default
    if (personas.length > 0) {
      const rates = personas
        .map((p) => personaLearning.personas?.[p]?.findingRate ?? 0)
        .filter((r) => r >= 0);
      if (rates.length > 0) {
        const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
        // Finding rate 0.1-0.5 is healthy; 0 means not finding anything; >0.5 means lots of bugs
        if (avgRate === 0) {
          personaEffectiveness = 80; // No bugs found = healthy feature
        } else if (avgRate <= 0.2) {
          personaEffectiveness = 70;
        } else if (avgRate <= 0.5) {
          personaEffectiveness = 40; // Active bugs being found
        } else {
          personaEffectiveness = 20; // High bug rate = unhealthy
        }
      }
    }

    // 5. Fix pattern activity: are patterns actively fixing issues in this area?
    const relatedPatterns = fixPatterns.patterns.filter((p) => {
      if (p.disabled) {
        return false;
      }
      if (codeAreas.some((a) => p.glob?.includes(a))) {
        return true;
      }
      return false;
    });
    const hasActivePatterns = relatedPatterns.length > 0;

    // Weighted health score: findings (35%), pass rate (30%), coverage (20%), effectiveness (15%)
    const healthScore = Math.round(
      findingScore * 0.35 + passScore * 0.30 + coverageScore * 0.20 + personaEffectiveness * 0.15
    );

    // Status thresholds
    let status;
    if (healthScore >= 80) {
      status = "healthy";
    } else if (healthScore >= 60) {
      status = "warning";
    } else {
      status = "critical";
    }

    healthScores[featureKey] = {
      healthScore,
      status,
      breakdown: {
        findings: findingScore,
        passRate: passScore,
        coverage: coverageScore,
        effectiveness: personaEffectiveness,
      },
      detail: {
        openBugs,
        openSecurity,
        openSuggestions,
        totalFindings: featureFindings.length,
        relatedTests: relatedTests.length,
        assignedPersonas: personas.length,
        activePersonas,
        permissions: permissions.length,
        pages: pages.length,
        codeAreas: codeAreas.length,
        hasActiveFixPatterns: hasActivePatterns,
      },
    };
  }

  return healthScores;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTable(healthScores) {
  const entries = Object.entries(healthScores).sort(
    ([, a], [, b]) => a.healthScore - b.healthScore
  );

  console.log("");
  console.log("Feature Health Dashboard");
  console.log("========================");
  console.log("");

  const STATUS_ICON = { healthy: "[OK]", warning: "[!!]", critical: "[XX]" };

  // Header
  console.log(
    padRight("Feature", 30) +
      padRight("Score", 8) +
      padRight("Status", 12) +
      padRight("Findings", 10) +
      padRight("PassRate", 10) +
      padRight("Coverage", 10) +
      padRight("Bugs", 6) +
      padRight("Tests", 7) +
      padRight("Personas", 10)
  );
  console.log("-".repeat(103));

  for (const [key, data] of entries) {
    const icon = STATUS_ICON[data.status] ?? "[ ]";
    console.log(
      padRight(key, 30) +
        padRight(`${data.healthScore}%`, 8) +
        padRight(`${icon} ${data.status}`, 12) +
        padRight(`${data.breakdown.findings}`, 10) +
        padRight(`${data.breakdown.passRate}%`, 10) +
        padRight(`${data.breakdown.coverage}%`, 10) +
        padRight(`${data.detail.openBugs}`, 6) +
        padRight(`${data.detail.relatedTests}`, 7) +
        padRight(`${data.detail.activePersonas}/${data.detail.assignedPersonas}`, 10)
    );
  }

  console.log("");

  // Summary
  const scores = entries.map(([, d]) => d.healthScore);
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const critical = entries.filter(([, d]) => d.status === "critical").length;
  const warning = entries.filter(([, d]) => d.status === "warning").length;
  const healthy = entries.filter(([, d]) => d.status === "healthy").length;

  console.log(
    `Overall: ${avg}% avg | ${healthy} healthy | ${warning} warning | ${critical} critical`
  );
  console.log("");
}

function padRight(str, len) {
  return String(str).padEnd(len);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const healthScores = computeFeatureHealth();

if (isJson) {
  console.log(JSON.stringify(healthScores, null, 2));
} else {
  printTable(healthScores);
}

if (doExport) {
  const output = {
    timestamp: new Date().toISOString(),
    features: healthScores,
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  if (!isJson) {
    console.log(`Exported to ${path.relative(ROOT, OUTPUT_PATH)}`);
  }
}
