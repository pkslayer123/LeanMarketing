#!/usr/bin/env node

/**
 * Fix Funnel Dashboard — Unified pipeline visibility.
 *
 * Joins data from 4 state files to show the full pipeline funnel:
 *   findings → MOCs → fixes → verified
 *
 * Identifies where the pipeline is leaking (biggest drop-off stage).
 *
 * Usage:
 *   node scripts/e2e/fix-funnel-dashboard.js          # Markdown summary to stdout
 *   node scripts/e2e/fix-funnel-dashboard.js --json    # Machine-readable output
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

function main() {
  const jsonMode = process.argv.includes("--json");

  // Load all state files
  const findings = loadJSON(path.join(STATE, "findings", "findings.json")) || [];
  const queueRaw = loadJSON(path.join(STATE, "moc-queue.json")) || {};
  const mocs = queueRaw.mocs || queueRaw || [];
  const fixLog = loadJSON(path.join(STATE, "auto-fix-log.json")) || {};
  const effectivenessRaw = loadJSON(path.join(STATE, "fix-effectiveness.json")) || {};
  const effectivenessEntries = effectivenessRaw.entries || [];

  // ── Findings breakdown ──
  const findingsTotal = findings.length;
  const findingsByStatus = {};
  const findingsBySeverity = {};
  for (const f of findings) {
    findingsByStatus[f.status] = (findingsByStatus[f.status] || 0) + 1;
    findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
  }

  const findingsOpen = (findingsByStatus.open || 0) + (findingsByStatus.pending_fix || 0);
  const findingsResolved = findingsByStatus.resolved || 0;
  const findingsNoise = findingsByStatus.noise || 0;

  // ── MOC breakdown ──
  const mocsTotal = Array.isArray(mocs) ? mocs.length : 0;
  const mocsByStatus = {};
  const mocsByTier = {};
  let mocsWithCommit = 0;
  let mocsVerified = 0;

  for (const m of (Array.isArray(mocs) ? mocs : [])) {
    const status = m.status || "unknown";
    const tier = m.tier || "none";
    mocsByStatus[status] = (mocsByStatus[status] || 0) + 1;
    mocsByTier[tier] = (mocsByTier[tier] || 0) + 1;
    if (m.commit_sha) {
      mocsWithCommit++;
    }
    if (m.verified) {
      mocsVerified++;
    }
  }

  // ── Fix log breakdown ──
  const fixesAttempted = fixLog.fixAttempted || 0;
  const fixesApplied = fixLog.fixApplied || 0;
  const fixesFailed = fixLog.fixFailed || 0;
  const noiseAutoClosed = fixLog.noiseAutoClose || 0;
  const noFixNeeded = fixLog.noFixNeeded || 0;

  // ── By tier aggregation ──
  const byTier = {};
  for (const m of (Array.isArray(mocs) ? mocs : [])) {
    const tier = m.tier || "none";
    if (!byTier[tier]) {
      byTier[tier] = { total: 0, implemented: 0, failed: 0, archived: 0, awaiting: 0 };
    }
    byTier[tier].total++;
    if (m.status === "implemented") {
      byTier[tier].implemented++;
    }
    if (m.status === "needs_human" || (m.autoFixFailures || 0) >= 3) {
      byTier[tier].failed++;
    }
    if (m.status === "archived") {
      byTier[tier].archived++;
    }
    if (m.status === "awaiting_closeout" || m.status === "pending_approval") {
      byTier[tier].awaiting++;
    }
  }

  // ── Conversion rates ──
  const findingToMoc = findingsTotal > 0 ? mocsTotal / findingsTotal : 0;
  const mocToFixAttempt = mocsTotal > 0 ? fixesAttempted / mocsTotal : 0;
  const fixAttemptToSuccess = fixesAttempted > 0 ? fixesApplied / fixesAttempted : 0;
  const mocToImplemented = mocsTotal > 0 ? (mocsByStatus.implemented || 0) / mocsTotal : 0;
  const implementedToVerified = (mocsByStatus.implemented || 0) > 0
    ? mocsVerified / (mocsByStatus.implemented || 1) : 0;
  const endToEnd = findingsTotal > 0 ? mocsWithCommit / findingsTotal : 0;

  // ── Identify leaks ──
  const leaks = [];
  const stages = [
    { name: "findings_to_open", from: findingsTotal, to: findingsOpen, label: "Findings → Open (not noise)" },
    { name: "open_to_moc", from: findingsOpen, to: mocsTotal, label: "Open findings → MOCs created" },
    { name: "moc_to_implemented", from: mocsTotal, to: mocsByStatus.implemented || 0, label: "MOCs → Implemented" },
    { name: "implemented_to_verified", from: mocsByStatus.implemented || 0, to: mocsVerified, label: "Implemented → Verified (commit)" },
  ];

  for (const s of stages) {
    const lost = s.from - s.to;
    if (lost > 0 && s.from > 0) {
      const dropRate = (lost / s.from * 100).toFixed(0);
      leaks.push({
        stage: s.name,
        label: s.label,
        from: s.from,
        to: s.to,
        lostCount: lost,
        dropRate: parseFloat(dropRate),
      });
    }
  }
  leaks.sort((a, b) => b.lostCount - a.lostCount);

  // ── Trend from effectiveness entries ──
  const trend = effectivenessEntries.slice(-10).map((e) => ({
    date: e.timestamp ? e.timestamp.split("T")[0] : "unknown",
    iteration: e.iteration,
    findingsBefore: e.findingsBefore,
    findingsAfter: e.findingsAfter,
    resolved: e.breakdown?.resolved || 0,
    newFound: e.breakdown?.new || e.perFindingDelta?.new || 0,
    regressed: e.breakdown?.regressed || e.perFindingDelta?.regressed || 0,
  }));

  // ── Assemble result ──
  const result = {
    generatedAt: new Date().toISOString(),
    funnel: {
      findings_total: findingsTotal,
      findings_open: findingsOpen,
      findings_resolved: findingsResolved,
      findings_noise: findingsNoise,
      mocs_total: mocsTotal,
      mocs_implemented: mocsByStatus.implemented || 0,
      mocs_awaiting_closeout: mocsByStatus.awaiting_closeout || 0,
      mocs_pending_approval: mocsByStatus.pending_approval || 0,
      mocs_needs_human: mocsByStatus.needs_human || 0,
      mocs_archived: mocsByStatus.archived || 0,
      mocs_with_commit: mocsWithCommit,
      mocs_verified: mocsVerified,
      fixes_attempted: fixesAttempted,
      fixes_applied: fixesApplied,
      fixes_failed: fixesFailed,
      fixes_noise_closed: noiseAutoClosed,
      fixes_no_fix_needed: noFixNeeded,
    },
    conversionRates: {
      finding_to_moc: parseFloat(findingToMoc.toFixed(3)),
      moc_to_fix_attempt: parseFloat(mocToFixAttempt.toFixed(3)),
      fix_attempt_to_success: parseFloat(fixAttemptToSuccess.toFixed(3)),
      moc_to_implemented: parseFloat(mocToImplemented.toFixed(3)),
      implemented_to_verified: parseFloat(implementedToVerified.toFixed(3)),
      end_to_end: parseFloat(endToEnd.toFixed(3)),
    },
    findingsBySeverity,
    mocsByStatus,
    byTier,
    leaks,
    trend,
  };

  // Write state file
  const outPath = path.join(STATE, "fix-funnel.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  if (jsonMode) {
    console.log(JSON.stringify(result));
    return;
  }

  // ── Print markdown summary ──
  console.log("## Fix Pipeline Funnel\n");
  console.log("```");
  console.log(`Findings: ${findingsTotal} total (${findingsOpen} open, ${findingsResolved} resolved, ${findingsNoise} noise)`);
  console.log(`    ↓`);
  console.log(`MOCs:     ${mocsTotal} created`);
  console.log(`    ↓`);
  console.log(`Fixes:    ${fixesAttempted} attempted → ${fixesApplied} applied, ${fixesFailed} failed, ${noFixNeeded} no-fix-needed`);
  console.log(`    ↓`);
  console.log(`Done:     ${mocsByStatus.implemented || 0} implemented (${mocsWithCommit} with commits, ${mocsVerified} verified)`);
  console.log("```\n");

  console.log("### Conversion Rates\n");
  console.log(`| Stage | Rate |`);
  console.log(`|-------|------|`);
  console.log(`| Finding → MOC | ${(findingToMoc * 100).toFixed(0)}% |`);
  console.log(`| MOC → Fix attempt | ${(mocToFixAttempt * 100).toFixed(0)}% |`);
  console.log(`| Fix attempt → Success | ${(fixAttemptToSuccess * 100).toFixed(0)}% |`);
  console.log(`| MOC → Implemented | ${(mocToImplemented * 100).toFixed(0)}% |`);
  console.log(`| End-to-end (finding → commit) | ${(endToEnd * 100).toFixed(0)}% |`);
  console.log();

  if (leaks.length > 0) {
    console.log("### Pipeline Leaks (biggest drop-offs)\n");
    for (const leak of leaks.slice(0, 3)) {
      console.log(`- **${leak.label}**: ${leak.from} → ${leak.to} (lost ${leak.lostCount}, ${leak.dropRate}% drop)`);
    }
    console.log();
  }

  console.log("### By Tier\n");
  console.log("| Tier | Total | Implemented | Failed | Archived | Awaiting |");
  console.log("|------|-------|-------------|--------|----------|----------|");
  for (const [tier, data] of Object.entries(byTier)) {
    console.log(`| ${tier} | ${data.total} | ${data.implemented} | ${data.failed} | ${data.archived} | ${data.awaiting} |`);
  }
  console.log();

  console.log("### By Severity\n");
  console.log("| Severity | Count |");
  console.log("|----------|-------|");
  for (const [sev, count] of Object.entries(findingsBySeverity).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${sev} | ${count} |`);
  }
}

main();
