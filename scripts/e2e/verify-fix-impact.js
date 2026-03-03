#!/usr/bin/env node

/**
 * verify-fix-impact.js — Post-fix verification loop.
 *
 * After fixes are deployed, checks if target findings actually resolved.
 * Promotes "committed" MOCs to "implemented" when findings are confirmed gone,
 * or re-queues them when findings persist.
 *
 * Flow:
 *   1. Read moc-queue.json — find MOCs with status "committed"
 *   2. For each committed MOC, check its findingIds in findings.json
 *   3. If findings resolved after 2+ test cycles → mark "implemented" (verified)
 *   4. If findings persist after 4+ cycles → mark fix as "failed", re-queue
 *   5. Write results to fix-impact.json
 *
 * Usage:
 *   node scripts/e2e/verify-fix-impact.js               # Run verification
 *   node scripts/e2e/verify-fix-impact.js --dry-run      # Preview only
 *   node scripts/e2e/verify-fix-impact.js --json         # Machine-readable output
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const QUEUE_PATH = path.join(STATE_DIR, "moc-queue.json");
const FINDINGS_PATH = path.join(STATE_DIR, "findings", "findings.json");
const IMPACT_PATH = path.join(STATE_DIR, "fix-impact.json");

// Pattern-matcher verification outcome feedback
let patternMatcher;
try { patternMatcher = require("./lib/pattern-matcher"); } catch { /* not available */ }

// Pipeline accuracy tracking
let pipelineMetrics;
try { pipelineMetrics = require("./lib/pipeline-metrics"); } catch { /* not available */ }

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const jsonOutput = args.includes("--json");

// Cycles to wait before declaring verified or failed
const VERIFY_CYCLES = 2;
const FAIL_CYCLES = 4;

function loadJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) { return null; }
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function saveJSON(filePath, data) {
  const tmpPath = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function main() {
  const queue = loadJSON(QUEUE_PATH);
  if (!queue || !Array.isArray(queue.mocs)) {
    if (!jsonOutput) { console.log("[verify-fix-impact] No queue found."); }
    if (jsonOutput) { console.log(JSON.stringify({ verified: 0, failed: 0, pending: 0 })); }
    return;
  }

  // Load findings for cross-reference
  const findingsRaw = loadJSON(FINDINGS_PATH);
  const findings = Array.isArray(findingsRaw) ? findingsRaw : [];
  const findingById = new Map();
  for (const f of findings) {
    const id = f.id || f.findingId;
    if (id) { findingById.set(id, f); }
  }

  // Find committed MOCs
  const committed = queue.mocs.filter((m) => m.status === "committed");

  if (committed.length === 0) {
    if (!jsonOutput) { console.log("[verify-fix-impact] No committed MOCs to verify."); }
    if (jsonOutput) { console.log(JSON.stringify({ verified: 0, failed: 0, pending: 0 })); }
    return;
  }

  if (!jsonOutput) {
    console.log(`[verify-fix-impact] Checking ${committed.length} committed MOCs...`);
  }

  let verified = 0;
  let failed = 0;
  let pending = 0;
  const verifications = [];

  for (const moc of committed) {
    // Increment cycle counter
    const cycles = (moc._verificationCyclesSinceCommit ?? 0) + 1;
    if (!dryRun) {
      moc._verificationCyclesSinceCommit = cycles;
    }

    // Check finding resolution
    const findingIds = moc.findingIds ?? moc.findings ?? [];
    let totalFindings = findingIds.length;
    let resolvedCount = 0;
    let openCount = 0;

    for (const fid of findingIds) {
      const finding = findingById.get(fid);
      if (!finding) {
        // Finding no longer in the file = resolved/pruned
        resolvedCount++;
      } else if (finding.status === "resolved" || finding.status === "in_moc_archived") {
        resolvedCount++;
      } else {
        openCount++;
      }
    }

    // If MOC has no findingIds, check by page+description match
    if (totalFindings === 0 && moc.pageArea) {
      const pageFindings = findings.filter((f) =>
        f.page === moc.pageArea &&
        f.status !== "resolved" &&
        f.status !== "in_moc_archived"
      );
      // If no open findings on this page area, consider it resolved
      if (pageFindings.length === 0) {
        totalFindings = 1;
        resolvedCount = 1;
      } else {
        totalFindings = pageFindings.length;
        openCount = pageFindings.length;
      }
    }

    const successRate = totalFindings > 0 ? resolvedCount / totalFindings : 0;

    const verification = {
      mocId: moc.id,
      title: (moc.title || "").slice(0, 80),
      commitSha: moc.commit_sha,
      findingsTargeted: totalFindings,
      findingsResolved: resolvedCount,
      findingsOpen: openCount,
      successRate: Math.round(successRate * 100) / 100,
      cyclesSinceCommit: cycles,
    };

    // Decision logic
    if (successRate >= 0.5 && cycles >= VERIFY_CYCLES) {
      // Enough findings resolved — mark as implemented (verified)
      verification.action = "verified";
      if (!dryRun) {
        moc.status = "implemented";
        moc.verificationStatus = "verified";
        moc.implementedAt = new Date().toISOString();
        moc.implementationNotes = `Verified: ${resolvedCount}/${totalFindings} findings resolved (${Math.round(successRate * 100)}%)`;
      }
      verified++;
      // Feed verification outcome back to pattern matcher + pipeline metrics
      if (!dryRun && patternMatcher && moc._patternId) {
        try { patternMatcher.recordVerificationOutcome(moc._patternId, true); } catch { /* non-fatal */ }
      }
      if (!dryRun && pipelineMetrics) {
        try {
          pipelineMetrics.recordDecision("fix_verification", {
            mocId: moc.platformMocNumber ?? moc.id,
            tier: moc.tier ?? "unknown",
          }, {
            action: "verified",
            successRate,
            cyclesSinceCommit: cycles,
          }, { correct: true });
        } catch { /* non-fatal */ }
      }
      if (!jsonOutput) {
        console.log(`  [VERIFIED] ${moc.title?.slice(0, 60)} — ${resolvedCount}/${totalFindings} findings resolved`);
      }
    } else if (cycles >= FAIL_CYCLES && successRate < 0.5) {
      // Fix didn't work — re-queue
      verification.action = "failed";
      if (!dryRun) {
        moc.status = "approved"; // Re-queue for another fix attempt
        moc.verificationStatus = "failed";
        moc.failures = (moc.failures ?? 0) + 1;
        moc._verificationCyclesSinceCommit = 0;
        // Clear commit data so it can be re-fixed
        delete moc.commit_sha;
        delete moc.commit_refs;
        delete moc.committedAt;
      }
      failed++;
      // Feed failure back to pattern matcher + pipeline metrics
      if (!dryRun && patternMatcher && moc._patternId) {
        try { patternMatcher.recordVerificationOutcome(moc._patternId, false); } catch { /* non-fatal */ }
      }
      if (!dryRun && pipelineMetrics) {
        try {
          pipelineMetrics.recordDecision("fix_verification", {
            mocId: moc.platformMocNumber ?? moc.id,
            tier: moc.tier ?? "unknown",
          }, {
            action: "failed",
            successRate,
            cyclesSinceCommit: cycles,
          }, { correct: false });
        } catch { /* non-fatal */ }
      }
      if (!jsonOutput) {
        console.log(`  [FAILED] ${moc.title?.slice(0, 60)} — ${openCount}/${totalFindings} findings still open after ${cycles} cycles`);
      }
    } else {
      // Still waiting
      verification.action = "pending";
      pending++;
    }

    verifications.push(verification);
  }

  // Save queue with updated statuses
  if (!dryRun && (verified > 0 || failed > 0)) {
    saveJSON(QUEUE_PATH, queue);
  }

  // Compute aggregate stats
  const completedVerifications = verifications.filter((v) => v.action === "verified" || v.action === "failed");
  const aggregateSuccessRate = completedVerifications.length > 0
    ? completedVerifications.filter((v) => v.action === "verified").length / completedVerifications.length
    : null;

  // Load previous impact data for trend
  const prevImpact = loadJSON(IMPACT_PATH);
  const prevRate = prevImpact?.aggregateSuccessRate ?? null;
  let trend = "unknown";
  if (aggregateSuccessRate !== null && prevRate !== null) {
    if (aggregateSuccessRate > prevRate + 0.05) { trend = "improving"; }
    else if (aggregateSuccessRate < prevRate - 0.05) { trend = "declining"; }
    else { trend = "stable"; }
  }

  // Save impact data
  const impactData = {
    verifications,
    aggregateSuccessRate,
    trend,
    verified,
    failed,
    pending,
    updatedAt: new Date().toISOString(),
  };

  if (!dryRun) {
    saveJSON(IMPACT_PATH, impactData);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ verified, failed, pending, aggregateSuccessRate, trend }));
  } else {
    console.log(`\n[verify-fix-impact] Summary: ${verified} verified, ${failed} failed, ${pending} pending`);
    if (aggregateSuccessRate !== null) {
      console.log(`  Aggregate success rate: ${Math.round(aggregateSuccessRate * 100)}% (trend: ${trend})`);
    }
    if (dryRun) { console.log("  (dry run — no changes saved)"); }
  }
}

main();
