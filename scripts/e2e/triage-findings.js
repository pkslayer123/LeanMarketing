#!/usr/bin/env node

/**
 * Tina Triage — Suggested fix order from findings.
 *
 * Reads findings.json, detects patterns, outputs prioritized fix list
 * for the loop analyst. Feeds into the analysis prompt.
 *
 * Usage:
 *   node scripts/e2e/triage-findings.js
 *   node scripts/e2e/triage-findings.js --json
 */

const fs = require("fs");
const path = require("path");
const { detectPatternsWithImpact } = require("./lib/persona-nuance.js");

const ROOT = path.resolve(__dirname, "..", "..");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const TRIAGE_OUT = path.join(ROOT, "e2e", "state", "triage-priority.md");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");

function loadFindings() {
  if (!fs.existsSync(FINDINGS_FILE)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function detectPatterns(findings) {
  return detectPatternsWithImpact(findings, { severityWeight: true, impactWeight: true });
}

function main() {
  const findings = loadFindings();
  const patterns = detectPatterns(findings);

  const output = {
    totalFindings: findings.length,
    suggestedFixOrder: patterns,
    generatedAt: new Date().toISOString(),
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const lines = [
    "# Tina Triage — Suggested Fix Order",
    "",
    `Generated: ${output.generatedAt}`,
    `Total findings: ${findings.length}`,
    "",
    "## Prioritized Fixes",
    "",
  ];
  patterns.forEach((p, i) => {
    lines.push(`### ${i + 1}. ${p.name} (${p.count})`);
    lines.push("");
    lines.push(`**Fix:** ${p.fix}`);
    lines.push(`**Affected:** ${p.affected.join(", ")}`);
    lines.push("");
  });

  const md = lines.join("\n");
  fs.mkdirSync(path.dirname(TRIAGE_OUT), { recursive: true });
  fs.writeFileSync(TRIAGE_OUT, md);
  console.log(md);
}

main();
