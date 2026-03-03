#!/usr/bin/env node

/**
 * Update Green History — Records test pass/fail results into the green tracker.
 *
 * Reads the Playwright JSON results file and updates e2e/state/green-history.json
 * with pass/fail records for each test. Used by compute-skippable.js to determine
 * which tests can be safely skipped.
 *
 * Usage:
 *   node scripts/e2e/update-green-history.js [results.json]
 *   node scripts/e2e/update-green-history.js --json
 *
 * Called by: loop.sh after test run (Step 3b, alongside test-frequency.js)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_RESULTS = path.join(ROOT, "e2e", "test-results", "results.json");
const GREEN_HISTORY_FILE = path.join(ROOT, "e2e", "state", "green-history.json");
const MANIFEST_FILE = path.join(ROOT, "e2e", "state", "manifest.json");

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const resultsPath = args.find((a) => !a.startsWith("--")) || DEFAULT_RESULTS;

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
 * Save green history to disk.
 */
function saveGreenHistory(history) {
  const dir = path.dirname(GREEN_HISTORY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  history.lastUpdated = new Date().toISOString();
  fs.writeFileSync(GREEN_HISTORY_FILE, JSON.stringify(history, null, 2));
}

/**
 * Hash code areas using git diff (matching green-tracker.ts logic).
 */
function hashCodeAreas(codeAreas) {
  if (codeAreas.length === 0) {
    return "no-areas";
  }
  try {
    const diffOutput = codeAreas
      .map((area) => {
        try {
          return execSync(`git diff HEAD -- "${area}"`, {
            encoding: "utf-8",
            cwd: ROOT,
            timeout: 5000,
          });
        } catch {
          return "";
        }
      })
      .join("");
    return crypto
      .createHash("md5")
      .update(diffOutput || codeAreas.join(","))
      .digest("hex")
      .slice(0, 12);
  } catch {
    return crypto.createHash("md5").update(codeAreas.join(",")).digest("hex").slice(0, 12);
  }
}

/**
 * Build persona -> codeAreas mapping from manifest.
 */
function buildPersonaCodeAreas() {
  let manifest = { features: {} };
  if (fs.existsSync(MANIFEST_FILE)) {
    try {
      manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8"));
    } catch {
      // Fall through
    }
  }

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

  return personaCodeAreas;
}

/**
 * Resolve code areas for a test title.
 */
function resolveCodeAreas(testTitle, personaCodeAreas) {
  const titleLower = testTitle.toLowerCase();
  for (const [personaId, areas] of Object.entries(personaCodeAreas)) {
    const personaPattern = personaId.replace(/-/g, "[- ]");
    if (new RegExp(personaPattern, "i").test(testTitle)) {
      return Array.from(areas);
    }
  }
  return [];
}

/**
 * Walk Playwright JSON results and extract test titles with pass/fail status.
 */
function extractResults(resultsFile) {
  if (!fs.existsSync(resultsFile)) {
    return { passed: [], failed: [] };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(resultsFile, "utf-8"));
  } catch {
    return { passed: [], failed: [] };
  }

  const passed = [];
  const failed = [];

  function walk(suites) {
    if (!suites || !Array.isArray(suites)) {
      return;
    }
    for (const suite of suites) {
      if (suite.specs && Array.isArray(suite.specs)) {
        for (const spec of suite.specs) {
          // Build full title: suite.title > spec.title
          const suiteTitle = suite.title || "";
          const specTitle = spec.title || "";
          const fullTitle = suiteTitle ? `${suiteTitle} > ${specTitle}` : specTitle;

          for (const t of spec.tests || []) {
            if (t.status === "expected" || t.status === "passed") {
              passed.push(fullTitle);
            } else if (t.status === "unexpected" || t.status === "failed" || t.status === "timedOut") {
              failed.push(fullTitle);
            }
          }
        }
      }
      if (suite.suites) {
        // Recurse into nested suites, passing parent title context
        for (const child of suite.suites) {
          const parentTitle = suite.title || "";
          if (parentTitle && child.title && !child.title.startsWith(parentTitle)) {
            child._parentTitle = parentTitle;
          }
        }
        walk(suite.suites);
      }
    }
  }

  walk(data.suites || []);
  return { passed: [...new Set(passed)], failed: [...new Set(failed)] };
}

function main() {
  const { passed, failed } = extractResults(resultsPath);

  if (passed.length === 0 && failed.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ updated: 0, message: "No test results found" }));
    } else {
      console.log("[update-green-history] No test results found in " + resultsPath);
    }
    return;
  }

  const history = loadGreenHistory();
  const personaCodeAreas = buildPersonaCodeAreas();
  const now = new Date().toISOString();

  let passesRecorded = 0;
  let failuresRecorded = 0;

  // Record passes
  for (const title of passed) {
    const codeAreas = resolveCodeAreas(title, personaCodeAreas);
    const currentHash = hashCodeAreas(codeAreas);
    const entry = history.tests[title];

    if (entry && entry.codeAreaHash === currentHash) {
      entry.consecutivePasses++;
      entry.lastRun = now;
    } else {
      history.tests[title] = {
        consecutivePasses: 1,
        lastFailed: entry?.lastFailed ?? null,
        lastRun: now,
        lastReintroduced: null,
        codeAreaHash: currentHash,
      };
    }
    passesRecorded++;
  }

  // Record failures
  for (const title of failed) {
    const codeAreas = resolveCodeAreas(title, personaCodeAreas);
    const currentHash = hashCodeAreas(codeAreas);
    history.tests[title] = {
      consecutivePasses: 0,
      lastFailed: now,
      lastRun: now,
      lastReintroduced: null,
      codeAreaHash: currentHash,
    };
    failuresRecorded++;
  }

  saveGreenHistory(history);

  if (jsonMode) {
    console.log(
      JSON.stringify({
        updated: passesRecorded + failuresRecorded,
        passes: passesRecorded,
        failures: failuresRecorded,
        totalTracked: Object.keys(history.tests).length,
      })
    );
  } else {
    console.log(
      `[update-green-history] Recorded ${passesRecorded} passes, ${failuresRecorded} failures (${Object.keys(history.tests).length} total tracked)`
    );
  }
}

main();
