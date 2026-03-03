#!/usr/bin/env node
/**
 * reclassify-queue.js — Reclassify, deduplicate, and archive stale MOCs in the queue.
 *
 * Fixes the pipeline bottleneck where pending_approval MOCs block dedup and never advance.
 * - Reclassifies pending_approval → approved (cp-meta handles stage 4 gate)
 * - Archives MOCs >14 days old with no platform activity
 * - Deduplicates active MOCs by changeType::pageGroup (keeps newest per group)
 * - Re-routes based on updated ROUTING_MAP
 *
 * Usage:
 *   node scripts/e2e/reclassify-queue.js           # Apply changes
 *   node scripts/e2e/reclassify-queue.js --dry-run  # Preview only
 */

const fs = require("fs");
const path = require("path");

const QUEUE_PATH = path.resolve(__dirname, "..", "..", "e2e", "state", "moc-queue.json");
const DRY_RUN = process.argv.includes("--dry-run");
const STALE_DAYS = 14;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

const NEW_ROUTING_MAP = {
  bug_fix: ["Engineering", "QA & Testing"],
  feature: ["Engineering", "Product", "Design"],
  infrastructure: ["DevOps", "Engineering"],
  security: ["Security", "Engineering"],
  ui_ux: ["Design", "Product", "Engineering"],
  migration: ["DevOps", "Engineering", "Security"],
  dependency: ["DevOps", "Security"],
  api_change: ["Engineering", "Security", "QA & Testing"],
  process: ["Product", "Engineering"],
};

// Only these patterns remain as true NEEDS_APPROVAL
const CRITICAL_PATTERNS = [
  /BOLA|cross.org|data\s*isolation/i,
  /sensitive\s*data.*expos|PII.*expos|credential.*expos|secret.*expos/i,
  /SQL\s*injection|XSS|CSRF/i,
  /spec.conflict|BUILD-SPEC.*conflict|protected.decision.*violat/i,
];

// Auto-fixable patterns
const AUTO_FIX_PATTERNS = [
  /dark\s*mode.*missing|missing.*dark:\s*class/i,
  /stale\s*selector|element.*not\s*found/i,
  /missing\s*aria|aria-label.*missing/i,
  /console\s*(error|warning)/i,
  /text\s*truncat|overflow.*hidden.*text/i,
  /placeholder.*generic|placeholder.*lorem/i,
  /z-index|overlap|layer/i,
  /500\s*(error|status|internal)/i,
  /API\s*(error|failure|returned?\s*error)/i,
  /null\s*reference|undefined\s*is\s*not|cannot\s*read\s*propert/i,
  /missing\s*null\s*check|\.single\(\)/i,
  /empty\s*(page|content|body).*no.*error/i,
  /broken\s*link|404.*page/i,
  /form\s*validation.*missing|required.*field.*not.*validated/i,
  /\bbug\b.*\bfix\b|\bFailed to\b|\bError:/i,
];

function reclassifyTier(title, desc) {
  const text = ((title || "") + " " + (desc || ""));
  for (const p of CRITICAL_PATTERNS) {
    if (p.test(text)) { return "needs_approval"; }
  }
  for (const p of AUTO_FIX_PATTERNS) {
    if (p.test(text)) { return "auto_fix"; }
  }
  return "auto_approve";
}

function extractPageGroup(description) {
  const match = (description || "").match(/\*\*Page area:\*\* (.+)/);
  if (match) {
    return match[1].trim().split("/").slice(0, 3).join("/");
  }
  return "unknown";
}

function loadQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
  } catch {
    return { mocs: [] };
  }
}

function run() {
  const queue = loadQueue();
  const now = Date.now();

  let reclassified = 0;
  let archived = 0;
  let deduplicated = 0;
  let routingChanges = 0;
  let tierChanges = 0;

  // --- Phase 1: Reclassify pending_approval → approved, archive stale ---
  for (const moc of queue.mocs) {
    if (moc.status === "pending_approval" || moc.status === "awaiting_approval") {
      const age = now - new Date(moc.submittedAt || 0).getTime();

      if (age > STALE_MS) {
        console.log(`[reclassify] ARCHIVE (stale ${Math.floor(age / 86400000)}d): ${moc.title?.slice(0, 60)}`);
        moc.status = "archived";
        moc.archivedAt = new Date().toISOString();
        moc.archivedReason = `Stale ${moc.status} (${Math.floor(age / 86400000)} days, never advanced)`;
        archived++;
      } else {
        console.log(`[reclassify] APPROVE (was ${moc.status}, tier=${moc.tier}): ${moc.title?.slice(0, 60)}`);
        moc.status = "approved";
        moc.approvedAt = moc.approvedAt || new Date().toISOString();
        moc.reclassifiedFrom = moc.status;
        reclassified++;
      }
    }

    // Re-classify tier with narrowed rules
    // Infrastructure tiers are set by diagnostics/builder and control model selection + verification
    const PROTECTED_TIERS = ["claw_repair", "pipeline_repair", "SPEC_IMPLEMENTATION"];
    const oldTier = moc.tier;
    if (!PROTECTED_TIERS.includes(oldTier)) {
      const newTier = reclassifyTier(moc.title, moc.description);
      if (newTier !== oldTier && moc.status !== "implemented" && moc.status !== "archived") {
        moc.tier = newTier;
        tierChanges++;
      }
    }

    // Update routing
    const newRouting = NEW_ROUTING_MAP[moc.changeType] || ["Engineering"];
    if (JSON.stringify(moc.routedDepartments) !== JSON.stringify(newRouting)) {
      moc.routedDepartments = newRouting;
      routingChanges++;
    }
  }

  // --- Phase 2: Deduplicate active MOCs by changeType::pageGroup ---
  const active = queue.mocs.filter(
    (m) => !["implemented", "archived", "rejected", "consolidated", "triaged"].includes(m.status)
  );

  const groups = {};
  for (const moc of active) {
    const pg = extractPageGroup(moc.description);
    const key = `${moc.changeType}::${pg}`;
    if (!groups[key]) { groups[key] = []; }
    groups[key].push(moc);
  }

  for (const [key, mocs] of Object.entries(groups)) {
    if (mocs.length <= 1) { continue; }

    // Sort by submittedAt descending — keep newest
    mocs.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));

    for (let i = 1; i < mocs.length; i++) {
      const dup = mocs[i];
      console.log(`[reclassify] DEDUP (${key}): archiving older ${dup.id?.slice(0, 12)} — kept ${mocs[0].id?.slice(0, 12)}`);
      dup.status = "archived";
      dup.archivedAt = new Date().toISOString();
      dup.archivedReason = `Deduplicated — newer MOC ${mocs[0].id} covers same area`;
      deduplicated++;
    }
  }

  // --- Summary ---
  console.log(`\n=== Reclassification Summary ===`);
  console.log(`Reclassified (pending/awaiting → approved): ${reclassified}`);
  console.log(`Archived (stale >14d): ${archived}`);
  console.log(`Deduplicated: ${deduplicated}`);
  console.log(`Tier changes: ${tierChanges}`);
  console.log(`Routing changes: ${routingChanges}`);

  const byStatus = {};
  for (const m of queue.mocs) {
    byStatus[m.status] = (byStatus[m.status] || 0) + 1;
  }
  console.log(`\nQueue distribution:`);
  for (const [status, count] of Object.entries(byStatus).sort()) {
    console.log(`  ${status}: ${count}`);
  }

  if (DRY_RUN) {
    console.log("\n[reclassify] DRY RUN — no changes written.");
    return;
  }

  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
  console.log("\n[reclassify] Queue saved.");
}

run();
