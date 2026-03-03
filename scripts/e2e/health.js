#!/usr/bin/env node

/**
 * E2E Testing System Health Check
 *
 * Verifies that all components of the E2E testing infrastructure are
 * present and properly configured. Outputs a pass/fail checklist with
 * fix suggestions for any failures.
 *
 * Usage:
 *   node scripts/e2e/health.js
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

// ---------------------------------------------------------------------------
// Resolve project root by walking up from __dirname until we find package.json
// ---------------------------------------------------------------------------

function findProjectRoot(dir) {
  let current = dir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  // Fallback: two levels up from scripts/e2e/
  return path.resolve(__dirname, "..", "..");
}

const ROOT = findProjectRoot(__dirname);

// ---------------------------------------------------------------------------
// Color helpers (ANSI, no dependencies)
// ---------------------------------------------------------------------------

const supportsColor =
  process.stdout.isTTY && !process.env.NO_COLOR;

const green = (s) => (supportsColor ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (supportsColor ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s) => (supportsColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (supportsColor ? `\x1b[1m${s}\x1b[0m` : s);

const PASS = green("  [PASS]");
const FAIL = red("  [FAIL]");

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

const results = [];

function pass(label, detail) {
  results.push({ ok: true, label });
  console.log(`${PASS} ${label}${detail ? dim(`  (${detail})`) : ""}`);
}

function fail(label, suggestion) {
  results.push({ ok: false, label });
  console.log(`${FAIL} ${label}`);
  if (suggestion) {
    console.log(red(`         -> ${suggestion}`));
  }
}

// ---------------------------------------------------------------------------
// Env var loader (reads .env.local and e2e/.env without dotenv)
// ---------------------------------------------------------------------------

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const vars = {};
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

// ---------------------------------------------------------------------------
// HTTP fetch helper (Node built-in, no external deps)
// ---------------------------------------------------------------------------

function httpGet(url, timeoutMs = 5000) {
  const client = url.startsWith("https") ? https : http;
  return new Promise((resolve) => {
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      resolve({ ok: true, status: res.statusCode });
      res.resume(); // drain
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
  });
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkPoolAccounts() {
  const label = "Pool accounts (e2e/pool-config.json)";
  const configPath = path.join(ROOT, "e2e", "pool-config.json");

  if (!fs.existsSync(configPath)) {
    fail(
      label,
      "Run: node scripts/e2e/pool.js --count 4  (creates pool accounts and writes pool-config.json)"
    );
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const entries = Array.isArray(data) ? data : data.entries || data.pairs || data.accounts || [];
    if (entries.length === 0) {
      fail(
        label,
        "pool-config.json exists but has no entries. Run: node scripts/e2e/pool.js --count 4"
      );
      return;
    }
    pass(label, `${entries.length} pool entry(ies)`);
  } catch (e) {
    fail(label, `pool-config.json is not valid JSON: ${e.message}`);
  }
}

function checkManifest() {
  const label = "Manifest (e2e/state/manifest.json)";
  const manifestPath = path.join(ROOT, "e2e", "state", "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    fail(
      label,
      "Run: node scripts/e2e/sync-manifest.js  (generates the manifest from codebase)"
    );
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const hasFeatures = data.features && typeof data.features === "object";
    const hasRoles = data.roles && typeof data.roles === "object";

    if (!hasFeatures || !hasRoles) {
      const missing = [];
      if (!hasFeatures) { missing.push("features"); }
      if (!hasRoles) { missing.push("roles"); }
      fail(
        label,
        `manifest.json is missing key(s): ${missing.join(", ")}. Run: node scripts/e2e/sync-manifest.js`
      );
      return;
    }

    const featureCount = Object.keys(data.features).length;
    const roleCount = Object.keys(data.roles).length;

    if (featureCount < 10) {
      fail(label, `Only ${featureCount} features in manifest — expected at least 10. Run: node scripts/e2e/sync-manifest.js`);
      return;
    }

    pass(label, `${featureCount} features, ${roleCount} roles`);
  } catch (e) {
    fail(label, `manifest.json is not valid JSON: ${e.message}`);
  }
}

function checkJitPrompt() {
  const label = "JiT prompt (e2e/jit/prompts/generate-test.txt)";
  const promptPath = path.join(ROOT, "e2e", "jit", "prompts", "generate-test.txt");

  if (!fs.existsSync(promptPath)) {
    fail(
      label,
      "Missing JiT prompt file. Ensure e2e/jit/prompts/generate-test.txt exists in the repo."
    );
    return;
  }

  const stat = fs.statSync(promptPath);
  if (stat.size === 0) {
    fail(label, "JiT prompt file is empty. It should contain the test generation prompt template.");
    return;
  }

  pass(label, `${stat.size} bytes`);
}

function checkOracleApiKey() {
  const label = "Oracle API key (OPENAI_API_KEY)";

  // Check process.env first
  if (process.env.OPENAI_API_KEY) {
    pass(label, "set in environment");
    return;
  }

  // Try .env.local at project root
  const envLocal = loadEnvFile(path.join(ROOT, ".env.local"));
  if (envLocal.OPENAI_API_KEY) {
    pass(label, "found in .env.local");
    return;
  }

  // Try e2e/.env
  const e2eEnv = loadEnvFile(path.join(ROOT, "e2e", ".env"));
  if (e2eEnv.OPENAI_API_KEY) {
    pass(label, "found in e2e/.env");
    return;
  }

  fail(
    label,
    "Set OPENAI_API_KEY in .env.local or e2e/.env as emergency fallback. The oracle uses Gemini 2.5 Flash for all oracle checks (OpenAI emergency fallback only)."
  );
}

function checkGeminiApiKey() {
  const label = "Gemini API key (GEMINI_API_KEY)";

  if (process.env.GEMINI_API_KEY) {
    pass(label, "set in environment");
    return;
  }

  const envLocal = loadEnvFile(path.join(ROOT, ".env.local"));
  if (envLocal.GEMINI_API_KEY) {
    pass(label, "found in .env.local");
    return;
  }

  const e2eEnv = loadEnvFile(path.join(ROOT, "e2e", ".env"));
  if (e2eEnv.GEMINI_API_KEY) {
    pass(label, "found in e2e/.env");
    return;
  }

  fail(
    label,
    "Set GEMINI_API_KEY in .env.local. The oracle routes HIGH/LOW checks to Gemini Flash (cheaper than OpenAI)."
  );
}

function checkPersonaSpecs() {
  const label = "Persona specs (e2e/tests/personas/*.spec.ts)";
  const personasDir = path.join(ROOT, "e2e", "tests", "personas");

  if (!fs.existsSync(personasDir)) {
    fail(label, "Directory e2e/tests/personas/ does not exist.");
    return;
  }

  const specFiles = fs
    .readdirSync(personasDir)
    .filter((f) => f.endsWith(".spec.ts"));

  if (specFiles.length === 0) {
    fail(label, "No .spec.ts files found in e2e/tests/personas/.");
    return;
  }

  const issues = [];
  for (const file of specFiles) {
    const filePath = path.join(personasDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes("test.describe")) {
      issues.push(file);
    }
  }

  if (issues.length > 0) {
    fail(
      label,
      `${issues.length} spec(s) missing test.describe: ${issues.slice(0, 5).join(", ")}${issues.length > 5 ? "..." : ""}`
    );
    return;
  }

  pass(label, `${specFiles.length} spec files, all contain test.describe`);
}

function checkGuardrails() {
  const label = "Guardrails (e2e/state/guardrails.json)";
  const guardrailsPath = path.join(ROOT, "e2e", "state", "guardrails.json");

  if (!fs.existsSync(guardrailsPath)) {
    fail(
      label,
      "Run: node scripts/e2e/guardrails.js  (generates guardrails.json)"
    );
    return;
  }

  try {
    JSON.parse(fs.readFileSync(guardrailsPath, "utf-8"));
    pass(label);
  } catch (e) {
    fail(label, `guardrails.json is not valid JSON: ${e.message}`);
  }
}

async function checkServer() {
  const baseUrl = getResolvedBaseUrl();
  const lower = baseUrl.toLowerCase();
  const isLocal = lower.includes("localhost") || lower.includes("127.0.0.1");

  if (isLocal) {
    const label = "Dev server (localhost)";
    const result = await httpGet("http://localhost:3000");
    if (result.ok) {
      pass(label, `status ${result.status}`);
    } else {
      fail(
        label,
        `Server not reachable (${result.error}). Run: npm run dev  (or npm run build && npm start)`
      );
    }
  } else {
    const label = "Target URL (production)";
    const result = await httpGet(baseUrl);
    if (result.ok) {
      pass(label, `status ${result.status}`);
    } else {
      fail(label, `Target not reachable (${result.error})`);
    }
  }
}

function checkInvariants() {
  const label = "Invariants (e2e/invariants/index.ts)";
  const invariantsPath = path.join(ROOT, "e2e", "invariants", "index.ts");

  if (!fs.existsSync(invariantsPath)) {
    fail(
      label,
      "Missing e2e/invariants/index.ts. This file defines shared test invariants for persona specs."
    );
    return;
  }

  pass(label);
}

function checkOraclePrompts() {
  const label = "Oracle prompts (e2e/oracle/prompts/)";
  const promptsDir = path.join(ROOT, "e2e", "oracle", "prompts");

  if (!fs.existsSync(promptsDir)) {
    fail(label, "Directory e2e/oracle/prompts/ does not exist.");
    return;
  }

  const files = fs.readdirSync(promptsDir).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return ext === ".txt" || ext === ".md" || ext === ".prompt";
  });

  if (files.length < 4) {
    fail(
      label,
      `Found ${files.length} prompt file(s), need at least 4. Expected: page-semantics, permission-ui-enforcement, data-isolation, api-response-validation.`
    );
    return;
  }

  pass(label, `${files.length} prompt files`);
}

// ---------------------------------------------------------------------------
// Build Spec & Improvement System checks
// ---------------------------------------------------------------------------

function checkBuildSpec() {
  const label = "Build spec (docs/BUILD-SPEC.md)";
  const specPath = path.join(ROOT, "docs", "BUILD-SPEC.md");

  if (!fs.existsSync(specPath)) {
    fail(label, "docs/BUILD-SPEC.md does not exist. Run: create living build spec.");
    return;
  }

  const content = fs.readFileSync(specPath, "utf-8");
  const hasSmeSection = content.includes("SME Intent");
  const hasProtected = content.includes("Protected SME Decisions");
  const hasAttribution = content.includes("Change Attribution Log");

  if (!hasSmeSection || !hasProtected || !hasAttribution) {
    const missing = [];
    if (!hasSmeSection) missing.push("SME Intent columns");
    if (!hasProtected) missing.push("Protected SME Decisions");
    if (!hasAttribution) missing.push("Change Attribution Log");
    fail(label, `Missing sections: ${missing.join(", ")}`);
    return;
  }

  pass(label, `${Math.round(content.length / 1024)}KB, has SME tracking`);
}

function checkSpecChangeGuard() {
  const label = "Spec change guard (scripts/e2e/spec-change-guard.js)";
  const scriptPath = path.join(ROOT, "scripts", "e2e", "spec-change-guard.js");

  if (!fs.existsSync(scriptPath)) {
    fail(label, "spec-change-guard.js missing. Creates spec impact warnings.");
    return;
  }

  pass(label, "present");
}

function checkImprovementReport() {
  const label = "Improvement report (scripts/e2e/improvement-report.js)";
  const scriptPath = path.join(ROOT, "scripts", "e2e", "improvement-report.js");

  if (!fs.existsSync(scriptPath)) {
    fail(label, "improvement-report.js missing. Aggregates persona improvement suggestions.");
    return;
  }

  // Check if product-improvement oracle prompt exists
  const promptPath = path.join(ROOT, "e2e", "oracle", "prompts", "product-improvement.txt");
  if (!fs.existsSync(promptPath)) {
    fail(label, "product-improvement.txt oracle prompt missing.");
    return;
  }

  pass(label, "report + oracle prompt present");
}

function checkVisualSpec() {
  const label = "Visual spec (docs/visual-spec/VISUAL-SPEC.md)";
  const specPath = path.join(ROOT, "docs", "visual-spec", "VISUAL-SPEC.md");
  const statePath = path.join(ROOT, "e2e", "state", "visual-spec.json");

  if (!fs.existsSync(specPath)) {
    fail(label, "Not generated yet. Run: node scripts/e2e/visual-spec-generator.js");
    return;
  }

  const mtime = fs.statSync(specPath).mtime.getTime();
  const ageHours = Math.round((Date.now() - mtime) / 3600000);

  const hasJson = fs.existsSync(statePath);
  if (ageHours > 48) {
    fail(label, `stale (${ageHours}h old). Run: node scripts/e2e/visual-spec-generator.js`);
  } else {
    pass(label, `${ageHours}h old${hasJson ? ", persona JSON present" : ""}`);
  }
}

const DEFAULT_BASE_URL = "https://moc-ai.vercel.app";

function checkCpPersonasDeptHead() {
  const label = "cp-personas-dept-head";
  try {
    const personasPath = path.join(ROOT, "e2e", "fixtures", "personas.ts");
    const content = fs.readFileSync(personasPath, "utf-8");
    const cpPersonas = ["CP_QA", "CP_PRODUCT", "CP_SECURITY", "CP_DEVOPS", "CP_DESIGN"];
    const notDeptHead = [];
    for (const name of cpPersonas) {
      // Find the persona definition and check its role
      const regex = new RegExp(`export const ${name}[\\s\\S]*?role:\\s*"([^"]+)"`, "m");
      const match = content.match(regex);
      if (match && match[1] !== "dept_head") {
        notDeptHead.push(`${name} is "${match[1]}"`);
      }
    }
    if (notDeptHead.length > 0) {
      fail(label, `These CP personas should be dept_head: ${notDeptHead.join(", ")}`);
    } else {
      pass(label, `All 5 CP reviewer personas are dept_head`);
    }
  } catch (e) {
    fail(label, `Could not read personas.ts: ${e.message}`);
  }
}

function checkFindingsToMocsWired() {
  const label = "findings-to-mocs-wired";
  try {
    // findings-to-mocs is wired via the daemon's finding-pipeline claw (not legacy run-loop-hooks)
    const clawPath = path.join(ROOT, "scripts", "e2e", "claws", "finding-pipeline.js");
    const content = fs.readFileSync(clawPath, "utf-8");
    if (content.includes("findings-to-mocs")) {
      pass(label, "findings-to-mocs wired in finding-pipeline claw");
    } else {
      fail(label, "findings-to-mocs.js not wired into finding-pipeline claw");
    }
  } catch (e) {
    fail(label, `Could not read finding-pipeline.js: ${e.message}`);
  }
}

function checkBaseUrl() {
  const label = "BASE_URL";
  const baseUrl =
    process.env.BASE_URL ??
    loadEnvFile(path.join(ROOT, "e2e", ".env")).BASE_URL ??
    loadEnvFile(path.join(ROOT, ".env.local")).BASE_URL ??
    DEFAULT_BASE_URL;
  const lower = baseUrl.toLowerCase();
  const isProd =
    lower.includes("changepilot.com") ||
    lower.includes("vercel.app") ||
    (lower.includes("moc-ai") && lower.includes("vercel"));
  const isLocal = lower.includes("localhost") || lower.includes("127.0.0.1");
  if (isProd) {
    pass(label, `production (${baseUrl})`);
  } else if (isLocal) {
    pass(label, `local (${baseUrl})`);
  } else {
    pass(label, baseUrl);
  }
}

function getResolvedBaseUrl() {
  return (
    process.env.BASE_URL ??
    loadEnvFile(path.join(ROOT, "e2e", ".env")).BASE_URL ??
    loadEnvFile(path.join(ROOT, ".env.local")).BASE_URL ??
    DEFAULT_BASE_URL
  );
}

// ---------------------------------------------------------------------------
// Infrastructure Wiring Guard
// Prevents built E2E tools from silently going unused (regression detection)
// ---------------------------------------------------------------------------

function countSpecsMatching(pattern) {
  const personasDir = path.join(ROOT, "e2e", "tests", "personas");
  if (!fs.existsSync(personasDir)) {
    return { count: 0, files: [] };
  }
  const specFiles = fs.readdirSync(personasDir).filter((f) => f.endsWith(".spec.ts"));
  const matching = [];
  for (const file of specFiles) {
    const content = fs.readFileSync(path.join(personasDir, file), "utf-8");
    if (pattern.test(content)) {
      matching.push(file);
    }
  }
  return { count: matching.length, files: matching };
}

function checkWiringUIJourney() {
  const label = "Wiring: UIJourney used in persona specs";
  const { count } = countSpecsMatching(/UIJourney|ui-journey/);
  if (count < 30) {
    fail(label, `Only ${count} spec(s) use UIJourney. Min 30 expected (exploration + interactive tests).`);
  } else {
    pass(label, `${count} specs use UIJourney`);
  }
}

function checkWiringExploration() {
  const label = "Wiring: exploratory navigation across personas";
  const { count } = countSpecsMatching(/journey\.explore\(|exploratory navigation/);
  if (count < 30) {
    fail(label, `Only ${count} spec(s) have exploration tests. Min 30 expected.`);
  } else {
    pass(label, `${count} specs have exploration tests`);
  }
}

function checkWiringSelectors() {
  const label = "Wiring: selectors.ts exists and exported";
  const selectorsPath = path.join(ROOT, "e2e", "lib", "selectors.ts");
  if (!fs.existsSync(selectorsPath)) {
    fail(label, "e2e/lib/selectors.ts missing. Consolidated selector library deleted?");
    return;
  }
  const content = fs.readFileSync(selectorsPath, "utf-8");
  const exportCount = (content.match(/export function /g) || []).length;
  if (exportCount < 5) {
    fail(label, `Only ${exportCount} exported functions. Expected 5+. Selectors may have been gutted.`);
  } else {
    pass(label, `${exportCount} exported selector helpers`);
  }
}

function checkWiringEvaluateImprovements() {
  const label = "Wiring: evaluateImprovements() called across personas";
  const { count } = countSpecsMatching(/evaluateImprovements\s*\(/);
  if (count < 50) {
    fail(label, `Only ${count} spec(s) call evaluateImprovements. Min 50 expected for UX coverage.`);
  } else {
    pass(label, `${count} specs call evaluateImprovements`);
  }
}

function checkWiringVisionOracle() {
  const label = "Wiring: validateScreenshotWithVision() called across personas";
  const { count } = countSpecsMatching(/validateScreenshotWithVision\s*\(/);
  if (count < 8) {
    fail(label, `Only ${count} spec(s) use vision oracle. Min 8 expected.`);
  } else {
    pass(label, `${count} specs use vision oracle`);
  }
}

function checkWiringObserveFeedback() {
  const label = "Wiring: observeAndGenerateFeedback() called across personas";
  const { count } = countSpecsMatching(/observeAndGenerateFeedback\s*\(/);
  if (count < 5) {
    fail(label, `Only ${count} spec(s) use observation feedback. Min 5 expected.`);
  } else {
    pass(label, `${count} specs use observation feedback`);
  }
}

function checkNoDeadFrameworks() {
  const label = "Wiring: no dead frameworks re-introduced";
  const deadPatterns = [
    { name: "persona-hooks.ts", path: path.join(ROOT, "e2e", "lib", "persona-hooks.ts") },
    { name: "hook-registry.json", path: path.join(ROOT, "e2e", "state", "hook-registry.json") },
  ];
  const zombies = deadPatterns.filter((p) => fs.existsSync(p.path));
  if (zombies.length > 0) {
    fail(label, `Dead frameworks resurrected: ${zombies.map((z) => z.name).join(", ")}. These were deleted intentionally.`);
  } else {
    pass(label, "no zombie frameworks detected");
  }

  // Also check no persona spec imports persona-hooks
  const { count, files } = countSpecsMatching(/persona-hooks/);
  if (count > 0) {
    fail(
      `Wiring: persona-hooks not imported in specs`,
      `${count} spec(s) still reference persona-hooks: ${files.slice(0, 3).join(", ")}. Remove dead imports.`
    );
  }
}

function checkWiringFeatureTemplate() {
  const label = "Wiring: feature-persona template has interactive tests";
  const templatePath = path.join(ROOT, "e2e", "templates", "feature-persona.template.ts");
  if (!fs.existsSync(templatePath)) {
    fail(label, "e2e/templates/feature-persona.template.ts missing.");
    return;
  }
  const content = fs.readFileSync(templatePath, "utf-8");
  const hasUIJourney = /UIJourney/.test(content);
  const hasActions = /FEATURE_TEST_ACTIONS/.test(content);
  const hasInteractive = /clickButton|fillFields|checkButtons/.test(content);
  if (!hasUIJourney || !hasActions || !hasInteractive) {
    const missing = [];
    if (!hasUIJourney) missing.push("UIJourney import");
    if (!hasActions) missing.push("FEATURE_TEST_ACTIONS map");
    if (!hasInteractive) missing.push("interactive test fields");
    fail(label, `Template missing: ${missing.join(", ")}. Interactive test generation degraded.`);
  } else {
    pass(label, "UIJourney + FEATURE_TEST_ACTIONS + interactive fields present");
  }
}

function checkWiringInteractiveTests() {
  const label = "Wiring: interactive UIJourney form tests across personas";
  const { count } = countSpecsMatching(/startFrictionTracking\s*\(/);
  if (count < 40) {
    fail(label, `Only ${count} spec(s) have interactive form tests. Min 40 expected.`);
  } else {
    pass(label, `${count} specs have interactive form tests`);
  }
}

// ---------------------------------------------------------------------------
// Orphaned Route Detection — find app routes not covered by any persona test
// ---------------------------------------------------------------------------

function checkOrphanedRoutes() {
  const label = "Route coverage: no orphaned app routes";

  // 1. Discover all Next.js page routes from app/ directory
  const appDir = path.join(ROOT, "app");
  if (!fs.existsSync(appDir)) {
    fail(label, "app/ directory not found");
    return;
  }

  const appRoutes = [];
  function scanDir(dir, routePrefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip API routes and layout-only directories
        if (entry.name === "api") {
          continue;
        }
        const segment = entry.name.startsWith("(")
          ? "" // Route groups don't add segments
          : `/${entry.name.replace(/\[(.+?)\]/g, ":$1")}`;
        scanDir(fullPath, routePrefix + segment);
      } else if (entry.name === "page.tsx" || entry.name === "page.ts") {
        appRoutes.push(routePrefix || "/");
      }
    }
  }
  scanDir(appDir, "");

  if (appRoutes.length === 0) {
    pass(label, "no routes found (unexpected)");
    return;
  }

  // 2. Collect routes referenced in persona specs and manifest
  const coveredRoutes = new Set();

  // From manifest pages
  const manifestPath = path.join(ROOT, "e2e", "state", "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      for (const feature of Object.values(manifest.features || {})) {
        for (const page of (feature.pages || [])) {
          coveredRoutes.add(page.replace(/\[(.+?)\]/g, ":$1"));
        }
      }
    } catch {
      // skip
    }
  }

  // From all spec files (personas + top-level e2e/tests/)
  const specDirs = [
    path.join(ROOT, "e2e", "tests", "personas"),
    path.join(ROOT, "e2e", "tests"),
  ];
  for (const specDir of specDirs) {
    if (!fs.existsSync(specDir)) continue;
    const specFiles = fs.readdirSync(specDir).filter((f) => f.endsWith(".spec.ts"));
    for (const file of specFiles) {
      const content = fs.readFileSync(path.join(specDir, file), "utf-8");
      // Match paths in goto, tryAccessPage, navigateTo, and route strings
      const pathMatches = content.match(/(?:goto|tryAccessPage|navigateTo)\s*\(\s*["'`]([^"'`]+)["'`]/g) || [];
      for (const match of pathMatches) {
        const routeMatch = match.match(/["'`]([^"'`]+)["'`]/);
        if (routeMatch) {
          coveredRoutes.add(routeMatch[1].replace(/\[(.+?)\]/g, ":$1"));
        }
      }
      // Also match path strings in STATIC_ROUTES or route arrays
      const routeStrings = content.match(/path:\s*["'`]([^"'`]+)["'`]/g) || [];
      for (const match of routeStrings) {
        const routeMatch = match.match(/["'`]([^"'`]+)["'`]/);
        if (routeMatch) {
          coveredRoutes.add(routeMatch[1]);
        }
      }
    }
  }

  // 3. Find orphaned routes (in app but not in any test or manifest)
  // Normalize: remove dynamic segments for comparison
  function normalizeRoute(r) {
    return r.replace(/:[^/]+/g, ":id").replace(/\/+$/, "") || "/";
  }

  const normalizedCovered = new Set([...coveredRoutes].map(normalizeRoute));

  // Exclude routes that are inherently internal/non-testable
  const EXCLUDE_PATTERNS = [
    "/login", "/signup", "/auth", "/verify", "/reset-password",
    "/enter-organization-key", "/not-found", "/error",
  ];

  const orphaned = appRoutes.filter((route) => {
    const normalized = normalizeRoute(route);
    if (EXCLUDE_PATTERNS.some((ex) => normalized.startsWith(ex))) {
      return false;
    }
    // Check if any covered route matches (prefix match for dynamic routes)
    for (const covered of normalizedCovered) {
      if (normalized === covered || normalized.startsWith(covered + "/") || covered.startsWith(normalized + "/")) {
        return false;
      }
    }
    return true;
  });

  if (orphaned.length === 0) {
    pass(label, `${appRoutes.length} routes, all covered`);
  } else if (orphaned.length <= 5) {
    // Warn but don't fail for small gaps
    pass(label, `${appRoutes.length} routes, ${orphaned.length} orphaned: ${orphaned.join(", ")}`);
  } else {
    fail(
      label,
      `${orphaned.length}/${appRoutes.length} app routes have no persona test coverage: ${orphaned.slice(0, 8).join(", ")}${orphaned.length > 8 ? "..." : ""}`
    );
  }
}

function checkUIInteractionCoverage() {
  const label = "UI Coverage: personas with real form interaction (fill/click)";
  const personasDir = path.join(ROOT, "e2e", "tests", "personas");
  if (!fs.existsSync(personasDir)) {
    fail(label, "e2e/tests/personas/ not found");
    return;
  }

  const specs = fs.readdirSync(personasDir).filter((f) => f.endsWith(".spec.ts"));
  const uiInteractionPatterns = /page\.fill\s*\(|page\.click\s*\(|page\.check\s*\(|page\.selectOption\s*\(|journey\.fillInput\s*\(|journey\.fillTextarea\s*\(|journey\.clickButton\s*\(|journey\.fillForm\s*\(|journey\.fillAndAdvance|journey\.createMocViaUI|journey\.publishReviewPlanViaUI|journey\.fullMocCreationJourney|journey\.exploreWithLLM/;
  const apiOnlyPatterns = /sim\.apiRequest\s*\(|seedStage\d+Data\s*\(|advanceMocStage\s*\(|createMoc\s*\(/;
  const formPagePatterns = /\/capture|\/frame|\/hotspots|\/route|\/decide|\/execute|\/mocs\/new/;

  let uiInteractive = 0;
  let apiOnly = 0;
  const apiOnlySpecs = [];

  for (const specFile of specs) {
    const content = fs.readFileSync(path.join(personasDir, specFile), "utf-8");
    const hasUIInteraction = uiInteractionPatterns.test(content);
    const hasAPICall = apiOnlyPatterns.test(content);
    const visitsForms = formPagePatterns.test(content);

    if (hasUIInteraction) {
      uiInteractive++;
    } else if (hasAPICall && visitsForms) {
      // Visits form pages but never interacts with forms — gap
      apiOnly++;
      apiOnlySpecs.push(specFile.replace(".spec.ts", ""));
    }
  }

  const total = specs.length;
  const ratio = total > 0 ? Math.round((uiInteractive / total) * 100) : 0;

  if (uiInteractive < 10) {
    fail(
      label,
      `Only ${uiInteractive}/${total} personas (${ratio}%) have real UI interaction. ` +
        `${apiOnly} visit form pages but are API-only. ` +
        `Top gaps: ${apiOnlySpecs.slice(0, 5).join(", ")}. ` +
        `Add journey.fillInput/clickButton/fillAndAdvance* calls.`
    );
  } else {
    pass(label, `${uiInteractive}/${total} (${ratio}%) with UI interaction, ${apiOnly} API-only form visitors`);
  }
}

function checkMocUIFlowWiring() {
  const label = "Wiring: MOC UI flow methods used (createMocViaUI, fillAndAdvance*)";
  const { count } = countSpecsMatching(
    /createMocViaUI\s*\(|fillAndAdvanceCapture\s*\(|fillAndAdvanceFrame\s*\(|fillAndAdvanceHotspots\s*\(|publishReviewPlanViaUI\s*\(|fullMocCreationJourney\s*\(/
  );
  if (count < 1) {
    fail(label, `No specs use MOC UI flow methods. Wire cp-meta or workflow personas to use them.`);
  } else {
    pass(label, `${count} spec(s) use MOC UI flow methods`);
  }
}

function checkLLMGuidedExploration() {
  const label = "Wiring: LLM-guided exploration (exploreWithLLM) used";
  const { count } = countSpecsMatching(/exploreWithLLM\s*\(/);
  if (count < 3) {
    fail(label, `Only ${count} spec(s) use LLM-guided exploration. Min 3 expected for deep coverage.`);
  } else {
    pass(label, `${count} specs use LLM-guided exploration`);
  }
}

function checkOracleEffectiveness() {
  const label = "Oracle effectiveness (skip rate from last run)";
  const runLogPath = path.join(ROOT, "e2e", "state", "run-log.jsonl");

  if (!fs.existsSync(runLogPath)) {
    pass(label, "no run log yet (first run)");
    return;
  }

  try {
    const lines = fs.readFileSync(runLogPath, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      pass(label, "no run entries yet");
      return;
    }

    // Read last entry
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    const oracleStats = lastEntry.oracleStats;

    if (!oracleStats) {
      pass(label, "last run has no oracle stats (pre-tracking)");
      return;
    }

    const total = (oracleStats.validated || 0) + (oracleStats.skipped || 0);
    if (total === 0) {
      pass(label, "no oracle calls in last run");
      return;
    }

    const skipRate = Math.round(((oracleStats.skipped || 0) / total) * 100);
    if (skipRate > 50) {
      fail(
        label,
        `${skipRate}% oracle checks skipped in last run (${oracleStats.skipped}/${total}). ` +
        `Check OPENAI_API_KEY and token budget. Reasons: ${JSON.stringify(oracleStats.skipReasons || {})}`
      );
    } else {
      pass(label, `${oracleStats.validated} validated, ${oracleStats.skipped} skipped (${skipRate}% skip rate)`);
    }
  } catch (e) {
    pass(label, `could not parse run log: ${e.message}`);
  }
}

function checkUIFormInteractionCoverage() {
  const label = "UI form coverage: personas with fillInput/clickButton/createMocViaUI";
  const personasDir = path.join(ROOT, "e2e", "tests", "personas");
  if (!fs.existsSync(personasDir)) {
    fail(label, "e2e/tests/personas/ not found");
    return;
  }

  const pattern = /journey\.fillInput|journey\.clickButton|journey\.createMocViaUI|journey\.fillAndAdvance|journey\.fillForm|journey\.exploreWithLLM/;
  const specs = fs.readdirSync(personasDir).filter((f) => f.endsWith(".spec.ts"));
  const matching = specs.filter((f) => {
    const content = fs.readFileSync(path.join(personasDir, f), "utf-8");
    return pattern.test(content);
  });

  if (matching.length < 7) {
    fail(label, `Only ${matching.length} personas have real UI form interaction. Target: >= 7.`);
  } else {
    pass(label, `${matching.length} personas with UI form interaction`);
  }
}

function checkFrictionRegressionWired() {
  const label = "Wiring: friction regression generates findings";
  const simPath = path.join(ROOT, "e2e", "fixtures", "simulation.ts");
  if (!fs.existsSync(simPath)) {
    fail(label, "simulation.ts not found");
    return;
  }
  const content = fs.readFileSync(simPath, "utf-8");
  if (content.includes("frictionResult.regressed") && content.includes("Workflow Friction Regression")) {
    pass(label, "friction regression triggers reportFinding()");
  } else {
    fail(label, "recordFrictionResult() return value not wired to reportFinding(). Friction regressions are silently lost.");
  }
}

function checkHotspotSuggestionsWired() {
  const label = "Wiring: hotspot suggestions exposed via SimulationManager";
  const simPath = path.join(ROOT, "e2e", "fixtures", "simulation.ts");
  if (!fs.existsSync(simPath)) {
    fail(label, "simulation.ts not found");
    return;
  }
  const content = fs.readFileSync(simPath, "utf-8");
  const hasMethod = content.includes("getHotspotSuggestions(") && content.includes("getSuggestedExploration(");
  const hasTopHotspots = content.includes("getTopHotspots(");
  if (hasMethod && hasTopHotspots) {
    pass(label, "getHotspotSuggestions() and getTopHotspots() are public methods");
  } else {
    fail(label, "getSuggestedExploration/getTopHotspots imported but not exposed as public methods. Dead imports.");
  }
}

function checkCoverageGapsWired() {
  const label = "Wiring: coverage gaps from persona-learner exposed";
  const simPath = path.join(ROOT, "e2e", "fixtures", "simulation.ts");
  if (!fs.existsSync(simPath)) {
    fail(label, "simulation.ts not found");
    return;
  }
  const content = fs.readFileSync(simPath, "utf-8");
  if (content.includes("getCoverageGaps(") && content.includes("suggestNewAreas(")) {
    pass(label, "getCoverageGaps() wraps suggestNewAreas()");
  } else {
    fail(label, "suggestNewAreas() imported but never called. Dead import in simulation.ts.");
  }
}

function checkExploreUsesHotspots() {
  const label = "Wiring: UIJourney.explore() prioritizes hotspot suggestions";
  const journeyPath = path.join(ROOT, "e2e", "lib", "ui-journey.ts");
  if (!fs.existsSync(journeyPath)) {
    fail(label, "ui-journey.ts not found");
    return;
  }
  const content = fs.readFileSync(journeyPath, "utf-8");
  if (content.includes("getHotspotSuggestions")) {
    pass(label, "explore() uses hotspot suggestions for page prioritization");
  } else {
    fail(label, "UIJourney.explore() picks pages randomly without hotspot intelligence. Wire getHotspotSuggestions().");
  }
}

function checkOrphanedStateFiles() {
  const label = "Intelligence: no orphaned state files (written but never consumed)";

  // Every intelligence state file must have BOTH a writer (scripts/e2e/*.js)
  // AND a consumer (code that reads it and changes behavior).
  // The consumer is e2e/lib/intelligence-consumer.ts which reads all state files
  // and exports decision functions used by the test framework.
  const INTELLIGENCE_STATE_FILES = [
    { file: "thompson-selection.json", writer: "thompson-selector.js", consumer: "intelligence-consumer.ts" },
    { file: "persona-drives.json", writer: "homeostatic-update.js", consumer: "intelligence-consumer.ts" },
    { file: "persona-hibernation.json", writer: "homeostatic-update.js", consumer: "intelligence-consumer.ts" },
    { file: "aco-graph.json", writer: "aco-path-selector.js", consumer: "intelligence-consumer.ts" },
    { file: "curiosity-model.json", writer: "curiosity-engine.js", consumer: "intelligence-consumer.ts" },
    { file: "foraging-model.json", writer: "foraging-decisions.js", consumer: "intelligence-consumer.ts" },
    { file: "waggle-signals.json", writer: "waggle-broadcast.js", consumer: "intelligence-consumer.ts" },
    { file: "marl-qtable.json", writer: "marl-update.js", consumer: "intelligence-consumer.ts" },
    { file: "strategy-library.json", writer: "strategy-distillation.js", consumer: "intelligence-consumer.ts" },
    { file: "experience-replay.json", writer: "marl-update.js", consumer: "intelligence-consumer.ts" },
    { file: "memory-longterm.json", writer: "memory-consolidation.js", consumer: "intelligence-consumer.ts" },
    { file: "memory-working.json", writer: "memory-consolidation.js", consumer: "intelligence-consumer.ts" },
    { file: "memory-sensory.json", writer: "memory-consolidation.js", consumer: "intelligence-consumer.ts" },
    { file: "mutation-plan.json", writer: "mutation-testing.js", consumer: "select-tests-by-learning.js" },
    { file: "causal-analysis.json", writer: "causal-analysis.js", consumer: "select-tests-by-learning.js" },
    { file: "persona-learning.json", writer: "persona-learner.ts", consumer: "persona-learner.ts" },
    { file: "green-history.json", writer: "green-tracker.ts", consumer: "green-tracker.ts" },
    { file: "hotspot-map.json", writer: "aco-path-selector.js", consumer: "simulation.ts" },
    { file: "explored-paths.json", writer: "orchestrator.js", consumer: "fuse-test-strategy.js" },
    { file: "fix-effectiveness.json", writer: "record-fix-effectiveness.js", consumer: "select-tests-by-learning.js" },
    { file: "fix-funnel.json", writer: "fix-funnel-dashboard.js", consumer: "orchestrator.js" },
    { file: "persona-roi.json", writer: "persona-roi-scorer.js", consumer: "fuse-test-strategy.js" },
    { file: "finding-themes.json", writer: "consolidate-themes.js", consumer: "findings-to-mocs.js" },
    { file: "discovery-samples.json", writer: "discovery-sampler.ts", consumer: "orchestrator.js" },
  ];

  const stateDir = path.join(ROOT, "e2e", "state");
  const libDir = path.join(ROOT, "e2e", "lib");
  const scriptsDir = path.join(ROOT, "scripts", "e2e");

  const orphans = [];
  const missingWriters = [];
  const missingConsumers = [];

  // Search multiple directories for .ts and .js files
  const searchDirs = [libDir, scriptsDir, path.join(ROOT, "e2e", "oracle"), path.join(ROOT, "e2e", "fixtures")];
  function findFile(filename) {
    for (const dir of searchDirs) {
      if (fs.existsSync(path.join(dir, filename))) { return true; }
    }
    return false;
  }

  for (const entry of INTELLIGENCE_STATE_FILES) {
    const stateExists = fs.existsSync(path.join(stateDir, entry.file));
    if (!stateExists) { continue; } // Skip files that don't exist yet

    // Check writer exists
    if (!findFile(entry.writer)) {
      missingWriters.push(`${entry.file} (writer: ${entry.writer})`);
    }

    // Check consumer exists
    if (!entry.consumer) {
      orphans.push(entry.file);
    } else if (!findFile(entry.consumer)) {
      missingConsumers.push(`${entry.file} (consumer: ${entry.consumer})`);
    }
  }

  if (orphans.length > 0) {
    fail(label, `${orphans.length} orphaned state file(s) with no consumer: ${orphans.join(", ")}. Add to intelligence-consumer.ts.`);
  } else if (missingWriters.length > 0 || missingConsumers.length > 0) {
    const issues = [...missingWriters.map(w => `writer missing: ${w}`), ...missingConsumers.map(c => `consumer missing: ${c}`)];
    fail(label, issues.join("; "));
  } else {
    const consumed = INTELLIGENCE_STATE_FILES.filter(e => e.consumer && fs.existsSync(path.join(stateDir, e.file))).length;
    pass(label, `${consumed} state files have active consumers`);
  }
}

function checkIntelligenceConsumerWired() {
  const label = "Intelligence: consumer wired into test framework";
  const consumerPath = path.join(ROOT, "e2e", "lib", "intelligence-consumer.ts");

  if (!fs.existsSync(consumerPath)) {
    fail(label, "e2e/lib/intelligence-consumer.ts missing. Intelligence outputs are orphaned.");
    return;
  }

  // Verify it's imported by the key integration points
  const integrations = [
    { file: "e2e/fixtures/test.ts", name: "test fixture" },
    { file: "e2e/modes/index.ts", name: "mode selector" },
    { file: "e2e/lib/ui-journey.ts", name: "UIJourney" },
  ];

  const wired = [];
  const missing = [];

  for (const integration of integrations) {
    const filePath = path.join(ROOT, integration.file);
    if (!fs.existsSync(filePath)) {
      missing.push(integration.name);
      continue;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.includes("intelligence-consumer")) {
      wired.push(integration.name);
    } else {
      missing.push(integration.name);
    }
  }

  if (missing.length > 0) {
    fail(label, `intelligence-consumer not imported by: ${missing.join(", ")}. Outputs are computed but unused.`);
  } else {
    pass(label, `wired into ${wired.join(", ")}`);
  }
}

function checkOrchestratorInLoop() {
  const label = "Intelligence: orchestrator called from loop.sh";
  const loopPath = path.join(ROOT, "scripts", "e2e", "loop.sh");

  if (!fs.existsSync(loopPath)) {
    fail(label, "scripts/e2e/loop.sh not found");
    return;
  }

  const content = fs.readFileSync(loopPath, "utf-8");
  const hasAfterTests = content.includes("run-loop-hooks.js after-tests");
  const hasAfterIteration = content.includes("run-loop-hooks.js after-iteration");

  if (!hasAfterTests && !hasAfterIteration) {
    fail(label, "loop.sh never calls run-loop-hooks.js. Intelligence systems (phases 2-5) are orphaned.");
  } else if (!hasAfterIteration) {
    fail(label, "loop.sh calls after-tests but not after-iteration. Phases 2-5 (intelligence) never run.");
  } else {
    pass(label, "after-tests + after-iteration hooks wired");
  }
}

// ---------------------------------------------------------------------------
// Pipeline Intelligence Checks (fix funnel, persona ROI, themes, discovery)
// ---------------------------------------------------------------------------

function checkFixFunnelDashboard() {
  const label = "Pipeline: fix-funnel-dashboard.js exists and wired";
  const scriptPath = path.join(ROOT, "scripts", "e2e", "fix-funnel-dashboard.js");

  if (!fs.existsSync(scriptPath)) {
    fail(label, "scripts/e2e/fix-funnel-dashboard.js missing. Creates pipeline funnel visibility.");
    return;
  }

  // Check orchestrator wiring
  const orchPath = path.join(ROOT, "scripts", "e2e", "orchestrator.js");
  if (fs.existsSync(orchPath)) {
    const orchContent = fs.readFileSync(orchPath, "utf-8");
    if (!orchContent.includes("fix-funnel-dashboard")) {
      fail(label, "Script exists but not wired into orchestrator.js. Add to Phase 2.");
      return;
    }
  }

  // Check state file validity if it exists
  const statePath = path.join(ROOT, "e2e", "state", "fix-funnel.json");
  if (fs.existsSync(statePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      if (!data.funnel || !data.conversionRates) {
        fail(label, "fix-funnel.json exists but missing funnel or conversionRates. Re-run dashboard.");
        return;
      }
      const e2e = ((data.conversionRates.end_to_end || 0) * 100).toFixed(0);
      pass(label, `wired, state valid (E2E rate: ${e2e}%)`);
    } catch {
      fail(label, "fix-funnel.json is not valid JSON.");
    }
  } else {
    pass(label, "wired (state not yet generated — run orchestrator)");
  }
}

function checkPersonaRoiScorer() {
  const label = "Pipeline: persona-roi-scorer.js exists and wired";
  const scriptPath = path.join(ROOT, "scripts", "e2e", "persona-roi-scorer.js");

  if (!fs.existsSync(scriptPath)) {
    fail(label, "scripts/e2e/persona-roi-scorer.js missing. Scores persona fix contribution.");
    return;
  }

  // Check orchestrator wiring
  const orchPath = path.join(ROOT, "scripts", "e2e", "orchestrator.js");
  if (fs.existsSync(orchPath)) {
    const orchContent = fs.readFileSync(orchPath, "utf-8");
    if (!orchContent.includes("persona-roi-scorer")) {
      fail(label, "Script exists but not wired into orchestrator.js. Add to Phase 2.");
      return;
    }
  }

  // Check state file validity
  const statePath = path.join(ROOT, "e2e", "state", "persona-roi.json");
  if (fs.existsSync(statePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      if (!data.tiers || !data.personas) {
        fail(label, "persona-roi.json missing tiers or personas. Re-run scorer.");
        return;
      }
      const highCount = (data.tiers["high-value"] || []).length;
      const totalPersonas = Object.keys(data.personas).length;
      pass(label, `wired, ${totalPersonas} personas scored (${highCount} high-value)`);
    } catch {
      fail(label, "persona-roi.json is not valid JSON.");
    }
  } else {
    pass(label, "wired (state not yet generated — run orchestrator)");
  }
}

function checkConsolidateThemes() {
  const label = "Pipeline: consolidate-themes.js exists and wired";
  const scriptPath = path.join(ROOT, "scripts", "e2e", "consolidate-themes.js");

  if (!fs.existsSync(scriptPath)) {
    fail(label, "scripts/e2e/consolidate-themes.js missing. Aggregates findings into themes.");
    return;
  }

  // Check orchestrator wiring
  const orchPath = path.join(ROOT, "scripts", "e2e", "orchestrator.js");
  if (fs.existsSync(orchPath)) {
    const orchContent = fs.readFileSync(orchPath, "utf-8");
    if (!orchContent.includes("consolidate-themes")) {
      fail(label, "Script exists but not wired into orchestrator.js. Add to Phase 1.");
      return;
    }
  }

  // Check state file validity
  const statePath = path.join(ROOT, "e2e", "state", "finding-themes.json");
  if (fs.existsSync(statePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      if (!data.stats || !data.themes) {
        fail(label, "finding-themes.json missing stats or themes. Re-run consolidator.");
        return;
      }
      pass(label, `wired, ${data.stats.totalClusters || 0} clusters → ${data.stats.totalThemes || 0} themes`);
    } catch {
      fail(label, "finding-themes.json is not valid JSON.");
    }
  } else {
    pass(label, "wired (state not yet generated — run orchestrator)");
  }
}

function checkDiscoverySampler() {
  const label = "Pipeline: discovery-sampler.ts exists and wired into oracle";
  const samplerPath = path.join(ROOT, "e2e", "oracle", "discovery-sampler.ts");

  if (!fs.existsSync(samplerPath)) {
    fail(label, "e2e/oracle/discovery-sampler.ts missing. Premium model blind spot detection.");
    return;
  }

  // Check oracle wiring
  const oraclePath = path.join(ROOT, "e2e", "oracle", "llm-oracle.ts");
  if (fs.existsSync(oraclePath)) {
    const oracleContent = fs.readFileSync(oraclePath, "utf-8");
    if (!oracleContent.includes("discoverySampler")) {
      fail(label, "discovery-sampler.ts exists but not wired into llm-oracle.ts.");
      return;
    }
  }

  // Check state file validity
  const statePath = path.join(ROOT, "e2e", "state", "discovery-samples.json");
  if (fs.existsSync(statePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      if (!data.stats) {
        fail(label, "discovery-samples.json missing stats. Re-run with DISCOVERY_ENABLED=1.");
        return;
      }
      const rate = ((data.stats.discrepancyRate || 0) * 100).toFixed(1);
      pass(label, `wired, ${data.stats.totalSamples || 0} samples (${rate}% blind spot rate)`);
    } catch {
      fail(label, "discovery-samples.json is not valid JSON.");
    }
  } else {
    pass(label, "wired (no samples yet — discovery runs during tests)");
  }
}

function checkSynthesizerFallback() {
  const label = "Pipeline: finding-synthesizer has heuristic fallback";
  const synthPath = path.join(ROOT, "scripts", "e2e", "claude-finding-synthesizer.js");

  if (!fs.existsSync(synthPath)) {
    fail(label, "claude-finding-synthesizer.js missing.");
    return;
  }

  const content = fs.readFileSync(synthPath, "utf-8");
  if (content.includes("heuristicCluster") && content.includes("jaccard")) {
    pass(label, "Jaccard similarity fallback present (handles Claude batch failures)");
  } else {
    fail(label, "No heuristic fallback. When Claude batches fail, clusters degrade to 1:1 copies.");
  }
}

function checkRoiConsumedByStrategy() {
  const label = "Feedback Loop: ROI consumed by test strategy fusion";
  const fusePath = path.join(ROOT, "scripts", "e2e", "fuse-test-strategy.js");

  if (!fs.existsSync(fusePath)) {
    fail(label, "fuse-test-strategy.js missing.");
    return;
  }
  const content = fs.readFileSync(fusePath, "utf-8");
  if (content.includes("persona-roi.json") && content.includes("roiBoost")) {
    pass(label, "persona-roi.json loaded and roiBoost integrated into fusion formula");
  } else {
    fail(label, "fuse-test-strategy.js does not read persona-roi.json. ROI data is write-only.");
  }
}

function checkRoiConsumedByDiscovery() {
  const label = "Feedback Loop: ROI consumed by discovery sampler";
  const samplerPath = path.join(ROOT, "e2e", "oracle", "discovery-sampler.ts");

  if (!fs.existsSync(samplerPath)) {
    fail(label, "discovery-sampler.ts missing.");
    return;
  }
  const content = fs.readFileSync(samplerPath, "utf-8");
  if (content.includes("highRoiPersonas") && content.includes("persona-roi.json")) {
    pass(label, "High-ROI personas get 2x discovery sample rate");
  } else {
    fail(label, "discovery-sampler.ts does not use ROI data. Sampling is uniform.");
  }
}

function checkThemesGenerateMocs() {
  const label = "Feedback Loop: themes generate batch MOCs";
  const themesPath = path.join(ROOT, "scripts", "e2e", "consolidate-themes.js");

  if (!fs.existsSync(themesPath)) {
    fail(label, "consolidate-themes.js missing.");
    return;
  }
  const content = fs.readFileSync(themesPath, "utf-8");
  if (content.includes("generateThemeMocs") && content.includes("moc-queue.json")) {
    pass(label, "generateThemeMocs() creates batch MOCs from high-priority themes");
  } else {
    fail(label, "consolidate-themes.js does not generate MOCs from themes. Themes are metadata-only.");
  }
}

function checkDedupLeakFix() {
  const label = "Feedback Loop: finding→MOC dedup leak reduced";
  const f2mPath = path.join(ROOT, "scripts", "e2e", "findings-to-mocs.js");

  if (!fs.existsSync(f2mPath)) {
    fail(label, "findings-to-mocs.js missing.");
    return;
  }
  const content = fs.readFileSync(f2mPath, "utf-8");
  const has3day = content.includes("IMPLEMENTED_DEDUP_MS") && content.includes("3 *");
  const bypassesArchived = content.includes("archived") && content.includes("continue");
  if (has3day && bypassesArchived) {
    pass(label, "3-day dedup for implemented, archived MOCs bypassed");
  } else if (has3day) {
    pass(label, "3-day dedup cooldown (archived bypass missing)");
  } else {
    fail(label, "Still using 7-day dedup cooldown — 53% of findings blocked.");
  }
}

function checkRoiConsumedByHomeostatic() {
  const label = "Feedback Loop: ROI consumed by homeostatic drives";
  const homePath = path.join(ROOT, "scripts", "e2e", "homeostatic-update.js");

  if (!fs.existsSync(homePath)) {
    fail(label, "homeostatic-update.js missing.");
    return;
  }
  const content = fs.readFileSync(homePath, "utf-8");
  if (content.includes("persona-roi.json") && content.includes("roiTier")) {
    pass(label, "ROI tier adjusts energy drive (high +0.1, low -0.1)");
  } else {
    fail(label, "homeostatic-update.js does not use ROI data. Energy is ROI-blind.");
  }
}

function checkRoiInOracleContext() {
  const label = "Feedback Loop: ROI in oracle prompt context";
  const learnerPath = path.join(ROOT, "e2e", "lib", "persona-learner.ts");

  if (!fs.existsSync(learnerPath)) {
    fail(label, "persona-learner.ts missing.");
    return;
  }
  const content = fs.readFileSync(learnerPath, "utf-8");
  if (content.includes("roiScore") && content.includes("ROI:")) {
    pass(label, "getPersonaHistoryContext includes ROI summary for oracle");
  } else {
    fail(label, "persona-learner.ts does not include ROI in history context.");
  }
}

function checkSubsystemValueTracker() {
  const label = "Pipeline: subsystem-value-tracker.js exists and wired";
  const scriptPath = path.join(ROOT, "scripts", "e2e", "subsystem-value-tracker.js");

  if (!fs.existsSync(scriptPath)) {
    fail(label, "scripts/e2e/subsystem-value-tracker.js missing. Tracks intelligence subsystem effectiveness.");
    return;
  }

  // Check intelligence claw wiring
  const clawPath = path.join(ROOT, "scripts", "e2e", "claws", "intelligence.js");
  if (fs.existsSync(clawPath)) {
    const clawContent = fs.readFileSync(clawPath, "utf-8");
    if (!clawContent.includes("subsystem-value-tracker")) {
      fail(label, "Script exists but not wired into intelligence claw. Add to Phase 5.5.");
      return;
    }
  }

  // Check state file validity and staleness
  const statePath = path.join(ROOT, "e2e", "state", "subsystem-value.json");
  if (fs.existsSync(statePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      if (!data.subsystems || !data.meta) {
        fail(label, "subsystem-value.json missing subsystems or meta. Re-run tracker.");
        return;
      }

      // Check staleness — should be updated within 24h if intelligence claw is running
      const mtime = fs.statSync(statePath).mtime.getTime();
      const ageHours = Math.round((Date.now() - mtime) / 3600000);

      const active = data.meta.activeSubsystems || 0;
      const total = data.meta.totalSubsystems || 0;
      const disabling = data.meta.disableRecommendations || 0;

      if (ageHours > 24) {
        fail(label, `subsystem-value.json is ${ageHours}h old (stale). Intelligence claw should refresh within 24h.`);
      } else {
        pass(label, `wired, ${active}/${total} active, ${disabling} consider disabling (${ageHours}h old)`);
      }
    } catch {
      fail(label, "subsystem-value.json is not valid JSON.");
    }
  } else {
    pass(label, "wired (state not yet generated — run intelligence claw)");
  }
}

function runPipelineIntelligenceChecks() {
  console.log("");
  console.log(bold("Pipeline Intelligence"));
  console.log("");
  checkFixFunnelDashboard();
  checkPersonaRoiScorer();
  checkConsolidateThemes();
  checkDiscoverySampler();
  checkSynthesizerFallback();
  checkSubsystemValueTracker();
}

function runFeedbackLoopChecks() {
  console.log("");
  console.log(bold("Feedback Loop Closures"));
  console.log("");
  checkRoiConsumedByStrategy();
  checkRoiConsumedByDiscovery();
  checkThemesGenerateMocs();
  checkDedupLeakFix();
  checkRoiConsumedByHomeostatic();
  checkRoiInOracleContext();
}

function runWiringGuard() {
  console.log("");
  console.log(bold("Infrastructure Wiring Guard"));
  console.log("");
  checkWiringUIJourney();
  checkWiringExploration();
  checkWiringInteractiveTests();
  checkUIInteractionCoverage();
  checkMocUIFlowWiring();
  checkLLMGuidedExploration();
  checkWiringSelectors();
  checkWiringEvaluateImprovements();
  checkWiringVisionOracle();
  checkWiringObserveFeedback();
  checkNoDeadFrameworks();
  checkWiringFeatureTemplate();
  checkUIFormInteractionCoverage();
  checkFrictionRegressionWired();
  checkHotspotSuggestionsWired();
  checkCoverageGapsWired();
  checkExploreUsesHotspots();
  checkOrphanedStateFiles();
  checkIntelligenceConsumerWired();
  checkOrchestratorInLoop();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("E2E Health Check"));
  console.log(dim(`Project root: ${ROOT}`));
  console.log("");

  checkBaseUrl();

  // Run all checks (async ones awaited in order)
  await checkPoolAccounts();
  checkManifest();
  checkJitPrompt();
  checkOracleApiKey();
  checkGeminiApiKey();
  checkPersonaSpecs();
  checkGuardrails();
  await checkServer();
  checkInvariants();
  checkOraclePrompts();
  checkBuildSpec();
  checkSpecChangeGuard();
  checkImprovementReport();
  checkVisualSpec();
  checkCpPersonasDeptHead();
  checkFindingsToMocsWired();
  checkOracleEffectiveness();
  checkOrphanedRoutes();

  // Pipeline intelligence checks — fix funnel, persona ROI, themes, discovery
  runPipelineIntelligenceChecks();

  // Feedback loop closure checks — verify intelligence outputs drive behavior
  runFeedbackLoopChecks();

  // Infrastructure wiring checks — detect silent regressions
  runWiringGuard();

  // Summary
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const allPassed = passed === total;

  console.log("");
  if (allPassed) {
    console.log(green(bold(`${passed}/${total} checks passed`)));
  } else {
    console.log(red(bold(`${passed}/${total} checks passed`)));
  }
  console.log("");

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Health check crashed:", err);
  process.exit(1);
});
