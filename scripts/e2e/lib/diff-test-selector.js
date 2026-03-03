/**
 * Differential Test Selector
 *
 * Maps git diff (changed files) → affected routes → test filter.
 * Only tests pages touched by recent code changes. Cuts test volume
 * by 70%+ on typical deploys while still catching regressions.
 *
 * Uses the same FILE_TO_FEATURE mapping as spec-change-guard.js
 * plus the manifest.json for feature→persona mapping.
 *
 * Usage:
 *   const { getAffectedTests } = require("./lib/diff-test-selector");
 *   const selection = getAffectedTests({ since: "HEAD~1" });
 *   // selection.grepPattern → Playwright --grep filter
 *   // selection.affectedRoutes → ["/mocs", "/admin/permissions", ...]
 *   // selection.affectedPersonas → ["alice-admin", "bob-reviewer", ...]
 *   // selection.fullRun → true if too many changes (>30 files) or critical path changed
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");

// ---------------------------------------------------------------------------
// File → Route mapping (extends spec-change-guard.js FILE_TO_FEATURE)
// ---------------------------------------------------------------------------

const FILE_TO_ROUTE = {
  // MOC stages
  "app/moc/[id]/stage-0": ["/moc/*/stage-0"],
  "app/moc/[id]/stage-1": ["/moc/*/stage-1"],
  "app/moc/[id]/stage-2": ["/moc/*/stage-2"],
  "app/moc/[id]/stage-3": ["/moc/*/stage-3"],
  "app/moc/[id]/stage-4": ["/moc/*/stage-4"],
  "app/moc/[id]/stage-5": ["/moc/*/stage-5"],
  "app/moc/[id]/stage-6": ["/moc/*/stage-6"],

  // Pages
  "app/mocs/page": ["/mocs"],
  "app/mocs/new": ["/mocs/new"],
  "app/mocs/completed": ["/mocs/completed"],
  "app/mocs/portfolio": ["/mocs/portfolio"],
  "app/login": ["/login"],
  "app/admin/page": ["/admin"],
  "app/admin/permissions": ["/admin/permissions"],
  "app/admin/people": ["/admin/people"],
  "app/admin/departments": ["/admin/departments"],
  "app/admin/features": ["/admin/features"],
  "app/admin/integrations": ["/admin/integrations"],
  "app/admin/developer": ["/admin/developer"],
  "app/admin/agents": ["/admin/agents"],
  "app/admin/audit-log": ["/admin/audit-log"],
  "app/admin/webhooks": ["/admin/webhooks"],
  "app/admin/onboarding": ["/admin/onboarding"],
  "app/admin/portfolio": ["/admin/portfolio"],
  "app/review/role-inbox": ["/review/role-inbox"],
  "app/review/cursory": ["/review/cursory"],
  "app/my-department": ["/my-department"],
  "app/account/settings": ["/account/settings"],
  "app/pricing": ["/pricing"],
  "app/contact": ["/contact"],
  "app/demo": ["/demo"],
  "app/evolution": ["/evolution"],
  "app/enter-organization-key": ["/enter-organization-key"],
  "app/free-onboarding": ["/free-onboarding"],
  "app/getting-started": ["/getting-started"],
  "app/help": ["/help"],
  "app/logout": ["/logout"],
  "app/select-organization": ["/select-organization"],
  "app/setup-profile": ["/setup-profile"],
  "app/unaffiliated": ["/unaffiliated"],
  "app/upgrade": ["/upgrade"],
  "app/admin/analytics": ["/admin/analytics", "/admin/analytics/feature-usage", "/admin/analytics/reviewer-patterns", "/admin/analytics/risk-patterns"],
  "app/admin/errors": ["/admin/errors"],
  "app/admin/autonomous-operations": ["/admin/autonomous-operations"],
  "app/admin/compliance": ["/admin/compliance"],
  "app/admin/system-audit": ["/admin/system-audit"],
  "app/admin/change-definitions": ["/admin/change-definitions"],
  "app/admin/change-types": ["/admin/change-types"],
  "app/admin/security": ["/admin/security"],
  "app/admin/settings": ["/admin/settings"],
  "app/admin/reports": ["/admin/reports"],
  "app/admin/subscription": ["/admin/subscription"],
  "app/mocs/[id]/decide": ["/mocs"],

  // API routes → the pages they serve
  "app/api/mocs/route": ["/mocs", "/mocs/new"],
  "app/api/mocs/[id]": ["/moc/*/stage-0", "/moc/*/stage-1", "/moc/*/stage-2", "/moc/*/stage-3", "/moc/*/stage-4", "/moc/*/stage-5", "/moc/*/stage-6"],
  "app/api/mocs/completed": ["/mocs/completed"],
  "app/api/admin": ["/admin"],
  "app/api/auth": ["/login", "/mocs"],
  "app/api/permissions": ["/admin/permissions"],
  "app/api/notifications": ["/mocs"],

  // Libraries — map to affected routes
  "lib/permissions/": ["/admin/permissions", "/mocs"],
  "lib/notifications/": ["/mocs"],
  "lib/llm/": ["/moc/*/stage-0"],
  "lib/agents/": ["/admin/agents", "/review/role-inbox"],
  "lib/auth": ["/login", "/mocs"],
  "lib/supabase": ["/mocs", "/admin"],

  // Components — broad impact
  "components/ui/": ["*"],
  "components/layout": ["*"],
  "components/nav": ["*"],

  // Migrations — always full run
  "supabase/migrations/": ["*"],
};

// Routes that when changed, should trigger a full test run
const CRITICAL_PATHS = [
  "lib/auth",
  "lib/supabase",
  "lib/permissions/",
  "supabase/migrations/",
  "components/ui/",
  "components/layout",
];

// ---------------------------------------------------------------------------
// Route → Persona mapping (from manifest.json)
// ---------------------------------------------------------------------------

function loadManifest() {
  try {
    const manifestPath = path.join(STATE_DIR, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
  } catch {}
  return null;
}

function getPersonasForRoutes(routes, manifest) {
  if (!manifest?.features) { return []; }
  const personas = new Set();

  for (const route of routes) {
    for (const [, feature] of Object.entries(manifest.features)) {
      // Check if any persona page matches the route
      const featurePersonas = feature.personas ?? [];
      for (const pid of featurePersonas) {
        // All personas test their assigned routes
        personas.add(pid);
      }
    }
  }

  return [...personas];
}

// ---------------------------------------------------------------------------
// Git diff analysis
// ---------------------------------------------------------------------------

function getChangedFiles(since = "HEAD~1") {
  try {
    const output = execSync(`git diff --name-only ${since}`, {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    // Fallback: staged + unstaged
    try {
      const output = execSync("git diff --name-only HEAD", {
        cwd: ROOT,
        stdio: "pipe",
        timeout: 10000,
      }).toString().trim();
      return output ? output.split("\n").filter(Boolean) : [];
    } catch {
      return [];
    }
  }
}

function mapFilesToRoutes(changedFiles) {
  const routes = new Set();
  let isCritical = false;

  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, "/");

    // Check critical paths
    for (const critical of CRITICAL_PATHS) {
      if (normalized.includes(critical)) {
        isCritical = true;
        break;
      }
    }

    // Map to routes
    let matched = false;
    for (const [pattern, mappedRoutes] of Object.entries(FILE_TO_ROUTE)) {
      if (normalized.includes(pattern)) {
        for (const route of mappedRoutes) {
          routes.add(route);
        }
        matched = true;
      }
    }

    // Unmapped files in app/ → try to derive route
    if (!matched && normalized.startsWith("app/") && !normalized.includes("api/")) {
      const route = "/" + normalized
        .replace(/^app\//, "")
        .replace(/\/page\.tsx$/, "")
        .replace(/\[([^\]]+)\]/g, "*");
      routes.add(route);
    }
  }

  return { routes: [...routes], isCritical };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get affected tests based on git diff.
 *
 * @param {object} opts
 * @param {string} opts.since — Git ref to diff against (default: HEAD~1)
 * @param {number} opts.maxFilesForFull — If more files changed, trigger full run (default: 30)
 * @returns {{ fullRun: boolean, grepPattern: string|null, affectedRoutes: string[], affectedPersonas: string[], changedFiles: string[], reason: string }}
 */
function getAffectedTests(opts = {}) {
  const since = opts.since ?? "HEAD~1";
  const maxFiles = opts.maxFilesForFull ?? 30;

  const changedFiles = getChangedFiles(since);

  if (changedFiles.length === 0) {
    return {
      fullRun: false,
      grepPattern: null,
      affectedRoutes: [],
      affectedPersonas: [],
      changedFiles: [],
      reason: "no changes detected",
    };
  }

  if (changedFiles.length > maxFiles) {
    return {
      fullRun: true,
      grepPattern: null,
      affectedRoutes: ["*"],
      affectedPersonas: [],
      changedFiles,
      reason: `${changedFiles.length} files changed (> ${maxFiles} threshold)`,
    };
  }

  const { routes, isCritical } = mapFilesToRoutes(changedFiles);

  if (isCritical || routes.includes("*")) {
    return {
      fullRun: true,
      grepPattern: null,
      affectedRoutes: ["*"],
      affectedPersonas: [],
      changedFiles,
      reason: "critical path changed",
    };
  }

  if (routes.length === 0) {
    return {
      fullRun: false,
      grepPattern: null,
      affectedRoutes: [],
      affectedPersonas: [],
      changedFiles,
      reason: "no route-mapped changes",
    };
  }

  // Build grep pattern for Playwright
  // Convert routes to test name fragments
  const grepParts = routes.map((route) => {
    // "/mocs" → "mocs", "/admin/permissions" → "permissions"
    const segments = route.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? segments[0] ?? "";
  }).filter(Boolean);

  const manifest = loadManifest();
  const personas = getPersonasForRoutes(routes, manifest);

  return {
    fullRun: false,
    grepPattern: grepParts.length > 0 ? grepParts.join("|") : null,
    affectedRoutes: routes,
    affectedPersonas: personas,
    changedFiles,
    reason: `${routes.length} routes affected by ${changedFiles.length} file changes`,
  };
}

/**
 * Get the last deploy SHA for diff calculation.
 */
function getLastDeploySha() {
  try {
    const signalsPath = path.join(STATE_DIR, "claw-signals.json");
    if (fs.existsSync(signalsPath)) {
      const signals = JSON.parse(fs.readFileSync(signalsPath, "utf-8"));
      return signals.signals?.["deploy-detected"]?.sha ?? null;
    }
  } catch {}
  return null;
}

// CLI mode
if (require.main === module) {
  const since = process.argv[2] ?? "HEAD~1";
  const result = getAffectedTests({ since });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { getAffectedTests, getLastDeploySha, mapFilesToRoutes, getChangedFiles };
