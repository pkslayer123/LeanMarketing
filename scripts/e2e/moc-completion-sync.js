#!/usr/bin/env node

/**
 * MOC Completion Sync — Connects MOC workflow outcomes back to findings.
 *
 * Runs as an after-iteration hook. Checks the platform for MOC status updates
 * (approved, rejected, archived, completed) and syncs back to:
 *   1. Local moc-queue.json (status updates)
 *   2. findings.json (resolve findings linked to completed MOCs)
 *   3. fix-queue.json (queue approved MOC findings for implementation)
 *
 * The fix queue is consumed by pre-iteration-fix.js and/or Claude to apply fixes.
 *
 * Usage:
 *   node scripts/e2e/moc-completion-sync.js
 *   node scripts/e2e/moc-completion-sync.js --dry-run
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MOC_QUEUE_FILE = path.join(ROOT, "e2e", "state", "moc-queue.json");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const FIX_QUEUE_FILE = path.join(ROOT, "e2e", "state", "fix-queue.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RECLASSIFY_PENDING = args.includes("--reclassify-pending");

// Supabase client (service role for reading MOC status)
let _supabase = null;
function getSupabase() {
  if (_supabase) {
    return _supabase;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return null;
  }
  try {
    const { createClient } = require("@supabase/supabase-js");
    _supabase = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return _supabase;
  } catch {
    return null;
  }
}

function loadQueue() {
  if (!fs.existsSync(MOC_QUEUE_FILE)) {
    return { version: 2, mocs: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(MOC_QUEUE_FILE, "utf-8"));
  } catch {
    return { version: 2, mocs: [] };
  }
}

function saveQueue(queue) {
  if (DRY_RUN) {
    return;
  }
  fs.writeFileSync(MOC_QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
}

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

function saveFindings(findings) {
  if (DRY_RUN) {
    return;
  }
  fs.writeFileSync(FINDINGS_FILE, JSON.stringify(findings, null, 2) + "\n");
}

function loadFixQueue() {
  if (!fs.existsSync(FIX_QUEUE_FILE)) {
    return { version: 1, items: [], lastSync: null };
  }
  try {
    return JSON.parse(fs.readFileSync(FIX_QUEUE_FILE, "utf-8"));
  } catch {
    return { version: 1, items: [], lastSync: null };
  }
}

function saveFixQueue(fixQueue) {
  if (DRY_RUN) {
    return;
  }
  fixQueue.lastSync = new Date().toISOString();
  const dir = path.dirname(FIX_QUEUE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(FIX_QUEUE_FILE, JSON.stringify(fixQueue, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Platform MOC status check
// ---------------------------------------------------------------------------

/**
 * Check platform MOC status for all pending MOCs in the queue.
 * Returns a map of platformMocId -> { status, stage, is_archived }
 */
async function checkPlatformStatus(platformMocIds) {
  const supabase = getSupabase();
  if (!supabase || platformMocIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("mocs")
    .select("id, status, stage, is_archived, moc_number, title")
    .in("id", platformMocIds);

  if (error) {
    console.error("[moc-completion-sync] Failed to query platform MOCs:", error.message);
    return new Map();
  }

  const statusMap = new Map();
  for (const moc of data ?? []) {
    statusMap.set(moc.id, {
      status: moc.status,
      stage: moc.stage,
      isArchived: moc.is_archived === true,
      mocNumber: moc.moc_number,
      title: moc.title,
    });
  }
  return statusMap;
}

// ---------------------------------------------------------------------------
// Map platform status to local queue status
// ---------------------------------------------------------------------------

function mapPlatformToLocalStatus(platformStatus) {
  const { status, isArchived } = platformStatus;

  if (isArchived) {
    return "archived";
  }

  switch (status) {
    case "completed":
      return "implemented";
    case "approved":
    case "approved_with_conditions":
      return "approved";
    case "rejected":
      return "rejected";
    case "tabled":
    case "on_hold":
      return "archived";
    default:
      // Still in progress (draft, in_review, etc.)
      return null;
  }
}

// ---------------------------------------------------------------------------
// Hygiene pass — archive stale MOCs based on TTL and failure count
// ---------------------------------------------------------------------------

function hygienePass(queue) {
  const now = Date.now();
  const DAY_MS = 86400000;
  let archived = 0;

  for (const moc of queue.mocs) {
    // Skip already-terminal statuses
    if (["implemented", "rejected", "archived", "consolidated"].includes(moc.status)) {
      continue;
    }

    const submittedAt = moc.submittedAt ? new Date(moc.submittedAt).getTime() : 0;
    const ageMs = now - submittedAt;

    // pending_approval older than 7 days → archive
    if (moc.status === "pending_approval" && ageMs > 7 * DAY_MS) {
      moc.status = "archived";
      moc.archivedAt = new Date().toISOString();
      moc.archivedReason = "TTL expired — pending_approval for >7 days";
      archived++;
      continue;
    }

    // approved older than 14 days with no implementation progress → archive
    if (moc.status === "approved" && ageMs > 14 * DAY_MS && !moc.implementedAt) {
      moc.status = "archived";
      moc.archivedAt = new Date().toISOString();
      moc.archivedReason = "TTL expired — approved for >14 days with no progress";
      archived++;
      continue;
    }

    // approved with 3+ lifecycle failures → archive
    if (moc.status === "approved" && (moc.lifecycleFailures ?? 0) >= 3) {
      moc.status = "archived";
      moc.archivedAt = new Date().toISOString();
      moc.archivedReason = `Archived — ${moc.lifecycleFailures} lifecycle failures`;
      archived++;
      continue;
    }
  }

  return archived;
}

/**
 * One-time reclassification of existing junk in pending_approval.
 * Downgrades vision/cosmetic/low-risk MOCs from pending_approval → approved.
 */
function reclassifyPending(queue) {
  const cosmeticPatterns = /\b(contrast|spacing|alignment|dark\s*mode|layout|visual|heading|responsive|truncat|z-index|font|color|padding|margin|icon|cosmetic|ui\/ux)\b/i;
  let downgraded = 0;

  for (const moc of queue.mocs) {
    if (moc.status !== "pending_approval") {
      continue;
    }

    const title = (moc.title ?? "").toLowerCase();
    const desc = (moc.description ?? "").toLowerCase();
    const changeType = moc.changeType ?? "";

    // Downgrade cosmetic/vision findings
    const isCosmetic =
      cosmeticPatterns.test(title) ||
      cosmeticPatterns.test(desc) ||
      changeType === "ui_ux" ||
      /\[vision/i.test(title) ||
      /\[auto-fix\]/i.test(title);

    if (isCosmetic) {
      moc.status = "approved";
      moc.approvedAt = new Date().toISOString();
      moc.reclassifiedFrom = "pending_approval";
      moc.reclassifiedReason = "Cosmetic/vision finding — auto-downgraded";
      downgraded++;
    }
  }

  return downgraded;
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

async function main() {
  console.log("[moc-completion-sync] Syncing MOC completion status...");
  if (DRY_RUN) {
    console.log("[moc-completion-sync] DRY RUN — no files will be modified");
  }

  const queue = loadQueue();
  const findings = loadFindings();
  const fixQueue = loadFixQueue();

  // Find MOCs that need status checking (have platform IDs and aren't final)
  const pendingMocs = queue.mocs.filter(
    (m) =>
      m.platformMocId &&
      !["implemented", "rejected"].includes(m.status)
  );

  if (pendingMocs.length === 0) {
    console.log("[moc-completion-sync] No pending MOCs to check.");
    return;
  }

  console.log(`[moc-completion-sync] Checking ${pendingMocs.length} pending MOCs...`);

  // Check platform status
  const platformMocIds = pendingMocs.map((m) => m.platformMocId);
  const statusMap = await checkPlatformStatus(platformMocIds);

  let updated = 0;
  let findingsResolved = 0;
  let fixesQueued = 0;

  for (const moc of pendingMocs) {
    const platformStatus = statusMap.get(moc.platformMocId);
    if (!platformStatus) {
      continue;
    }

    const newLocalStatus = mapPlatformToLocalStatus(platformStatus);
    if (!newLocalStatus || newLocalStatus === moc.status) {
      continue;
    }

    const prevStatus = moc.status;
    moc.status = newLocalStatus;
    moc.syncedAt = new Date().toISOString();
    updated++;

    const tag = moc.platformMocNumber ? ` [${moc.platformMocNumber}]` : "";
    console.log(`  ${tag} ${prevStatus} → ${newLocalStatus}: ${moc.title.slice(0, 60)}`);

    // Resolve linked findings
    const findingIds = moc.findings?.map((f) => f.id ?? f) ?? [];
    for (const fId of findingIds) {
      const finding = findings.find((f) => f.id === fId);
      if (!finding || finding.status === "resolved") {
        continue;
      }

      if (newLocalStatus === "archived" || newLocalStatus === "rejected") {
        // Archive/reject → resolve as noise or dismissed
        finding.status = "resolved";
        finding.resolution = newLocalStatus === "archived" ? "noise" : "rejected";
        finding.resolvedAt = new Date().toISOString();
        finding.resolvedBy = "moc-completion-sync";
        findingsResolved++;
      } else if (newLocalStatus === "approved" || newLocalStatus === "implemented") {
        // Approved/implemented → resolve as fixed or fix-pending
        finding.status = "resolved";
        finding.resolution = newLocalStatus === "implemented" ? "fixed" : "fix_pending";
        finding.resolvedAt = new Date().toISOString();
        finding.resolvedBy = "moc-completion-sync";
        findingsResolved++;

        // Add to fix queue if approved (not yet implemented)
        if (newLocalStatus === "approved") {
          const existingFix = fixQueue.items.find(
            (item) => item.mocId === moc.id || item.platformMocId === moc.platformMocId
          );
          if (!existingFix) {
            fixQueue.items.push({
              mocId: moc.id,
              platformMocId: moc.platformMocId,
              platformMocNumber: moc.platformMocNumber,
              title: moc.title,
              tier: moc.tier,
              changeType: moc.changeTypeLabel,
              description: moc.description,
              affectedFiles: moc.affectedFiles ?? [],
              findings: findingIds.slice(0, 20), // Cap at 20 finding IDs
              findingCount: findingIds.length,
              queuedAt: new Date().toISOString(),
              status: "pending",
            });
            fixesQueued++;
          }
        }
      }
    }
  }

  // Hygiene pass — archive stale MOCs based on TTL and failure count
  const hygieneArchived = hygienePass(queue);
  if (hygieneArchived > 0) {
    console.log(`[moc-completion-sync] Hygiene pass: archived ${hygieneArchived} stale MOCs`);
  }

  // One-time reclassification of junk in pending_approval
  let reclassified = 0;
  if (RECLASSIFY_PENDING) {
    reclassified = reclassifyPending(queue);
    if (reclassified > 0) {
      console.log(`[moc-completion-sync] Reclassified ${reclassified} cosmetic/vision MOCs from pending_approval → approved`);
    }
  }

  // Save updated data
  saveQueue(queue);
  saveFindings(findings);
  saveFixQueue(fixQueue);

  // Summary
  console.log(`[moc-completion-sync] Done:`);
  console.log(`  MOCs updated: ${updated}`);
  console.log(`  Findings resolved: ${findingsResolved}`);
  console.log(`  Fixes queued: ${fixesQueued}`);
  console.log(`  Fix queue total: ${fixQueue.items.filter((i) => i.status === "pending").length} pending`);
  if (hygieneArchived > 0) {
    console.log(`  Hygiene archived: ${hygieneArchived}`);
  }
  if (reclassified > 0) {
    console.log(`  Reclassified: ${reclassified}`);
  }
}

main().catch((err) => {
  console.error("[moc-completion-sync] Fatal error:", err);
  process.exit(1);
});
