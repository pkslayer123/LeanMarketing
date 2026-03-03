#!/usr/bin/env node

/**
 * discover-routes.js — Auto-discover Next.js routes by walking the filesystem.
 *
 * Compares discovered routes against manifest.json pages arrays to find
 * uncovered routes, then optionally updates manifest + generates test stubs.
 *
 * Algorithm:
 *   1. Walk app/ recursively for page.tsx and route.ts files
 *   2. Convert paths to routes (app/admin/people/page.tsx → /admin/people)
 *   3. Compare against all pages arrays in e2e/state/manifest.json
 *   4. For uncovered routes, infer feature area from path prefix
 *   5. With --fix: update manifest + call generate-tests.js per new feature
 *
 * Usage:
 *   node scripts/e2e/discover-routes.js              # Report only
 *   node scripts/e2e/discover-routes.js --fix         # Auto-update manifest + generate stubs
 *   node scripts/e2e/discover-routes.js --json        # Machine-readable output
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const APP_DIR = path.join(ROOT, "app");
const MANIFEST_PATH = path.join(ROOT, "e2e", "state", "manifest.json");

const args = process.argv.slice(2);
const FIX_MODE = args.includes("--fix");
const JSON_MODE = args.includes("--json");

// Files to skip (non-route files in app/)
const SKIP_FILES = new Set(["layout.tsx", "loading.tsx", "error.tsx", "not-found.tsx", "template.tsx", "default.tsx"]);

// Route prefix → manifest feature key mapping
const PREFIX_TO_FEATURE = {
  "/moc/": "moc_workflow",
  "/mocs/new": "moc_workflow",
  "/mocs/completed": "moc_decisions",
  "/mocs/portfolio": "moc_decisions",
  "/mocs": "moc_workflow",
  "/admin/departments": "department_management",
  "/admin/people": "user_management",
  "/admin/permissions": "admin_permissions",
  "/admin/developer": "developer_tools",
  "/admin/settings": "admin_settings",
  "/admin/analytics": "analytics",
  "/admin/features": "admin_features",
  "/admin/webhooks": "webhooks",
  "/admin/agents": "admin_agents",
  "/admin/errors": "error_monitoring",
  "/admin/security": "admin_security",
  "/admin/intelligence": "admin_intelligence",
  "/admin": "admin_dashboard",
  "/review": "moc_review",
  "/account": "account_settings",
  "/api/admin": "admin_api",
  "/api/mocs": "moc_api",
  "/api/auth": "auth_api",
  "/api/llm": "llm_api",
  "/api/features": "features_api",
  "/api/permissions": "permissions_api",
  "/api/": "api_general",
};

// Persona assignment rules (subset of sync-manifest.js rules)
const ROUTE_PERSONA_MAP = {
  "moc_workflow": ["cliff-patience", "paige-turner", "frank-doorman"],
  "moc_review": ["raj-diligence", "victor-veto", "maria-steadman"],
  "moc_decisions": ["cliff-patience", "wanda-walls"],
  "department_management": ["wanda-walls", "del-e-gate", "sue-pervisor"],
  "user_management": ["sue-pervisor"],
  "admin_dashboard": ["sue-pervisor"],
  "admin_permissions": ["sue-pervisor", "grant-powers"],
  "admin_settings": ["sue-pervisor"],
  "admin_features": ["sue-pervisor"],
  "admin_security": ["penny-tester", "sue-pervisor"],
  "admin_intelligence": ["sue-pervisor"],
  "admin_agents": ["sue-pervisor", "max-manual"],
  "developer_tools": ["grant-powers"],
  "error_monitoring": ["grant-powers"],
  "analytics": ["sue-pervisor"],
  "webhooks": ["penny-tester"],
  "account_settings": ["paige-turner", "cliff-patience"],
};

// ---------------------------------------------------------------------------
// Filesystem walking
// ---------------------------------------------------------------------------

function walkDir(dir, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules, hidden dirs
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      walkDir(fullPath, results);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function discoverRoutes() {
  const allFiles = walkDir(APP_DIR);
  const pages = [];
  const apiRoutes = [];

  for (const filePath of allFiles) {
    const relative = path.relative(APP_DIR, filePath).replace(/\\/g, "/");
    const fileName = path.basename(filePath);

    // Skip non-route files
    if (SKIP_FILES.has(fileName)) {
      continue;
    }

    // page.tsx → UI route
    if (fileName === "page.tsx") {
      const routeDir = path.dirname(relative);
      const route = routeDir === "." ? "/" : "/" + routeDir;
      pages.push(route);
    }

    // route.ts → API route
    if (fileName === "route.ts") {
      const routeDir = path.dirname(relative);
      const route = "/" + routeDir;
      apiRoutes.push(route);
    }
  }

  return { pages: pages.sort(), apiRoutes: apiRoutes.sort() };
}

// ---------------------------------------------------------------------------
// Manifest comparison
// ---------------------------------------------------------------------------

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {
    return { version: 2, features: {} };
  }
}

function getManifestPages(manifest) {
  const allPages = new Set();
  for (const feature of Object.values(manifest.features ?? {})) {
    for (const page of feature.pages ?? []) {
      allPages.add(page);
    }
  }
  return allPages;
}

function inferFeatureKey(route) {
  // Try longest prefix match first
  const prefixes = Object.keys(PREFIX_TO_FEATURE).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (route === prefix || route.startsWith(prefix + "/") || route.startsWith(prefix)) {
      return PREFIX_TO_FEATURE[prefix];
    }
  }
  // Dynamic route segments: /moc/[id]/stage-N → moc_workflow
  if (/^\/moc\//.test(route)) {
    return "moc_workflow";
  }
  return null;
}

function inferCodeArea(route) {
  // Convert route back to approximate code area
  if (route.startsWith("/api/")) {
    return "app" + route + "/";
  }
  // /admin/people → app/admin/people/
  return "app" + route + "/";
}

function findUncoveredRoutes(discovered, manifestPages) {
  const uncovered = [];

  for (const route of discovered.pages) {
    // Skip dynamic segment routes like /moc/[id]/stage-1 — these are sub-pages
    if (/\[.*\]/.test(route)) {
      continue;
    }

    if (!manifestPages.has(route)) {
      const featureKey = inferFeatureKey(route);
      const codeArea = inferCodeArea(route);
      const personas = featureKey ? (ROUTE_PERSONA_MAP[featureKey] ?? []) : [];
      uncovered.push({ route, type: "page", featureKey, codeArea, personas });
    }
  }

  return uncovered;
}

// ---------------------------------------------------------------------------
// Fix mode: update manifest + generate stubs
// ---------------------------------------------------------------------------

function updateManifest(manifest, uncovered) {
  let updated = 0;
  const newFeatures = new Set();

  for (const item of uncovered) {
    if (!item.featureKey) {
      continue;
    }

    // Create feature if it doesn't exist
    if (!manifest.features[item.featureKey]) {
      manifest.features[item.featureKey] = {
        permissions: [],
        personas: item.personas,
        pages: [item.route],
        codeAreas: [item.codeArea],
      };
      newFeatures.add(item.featureKey);
      updated++;
      continue;
    }

    // Add page to existing feature
    const feature = manifest.features[item.featureKey];
    if (!feature.pages) {
      feature.pages = [];
    }
    if (!feature.pages.includes(item.route)) {
      feature.pages.push(item.route);
      updated++;
    }

    // Add code area if not present
    if (!feature.codeAreas) {
      feature.codeAreas = [];
    }
    if (!feature.codeAreas.includes(item.codeArea)) {
      feature.codeAreas.push(item.codeArea);
    }

    // Add personas if missing
    if (item.personas.length > 0 && (!feature.personas || feature.personas.length === 0)) {
      feature.personas = item.personas;
    }
  }

  if (updated > 0) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  }

  return { updated, newFeatures: [...newFeatures] };
}

function generateStubs(newFeatures) {
  const generateScript = path.join(ROOT, "scripts", "e2e", "generate-tests.js");
  if (!fs.existsSync(generateScript)) {
    console.warn("[discover-routes] generate-tests.js not found, skipping stub generation");
    return;
  }

  for (const featureKey of newFeatures) {
    try {
      execSync(`node "${generateScript}" --feature ${featureKey}`, {
        cwd: ROOT,
        stdio: "pipe",
        timeout: 15000,
      });
      console.log(`  Generated test stub for: ${featureKey}`);
    } catch (e) {
      console.warn(`  Failed to generate stub for ${featureKey}: ${e.message?.slice(0, 80) ?? e}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const discovered = discoverRoutes();
  const manifest = loadManifest();
  const manifestPages = getManifestPages(manifest);
  const uncovered = findUncoveredRoutes(discovered, manifestPages);

  const report = {
    discoveredPages: discovered.pages.length,
    discoveredApiRoutes: discovered.apiRoutes.length,
    manifestPages: manifestPages.size,
    uncoveredCount: uncovered.length,
    uncovered,
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[discover-routes] Found ${discovered.pages.length} pages, ${discovered.apiRoutes.length} API routes`);
    console.log(`  Manifest covers: ${manifestPages.size} pages`);

    if (uncovered.length === 0) {
      console.log("  All discovered routes are covered in manifest.");
    } else {
      console.log(`  ${uncovered.length} uncovered route(s):`);
      for (const item of uncovered) {
        const featureLabel = item.featureKey ? ` -> ${item.featureKey}` : " -> (unmapped)";
        const personaLabel = item.personas.length > 0 ? ` [${item.personas.join(", ")}]` : "";
        console.log(`    ${item.route}${featureLabel}${personaLabel}`);
      }
    }
  }

  if (FIX_MODE && uncovered.length > 0) {
    const { updated, newFeatures } = updateManifest(manifest, uncovered);
    console.log(`\n  Updated manifest: ${updated} route(s) added`);

    if (newFeatures.length > 0) {
      console.log(`  New features created: ${newFeatures.join(", ")}`);
      generateStubs(newFeatures);
    }

    // Auto-update FILE_TO_ROUTE in diff-test-selector.js
    const routeResult = updateFileToRoute(uncovered);
    if (routeResult.added > 0) {
      console.log(`  Updated FILE_TO_ROUTE: ${routeResult.added} mapping(s) added`);
    }

    // Emit findings for uncovered routes — feeds into findings-to-mocs pipeline
    emitCoverageGapFindings(uncovered);
  }

  return report;
}

/**
 * Emit coverage gap findings for uncovered routes into findings.json.
 * These feed into the findings-to-mocs.js pipeline as auto_fix tier.
 * Only emits new findings — deduplicates against existing findings by route.
 */
function emitCoverageGapFindings(uncovered) {
  const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
  let findings = [];
  try {
    if (fs.existsSync(FINDINGS_FILE)) {
      findings = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
    }
  } catch {
    findings = [];
  }

  // Deduplicate: check existing route_coverage_gap findings by page
  const existingGapPages = new Set(
    findings
      .filter((f) => f.type === "route_coverage_gap" && f.status !== "resolved")
      .map((f) => f.page)
  );

  let added = 0;
  for (const item of uncovered) {
    if (existingGapPages.has(item.route)) {
      continue; // Already reported
    }

    findings.push({
      id: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: "route_coverage_gap",
      severity: "suggestion",
      page: item.route,
      persona: "Route Discovery",
      description:
        `Discovered route ${item.route} is not covered by any persona test. ` +
        `Feature: ${item.featureKey ?? "unmapped"}. ` +
        `Suggested personas: ${item.personas.join(", ") || "none assigned"}.`,
      status: "open",
      timestamp: new Date().toISOString(),
      featureKey: item.featureKey,
      suggestedPersonas: item.personas,
    });
    added++;
  }

  if (added > 0) {
    fs.writeFileSync(FINDINGS_FILE, JSON.stringify(findings, null, 2));
    console.log(`  Emitted ${added} coverage gap finding(s) to findings.json`);
  }
}

// ---------------------------------------------------------------------------
// FILE_TO_ROUTE auto-update (Part 5B)
// ---------------------------------------------------------------------------

const DIFF_TEST_SELECTOR_PATH = path.join(ROOT, "scripts", "e2e", "lib", "diff-test-selector.js");

/**
 * Read FILE_TO_ROUTE from diff-test-selector.js and return its mapped directories.
 */
function getMappedDirectories() {
  try {
    const src = fs.readFileSync(DIFF_TEST_SELECTOR_PATH, "utf-8");
    const mapped = new Set();
    // Match keys like "app/admin/people": or "app/mocs":
    const keyRe = /^\s*"(app\/[^"]+)":/gm;
    let m;
    while ((m = keyRe.exec(src)) !== null) {
      mapped.add(m[1]);
    }
    return mapped;
  } catch {
    return new Set();
  }
}

/**
 * Generate a FILE_TO_ROUTE entry for an uncovered app directory.
 * Converts "app/contact" → `"app/contact": ["/contact"],`
 */
function generateRouteEntry(appDir, route) {
  return `  "${appDir}": ["${route}"],`;
}

/**
 * Auto-update FILE_TO_ROUTE in diff-test-selector.js with uncovered route mappings.
 * Reads the file, finds the closing `};` of the FILE_TO_ROUTE object, and inserts
 * new entries before it.
 *
 * @param {Array<{route: string}>} uncoveredRoutes - Routes missing from FILE_TO_ROUTE
 * @returns {{added: number, entries: string[]}} - Number of entries added
 */
function updateFileToRoute(uncoveredRoutes) {
  const src = fs.readFileSync(DIFF_TEST_SELECTOR_PATH, "utf-8");
  const mapped = getMappedDirectories();
  const newEntries = [];

  for (const item of uncoveredRoutes) {
    // Convert route back to app directory: /admin/people → app/admin/people
    let appDir;
    if (item.route.startsWith("/api/")) {
      appDir = "app" + item.route;
    } else {
      appDir = "app" + item.route;
    }

    // Skip if already mapped or if it's a sub-path of a mapped directory
    if (mapped.has(appDir)) {
      continue;
    }

    // Check if a parent is already mapped (e.g., "app/admin" covers "app/admin/people")
    let parentMapped = false;
    for (const existing of mapped) {
      if (appDir.startsWith(existing + "/")) {
        parentMapped = true;
        break;
      }
    }
    // Even if parent is mapped, it may not include this specific route — add it
    // But skip if this exact directory is already there
    if (parentMapped) {
      continue;
    }

    newEntries.push(generateRouteEntry(appDir, item.route));
    mapped.add(appDir);
  }

  if (newEntries.length === 0) {
    return { added: 0, entries: [] };
  }

  // Find the closing `};` of FILE_TO_ROUTE object
  // The object starts with `const FILE_TO_ROUTE = {` and ends with `};`
  const objStartIdx = src.indexOf("const FILE_TO_ROUTE = {");
  if (objStartIdx === -1) {
    console.warn("[discover-routes] Could not find FILE_TO_ROUTE in diff-test-selector.js");
    return { added: 0, entries: [] };
  }

  // Find the matching closing `};` — count braces
  let braceDepth = 0;
  let closeIdx = -1;
  for (let i = src.indexOf("{", objStartIdx); i < src.length; i++) {
    if (src[i] === "{") {
      braceDepth++;
    }
    if (src[i] === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        closeIdx = i;
        break;
      }
    }
  }

  if (closeIdx === -1) {
    console.warn("[discover-routes] Could not find closing brace for FILE_TO_ROUTE");
    return { added: 0, entries: [] };
  }

  // Insert new entries before the closing `}`
  const insertion = "\n  // Auto-discovered routes\n" + newEntries.join("\n") + "\n";
  const updated = src.slice(0, closeIdx) + insertion + src.slice(closeIdx);
  fs.writeFileSync(DIFF_TEST_SELECTOR_PATH, updated);

  return { added: newEntries.length, entries: newEntries };
}

// ---------------------------------------------------------------------------
// Main (updated for --fix with FILE_TO_ROUTE update)
// ---------------------------------------------------------------------------

// Guard main() for import usage
if (require.main === module) {
  main();
}

module.exports = { discoverRoutes, findUncoveredRoutes, inferFeatureKey, loadManifest, getManifestPages, updateFileToRoute, getMappedDirectories };
