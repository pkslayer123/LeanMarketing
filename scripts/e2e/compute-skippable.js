#!/usr/bin/env node

/**
 * Compute Skippable Tests — Reads green history and manifest to determine
 * which tests can be safely skipped (consistently passing, code unchanged).
 *
 * Writes e2e/state/green-skip-list.json which is read by e2e/fixtures/test.ts
 * at runtime. Tests in the skip list call test.skip() automatically.
 * This replaces --grep-invert which exceeded Windows command-line length limits.
 *
 * Usage:
 *   node scripts/e2e/compute-skippable.js              # Write skip list + print summary
 *   node scripts/e2e/compute-skippable.js --json        # JSON output {skipped, due, total}
 *
 * Called by: loop.sh before each iteration to reduce test runtime.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const GREEN_HISTORY_FILE = path.join(ROOT, "e2e", "state", "green-history.json");
const MANIFEST_FILE = path.join(ROOT, "e2e", "state", "manifest.json");
const COVERAGE_MAP_FILE = path.join(ROOT, "e2e", "state", "coverage-map.json");

const SKIP_LIST_FILE = path.join(ROOT, "e2e", "state", "green-skip-list.json");

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");

/**
 * Load green history from disk.
 */
function loadGreenHistory() {
  if (!fs.existsSync(GREEN_HISTORY_FILE)) {
    return { tests: {}, lastUpdated: new Date().toISOString() };
  }
  try {
    return JSON.parse(fs.readFileSync(GREEN_HISTORY_FILE, "utf-8"));
  } catch {
    return { tests: {}, lastUpdated: new Date().toISOString() };
  }
}

/**
 * Build a code area map from manifest.json: testTitle -> codeAreas[].
 *
 * Since we don't have an exact mapping from test titles to code areas,
 * we build an approximate map by matching persona IDs in test titles
 * to the features they cover in the manifest.
 */
function buildCodeAreaMap(history) {
  let manifest = { features: {} };
  if (fs.existsSync(MANIFEST_FILE)) {
    try {
      manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8"));
    } catch {
      // Fall back to empty manifest
    }
  }

  // Build persona -> codeAreas mapping from manifest
  const personaCodeAreas = {};
  for (const [, feature] of Object.entries(manifest.features || {})) {
    const codeAreas = feature.codeAreas || [];
    const personas = feature.personas || [];
    for (const persona of personas) {
      if (!personaCodeAreas[persona]) {
        personaCodeAreas[persona] = new Set();
      }
      for (const area of codeAreas) {
        personaCodeAreas[persona].add(area);
      }
    }
  }

  // Map test titles to code areas
  // Test titles look like: "Cliff Patience -- MOC Creation Workflow > Stage 0 -- Capture > can see New MOC button"
  // Persona IDs look like: "cliff-patience"
  const codeAreaMap = {};
  const testTitles = Object.keys(history.tests);

  for (const title of testTitles) {
    const titleLower = title.toLowerCase().replace(/\s+/g, "-");
    let matched = false;

    for (const [personaId, areas] of Object.entries(personaCodeAreas)) {
      // Match persona ID patterns in test title (e.g., "cliff-patience" in "cliff patience")
      const personaPattern = personaId.replace(/-/g, "[- ]");
      if (new RegExp(personaPattern, "i").test(title)) {
        codeAreaMap[title] = Array.from(areas);
        matched = true;
        break;
      }
    }

    // Fallback: use empty array (hash will be "no-areas", so tests only skip
    // based on consecutive pass count, not code change detection)
    if (!matched) {
      codeAreaMap[title] = [];
    }
  }

  return codeAreaMap;
}

/**
 * Load coverage map for file-level hash checking.
 */
function loadCoverageMap() {
  try {
    if (fs.existsSync(COVERAGE_MAP_FILE)) {
      return JSON.parse(fs.readFileSync(COVERAGE_MAP_FILE, "utf-8"));
    }
  } catch {
    // ignore
  }
  return { tests: {} };
}

/**
 * Batch git diff cache — runs ONE git diff for all paths at once, then
 * slices results per-path. This replaces per-file execSync calls that
 * scaled to thousands of invocations with 2600+ tests.
 */
const _diffCache = {};

function batchGitDiff(paths, lastRunCommit) {
  if (paths.length === 0) {
    return "";
  }
  const key = paths.sort().join("|") + "|" + (lastRunCommit || "none");
  if (_diffCache[key] !== undefined) {
    return _diffCache[key];
  }
  let result = "";
  const quotedPaths = paths.map((p) => `"${p}"`).join(" ");
  try {
    if (lastRunCommit) {
      result += execSync(`git diff ${lastRunCommit}..HEAD -- ${quotedPaths}`, {
        encoding: "utf-8", cwd: ROOT, timeout: 30000,
      });
    }
  } catch {
    // ignore
  }
  try {
    result += execSync(`git diff HEAD -- ${quotedPaths}`, {
      encoding: "utf-8", cwd: ROOT, timeout: 30000,
    });
  } catch {
    // ignore
  }
  _diffCache[key] = result;
  return result;
}

/**
 * Hash covered files using git diff (mirrors coverage-collector.ts hashCoveredFiles).
 */
function hashCoveredFilesJS(coveredFiles, lastRunCommit) {
  const diffOutput = batchGitDiff(coveredFiles, lastRunCommit);
  return crypto.createHash("md5").update(diffOutput || coveredFiles.join(",")).digest("hex").slice(0, 12);
}

/**
 * Hash code areas using git diff — commit-aware version.
 * Mirrors green-tracker.ts hashCodeAreas() logic.
 */
function hashCodeAreas(codeAreas, lastRunCommit) {
  if (codeAreas.length === 0) {
    return "no-areas";
  }

  try {
    const diffOutput = batchGitDiff(codeAreas, lastRunCommit);
    return crypto.createHash("md5").update(diffOutput || codeAreas.join(",")).digest("hex").slice(0, 12);
  } catch {
    return crypto.createHash("md5").update(codeAreas.join(",")).digest("hex").slice(0, 12);
  }
}

/**
 * Compute hash for a test, preferring coverage data over manifest code areas.
 * Mirrors green-tracker.ts hashCodeAreasWithCoverage().
 */
function computeHash(testTitle, codeAreas, coverageMap, lastRunCommit) {
  const coveredFiles = coverageMap.tests[testTitle];
  if (coveredFiles && coveredFiles.length > 0) {
    return hashCoveredFilesJS(coveredFiles, lastRunCommit);
  }
  return hashCodeAreas(codeAreas, lastRunCommit);
}

/**
 * Escape regex special characters in test titles.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Get skippable tests from green history.
 * Now includes code area hash checking (critical fix — was previously omitted).
 */
function getSkippableTests(history, codeAreaMap) {
  const lastRunCommit = history.lastRunCommit || null;
  const coverageMap = loadCoverageMap();

  // Load quarantine list — quarantined tests should NOT be skipped
  // (they need to run so we can detect recovery)
  let quarantinedTests;
  try {
    const { getQuarantinedTests } = require("./test-quarantine");
    quarantinedTests = new Set(getQuarantinedTests());
  } catch {
    quarantinedTests = new Set();
  }

  return Object.keys(codeAreaMap).filter((testTitle) => {
    // Never skip quarantined tests — they must run to detect recovery
    if (quarantinedTests.has(testTitle)) {
      return false;
    }

    const entry = history.tests[testTitle];
    if (!entry) {
      return false;
    }

    // Must have at least 5 consecutive passes
    if (entry.consecutivePasses < 5) {
      return false;
    }

    // Code area must be unchanged — compute fresh hash and compare
    const codeAreas = codeAreaMap[testTitle] || [];
    const currentHash = computeHash(testTitle, codeAreas, coverageMap, lastRunCommit);
    if (entry.codeAreaHash !== currentHash) {
      return false; // Code changed since last run — must re-test
    }

    // If it failed recently (within 48h), don't skip
    if (entry.lastFailed) {
      const failedAt = new Date(entry.lastFailed).getTime();
      const fortyEightHoursAgo = Date.now() - 48 * 60 * 60 * 1000;
      if (failedAt > fortyEightHoursAgo) {
        return false;
      }
    }

    // Periodic reintroduction
    let interval;
    if (entry.consecutivePasses >= 50) {
      interval = 30 * 24 * 60 * 60 * 1000;
    } else if (entry.consecutivePasses >= 20) {
      interval = 14 * 24 * 60 * 60 * 1000;
    } else {
      interval = 7 * 24 * 60 * 60 * 1000;
    }

    const lastChecked = entry.lastReintroduced
      ? new Date(entry.lastReintroduced).getTime()
      : new Date(entry.lastRun).getTime();
    if (Date.now() - lastChecked >= interval) {
      return false; // Due for reintroduction
    }

    return true;
  });
}

/**
 * Get tests due for reintroduction.
 */
function getReintroductionDue(history) {
  const due = [];
  for (const [title, entry] of Object.entries(history.tests)) {
    if (entry.consecutivePasses < 5) {
      continue;
    }

    let interval;
    if (entry.consecutivePasses >= 50) {
      interval = 30 * 24 * 60 * 60 * 1000;
    } else if (entry.consecutivePasses >= 20) {
      interval = 14 * 24 * 60 * 60 * 1000;
    } else {
      interval = 7 * 24 * 60 * 60 * 1000;
    }

    const lastChecked = entry.lastReintroduced
      ? new Date(entry.lastReintroduced).getTime()
      : new Date(entry.lastRun).getTime();
    if (Date.now() - lastChecked >= interval) {
      due.push(title);
    }
  }
  return due;
}

/**
 * Load recently-fixed-files.json and return routes that should NOT be skipped.
 * Files fixed in the last 48h need re-testing regardless of green history.
 */
function loadRecentlyFixedRoutes() {
  try {
    const fixedPath = path.join(ROOT, "e2e", "state", "recently-fixed-files.json");
    if (!fs.existsSync(fixedPath)) { return []; }
    const data = JSON.parse(fs.readFileSync(fixedPath, "utf-8"));
    // Ignore stale entries (>48h old)
    if (data.at) {
      const age = Date.now() - new Date(data.at).getTime();
      if (age > 48 * 60 * 60 * 1000) { return []; }
    }
    return data.routes ?? [];
  } catch {
    return [];
  }
}

/**
 * Check if a test title matches any of the recently-fixed routes.
 */
function testMatchesFixedRoutes(testTitle, fixedRoutes) {
  if (fixedRoutes.length === 0) { return false; }
  const titleLower = testTitle.toLowerCase();
  for (const route of fixedRoutes) {
    // Convert route to search pattern: /mocs → "mocs", /admin/permissions → "admin" + "permissions"
    const segments = route.replace(/^\//, "").split("/").filter(Boolean);
    // Match if all non-wildcard segments appear in the test title
    const nonWild = segments.filter((s) => s !== "*");
    if (nonWild.length > 0 && nonWild.every((seg) => titleLower.includes(seg.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

function main() {
  const history = loadGreenHistory();
  const testCount = Object.keys(history.tests).length;

  if (testCount === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ pattern: null, skipped: 0, due: 0, total: 0 }));
    } else {
      console.error("[compute-skippable] No green history yet. Run tests to populate.");
    }
    return;
  }

  const codeAreaMap = buildCodeAreaMap(history);
  const skippable = getSkippableTests(history, codeAreaMap);
  const due = getReintroductionDue(history);

  // Force-include tests that touch recently-fixed routes (observer integration)
  const fixedRoutes = loadRecentlyFixedRoutes();
  let forceIncluded = 0;
  if (fixedRoutes.length > 0) {
    const beforeCount = skippable.length;
    const forceIncludedTests = skippable.filter((t) => testMatchesFixedRoutes(t, fixedRoutes));
    forceIncluded = forceIncludedTests.length;
    // Remove force-included tests from skippable
    for (const t of forceIncludedTests) {
      const idx = skippable.indexOf(t);
      if (idx >= 0) { skippable.splice(idx, 1); }
    }
    if (forceIncluded > 0 && !jsonMode) {
      console.error(
        `[compute-skippable] Force-included ${forceIncluded} tests matching recently-fixed routes: ${fixedRoutes.join(", ")}`
      );
    }
  }

  // Cap: never skip more than 80% of tracked tests.
  // A fully-pruned iteration wastes orchestrator/hook time with zero signal.
  const MAX_SKIP_RATIO = 0.80;
  const maxSkippable = Math.floor(testCount * MAX_SKIP_RATIO);
  let capped = false;
  let finalSkippable = skippable;
  if (skippable.length > maxSkippable && maxSkippable > 0) {
    // Keep the ones with the MOST consecutive passes (most stable) and force-run the rest
    const sorted = [...skippable].sort((a, b) => {
      const aEntry = history.tests[a];
      const bEntry = history.tests[b];
      return (bEntry?.consecutivePasses ?? 0) - (aEntry?.consecutivePasses ?? 0);
    });
    finalSkippable = sorted.slice(0, maxSkippable);
    capped = true;
    if (!jsonMode) {
      console.error(
        `[compute-skippable] Capped skip list from ${skippable.length} to ${maxSkippable} (80% of ${testCount}). ${skippable.length - maxSkippable} tests forced to run.`
      );
    }
  }

  // Always write skip list file for Playwright fixtures to read at runtime
  // This replaces --grep-invert which exceeds Windows command-line length limits
  const skipListData = {
    skippable: finalSkippable,
    due,
    generatedAt: new Date().toISOString(),
    total: testCount,
    capped,
  };
  fs.mkdirSync(path.dirname(SKIP_LIST_FILE), { recursive: true });
  fs.writeFileSync(SKIP_LIST_FILE, JSON.stringify(skipListData, null, 2));

  if (jsonMode) {
    console.log(
      JSON.stringify({
        skipped: finalSkippable.length,
        due: due.length,
        total: testCount,
        capped,
        skipListFile: SKIP_LIST_FILE,
      })
    );
    return;
  }

  // Summary to stderr
  console.error(
    `[compute-skippable] Skipping ${finalSkippable.length} tests (${due.length} due for reintroduction) out of ${testCount} tracked`
  );
  console.error(`[compute-skippable] Skip list written to ${SKIP_LIST_FILE}`);
}

main();
