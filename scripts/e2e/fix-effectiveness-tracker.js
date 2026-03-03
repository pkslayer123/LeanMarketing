#!/usr/bin/env node

/**
 * fix-effectiveness-tracker.js — Analyze fix effectiveness over time.
 *
 * Reads fix-effectiveness.json (written by record-fix-effectiveness.js after
 * each iteration), computes resolution rate, regression rate, and trend.
 * Writes fix-effectiveness-report.json for consumption by the loop and dashboards.
 *
 * Usage:
 *   node scripts/e2e/fix-effectiveness-tracker.js              # Human-readable report
 *   node scripts/e2e/fix-effectiveness-tracker.js --json        # Machine-readable JSON
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
try {
  require("dotenv").config({ path: path.join(ROOT, ".env.local"), quiet: true });
  require("dotenv").config({ path: path.join(ROOT, "e2e", ".env"), quiet: true });
} catch {}

const STATE_DIR = path.join(ROOT, "e2e", "state");
const INPUT_FILE = path.join(STATE_DIR, "fix-effectiveness.json");
const OUTPUT_FILE = path.join(STATE_DIR, "fix-effectiveness-report.json");

const jsonMode = process.argv.includes("--json");

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) { return null; }
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

function main() {
  const data = loadJson(INPUT_FILE);
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
    const empty = { generatedAt: new Date().toISOString(), entries: 0, resolutionRate: null, regressionRate: null, trend: "unknown", details: [] };
    if (jsonMode) { console.log(JSON.stringify(empty)); }
    else { console.log("[fix-effectiveness] No fix-effectiveness.json data found."); }
    return;
  }

  const entries = data.entries;
  const totalEntries = entries.length;

  // Compute aggregate stats
  let totalResolved = 0;
  let totalRegressed = 0;
  let totalFindings = 0;

  const details = entries.map((e) => {
    const bd = e.breakdown || {};
    const resolved = bd.resolved || 0;
    const regressed = bd.regressed || 0;
    const total = bd.total || e.findingsBefore || 0;
    totalResolved += resolved;
    totalRegressed += regressed;
    totalFindings += total;

    return {
      iteration: e.iteration ?? null,
      timestamp: e.timestamp,
      total,
      resolved,
      regressed,
      resolutionRate: total > 0 ? resolved / total : 0,
      regressionRate: total > 0 ? regressed / total : 0,
    };
  });

  const resolutionRate = totalFindings > 0 ? totalResolved / totalFindings : 0;
  const regressionRate = totalFindings > 0 ? totalRegressed / totalFindings : 0;

  // Trend: compare last 3 vs first 3 resolution rates
  let trend = "stable";
  if (details.length >= 6) {
    const first3 = details.slice(0, 3).reduce((s, d) => s + d.resolutionRate, 0) / 3;
    const last3 = details.slice(-3).reduce((s, d) => s + d.resolutionRate, 0) / 3;
    if (last3 > first3 + 0.05) { trend = "improving"; }
    else if (last3 < first3 - 0.05) { trend = "declining"; }
  } else if (details.length >= 2) {
    const first = details[0].resolutionRate;
    const last = details[details.length - 1].resolutionRate;
    if (last > first + 0.05) { trend = "improving"; }
    else if (last < first - 0.05) { trend = "declining"; }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    entries: totalEntries,
    resolutionRate: Math.round(resolutionRate * 10000) / 10000,
    regressionRate: Math.round(regressionRate * 10000) / 10000,
    totalResolved,
    totalRegressed,
    totalFindings,
    trend,
    details,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2) + "\n");

  if (jsonMode) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`[fix-effectiveness] ${totalEntries} iterations analyzed`);
    console.log(`  Resolution rate: ${(resolutionRate * 100).toFixed(1)}% (${totalResolved}/${totalFindings})`);
    console.log(`  Regression rate: ${(regressionRate * 100).toFixed(1)}% (${totalRegressed}/${totalFindings})`);
    console.log(`  Trend: ${trend}`);
  }
}

main();
