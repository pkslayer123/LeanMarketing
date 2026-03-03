#!/usr/bin/env node

/**
 * learn-from-production.js — Production error feedback loop.
 * Reads production errors and identifies test gaps.
 *
 * For each error cluster from production, checks whether any persona test
 * covers the affected page or API route. Categorizes gaps as:
 *   - "uncovered": no persona test visits this path
 *   - "covered_but_passing": a test exists but doesn't reproduce the error
 *   - "noise": known transient/irrelevant pattern (auto-skipped)
 *
 * Output: e2e/state/production-test-gaps.json + console summary.
 *
 * Usage:
 *   node scripts/e2e/learn-from-production.js
 *   node scripts/e2e/learn-from-production.js --json
 *   node scripts/e2e/learn-from-production.js --days 7
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const PERSONAS_DIR = path.join(ROOT, "e2e", "tests", "personas");
const OUTPUT_FILE = path.join(ROOT, "e2e", "state", "production-test-gaps.json");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}
const jsonOutput = args.includes("--json");
const days = getArg("--days") || "30d";
// Normalise: allow bare number ("7") or suffixed ("7d")
const daysFlag = /^\d+$/.test(days) ? `${days}d` : days;

// ---------------------------------------------------------------------------
// Noise patterns — auto-skip these error messages
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
  /network.*offline|failed to fetch|aborterror/i,
  /hydration|react.*419/i,
  /long.*task|PerformanceObserver/i,
  /NEXT_REDIRECT/i,
  /refresh_token|bad_jwt/i,
];

function isNoise(message) {
  if (!message) {
    return false;
  }
  return NOISE_PATTERNS.some((re) => re.test(message));
}

// ---------------------------------------------------------------------------
// Load production errors via query-errors.js
// ---------------------------------------------------------------------------

function loadProductionErrors() {
  const script = path.join(ROOT, "scripts", "query-errors.js");
  if (!fs.existsSync(script)) {
    console.error("query-errors.js not found at", script);
    process.exit(1);
  }

  try {
    const stdout = execSync(
      `node "${script}" --json --top 20 --last ${daysFlag}`,
      {
        cwd: ROOT,
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    // The script may print non-JSON preamble; find the JSON object
    const jsonStart = stdout.indexOf("{");
    if (jsonStart === -1) {
      console.error("No JSON output from query-errors.js. Raw output:");
      console.error(stdout.slice(0, 500));
      return [];
    }
    const parsed = JSON.parse(stdout.slice(jsonStart));
    return parsed.patterns || [];
  } catch (err) {
    // If the script exits non-zero (e.g. no env vars), handle gracefully
    if (err.stderr && /Missing.*SUPABASE/.test(err.stderr)) {
      console.error(
        "Cannot load production errors: missing Supabase env vars in .env.local"
      );
    } else if (err.stdout) {
      // May still have JSON in stdout even with non-zero exit
      try {
        const jsonStart = err.stdout.indexOf("{");
        if (jsonStart >= 0) {
          const parsed = JSON.parse(err.stdout.slice(jsonStart));
          return parsed.patterns || [];
        }
      } catch {
        // fall through
      }
      console.error("query-errors.js failed:", (err.message || "").slice(0, 200));
    } else {
      console.error("query-errors.js failed:", (err.message || "").slice(0, 200));
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Load all persona spec files and build a coverage index
// ---------------------------------------------------------------------------

function buildCoverageIndex() {
  if (!fs.existsSync(PERSONAS_DIR)) {
    console.error("Personas directory not found:", PERSONAS_DIR);
    return { pages: new Map(), apis: new Map() };
  }

  const specFiles = fs
    .readdirSync(PERSONAS_DIR)
    .filter((f) => f.endsWith(".spec.ts"));

  // Map from page path pattern -> [{ personaId, file }]
  // Map from API route pattern -> [{ personaId, file }]
  const pages = new Map();
  const apis = new Map();

  for (const file of specFiles) {
    const filePath = path.join(PERSONAS_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const personaId = file.replace(".spec.ts", "");

    // Match page navigations: sim.goto("/path"), page.goto("/path"), .goto(`...`)
    const gotoMatches = content.matchAll(
      /\.goto\(\s*["'`]([^"'`]+)["'`]\s*\)/g
    );
    for (const m of gotoMatches) {
      const pagePath = m[1];
      if (!pagePath.startsWith("/")) {
        continue;
      }
      if (!pages.has(pagePath)) {
        pages.set(pagePath, []);
      }
      const existing = pages.get(pagePath);
      if (!existing.some((e) => e.personaId === personaId)) {
        existing.push({ personaId, file });
      }
    }

    // Match API requests: sim.apiRequest("GET", "/api/..."), fetch(`${baseURL}/api/...`)
    const apiMatches = content.matchAll(
      /(?:apiRequest|fetch)\s*\(\s*(?:["'`](?:GET|POST|PUT|PATCH|DELETE)["'`]\s*,\s*)?["'`](?:\$\{[^}]*\})?(\/api\/[^"'`\s]+)["'`]/g
    );
    for (const m of apiMatches) {
      const apiPath = m[1];
      if (!apis.has(apiPath)) {
        apis.set(apiPath, []);
      }
      const existing = apis.get(apiPath);
      if (!existing.some((e) => e.personaId === personaId)) {
        existing.push({ personaId, file });
      }
    }

    // Match page.goto with baseURL prefix: `${baseURL}/path`
    const baseUrlGotoMatches = content.matchAll(
      /\.goto\(\s*`\$\{[^}]+\}(\/[^`]+)`\s*\)/g
    );
    for (const m of baseUrlGotoMatches) {
      const pagePath = m[1];
      if (pagePath.startsWith("/api/")) {
        if (!apis.has(pagePath)) {
          apis.set(pagePath, []);
        }
        const existing = apis.get(pagePath);
        if (!existing.some((e) => e.personaId === personaId)) {
          existing.push({ personaId, file });
        }
      } else {
        if (!pages.has(pagePath)) {
          pages.set(pagePath, []);
        }
        const existing = pages.get(pagePath);
        if (!existing.some((e) => e.personaId === personaId)) {
          existing.push({ personaId, file });
        }
      }
    }
  }

  return { pages, apis };
}

// ---------------------------------------------------------------------------
// Normalise a path for matching (strip dynamic segments)
// ---------------------------------------------------------------------------

function normalisePath(rawPath) {
  if (!rawPath) {
    return null;
  }
  // Strip query string and hash
  let p = rawPath.split("?")[0].split("#")[0];
  // Strip trailing slash (except root)
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * Turn a concrete path like /api/mocs/abc123/review into a pattern like
 * /api/mocs/[id]/review by replacing UUID-like or opaque ID segments
 * with a wildcard placeholder.
 */
function toWildcardPath(p) {
  if (!p) {
    return null;
  }
  return p.replace(
    /\/[0-9a-f]{8,}(?:-[0-9a-f]{4,}){0,4}/gi,
    "/[id]"
  );
}

/**
 * Check if a coverage-index key matches a target path.
 * Supports exact match, wildcard match, and prefix match.
 */
function pathMatches(indexPath, targetPath) {
  if (!indexPath || !targetPath) {
    return false;
  }
  // Exact match
  if (indexPath === targetPath) {
    return true;
  }
  // Wildcard: index may have /mocs or target may have /mocs/[id]
  const indexWild = toWildcardPath(indexPath);
  const targetWild = toWildcardPath(targetPath);
  if (indexWild === targetWild) {
    return true;
  }
  // Prefix match: /admin/settings covers /admin/settings/llm
  if (targetPath.startsWith(indexPath + "/")) {
    return true;
  }
  if (indexPath.startsWith(targetPath + "/")) {
    return true;
  }
  // Wildcard prefix
  if (indexWild && targetWild && targetWild.startsWith(indexWild + "/")) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Find covering tests for an error
// ---------------------------------------------------------------------------

function findCoveringTests(error, coverageIndex) {
  const coveredBy = [];

  // Extract paths from error
  const endpoints = error.endpoints || [];
  const message = error.message || "";

  // Also try to extract a path from the stack trace
  const stackPaths = [];
  if (error.stack_trace_preview) {
    const stackRouteMatch = error.stack_trace_preview.match(
      /(?:app|pages)(\/[^\s:)]+)/
    );
    if (stackRouteMatch) {
      stackPaths.push(stackRouteMatch[1]);
    }
  }

  // Combine all paths to check
  const allPaths = [...endpoints, ...stackPaths].map(normalisePath).filter(Boolean);

  // Also try to extract a page path from the error message
  const msgPathMatch = message.match(/(?:\/(?:moc|admin|review|mocs|account|api)\S*)/);
  if (msgPathMatch) {
    const p = normalisePath(msgPathMatch[0]);
    if (p) {
      allPaths.push(p);
    }
  }

  // De-duplicate
  const uniquePaths = [...new Set(allPaths)];

  for (const targetPath of uniquePaths) {
    const isApi = targetPath.startsWith("/api/");
    const index = isApi ? coverageIndex.apis : coverageIndex.pages;

    for (const [indexPath, personas] of index.entries()) {
      if (pathMatches(indexPath, targetPath)) {
        for (const { personaId } of personas) {
          if (!coveredBy.includes(personaId)) {
            coveredBy.push(personaId);
          }
        }
      }
    }
  }

  return { coveredBy, paths: uniquePaths };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("Loading production errors...");
  const errors = loadProductionErrors();

  if (errors.length === 0) {
    console.log("No production errors to analyze.");
    const emptyResult = {
      analyzedAt: new Date().toISOString(),
      errorsAnalyzed: 0,
      gaps: [],
      summary: { uncovered: 0, coveredButPassing: 0, noise: 0 },
    };
    writeOutput(emptyResult);
    if (jsonOutput) {
      console.log(JSON.stringify(emptyResult, null, 2));
    }
    return;
  }

  console.log(`Analyzing ${errors.length} error clusters...`);
  console.log("Building persona test coverage index...");

  const coverageIndex = buildCoverageIndex();
  const pageCount = coverageIndex.pages.size;
  const apiCount = coverageIndex.apis.size;
  console.log(
    `Coverage index: ${pageCount} page paths, ${apiCount} API paths across persona specs.\n`
  );

  const gaps = [];
  const summary = { uncovered: 0, coveredButPassing: 0, noise: 0 };

  for (const error of errors) {
    const message = error.message || "";
    const errorId = (error.ids && error.ids[0]) || "unknown";

    // Check noise first
    if (isNoise(message)) {
      gaps.push({
        errorId,
        message: message.slice(0, 200),
        page: (error.endpoints || [])[0] || null,
        count: error.count || 1,
        status: "noise",
        coveredBy: [],
      });
      summary.noise++;
      continue;
    }

    // Find covering tests
    const { coveredBy, paths } = findCoveringTests(error, coverageIndex);
    const page = paths[0] || (error.endpoints || [])[0] || null;

    if (coveredBy.length === 0) {
      gaps.push({
        errorId,
        message: message.slice(0, 200),
        page,
        count: error.count || 1,
        status: "uncovered",
        coveredBy: [],
      });
      summary.uncovered++;
    } else {
      gaps.push({
        errorId,
        message: message.slice(0, 200),
        page,
        count: error.count || 1,
        status: "covered_but_passing",
        coveredBy,
      });
      summary.coveredButPassing++;
    }
  }

  const result = {
    analyzedAt: new Date().toISOString(),
    errorsAnalyzed: errors.length,
    gaps,
    summary,
  };

  writeOutput(result);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Console summary
  console.log("=".repeat(70));
  console.log("  Production Error -> Test Gap Analysis");
  console.log("=".repeat(70));
  console.log(
    `  Errors analyzed:     ${result.errorsAnalyzed}`
  );
  console.log(
    `  Uncovered:           ${summary.uncovered}  (no persona test covers this path)`
  );
  console.log(
    `  Covered but passing: ${summary.coveredButPassing}  (test exists, doesn't reproduce)`
  );
  console.log(
    `  Noise (skipped):     ${summary.noise}  (network drops, hydration, etc.)`
  );
  console.log("=".repeat(70));

  // Detail: uncovered gaps
  const uncovered = gaps.filter((g) => g.status === "uncovered");
  if (uncovered.length > 0) {
    console.log("\nUNCOVERED error paths (need new persona tests):\n");
    for (const gap of uncovered) {
      console.log(`  [x${gap.count}] ${gap.page || "(no path)"}`);
      console.log(`         ${gap.message.slice(0, 100)}`);
      console.log();
    }
  }

  // Detail: covered but passing
  const covered = gaps.filter((g) => g.status === "covered_but_passing");
  if (covered.length > 0) {
    console.log("COVERED BUT PASSING (test exists, error not reproduced):\n");
    for (const gap of covered) {
      console.log(`  [x${gap.count}] ${gap.page || "(no path)"}`);
      console.log(`         Covered by: ${gap.coveredBy.join(", ")}`);
      console.log(`         ${gap.message.slice(0, 100)}`);
      console.log();
    }
  }

  // Detail: noise
  if (summary.noise > 0) {
    console.log(
      `NOISE: ${summary.noise} clusters auto-skipped (network drops, hydration, etc.)\n`
    );
  }

  console.log(`Output written to: ${path.relative(ROOT, OUTPUT_FILE)}`);
}

// ---------------------------------------------------------------------------
// Write output file
// ---------------------------------------------------------------------------

function writeOutput(result) {
  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main();
