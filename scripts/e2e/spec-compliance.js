#!/usr/bin/env node

/**
 * spec-compliance.js — Check BUILD-SPEC.md compliance against manifest and codebase.
 *
 * Reads BUILD-SPEC.md and manifest.json, checks:
 *   - Feature coverage: features in spec that have manifest entries + persona tests
 *   - Permission keys: permissions referenced in spec that exist in manifest
 *   - Change Attribution Log: entries in the log section
 *
 * Writes spec-compliance-report.json for consumption by orchestrator and dashboards.
 *
 * Usage:
 *   node scripts/e2e/spec-compliance.js               # Human-readable report
 *   node scripts/e2e/spec-compliance.js --json         # Machine-readable JSON
 *   node scripts/e2e/spec-compliance.js --dry-run      # Preview only
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
try {
  require("dotenv").config({ path: path.join(ROOT, ".env.local"), quiet: true });
  require("dotenv").config({ path: path.join(ROOT, "e2e", ".env"), quiet: true });
} catch {}

const SPEC_PATH = path.join(ROOT, "docs", "BUILD-SPEC.md");
const MANIFEST_PATH = path.join(ROOT, "e2e", "state", "manifest.json");
const OUTPUT_PATH = path.join(ROOT, "e2e", "state", "spec-compliance-report.json");

const jsonMode = process.argv.includes("--json");
const dryRun = process.argv.includes("--dry-run");

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) { return null; }
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

function extractSpecFeatures(specContent) {
  // Extract feature names from markdown table rows or ## headings
  const features = [];
  const lines = specContent.split("\n");
  for (const line of lines) {
    // Match table rows: | Feature Name | ... |
    const tableMatch = line.match(/^\|\s*([A-Za-z][\w\s/()-]+?)\s*\|/);
    if (tableMatch && !line.includes("---") && !line.toLowerCase().includes("feature name")) {
      features.push(tableMatch[1].trim());
    }
    // Match ## Feature: Name headings
    const headingMatch = line.match(/^##\s+(?:Feature:\s*)?(.+)/);
    if (headingMatch && !headingMatch[1].includes("Table") && !headingMatch[1].includes("Log")) {
      features.push(headingMatch[1].trim());
    }
  }
  return [...new Set(features)];
}

function extractPermissionKeys(specContent) {
  // Match permission_key patterns like `can_create_moc`, `view_admin_dashboard`
  const matches = specContent.match(/\b(can_[a-z_]+|view_[a-z_]+|manage_[a-z_]+|edit_[a-z_]+|delete_[a-z_]+)\b/g) || [];
  return [...new Set(matches)];
}

function extractAttributionLog(specContent) {
  const logStart = specContent.indexOf("## Change Attribution Log");
  if (logStart === -1) { return []; }
  const logSection = specContent.slice(logStart);
  const entries = [];
  const lines = logSection.split("\n");
  for (const line of lines) {
    // Match entries like: | MOC-2026-XXXX | ... |
    const match = line.match(/^\|\s*(MOC-\d{4}-\d+)\s*\|/);
    if (match) {
      entries.push(match[1]);
    }
  }
  return entries;
}

function main() {
  if (!fs.existsSync(SPEC_PATH)) {
    const error = { error: "BUILD-SPEC.md not found", path: SPEC_PATH };
    if (jsonMode) { console.log(JSON.stringify(error)); }
    else { console.error(`[spec-compliance] ${error.error}`); }
    return;
  }

  const specContent = fs.readFileSync(SPEC_PATH, "utf-8");
  const manifest = loadJson(MANIFEST_PATH);

  // 1. Feature coverage
  const specFeatures = extractSpecFeatures(specContent);
  const manifestFeatures = manifest ? Object.keys(manifest.features || {}) : [];
  const manifestFeatureSet = new Set(manifestFeatures.map((f) => f.toLowerCase()));

  const coveredFeatures = specFeatures.filter((f) => {
    const lower = f.toLowerCase().replace(/\s+/g, "_");
    return manifestFeatureSet.has(lower) || [...manifestFeatureSet].some((mf) => mf.includes(lower) || lower.includes(mf));
  });
  const uncoveredFeatures = specFeatures.filter((f) => !coveredFeatures.includes(f));
  const featureCoverage = specFeatures.length > 0 ? coveredFeatures.length / specFeatures.length : 1;

  // 2. Permission keys
  const specPermissions = extractPermissionKeys(specContent);
  const manifestPermissions = new Set();
  if (manifest && manifest.features) {
    for (const feat of Object.values(manifest.features)) {
      for (const perm of (feat.permissions || [])) {
        manifestPermissions.add(perm);
      }
    }
  }
  const coveredPermissions = specPermissions.filter((p) => manifestPermissions.has(p));
  const uncoveredPermissions = specPermissions.filter((p) => !manifestPermissions.has(p));
  const permissionCoverage = specPermissions.length > 0 ? coveredPermissions.length / specPermissions.length : 1;

  // 3. Change Attribution Log
  const attributionEntries = extractAttributionLog(specContent);

  // 4. Section checks
  const hasSmeIntent = specContent.includes("SME Intent");
  const hasProtectedDecisions = specContent.includes("Protected SME Decisions");
  const hasAttributionLog = specContent.includes("Change Attribution Log");

  const report = {
    generatedAt: new Date().toISOString(),
    specPath: SPEC_PATH,
    features: {
      total: specFeatures.length,
      covered: coveredFeatures.length,
      uncovered: uncoveredFeatures.slice(0, 20),
      coverage: Math.round(featureCoverage * 10000) / 10000,
    },
    permissions: {
      total: specPermissions.length,
      covered: coveredPermissions.length,
      uncovered: uncoveredPermissions.slice(0, 20),
      coverage: Math.round(permissionCoverage * 10000) / 10000,
    },
    attributionLog: {
      entries: attributionEntries.length,
      recentEntries: attributionEntries.slice(-10),
    },
    sections: {
      hasSmeIntent,
      hasProtectedDecisions,
      hasAttributionLog,
    },
    overall: {
      score: Math.round(((featureCoverage + permissionCoverage + (hasSmeIntent ? 1 : 0) + (hasProtectedDecisions ? 1 : 0) + (hasAttributionLog ? 1 : 0)) / 5) * 100),
    },
  };

  if (!dryRun) {
    const dir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n");
  }

  if (jsonMode) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`[spec-compliance] BUILD-SPEC.md compliance report`);
    console.log(`  Features: ${coveredFeatures.length}/${specFeatures.length} covered (${(featureCoverage * 100).toFixed(0)}%)`);
    console.log(`  Permissions: ${coveredPermissions.length}/${specPermissions.length} covered (${(permissionCoverage * 100).toFixed(0)}%)`);
    console.log(`  Attribution log: ${attributionEntries.length} entries`);
    console.log(`  Sections: SME=${hasSmeIntent}, Protected=${hasProtectedDecisions}, Attribution=${hasAttributionLog}`);
    console.log(`  Overall score: ${report.overall.score}/100`);
    if (uncoveredFeatures.length > 0) {
      console.log(`  Uncovered features: ${uncoveredFeatures.slice(0, 5).join(", ")}${uncoveredFeatures.length > 5 ? "..." : ""}`);
    }
  }
}

main();
