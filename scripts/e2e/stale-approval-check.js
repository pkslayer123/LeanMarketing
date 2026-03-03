#!/usr/bin/env node

/**
 * stale-approval-check.js — Find MOCs stuck in pending_approval for too long.
 *
 * Reads moc-queue.json, identifies MOCs with status pending_approval that have
 * been waiting > 7 days. Writes stale-approvals.json for dashboards and alerts.
 *
 * Usage:
 *   node scripts/e2e/stale-approval-check.js              # Human-readable report
 *   node scripts/e2e/stale-approval-check.js --json        # Machine-readable JSON
 *   node scripts/e2e/stale-approval-check.js --threshold 3 # Custom days threshold
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
try {
  require("dotenv").config({ path: path.join(ROOT, ".env.local"), quiet: true });
  require("dotenv").config({ path: path.join(ROOT, "e2e", ".env"), quiet: true });
} catch {}

const QUEUE_PATH = path.join(ROOT, "e2e", "state", "moc-queue.json");
const OUTPUT_PATH = path.join(ROOT, "e2e", "state", "stale-approvals.json");

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const thresholdIdx = args.indexOf("--threshold");
const THRESHOLD_DAYS = thresholdIdx !== -1 ? parseInt(args[thresholdIdx + 1], 10) : 7;
const THRESHOLD_MS = THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) { return null; }
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

function main() {
  const queue = loadJson(QUEUE_PATH);
  if (!queue || !Array.isArray(queue.mocs)) {
    const empty = { generatedAt: new Date().toISOString(), thresholdDays: THRESHOLD_DAYS, stale: [], total: 0 };
    if (jsonMode) { console.log(JSON.stringify(empty)); }
    else { console.log("[stale-approval] No moc-queue.json found or empty."); }
    return;
  }

  const now = Date.now();
  const stale = [];

  for (const moc of queue.mocs) {
    // Check both pending_approval and awaiting_approval statuses
    if (moc.status !== "pending_approval" && moc.status !== "awaiting_approval") {
      continue;
    }

    const submittedAt = moc.submittedAt ? new Date(moc.submittedAt).getTime() : 0;
    if (!submittedAt) { continue; }

    const ageMs = now - submittedAt;
    if (ageMs > THRESHOLD_MS) {
      const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
      stale.push({
        id: moc.id,
        platformMocId: moc.platformMocId || null,
        platformMocNumber: moc.platformMocNumber || null,
        title: (moc.title || "").slice(0, 120),
        tier: moc.tier,
        status: moc.status,
        submittedAt: moc.submittedAt,
        ageDays,
        persona: moc.persona || "unknown",
        changeType: moc.changeType || "unknown",
      });
    }
  }

  // Sort by age descending (oldest first)
  stale.sort((a, b) => b.ageDays - a.ageDays);

  const report = {
    generatedAt: new Date().toISOString(),
    thresholdDays: THRESHOLD_DAYS,
    total: stale.length,
    stale,
  };

  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n");

  if (jsonMode) {
    console.log(JSON.stringify(report));
  } else {
    if (stale.length === 0) {
      console.log(`[stale-approval] No MOCs pending approval > ${THRESHOLD_DAYS} days.`);
    } else {
      console.log(`[stale-approval] ${stale.length} MOC(s) pending approval > ${THRESHOLD_DAYS} days:`);
      for (const s of stale) {
        console.log(`  ${s.id} (${s.ageDays}d) — ${s.title}`);
      }
    }
  }
}

main();
