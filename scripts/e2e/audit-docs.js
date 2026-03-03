#!/usr/bin/env node

/**
 * Update audit documentation with latest stats from manifest, findings, and test results.
 *
 * Regenerates sections of SECURITY-TESTING-AUDIT.md with current:
 * - Persona count and coverage matrix
 * - Permission key count
 * - Feature flag count
 * - Latest test findings summary
 * - Timestamp
 *
 * Usage:
 *   node scripts/update-audit-docs.js              # Update docs
 *   node scripts/update-audit-docs.js --json       # JSON summary only
 */

const fs = require("fs");
const path = require("path");

const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "e2e", "state", "manifest.json");
const PERSONAS_PATH = path.resolve(__dirname, "..", "..", "e2e", "fixtures", "personas.ts");
const FINDINGS_PATH = path.resolve(__dirname, "..", "..", "e2e", "state", "findings", "findings.json");
const AUDIT_DOC_PATH = path.resolve(__dirname, "..", "..", "e2e", "docs", "SECURITY-TESTING-AUDIT.md");
const PERMISSION_KEYS_PATH = path.resolve(__dirname, "..", "..", "lib", "permissions", "keys.ts");
const FEATURES_PATH = path.resolve(__dirname, "..", "..", "lib", "types", "features.ts");
const HISTORY_DIR = path.resolve(__dirname, "..", "..", "e2e", "state", "history");

const args = process.argv.slice(2);
const JSON_MODE = args.includes("--json");

// ---------------------------------------------------------------------------
// Gather stats
// ---------------------------------------------------------------------------

function countPermissionKeys() {
  try {
    const content = fs.readFileSync(PERMISSION_KEYS_PATH, "utf-8");
    const keys = new Set();
    const regex = /["']([a-z_]+\.[a-z_]+)["']/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      keys.add(match[1]);
    }
    return keys.size;
  } catch {
    return 0;
  }
}

function countFeatureFlags() {
  try {
    const content = fs.readFileSync(FEATURES_PATH, "utf-8");
    const flags = new Set();
    const regex = /:\s*["']([a-z_]+)["']/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      flags.add(match[1]);
    }
    return flags.size;
  } catch {
    return 0;
  }
}

function countPersonas() {
  try {
    const content = fs.readFileSync(PERSONAS_PATH, "utf-8");
    const matches = content.match(/export const \w+:\s*Persona/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function getManifestStats() {
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    const featureCount = Object.keys(manifest.features).length;
    const roleCount = Object.keys(manifest.roles).length;
    const allPersonas = new Set();
    for (const feature of Object.values(manifest.features)) {
      for (const p of feature.personas) {
        allPersonas.add(p);
      }
    }
    return { featureCount, roleCount, personasInManifest: allPersonas.size };
  } catch {
    return { featureCount: 0, roleCount: 0, personasInManifest: 0 };
  }
}

function getFindings() {
  try {
    const content = fs.readFileSync(FINDINGS_PATH, "utf-8");
    const findings = JSON.parse(content);
    const bugs = findings.filter((f) => f.severity === "bug").length;
    const security = findings.filter((f) => f.severity === "security").length;
    const ux = findings.filter((f) => f.severity === "ux").length;
    return { total: findings.length, bugs, security, ux };
  } catch {
    return { total: 0, bugs: 0, security: 0, ux: 0 };
  }
}

function getLatestRunSummary() {
  try {
    if (!fs.existsSync(HISTORY_DIR)) {
      return null;
    }
    const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).sort().reverse();
    if (files.length === 0) {
      return null;
    }
    const latest = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, files[0]), "utf-8"));
    return {
      runId: latest.runId,
      timestamp: latest.timestamp,
      totalPassed: latest.totalPassed ?? 0,
      totalFindings: latest.totalFindings ?? 0,
    };
  } catch {
    return null;
  }
}

function countTestFiles() {
  const testsDir = path.resolve(__dirname, "..", "e2e", "tests");
  let count = 0;
  function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name));
        } else if (entry.name.endsWith(".spec.ts")) {
          count++;
        }
      }
    } catch {
      // ignore
    }
  }
  walk(testsDir);
  return count;
}

// ---------------------------------------------------------------------------
// Gather all stats
// ---------------------------------------------------------------------------

const stats = {
  timestamp: new Date().toISOString().split("T")[0],
  permissionKeys: countPermissionKeys(),
  featureFlags: countFeatureFlags(),
  personas: countPersonas(),
  manifest: getManifestStats(),
  findings: getFindings(),
  latestRun: getLatestRunSummary(),
  testFiles: countTestFiles(),
};

if (JSON_MODE) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Update SECURITY-TESTING-AUDIT.md
// ---------------------------------------------------------------------------

if (!fs.existsSync(AUDIT_DOC_PATH)) {
  console.log("SECURITY-TESTING-AUDIT.md not found. Skipping doc update.");
  console.log("Stats:", JSON.stringify(stats, null, 2));
  process.exit(0);
}

let doc = fs.readFileSync(AUDIT_DOC_PATH, "utf-8");

// Update the executive summary stats
const summaryReplacements = [
  {
    pattern: /\*\*\d+ testing personas\*\*/,
    replacement: `**${stats.personas} testing personas**`,
  },
  {
    pattern: /\*\*\d+ granular permission keys\*\*/,
    replacement: `**${stats.permissionKeys} granular permission keys**`,
  },
  {
    pattern: /\*\*\d+\+ feature flags\*\*/,
    replacement: `**${stats.featureFlags}+ feature flags**`,
  },
];

for (const { pattern, replacement } of summaryReplacements) {
  doc = doc.replace(pattern, replacement);
}

// Update last-updated date
doc = doc.replace(
  /\*\*Last Updated:\*\* \d{4}-\d{2}-\d{2}/,
  `**Last Updated:** ${stats.timestamp}`
);

// Update permission matrix count in section 3.1
doc = doc.replace(
  /### 3\.1 Permission Matrix \(\d+ keys\)/,
  `### 3.1 Permission Matrix (${stats.permissionKeys} keys)`
);

// Add/update auto-generated stats footer
const statsFooter = `
<!-- AUTO-GENERATED STATS — updated by scripts/update-audit-docs.js -->
<!-- Permissions: ${stats.permissionKeys} | Features: ${stats.featureFlags} | Personas: ${stats.personas} | Test files: ${stats.testFiles} | Findings: ${stats.findings.total} (${stats.findings.bugs} bugs, ${stats.findings.security} security) | Last sync: ${stats.timestamp} -->
`;

// Remove old stats footer if present
doc = doc.replace(/\n<!-- AUTO-GENERATED STATS —.*?-->\n<!-- .*?-->\n?/s, "");

// Add new footer before the final line
doc = doc.trimEnd() + "\n" + statsFooter;

fs.writeFileSync(AUDIT_DOC_PATH, doc);

console.log("=== Audit Documentation Updated ===\n");
console.log(`File: ${AUDIT_DOC_PATH}`);
console.log(`Permissions: ${stats.permissionKeys}`);
console.log(`Feature flags: ${stats.featureFlags}`);
console.log(`Personas: ${stats.personas}`);
console.log(`Test files: ${stats.testFiles}`);
console.log(`Findings: ${stats.findings.total} (${stats.findings.bugs} bugs, ${stats.findings.security} security, ${stats.findings.ux} UX)`);
if (stats.latestRun) {
  console.log(`Latest run: ${stats.latestRun.runId} @ ${stats.latestRun.timestamp} — ${stats.latestRun.totalPassed} passed, ${stats.latestRun.totalFindings} findings`);
}
console.log(`Updated: ${stats.timestamp}`);
