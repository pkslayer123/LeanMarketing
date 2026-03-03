#!/usr/bin/env node

/**
 * Aggregate findings from e2e/state/findings/findings.json.
 *
 * Outputs summary by page, persona, and severity for triage prioritization.
 * Phase D + E: includes Persona Learning section when persona-learning.json exists.
 *
 * Usage:
 *   node scripts/e2e/aggregate-findings.js
 *   node scripts/e2e/aggregate-findings.js --json
 *   node scripts/e2e/aggregate-findings.js --markdown
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const OUTPUT_JSON = path.join(ROOT, "e2e", "state", "findings", "aggregated.json");
const OUTPUT_MD = path.join(ROOT, "e2e", "state", "findings", "aggregated.md");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const MARKDOWN_OUT = args.includes("--markdown");

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

function aggregate(findings) {
  const byPage = {};
  const byPersona = {};
  const bySeverity = {};

  for (const f of findings) {
    const page = f.page || "unknown";
    const persona = f.persona || "Unknown";
    const severity = f.severity || "ux";

    byPage[page] = byPage[page] || {};
    byPage[page][severity] = (byPage[page][severity] || 0) + 1;

    byPersona[persona] = byPersona[persona] || {};
    byPersona[persona][severity] = (byPersona[persona][severity] || 0) + 1;

    bySeverity[severity] = (bySeverity[severity] || 0) + 1;
  }

  const topPages = Object.entries(byPage)
    .map(([p, s]) => ({ page: p, total: Object.values(s).reduce((a, b) => a + b, 0), bySeverity: s }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);

  const topPersonas = Object.entries(byPersona)
    .map(([p, s]) => ({ persona: p, total: Object.values(s).reduce((a, b) => a + b, 0), bySeverity: s }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);

  return {
    total: findings.length,
    byPage,
    byPersona,
    bySeverity,
    topPages,
    topPersonas,
    generatedAt: new Date().toISOString(),
  };
}

function loadPersonaLearning() {
  if (!fs.existsSync(LEARNING_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(LEARNING_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function toMarkdown(agg, personaLearning) {
  const lines = [
    "# Findings Aggregation",
    "",
    `Generated: ${agg.generatedAt}`,
    `Total: ${agg.total}`,
    "",
    "## By Severity",
    "",
    "| Severity | Count |",
    "|----------|-------|",
    ...Object.entries(agg.bySeverity).map(([s, c]) => `| ${s} | ${c} |`),
    "",
    "## Top Pages",
    "",
    "| Page | Total | Bug | Security | UX |",
    "|------|-------|-----|----------|-----|",
    ...agg.topPages.map(
      (p) =>
        `| ${p.page} | ${p.total} | ${p.bySeverity.bug ?? 0} | ${p.bySeverity.security ?? 0} | ${p.bySeverity.ux ?? 0} |`
    ),
    "",
    "## Top Personas",
    "",
    "| Persona | Total | Bug | Security | UX |",
    "|---------|-------|-----|----------|-----|",
    ...agg.topPersonas.map(
      (p) =>
        `| ${p.persona} | ${p.total} | ${p.bySeverity.bug ?? 0} | ${p.bySeverity.security ?? 0} | ${p.bySeverity.ux ?? 0} |`
    ),
  ];

  // Phase E: Persona Learning section
  if (personaLearning?.personas && Object.keys(personaLearning.personas).length > 0) {
    const entries = Object.entries(personaLearning.personas);
    const topFinders = entries
      .sort(([, a], [, b]) => (b.findingRate ?? 0) - (a.findingRate ?? 0))
      .slice(0, 8);
    const rates = entries.map(([, e]) => e.findingRate ?? 0);
    const avgRate =
      rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;

    lines.push(
      "",
      "## Persona Learning (Phase E)",
      "",
      `Personas in learning: ${entries.length} | Avg finding rate: ${avgRate.toFixed(2)}`,
      "",
      "### Top Finders (by rate)",
      "",
      "| Persona | Runs | Finding Rate | Focus Areas | Suggested Shifts |",
      "|---------|------|-------------|------------|------------------|"
    );
    for (const [id, e] of topFinders) {
      const areas = (e.focusAreas ?? []).slice(0, 3).join(", ") || "—";
      const shifts = e.suggestedTraitShift
        ? Object.entries(e.suggestedTraitShift)
            .map(([k, v]) => `${k}→${v}`)
            .join("; ")
        : "—";
      lines.push(
        `| ${id} | ${e.totalRuns ?? 0} | ${(e.findingRate ?? 0).toFixed(2)} | ${areas} | ${shifts} |`
      );
    }
  }

  return lines.join("\n");
}

function main() {
  const findings = loadFindings();
  const agg = aggregate(findings);

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(agg, null, 2));
    console.log(JSON.stringify({ output: OUTPUT_JSON, total: agg.total }));
  } else if (MARKDOWN_OUT) {
    fs.mkdirSync(path.dirname(OUTPUT_MD), { recursive: true });
    const personaLearning = loadPersonaLearning();
    fs.writeFileSync(OUTPUT_MD, toMarkdown(agg, personaLearning));
    console.log(OUTPUT_MD);
  } else {
    console.log("\n--- Findings Summary ---");
    console.log(`Total: ${agg.total}`);
    console.log("\nBy severity:", agg.bySeverity);
    console.log("\nTop pages:");
    agg.topPages.forEach((p) => console.log(`  ${p.page}: ${p.total} (${JSON.stringify(p.bySeverity)})`));
    console.log("\nTop personas:");
    agg.topPersonas.forEach((p) => console.log(`  ${p.persona}: ${p.total} (${JSON.stringify(p.bySeverity)})`));
  }
}

main();
