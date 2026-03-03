#!/usr/bin/env node

/**
 * test-roi-scorer.js — Test ROI scoring, retirement, and dedup detection.
 *
 * Computes a return-on-investment score for every test based on finding
 * contribution and stability. Tests with extremely high pass counts and
 * zero recent findings become retirement candidates. Near-duplicate tests
 * (same persona type + same page) are flagged for review.
 *
 * ROI formula per test:
 *   finding_contribution = findings matching (persona + page) in last 30 days
 *   weighted_findings = sum(finding_contribution x severity_weight)
 *   roi = weighted_findings / max(consecutivePasses x 0.1, 0.1)
 *
 * Retirement criteria (ALL must be true):
 *   - 50+ consecutive passes
 *   - 0 associated findings in last 30 days
 *   - NOT touching BUILD-SPEC protected area
 *   - NOT a security persona test
 *   - Boring for 3+ consecutive scoring rounds
 *   - Max 3 retirements per scoring round
 *
 * Safety:
 *   - All JSON reads wrapped in try/catch with defaults
 *   - Single file write at end
 *   - No Claude CLI calls
 *   - No code edits (read-only analysis + soft retirement flags)
 *   - Max 3 retirements per round
 *
 * Usage:
 *   node scripts/e2e/test-roi-scorer.js
 *   node scripts/e2e/test-roi-scorer.js --dry-run
 *   node scripts/e2e/test-roi-scorer.js --json
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..");
const GREEN_HISTORY_PATH = path.join(ROOT, "e2e", "state", "green-history.json");
const FINDINGS_PATH = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const BUILD_SPEC_PATH = path.join(ROOT, "docs", "BUILD-SPEC.md");
const MANIFEST_PATH = path.join(ROOT, "e2e", "state", "manifest.json");
const OUTPUT_PATH = path.join(ROOT, "e2e", "state", "test-roi-scores.json");

const MAX_RETIREMENTS_PER_ROUND = 3;

const SECURITY_PERSONAS = new Set([
  "oscar-outsider",
  "rex-expired",
  "cody-trust",
  "wanda-walls",
  "frank-doorman",
]);

const SEVERITY_WEIGHTS = {
  security: 5,
  bug: 3,
  product: 1,
  ux: 1,
  suggestion: 0.5,
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const JSON_OUT = args.includes("--json");

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
// BUILD-SPEC protected sections (same logic as green-tracker.ts)
// ---------------------------------------------------------------------------

function getProtectedSections() {
  if (!fs.existsSync(BUILD_SPEC_PATH)) {
    return {};
  }

  try {
    const content = fs.readFileSync(BUILD_SPEC_PATH, "utf-8");
    const sections = {};
    let currentSection = null;
    let inProtected = false;
    const protectedItems = [];

    for (const line of content.split("\n")) {
      const sectionMatch = line.match(/^###\s+(.+)/);
      if (sectionMatch) {
        if (currentSection && protectedItems.length > 0) {
          sections[currentSection] = [...protectedItems];
          protectedItems.length = 0;
        }
        currentSection = sectionMatch[1]
          .replace(/^(Stage \d+:.*?|Cross-Cutting:.*?|Enterprise:.*?)(\s*\(.*\))?$/, "$1")
          .trim();
        inProtected = false;
      }

      if (line.includes("Protected SME Decisions")) {
        inProtected = true;
        continue;
      }

      if (inProtected && line.startsWith("- ") && !line.includes("None recorded yet")) {
        protectedItems.push(line.replace(/^-\s*/, "").trim());
      }

      if (inProtected && (line.startsWith("###") || line.startsWith("---"))) {
        inProtected = false;
      }
    }

    if (currentSection && protectedItems.length > 0) {
      sections[currentSection] = [...protectedItems];
    }

    return sections;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Code area to feature mapping (from manifest)
// ---------------------------------------------------------------------------

function getCodeAreaToFeature() {
  const manifest = loadJson(MANIFEST_PATH, { features: {} });
  const features = manifest.features || {};
  const mapping = {};
  for (const [featureKey, featureDef] of Object.entries(features)) {
    const def = featureDef || {};
    for (const area of def.codeAreas || []) {
      mapping[area] = featureKey;
    }
  }
  return mapping;
}

function touchesProtectedArea(testTitle) {
  const protectedSections = getProtectedSections();
  if (Object.keys(protectedSections).length === 0) {
    return false;
  }

  // Extract persona and page from test title to check feature coverage
  const personaMatch = testTitle.match(/(?:^|\s|\/)([\w]+-[\w]+)(?:\s|\/|\.spec|$)/i);
  if (!personaMatch) {
    return false;
  }

  const manifest = loadJson(MANIFEST_PATH, { features: {} });
  const features = manifest.features || {};
  const personaId = personaMatch[1].toLowerCase();

  for (const [featureKey, featureDef] of Object.entries(features)) {
    const def = featureDef || {};
    if ((def.personas || []).includes(personaId)) {
      // Check if this feature has protected sections
      for (const sectionName of Object.keys(protectedSections)) {
        if (
          sectionName.toLowerCase().includes(featureKey.replace(/_/g, " ")) ||
          featureKey.includes(sectionName.toLowerCase().replace(/\s/g, "_"))
        ) {
          if (protectedSections[sectionName].length > 0) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Extract persona ID from test title
// ---------------------------------------------------------------------------

function extractPersonaId(testTitle) {
  const match = testTitle.match(/(?:^|\s|\/)([\w]+-[\w]+)(?:\s|\/|\.spec|$)/i);
  return match ? match[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Extract page from test title (heuristic: last path-like segment)
// ---------------------------------------------------------------------------

function extractPage(testTitle) {
  const pageMatch = testTitle.match(/(?:\/[\w-]+)+/);
  return pageMatch ? pageMatch[0] : null;
}

// ---------------------------------------------------------------------------
// Count findings per (persona, page) in last N days
// ---------------------------------------------------------------------------

function buildFindingIndex(findings, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const index = {};

  for (const f of findings) {
    if (!f.timestamp) {
      continue;
    }
    const ts = new Date(f.timestamp).getTime();
    if (ts < cutoff) {
      continue;
    }

    const persona = (f.persona || "").toLowerCase();
    const page = f.page || "";
    const severity = f.severity || "suggestion";
    const key = `${persona}::${page}`;

    if (!index[key]) {
      index[key] = { total: 0, weighted: 0 };
    }
    index[key].total++;
    index[key].weighted += SEVERITY_WEIGHTS[severity] || 0.5;
  }

  return index;
}

// ---------------------------------------------------------------------------
// Near-duplicate detection
// ---------------------------------------------------------------------------

function detectNearDuplicates(greenHistory) {
  const tests = Object.keys(greenHistory.tests || {});
  const groups = {};

  for (const title of tests) {
    const persona = extractPersonaId(title);
    const page = extractPage(title);
    if (!persona || !page) {
      continue;
    }

    const key = `${persona}::${page}`;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(title);
  }

  const duplicates = [];
  for (const [key, titles] of Object.entries(groups)) {
    if (titles.length > 1) {
      duplicates.push({
        key,
        tests: titles,
        count: titles.length,
      });
    }
  }

  duplicates.sort((a, b) => b.count - a.count);
  return duplicates;
}

// ---------------------------------------------------------------------------
// Main scoring logic
// ---------------------------------------------------------------------------

function scoreTests() {
  const greenHistory = loadJson(GREEN_HISTORY_PATH, { tests: {} });
  const findings = loadJson(FINDINGS_PATH, []);
  const findingsArr = Array.isArray(findings) ? findings : [];

  // Load previous scores for boring tracking
  const previousScores = loadJson(OUTPUT_PATH, { scores: {}, retiredTests: {} });
  const prevScoreMap = previousScores.scores || {};
  const prevRetired = previousScores.retiredTests || {};

  const findingIndex = buildFindingIndex(findingsArr, 30);

  const tests = greenHistory.tests || {};
  const scores = {};

  for (const [testTitle, entry] of Object.entries(tests)) {
    const personaId = extractPersonaId(testTitle);
    const page = extractPage(testTitle);

    // Look up finding contribution
    const findingKey = `${personaId || ""}::${page || ""}`;
    const findingData = findingIndex[findingKey] || { total: 0, weighted: 0 };

    // ROI = weighted findings / max(consecutivePasses * 0.1, 0.1)
    const denominator = Math.max((entry.consecutivePasses || 0) * 0.1, 0.1);
    const roi = findingData.weighted / denominator;

    // Track boring rounds (score ≤ 0.1 for 3+ consecutive rounds)
    const prevScore = prevScoreMap[testTitle];
    let boringRounds = prevScore?.boringRounds || 0;
    if (roi <= 0.1 && findingData.total === 0) {
      boringRounds++;
    } else {
      boringRounds = 0;
    }

    scores[testTitle] = {
      roi: Math.round(roi * 1000) / 1000,
      consecutivePasses: entry.consecutivePasses || 0,
      findingsLast30d: findingData.total,
      weightedFindings: Math.round(findingData.weighted * 100) / 100,
      personaId,
      page,
      boringRounds,
      retired: prevRetired[testTitle]?.retired || false,
    };
  }

  // Determine retirement candidates
  const retirementCandidates = [];
  for (const [testTitle, score] of Object.entries(scores)) {
    if (score.retired) {
      continue; // Already retired
    }
    if (score.consecutivePasses < 50) {
      continue;
    }
    if (score.findingsLast30d > 0) {
      continue;
    }
    if (touchesProtectedArea(testTitle)) {
      continue;
    }
    if (score.personaId && SECURITY_PERSONAS.has(score.personaId)) {
      continue;
    }
    if (score.boringRounds < 3) {
      continue;
    }

    retirementCandidates.push({
      testTitle,
      score: score.roi,
      consecutivePasses: score.consecutivePasses,
      boringRounds: score.boringRounds,
    });
  }

  // Sort by most boring first, cap at MAX_RETIREMENTS_PER_ROUND
  retirementCandidates.sort((a, b) => b.boringRounds - a.boringRounds);
  const newRetirements = retirementCandidates.slice(0, MAX_RETIREMENTS_PER_ROUND);

  // Apply retirements
  const retiredTests = { ...prevRetired };
  for (const r of newRetirements) {
    scores[r.testTitle].retired = true;
    retiredTests[r.testTitle] = {
      retired: true,
      retiredAt: new Date().toISOString(),
      reason: `50+ passes, 0 findings in 30d, boring for ${r.boringRounds} rounds`,
    };
  }

  // Detect near-duplicates
  const nearDuplicates = detectNearDuplicates(greenHistory);

  return {
    scores,
    retiredTests,
    newRetirements: newRetirements.map((r) => r.testTitle),
    nearDuplicates,
    stats: {
      totalTests: Object.keys(scores).length,
      totalRetired: Object.values(retiredTests).filter((r) => r.retired).length,
      newRetirementsThisRound: newRetirements.length,
      nearDuplicateGroups: nearDuplicates.length,
      avgRoi:
        Object.values(scores).length > 0
          ? Math.round(
              (Object.values(scores).reduce((sum, s) => sum + s.roi, 0) /
                Object.values(scores).length) *
                1000
            ) / 1000
          : 0,
    },
    lastScored: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const result = scoreTests();

  if (!JSON_OUT) {
    console.log(`[test-roi-scorer] Scored ${result.stats.totalTests} tests`);
    console.log(`  Avg ROI: ${result.stats.avgRoi}`);
    console.log(`  Total retired: ${result.stats.totalRetired}`);
    console.log(`  New retirements this round: ${result.stats.newRetirementsThisRound}`);
    if (result.newRetirements.length > 0) {
      for (const t of result.newRetirements) {
        console.log(`    RETIRED: ${t}`);
      }
    }
    console.log(`  Near-duplicate groups: ${result.stats.nearDuplicateGroups}`);
    if (result.nearDuplicates.length > 0) {
      for (const d of result.nearDuplicates.slice(0, 5)) {
        console.log(`    DEDUP: ${d.key} (${d.count} tests)`);
      }
    }
  }

  if (DRY_RUN) {
    if (JSON_OUT) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("[test-roi-scorer] Dry run — not writing output");
    }
    return;
  }

  // Single write at end
  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + "\n");

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[test-roi-scorer] Scores written to ${path.relative(ROOT, OUTPUT_PATH)}`);
  }
}

main();
