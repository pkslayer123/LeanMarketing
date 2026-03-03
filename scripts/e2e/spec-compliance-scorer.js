#!/usr/bin/env node
/**
 * BUILD-SPEC Compliance Scorer
 *
 * Computes a composite compliance score (0-1.0) from four signals:
 *   1. Route coverage: % of spec-defined routes that exist in the filesystem
 *   2. Test pass rate: % of persona tests that pass
 *   3. Oracle confidence: Average oracle check confidence across features
 *   4. Error rate: Inverse of production errors per page
 *
 * Determines the daemon's build phase:
 *   0.0 - 0.3:  BUILD     (scaffold features aggressively)
 *   0.3 - 0.6:  STABILIZE (reduce building, increase testing)
 *   0.6 - 0.85: POLISH    (no new features, focus on UX/edge cases)
 *   0.85+:      CONVERGED (suspend building, report to user)
 *
 * Writes: e2e/state/spec-compliance-report.json
 * Usage: node scripts/e2e/spec-compliance-scorer.js [--json]
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const REPORT_PATH = path.join(STATE_DIR, "spec-compliance-report.json");

function loadJSON(filepath) {
  if (!fs.existsSync(filepath)) { return null; }
  try { return JSON.parse(fs.readFileSync(filepath, "utf-8")); } catch { return null; }
}

function computeRouteCoverage() {
  const builderState = loadJSON(path.join(STATE_DIR, "builder-state.json"));
  if (!builderState || !builderState.totalSections) { return 0; }
  return builderState.specCompletionRate ?? 0;
}

function computeTestPassRate() {
  const greenHistory = loadJSON(path.join(STATE_DIR, "green-history.json"));
  if (!greenHistory?.tests) { return 0; }

  const tests = Object.values(greenHistory.tests);
  if (tests.length === 0) { return 0; }

  let passing = 0;
  for (const t of tests) {
    // green-history stores consecutivePasses (not a history array)
    if ((t.consecutivePasses ?? 0) > 0) {
      passing++;
    }
  }

  return passing / tests.length;
}

function computeOracleConfidence() {
  const raw = loadJSON(path.join(STATE_DIR, "findings", "findings.json"));
  const findings = Array.isArray(raw) ? raw : (raw?.findings ?? []);
  if (findings.length === 0) { return 1.0; }

  const openFindings = findings.filter((f) => f.status === "open");
  if (openFindings.length === 0) { return 1.0; }

  const avgSeverity = openFindings.reduce((sum, f) => {
    const s = f.severity === "critical" ? 1.0 : f.severity === "high" ? 0.7 : f.severity === "medium" ? 0.4 : 0.2;
    return sum + s;
  }, 0) / openFindings.length;

  return Math.max(0, 1 - avgSeverity);
}

function computeErrorRate() {
  const health = loadJSON(path.join(STATE_DIR, "daemon-health-summary.json"));
  if (!health?.errorCount) { return 1.0; }
  return Math.max(0, 1 - Math.min(1, health.errorCount / 100));
}

function determinePhase(score) {
  if (score >= 0.85) { return "converged"; }
  if (score >= 0.6) { return "polish"; }
  if (score >= 0.3) { return "stabilize"; }
  return "build";
}

function main() {
  const asJson = process.argv.includes("--json");

  const routeCoverage = computeRouteCoverage();
  const testPassRate = computeTestPassRate();
  const oracleConfidence = computeOracleConfidence();
  const errorRate = computeErrorRate();

  // Weighted composite score
  const score =
    routeCoverage * 0.35 +
    testPassRate * 0.30 +
    oracleConfidence * 0.20 +
    errorRate * 0.15;

  const phase = determinePhase(score);

  // Load previous report for phase transition detection
  const prevReport = loadJSON(REPORT_PATH);
  const prevPhase = prevReport?.phase ?? "unknown";
  const phaseChanged = prevPhase !== phase && prevPhase !== "unknown";

  const report = {
    score: Math.round(score * 1000) / 1000,
    phase,
    phaseChanged,
    previousPhase: prevPhase,
    signals: {
      routeCoverage: Math.round(routeCoverage * 1000) / 1000,
      testPassRate: Math.round(testPassRate * 1000) / 1000,
      oracleConfidence: Math.round(oracleConfidence * 1000) / 1000,
      errorRate: Math.round(errorRate * 1000) / 1000,
    },
    thresholds: {
      build: "0.0 - 0.3",
      stabilize: "0.3 - 0.6",
      polish: "0.6 - 0.85",
      converged: "0.85+",
    },
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[spec-compliance] score=${report.score} phase=${phase} (routes:${report.signals.routeCoverage} tests:${report.signals.testPassRate} oracle:${report.signals.oracleConfidence} errors:${report.signals.errorRate})`);
    if (phaseChanged) {
      console.log(`[spec-compliance] PHASE TRANSITION: ${prevPhase} → ${phase}`);
    }
  }
}

if (require.main === module) { main(); }
module.exports = { computeRouteCoverage, computeTestPassRate, computeOracleConfidence, computeErrorRate, determinePhase };
