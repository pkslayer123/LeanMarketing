#!/usr/bin/env node

/**
 * iteration-report.js — Aggregate per-iteration report from multiple data sources.
 *
 * Reads test-strategy.json, findings.json, moc-queue.json, fix-effectiveness-report.json,
 * and loop-performance.jsonl to build a comprehensive iteration markdown report.
 *
 * Writes: e2e/reports/iteration-{N}.md
 *
 * Usage:
 *   node scripts/e2e/iteration-report.js --iteration 5     # Report for iteration 5
 *   node scripts/e2e/iteration-report.js                    # Report for latest iteration
 *   node scripts/e2e/iteration-report.js --json             # Machine-readable JSON
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
try {
  require("dotenv").config({ path: path.join(ROOT, ".env.local"), quiet: true });
  require("dotenv").config({ path: path.join(ROOT, "e2e", ".env"), quiet: true });
} catch {}

const STATE_DIR = path.join(ROOT, "e2e", "state");
const REPORTS_DIR = path.join(ROOT, "e2e", "reports");

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const iterationIdx = args.indexOf("--iteration");

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) { return null; }
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) { return []; }
  try {
    return fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function getLatestIteration() {
  const perfEntries = loadJsonl(path.join(STATE_DIR, "loop-performance.jsonl"));
  if (perfEntries.length > 0) {
    const last = perfEntries[perfEntries.length - 1];
    return last.iteration ?? perfEntries.length;
  }
  return 1;
}

function main() {
  const iteration = iterationIdx !== -1 ? parseInt(args[iterationIdx + 1], 10) : getLatestIteration();

  // Load data sources
  const strategy = loadJson(path.join(STATE_DIR, "test-strategy.json"));
  const findingsRaw = loadJson(path.join(STATE_DIR, "findings", "findings.json"));
  const queue = loadJson(path.join(STATE_DIR, "moc-queue.json"));
  const fixReport = loadJson(path.join(STATE_DIR, "fix-effectiveness-report.json"));
  const perfEntries = loadJsonl(path.join(STATE_DIR, "loop-performance.jsonl"));

  // Find matching performance entry
  const perfEntry = perfEntries.find((e) => e.iteration === iteration) || perfEntries[perfEntries.length - 1] || null;

  // Findings stats
  const findings = Array.isArray(findingsRaw) ? findingsRaw : [];
  const openFindings = findings.filter((f) => f.status === "open" || !f.status).length;
  const resolvedFindings = findings.filter((f) => f.status === "resolved").length;
  const inMocFindings = findings.filter((f) => f.status === "in_moc").length;
  const noiseFindings = findings.filter((f) => f.resolution === "noise").length;

  // MOC queue stats
  const mocs = queue ? (queue.mocs || []) : [];
  const approvedMocs = mocs.filter((m) => m.status === "approved").length;
  const implementedMocs = mocs.filter((m) => m.status === "implemented").length;
  const pendingApprovalMocs = mocs.filter((m) => m.status === "pending_approval" || m.status === "awaiting_approval").length;
  const awaitingCloseoutMocs = mocs.filter((m) => m.status === "awaiting_closeout").length;

  // Strategy stats
  const personaCount = strategy ? (strategy.prioritizedPersonas || []).length : 0;
  const topPersonas = strategy ? (strategy.prioritizedPersonas || []).slice(0, 5).map((p) => p.persona) : [];

  // Fix effectiveness
  const resolutionRate = fixReport ? fixReport.resolutionRate : null;
  const regressionRate = fixReport ? fixReport.regressionRate : null;
  const trend = fixReport ? fixReport.trend : "unknown";

  // Performance stats
  const durationMin = perfEntry ? Math.round((perfEntry.durationMs || 0) / 60000) : null;
  const passRate = perfEntry ? perfEntry.passRate : null;
  const workers = perfEntry ? perfEntry.workers : null;

  const reportData = {
    iteration,
    generatedAt: new Date().toISOString(),
    performance: { durationMin, passRate, workers },
    findings: { total: findings.length, open: openFindings, resolved: resolvedFindings, inMoc: inMocFindings, noise: noiseFindings },
    mocs: { total: mocs.length, approved: approvedMocs, implemented: implementedMocs, pendingApproval: pendingApprovalMocs, awaitingCloseout: awaitingCloseoutMocs },
    strategy: { personaCount, topPersonas },
    fixEffectiveness: { resolutionRate, regressionRate, trend },
  };

  if (jsonMode) {
    console.log(JSON.stringify(reportData, null, 2));
    return;
  }

  // Build markdown report
  const lines = [
    `# Iteration ${iteration} Report`,
    "",
    `**Generated:** ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`,
    "",
    "## Performance",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Duration | ${durationMin != null ? `${durationMin} min` : "N/A"} |`,
    `| Pass Rate | ${passRate != null ? `${(passRate * 100).toFixed(1)}%` : "N/A"} |`,
    `| Workers | ${workers ?? "N/A"} |`,
    "",
    "## Findings",
    "",
    `| Status | Count |`,
    `|--------|-------|`,
    `| Total | ${findings.length} |`,
    `| Open | ${openFindings} |`,
    `| Resolved | ${resolvedFindings} |`,
    `| In MOC | ${inMocFindings} |`,
    `| Noise | ${noiseFindings} |`,
    "",
    "## MOC Pipeline",
    "",
    `| Status | Count |`,
    `|--------|-------|`,
    `| Total | ${mocs.length} |`,
    `| Approved (pending fix) | ${approvedMocs} |`,
    `| Implemented | ${implementedMocs} |`,
    `| Pending Approval | ${pendingApprovalMocs} |`,
    `| Awaiting Closeout | ${awaitingCloseoutMocs} |`,
    "",
    "## Fix Effectiveness",
    "",
    `- **Resolution Rate:** ${resolutionRate != null ? `${(resolutionRate * 100).toFixed(1)}%` : "N/A"}`,
    `- **Regression Rate:** ${regressionRate != null ? `${(regressionRate * 100).toFixed(1)}%` : "N/A"}`,
    `- **Trend:** ${trend}`,
    "",
    "## Test Strategy",
    "",
    `- **Personas tested:** ${personaCount}`,
    `- **Top 5:** ${topPersonas.join(", ") || "N/A"}`,
    "",
  ];

  const markdown = lines.join("\n");

  // Write report file
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
  const reportPath = path.join(REPORTS_DIR, `iteration-${iteration}.md`);
  fs.writeFileSync(reportPath, markdown);
  console.log(`[iteration-report] Written to ${reportPath}`);
}

main();
