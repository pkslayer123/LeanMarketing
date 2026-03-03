#!/usr/bin/env node

/**
 * Persona ROI Scorer — Traces persona → findings → MOCs → fix results.
 *
 * Computes per-persona ROI by joining findings, MOC queue, and fix log data.
 * Answers: which personas produce high-value findings that lead to real fixes?
 *
 * Usage:
 *   node scripts/e2e/persona-roi-scorer.js          # Markdown summary
 *   node scripts/e2e/persona-roi-scorer.js --json    # Machine-readable output
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const STATE = path.join(ROOT, "e2e", "state");

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Convert display name "Grant Powers" → kebab-case "grant-powers" */
function toKebab(displayName) {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Severity weight for ROI formula */
const SEVERITY_WEIGHT = {
  security: 5,
  bug: 3,
  product: 2,
  ux: 2,
  suggestion: 1,
  inconsistency: 1,
};

function main() {
  const jsonMode = process.argv.includes("--json");

  // Load state files
  const findings = loadJSON(path.join(STATE, "findings", "findings.json")) || [];
  const queueRaw = loadJSON(path.join(STATE, "moc-queue.json")) || {};
  const mocs = Array.isArray(queueRaw.mocs) ? queueRaw.mocs : Array.isArray(queueRaw) ? queueRaw : [];
  const learningData = loadJSON(path.join(STATE, "persona-learning.json")) || { personas: {} };
  const fixEffData = loadJSON(path.join(STATE, "fix-effectiveness.json")) || {};
  const verifiedFixes = fixEffData.verifiedFixes ?? [];

  // Group verified fixes by persona
  const verifiedByPersona = {};
  for (const vf of verifiedFixes) {
    const name = vf.persona ?? "Unknown";
    verifiedByPersona[name] = (verifiedByPersona[name] ?? 0) + 1;
  }

  // ── Group findings by persona ──
  const findingsByPersona = {};
  for (const f of findings) {
    const name = f.persona || "Unknown";
    if (!findingsByPersona[name]) {
      findingsByPersona[name] = { total: 0, bySeverity: {}, byStatus: {}, items: [] };
    }
    const pg = findingsByPersona[name];
    pg.total++;
    pg.bySeverity[f.severity] = (pg.bySeverity[f.severity] || 0) + 1;
    pg.byStatus[f.status] = (pg.byStatus[f.status] || 0) + 1;
    pg.items.push(f);
  }

  // ── Group MOCs by persona (count implementations) ──
  const mocsByPersona = {};
  for (const m of mocs) {
    const name = m.persona || "Unknown";
    if (!mocsByPersona[name]) {
      mocsByPersona[name] = { total: 0, implemented: 0, withCommit: 0, failed: 0, archived: 0 };
    }
    const mg = mocsByPersona[name];
    mg.total++;
    if (m.status === "implemented") {
      mg.implemented++;
    }
    if (m.commit_sha) {
      mg.withCommit++;
    }
    if ((m.autoFixFailures || 0) >= 3 || m.status === "needs_human") {
      mg.failed++;
    }
    if (m.status === "archived") {
      mg.archived++;
    }
  }

  // ── Compute ROI per persona ──
  const allPersonaNames = new Set([
    ...Object.keys(findingsByPersona),
    ...Object.keys(mocsByPersona),
  ]);

  const personas = {};
  for (const name of allPersonaNames) {
    if (name === "Unknown") {
      continue;
    }

    const fg = findingsByPersona[name] || { total: 0, bySeverity: {}, byStatus: {}, items: [] };
    const mg = mocsByPersona[name] || { total: 0, implemented: 0, withCommit: 0, failed: 0, archived: 0 };

    const totalFindings = fg.total;
    const fixedFindings = mg.withCommit;
    const resolvedFindings = fg.byStatus.resolved || 0;
    const noiseFindings = fg.byStatus.noise || 0;

    // Count severity-weighted value
    let weightedValue = 0;
    for (const [sev, count] of Object.entries(fg.bySeverity)) {
      weightedValue += (SEVERITY_WEIGHT[sev] || 1) * count;
    }

    // ROI: weighted findings that led to commits
    const denominator = Math.max(totalFindings, 1);
    const securityFindings = fg.bySeverity.security || 0;
    const bugFindings = fg.bySeverity.bug || 0;

    // Verified fix bonus: findings that were open then disappeared after a fix
    const verifiedCount = verifiedByPersona[name] ?? 0;

    const roiScore = parseFloat(
      ((fixedFindings * 3 + securityFindings * 5 + bugFindings * 2 + verifiedCount * 2) / denominator).toFixed(2)
    );
    const noiseRate = parseFloat((noiseFindings / denominator).toFixed(3));
    const fixContribution = parseFloat(((fixedFindings + verifiedCount) / denominator).toFixed(3));

    // Top fixed types from MOC data
    const topFixedTypes = [];
    if (securityFindings > 0) {
      topFixedTypes.push("security");
    }
    if (bugFindings > 0) {
      topFixedTypes.push("bug");
    }
    if ((fg.bySeverity.ux || 0) > 0) {
      topFixedTypes.push("ux");
    }
    if ((fg.bySeverity.product || 0) > 0) {
      topFixedTypes.push("product");
    }

    // Tier assignment
    let tier = "no-data";
    if (totalFindings > 0) {
      if (roiScore >= 1.5 || fixContribution >= 0.2) {
        tier = "high-value";
      } else if (roiScore >= 0.5 || fixContribution >= 0.1) {
        tier = "medium-value";
      } else {
        tier = "low-value";
      }
    }

    personas[name] = {
      totalFindings,
      fixedFindings,
      resolvedFindings,
      noiseFindings,
      openFindings: totalFindings - resolvedFindings - noiseFindings,
      mocsCreated: mg.total,
      mocsImplemented: mg.implemented,
      mocsFailed: mg.failed,
      roiScore,
      noiseRate,
      fixContribution,
      weightedValue,
      topFixedTypes,
      tier,
    };
  }

  // ── Build tier groupings ──
  const tiers = { "high-value": [], "medium-value": [], "low-value": [], "no-data": [] };
  for (const [name, data] of Object.entries(personas)) {
    tiers[data.tier].push(name);
  }
  // Sort each tier by ROI descending
  for (const arr of Object.values(tiers)) {
    arr.sort((a, b) => (personas[b]?.roiScore || 0) - (personas[a]?.roiScore || 0));
  }

  // ── Generate recommendations ──
  const recommendations = [];
  for (const [name, data] of Object.entries(personas)) {
    if (data.tier === "low-value" && data.noiseRate > 0.4) {
      recommendations.push(
        `Consider reducing ${name} frequency (${(data.noiseRate * 100).toFixed(0)}% noise, ${(data.fixContribution * 100).toFixed(0)}% fix contribution)`
      );
    }
    if (data.tier === "high-value" && data.fixContribution >= 0.3) {
      recommendations.push(
        `${name} is highly productive (${(data.fixContribution * 100).toFixed(0)}% fix rate) — consider expanding their test scope`
      );
    }
  }

  // ── Write ROI back to persona-learning.json ──
  let learningUpdated = false;
  for (const [displayName, data] of Object.entries(personas)) {
    const kebab = toKebab(displayName);
    if (learningData.personas[kebab]) {
      learningData.personas[kebab].roiScore = data.roiScore;
      learningData.personas[kebab].fixContribution = data.fixContribution;
      learningData.personas[kebab].noiseRate = data.noiseRate;
      learningData.personas[kebab].fixedFindingCount = data.fixedFindings;
      learningData.personas[kebab].lastRoiScored = new Date().toISOString();
      learningUpdated = true;
    }
  }
  if (learningUpdated) {
    learningData.lastUpdated = new Date().toISOString();
    fs.writeFileSync(
      path.join(STATE, "persona-learning.json"),
      JSON.stringify(learningData, null, 2)
    );
  }

  // ── Assemble result ──
  const result = {
    generatedAt: new Date().toISOString(),
    personas,
    tiers,
    recommendations,
    summary: {
      totalPersonas: Object.keys(personas).length,
      highValue: tiers["high-value"].length,
      mediumValue: tiers["medium-value"].length,
      lowValue: tiers["low-value"].length,
      noData: tiers["no-data"].length,
    },
  };

  // Write state file
  fs.writeFileSync(
    path.join(STATE, "persona-roi.json"),
    JSON.stringify(result, null, 2)
  );

  if (jsonMode) {
    console.log(JSON.stringify(result));
    return;
  }

  // ── Markdown summary ──
  console.log("## Persona ROI Scores\n");
  console.log(`**${result.summary.totalPersonas} personas** — ${result.summary.highValue} high-value, ${result.summary.mediumValue} medium, ${result.summary.lowValue} low, ${result.summary.noData} no-data\n`);

  console.log("### Top Performers (High-Value)\n");
  if (tiers["high-value"].length === 0) {
    console.log("_None yet — need more fix data to identify top performers._\n");
  } else {
    console.log("| Persona | Findings | Fixed | ROI | Fix Rate | Noise |");
    console.log("|---------|----------|-------|-----|----------|-------|");
    for (const name of tiers["high-value"]) {
      const d = personas[name];
      console.log(`| ${name} | ${d.totalFindings} | ${d.fixedFindings} | ${d.roiScore} | ${(d.fixContribution * 100).toFixed(0)}% | ${(d.noiseRate * 100).toFixed(0)}% |`);
    }
    console.log();
  }

  console.log("### All Personas by ROI\n");
  console.log("| Persona | Tier | Findings | Fixed | MOCs | ROI | Fix% | Noise% |");
  console.log("|---------|------|----------|-------|------|-----|------|--------|");
  const sorted = Object.entries(personas).sort((a, b) => b[1].roiScore - a[1].roiScore);
  for (const [name, d] of sorted) {
    const tierTag = d.tier === "high-value" ? "HIGH" : d.tier === "medium-value" ? "MED" : d.tier === "low-value" ? "LOW" : "N/A";
    console.log(`| ${name} | ${tierTag} | ${d.totalFindings} | ${d.fixedFindings} | ${d.mocsCreated} | ${d.roiScore} | ${(d.fixContribution * 100).toFixed(0)}% | ${(d.noiseRate * 100).toFixed(0)}% |`);
  }
  console.log();

  if (recommendations.length > 0) {
    console.log("### Recommendations\n");
    for (const r of recommendations) {
      console.log(`- ${r}`);
    }
    console.log();
  }
}

main();
