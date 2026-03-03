#!/usr/bin/env node

/**
 * cleanup-archived-mocs.js — Soft-delete archived MOCs from the platform
 * and remove them from the queue.
 *
 * These are findings that were classified as noise/test_expectations but
 * had MOCs created before the current classifier existed. They should
 * never have been MOCs.
 *
 * Usage:
 *   node scripts/e2e/cleanup-archived-mocs.js             # Dry run
 *   node scripts/e2e/cleanup-archived-mocs.js --execute    # Actually delete
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_FILE = path.join(__dirname, "..", "..", "e2e", "state", "moc-queue.json");
const COOLDOWN_FILE = path.join(__dirname, "..", "..", "e2e", "state", "cleanup-last-run.json");

const execute = process.argv.includes("--execute");
const COOLDOWN_HOURS = 24;

async function main() {
  // Cooldown guard — skip if last run was within COOLDOWN_HOURS
  if (execute && fs.existsSync(COOLDOWN_FILE)) {
    try {
      const cooldown = JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf8"));
      const lastRun = new Date(cooldown.lastRun).getTime();
      const hoursSince = (Date.now() - lastRun) / 3600000;
      if (hoursSince < COOLDOWN_HOURS) {
        console.log(`[cleanup-archived-mocs] Cooldown: last run ${hoursSince.toFixed(1)}h ago (need ${COOLDOWN_HOURS}h). Skipping.`);
        return;
      }
    } catch {
      // Corrupted cooldown file — proceed
    }
  }

  if (!fs.existsSync(QUEUE_FILE)) {
    console.log("No moc-queue.json found. Nothing to clean up.");
    return;
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
  const archived = queue.mocs.filter((m) => m.status === "archived" && m.platformMocId);

  console.log(`Found ${archived.length} archived MOCs in queue.`);

  if (archived.length === 0) {
    console.log("Nothing to clean up.");
    return;
  }

  const ids = archived.map((m) => m.platformMocId);
  console.log(`Platform MOC IDs to soft-delete: ${ids.length}`);

  if (!execute) {
    console.log("\n[DRY RUN] Would delete these MOCs:");
    for (const m of archived.slice(0, 10)) {
      console.log(`  ${m.platformMocNumber ?? m.platformMocId} — ${m.title.slice(0, 80)}`);
    }
    if (archived.length > 10) {
      console.log(`  ... and ${archived.length - 10} more`);
    }
    console.log("\nRun with --execute to actually delete.");
    return;
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  const { createClient } = require("@supabase/supabase-js");
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // Hard-delete in batches of 50 (these were noise — should never have been MOCs)
  const BATCH = 50;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const { error } = await supabase
      .from("mocs")
      .delete()
      .in("id", batch);

    if (error) {
      console.error(`Batch ${i / BATCH + 1} failed:`, error.message);
    } else {
      deleted += batch.length;
      console.log(`Deleted batch ${i / BATCH + 1}: ${batch.length} MOCs (${deleted}/${ids.length})`);
    }
  }

  // Remove from queue
  const before = queue.mocs.length;
  queue.mocs = queue.mocs.filter((m) => m.status !== "archived");
  const after = queue.mocs.length;
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");

  // Record cooldown timestamp
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify({ lastRun: new Date().toISOString() }, null, 2) + "\n");

  console.log(`\nQueue: ${before} → ${after} entries (removed ${before - after} archived)`);
  console.log(`Platform: soft-deleted ${deleted} MOCs`);
}

main().catch(console.error);
