#!/usr/bin/env node

/**
 * Test frequency — intelligent test selection (never fully retire).
 *
 * Replaces binary prune with frequency tiers. Hot tests run every iteration;
 * warm/cool/cold run less often to make room for new coverage.
 *
 * Usage:
 *   node scripts/e2e/test-frequency.js --update <results.json>
 *   node scripts/e2e/test-frequency.js --select --iteration N
 *
 * --update: Read Playwright JSON, update e2e/state/test-frequency.json
 * --select --iteration N: Output JSON array of test titles to run this iteration
 *   (iteration 1: caller runs full suite; iteration 2+: use this list with --grep)
 */

const fs = require("fs");
const path = require("path");
const { assignTier, selectTitlesForIteration } = require("./lib/persona-nuance.js");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_FILE = path.join(ROOT, "e2e", "state", "test-frequency.json");
const DEFAULT_RESULTS = path.join(ROOT, "e2e", "test-results", "results.json");

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { tests: {}, lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { tests: {}, lastUpdated: null };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function walkSpecs(suites, fn) {
  if (!suites || !Array.isArray(suites)) return;
  for (const suite of suites) {
    if (suite.specs && Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        fn(spec);
      }
    }
    if (suite.suites) walkSpecs(suite.suites, fn);
  }
}

function getSpecResult(spec) {
  const tests = spec.tests ?? [];
  const hasPass = tests.some((t) => t.status === "expected" || t.status === "passed");
  const hasFail = tests.some((t) => t.status === "unexpected" || t.status === "flaky");
  if (hasFail) return "failed";
  if (hasPass) return "passed";
  return null;
}

// --update <results.json>
const updateIdx = process.argv.indexOf("--update");
if (updateIdx >= 0) {
  const resultsPath = path.resolve(process.argv[updateIdx + 1] ?? DEFAULT_RESULTS);
  if (!fs.existsSync(resultsPath)) {
    console.error(`Results file not found: ${resultsPath}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
  const state = loadState();
  const now = new Date().toISOString();

  walkSpecs(data.suites ?? [], (spec) => {
    const title = spec.title;
    if (!title) return;
    const result = getSpecResult(spec);
    if (!result) return;

    const prev = state.tests[title] ?? {};
    const prevConsecutive = prev.consecutivePasses ?? 0;
    const consecutivePasses = result === "passed" ? prevConsecutive + 1 : 0;
    const findingRate = prev.findingRate ?? 0; // Optional: set via --findings-rate later
    const tier = assignTier(consecutivePasses, result, { findingRate });

    state.tests[title] = {
      lastRun: now,
      lastResult: result,
      consecutivePasses,
      tier,
    };
  });

  saveState(state);
  console.log(`Updated ${Object.keys(state.tests).length} tests in test-frequency.json`);
  process.exit(0);
}

// --select --iteration N
const selectIdx = process.argv.indexOf("--select");
if (selectIdx >= 0) {
  const iterIdx = process.argv.indexOf("--iteration");
  const iteration = iterIdx >= 0 ? parseInt(process.argv[iterIdx + 1] ?? "1", 10) : 1;

  if (iteration <= 1) {
    // Iteration 1: caller runs full suite; output empty = no filter
    console.log(JSON.stringify([]));
    process.exit(0);
  }

  const state = loadState();
  const titles = selectTitlesForIteration(state, iteration);
  console.log(JSON.stringify(titles));
  process.exit(0);
}

console.error("Usage: --update <results.json> | --select --iteration N");
process.exit(1);
