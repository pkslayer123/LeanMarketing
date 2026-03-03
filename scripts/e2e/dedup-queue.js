#!/usr/bin/env node

/**
 * dedup-queue.js — Deduplicate MOCs in the queue.
 *
 * Uses normalized title signatures (order-independent word matching) to find
 * duplicates within the same changeType + pageGroup. Keeps the newest MOC
 * per group and archives older duplicates.
 *
 * Usage:
 *   node scripts/e2e/dedup-queue.js                # Preview
 *   node scripts/e2e/dedup-queue.js --apply         # Apply dedup
 *   node scripts/e2e/dedup-queue.js --archive       # Also check implemented MOCs
 *   node scripts/e2e/dedup-queue.js --auto          # Non-interactive apply (for daemon)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const QUEUE_PATH = path.join(ROOT, "e2e", "state", "moc-queue.json");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply") || args.includes("--auto");
const INCLUDE_ARCHIVE = args.includes("--archive");

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or",
  "not", "no", "with", "auto", "fix", "vision", "bug", "page", "area", "moc",
  "spec", "implementation", "should", "does", "can", "has", "are", "this",
  "that", "from", "was", "were", "been", "have", "will", "but", "all", "its",
  "our", "when",
]);

function normalizeForDedup(text) {
  return (text ?? "")
    .replace(/^\[.*?\]\s*/g, "")
    .replace(/\*\*[^*]+\*\*\s*/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 8)
    .sort()
    .join("_") || "general";
}

function extractPageGroup(description) {
  const match = (description ?? "").match(/\*\*Page area:\*\*\s*(.+)/);
  if (!match) {
    return "unknown";
  }
  return match[1].trim().split("/").slice(0, 3).join("/") || "/";
}

function main() {
  if (!fs.existsSync(QUEUE_PATH)) {
    console.log("No moc-queue.json found.");
    return;
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
  const mocs = queue.mocs ?? [];

  console.log(`Total MOCs: ${mocs.length}`);

  const statusCounts = {};
  for (const m of mocs) {
    statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1;
  }
  console.log(`Statuses: ${JSON.stringify(statusCounts)}`);

  // Group by changeType + pageGroup + normalized title signature
  const groups = {};
  for (let i = 0; i < mocs.length; i++) {
    const m = mocs[i];
    if (m.status === "implemented" && !INCLUDE_ARCHIVE) { continue; }
    if (m.status === "pending_approval" || m.status === "awaiting_approval") { continue; }

    const pg = m.pageGroup ?? extractPageGroup(m.description);
    const sig = normalizeForDedup(m.title);
    const key = `${m.changeType}::${pg}::${sig}`;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push({ moc: m, index: i });
  }

  const dupeGroups = Object.entries(groups).filter(([, entries]) => entries.length > 1);

  if (dupeGroups.length === 0) {
    console.log("No duplicates found.");
    return;
  }

  console.log(`\nFound ${dupeGroups.length} duplicate groups:\n`);

  let totalArchived = 0;
  const indicesToArchive = new Set();

  for (const [key, entries] of dupeGroups) {
    // Prefer approved over archived, then newest first
    entries.sort((a, b) => {
      const statusPriority = { approved: 0, awaiting_closeout: 1, archived: 2, implemented: 3 };
      const aPri = statusPriority[a.moc.status] ?? 4;
      const bPri = statusPriority[b.moc.status] ?? 4;
      if (aPri !== bPri) { return aPri - bPri; }
      return new Date(b.moc.submittedAt ?? 0).getTime() - new Date(a.moc.submittedAt ?? 0).getTime();
    });

    const keeper = entries[0];
    const toArchive = entries.slice(1);

    if (toArchive.length > 3) {
      console.log(`  ${key} — ${entries.length} MOCs (archiving ${toArchive.length})`);
    } else {
      console.log(`  ${key} — ${entries.length} MOCs`);
      for (const dup of toArchive) {
        console.log(`    Archive: ${dup.moc.id} (${dup.moc.status})`);
      }
      console.log(`    Keep:    ${keeper.moc.id} (${keeper.moc.status})`);
    }

    for (const dup of toArchive) {
      indicesToArchive.add(dup.index);
      totalArchived++;
    }
  }

  console.log(`\nWould archive ${totalArchived} duplicate MOCs, keeping ${mocs.length - totalArchived}`);

  if (APPLY) {
    for (let i = 0; i < mocs.length; i++) {
      if (indicesToArchive.has(i) && mocs[i].status !== "archived") {
        mocs[i].status = "archived";
        mocs[i].archivedAt = new Date().toISOString();
        mocs[i].archivedReason = "Deduplicated — newer MOC covers same area";
      }
    }

    // Auto-prune: move archived MOCs to compact dedup index when >500 accumulate
    const archivedMocs = queue.mocs.filter((m) => m.status === "archived");
    if (archivedMocs.length > 500) {
      if (!queue.archivedDedupIndex) { queue.archivedDedupIndex = []; }
      const kept = [];
      for (const m of queue.mocs) {
        if (m.status === "archived") {
          queue.archivedDedupIndex.push({
            changeType: m.changeType,
            pageGroup: m.pageGroup,
            title: (m.title || "").slice(0, 100),
          });
        } else {
          kept.push(m);
        }
      }
      queue.mocs = kept;
      queue.lastPruned = new Date().toISOString();
      console.log(`Auto-pruned ${archivedMocs.length} archived MOCs to compact index`);
    }

    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
    console.log(`\nApplied: ${totalArchived} MOCs archived.`);
  } else {
    console.log("\nRun with --apply to execute dedup.");
  }
}

main();
