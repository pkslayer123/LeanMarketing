/**
 * Predictive Test Selector
 *
 * Uses green history (pass/fail per test) + git diff (changed files) to predict
 * which tests are most likely to fail, and front-loads them.
 *
 * Algorithm:
 * 1. Get changed files from git diff
 * 2. Map files to affected routes (via diff-test-selector)
 * 3. Load green history (consecutive pass/fail counts)
 * 4. Score each test: higher = more likely to fail
 *    - Recently failed tests score highest
 *    - Tests on affected routes score higher
 *    - Tests with short green streaks score higher than long streaks
 *    - Tests for high-ROI personas score higher
 * 5. Sort by score, return ordered test list
 *
 * State: e2e/state/green-history.json, persona-roi.json
 *
 * Usage:
 *   const { getPredictedFailures, getTestPriority } = require("./lib/predictive-selector");
 *   const predictions = getPredictedFailures({ since: "HEAD~1" });
 *   // predictions.prioritized → tests sorted by failure likelihood
 */

const fs = require("fs");
const path = require("path");

const STATE_DIR = path.resolve(__dirname, "..", "..", "..", "e2e", "state");

function loadGreenHistory() {
  try {
    const filePath = path.join(STATE_DIR, "green-history.json");
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {}
  return {};
}

function loadPersonaRoi() {
  try {
    const filePath = path.join(STATE_DIR, "persona-roi.json");
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {}
  return null;
}

/**
 * Score a test for failure likelihood.
 * Higher score = more likely to fail = run first.
 */
function scoreTest(testTitle, greenHistory, affectedRoutes, roiData) {
  let score = 0;
  const entry = greenHistory[testTitle];

  if (!entry) {
    // Never run before — high priority (unknown state)
    score += 50;
  } else {
    const consecutivePasses = entry.consecutivePasses ?? 0;
    const consecutiveFailures = entry.consecutiveFailures ?? 0;
    const lastResult = entry.lastResult;

    // Recently failed tests are most likely to fail again
    if (lastResult === "fail") {
      score += 80 + Math.min(20, consecutiveFailures * 10);
    } else if (consecutivePasses <= 2) {
      // Flaky — recently started passing, might fail again
      score += 40;
    } else if (consecutivePasses <= 5) {
      score += 20;
    } else {
      // Stable green — low priority
      score += 5;
    }

    // Recency boost: tests that failed in the last 24h
    if (entry.lastFailedAt) {
      const hoursSinceFailure = (Date.now() - new Date(entry.lastFailedAt).getTime()) / 3600000;
      if (hoursSinceFailure < 24) {
        score += Math.max(0, 30 - hoursSinceFailure);
      }
    }
  }

  // Route affinity: if test covers an affected route, boost priority
  if (affectedRoutes.length > 0) {
    const testLower = testTitle.toLowerCase();
    for (const route of affectedRoutes) {
      const routeSegments = route.split("/").filter(Boolean);
      for (const segment of routeSegments) {
        if (segment !== "*" && testLower.includes(segment.toLowerCase())) {
          score += 25;
          break;
        }
      }
    }
  }

  // ROI boost: high-ROI personas' tests get priority
  if (roiData?.personas) {
    // Extract persona from test title (convention: "persona-name > test description")
    const personaMatch = testTitle.match(/^([a-z-]+)/i);
    if (personaMatch) {
      const personaId = personaMatch[1];
      const roi = roiData.personas[personaId];
      if (roi?.roiScore >= 0.6) {
        score += 15; // High ROI
      } else if (roi?.roiScore <= 0.2) {
        score -= 10; // Low ROI — deprioritize
      }
    }
  }

  return Math.max(0, score);
}

/**
 * Get predicted failure ordering for all known tests.
 *
 * @param {object} opts
 * @param {string[]} opts.affectedRoutes — Routes affected by recent changes
 * @param {number} opts.topN — Return only top N predictions (default: all)
 * @returns {{ prioritized: Array<{ test: string, score: number, reason: string }>, stats: object }}
 */
function getPredictedFailures(opts = {}) {
  const affectedRoutes = opts.affectedRoutes ?? [];
  const topN = opts.topN ?? Infinity;

  const greenHistory = loadGreenHistory();
  const roiData = loadPersonaRoi();

  const tests = Object.keys(greenHistory);
  const scored = [];

  for (const testTitle of tests) {
    const score = scoreTest(testTitle, greenHistory, affectedRoutes, roiData);
    const entry = greenHistory[testTitle];

    let reason = "unknown";
    if (!entry) {
      reason = "never run";
    } else if (entry.lastResult === "fail") {
      reason = `failing (${entry.consecutiveFailures ?? 1}x)`;
    } else if ((entry.consecutivePasses ?? 0) <= 2) {
      reason = "flaky (recently started passing)";
    } else if (score > 30) {
      reason = "affected route + low green streak";
    } else {
      reason = `stable (${entry.consecutivePasses ?? 0} passes)`;
    }

    scored.push({ test: testTitle, score, reason });
  }

  // Sort by score descending (highest failure likelihood first)
  scored.sort((a, b) => b.score - a.score);

  const prioritized = topN < Infinity ? scored.slice(0, topN) : scored;

  // Stats
  const highPriority = scored.filter((s) => s.score >= 50).length;
  const mediumPriority = scored.filter((s) => s.score >= 20 && s.score < 50).length;
  const lowPriority = scored.filter((s) => s.score < 20).length;

  return {
    prioritized,
    stats: {
      total: scored.length,
      highPriority,
      mediumPriority,
      lowPriority,
      affectedRoutes: affectedRoutes.length,
    },
  };
}

/**
 * Get priority score for a single test.
 */
function getTestPriority(testTitle, affectedRoutes = []) {
  const greenHistory = loadGreenHistory();
  const roiData = loadPersonaRoi();
  return scoreTest(testTitle, greenHistory, affectedRoutes, roiData);
}

/**
 * Generate a Playwright --grep pattern that front-loads likely failures.
 * Returns the top N likely-to-fail test patterns.
 */
function getFailureFirstGrep(opts = {}) {
  const topN = opts.topN ?? 20;
  const { prioritized } = getPredictedFailures({ ...opts, topN });

  if (prioritized.length === 0) { return null; }

  // Extract unique persona IDs from high-priority tests
  const personaIds = new Set();
  for (const { test } of prioritized.filter((p) => p.score >= 30)) {
    const match = test.match(/^([a-z]+-[a-z]+)/i);
    if (match) { personaIds.add(match[1]); }
  }

  if (personaIds.size === 0) { return null; }
  return [...personaIds].join("|");
}

// CLI mode
if (require.main === module) {
  const { getAffectedTests } = require("./diff-test-selector");
  const diffResult = getAffectedTests({ since: process.argv[2] ?? "HEAD~1" });
  const predictions = getPredictedFailures({ affectedRoutes: diffResult.affectedRoutes, topN: 20 });

  console.log(`Predicted failures (top ${predictions.prioritized.length} of ${predictions.stats.total}):\n`);
  for (const { test, score, reason } of predictions.prioritized) {
    console.log(`  [${score.toString().padStart(3)}] ${reason.padEnd(30)} ${test}`);
  }
  console.log(`\nStats: ${predictions.stats.highPriority} high, ${predictions.stats.mediumPriority} medium, ${predictions.stats.lowPriority} low priority`);
}

module.exports = { getPredictedFailures, getTestPriority, getFailureFirstGrep };
