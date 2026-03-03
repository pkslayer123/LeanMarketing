#!/usr/bin/env node

/**
 * Update BUILD-SPEC.md from completed MOCs — appends new entries to the
 * Change Attribution Log section.
 *
 * Runs after commit tracking in the orchestrator post-iteration phase.
 * Append-only — never deletes existing BUILD-SPEC content.
 *
 * Usage:
 *   node scripts/e2e/update-docs-from-mocs.js              # Apply updates
 *   node scripts/e2e/update-docs-from-mocs.js --dry-run     # Preview only
 *   node scripts/e2e/update-docs-from-mocs.js --json        # Machine-readable
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const BUILD_SPEC = path.join(ROOT, "docs", "BUILD-SPEC.md");
const MOC_QUEUE = path.join(ROOT, "e2e", "state", "moc-queue.json");
const TRACKER_FILE = path.join(ROOT, "e2e", "state", "docs-update-tracker.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const jsonOutput = args.includes("--json");

function loadTracker() {
  if (!fs.existsSync(TRACKER_FILE)) {
    return { documented: {} }; // mocId -> { documentedAt }
  }
  try {
    return JSON.parse(fs.readFileSync(TRACKER_FILE, "utf-8"));
  } catch {
    return { documented: {} };
  }
}

function saveTracker(tracker) {
  const dir = path.dirname(TRACKER_FILE);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

  // Keep manageable size (last 500 entries)
  const entries = Object.entries(tracker.documented);
  if (entries.length > 500) {
    tracker.documented = Object.fromEntries(entries.slice(-500));
  }
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2) + "\n");
}

/**
 * Map MOC change type to BUILD-SPEC section name.
 */
function changeTypeToSection(changeType) {
  const map = {
    bug_fix: "Cross-Cutting: Bug Fixes",
    feature: "Feature Implementation",
    infrastructure: "Infrastructure",
    security: "Security",
    ui_ux: "UI Components",
    migration: "Database Schema",
    dependency: "Infrastructure",
    api_change: "API Changes",
  };
  return map[changeType] || "Cross-Cutting";
}

/**
 * Map MOC to a source label.
 */
function mocToSource(moc) {
  if (moc.verified) { return `Verified (${moc.commit_sha?.slice(0, 7) || "commit"})`; }
  if (moc.source === "persona") { return `Persona: ${moc.persona || "system"}`; }
  return moc.source || "Pipeline";
}

function main() {
  if (!fs.existsSync(BUILD_SPEC)) {
    if (!jsonOutput) { console.log("[update-docs] BUILD-SPEC.md not found."); }
    if (jsonOutput) { console.log(JSON.stringify({ error: "no-build-spec", added: 0 })); }
    return;
  }

  if (!fs.existsSync(MOC_QUEUE)) {
    if (!jsonOutput) { console.log("[update-docs] MOC queue not found."); }
    if (jsonOutput) { console.log(JSON.stringify({ error: "no-queue", added: 0 })); }
    return;
  }

  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(MOC_QUEUE, "utf-8"));
  } catch {
    if (!jsonOutput) { console.log("[update-docs] Could not parse moc-queue.json"); }
    return;
  }

  const tracker = loadTracker();
  const mocs = queue.mocs ?? [];

  // Find completed MOCs not yet documented
  const newlyCompleted = mocs.filter((m) => {
    const isComplete = m.status === "implemented" || m.status === "auto_closed_unverified";
    const notDocumented = !tracker.documented[m.id];
    return isComplete && notDocumented && m.implementedAt;
  });

  if (newlyCompleted.length === 0) {
    if (!jsonOutput) { console.log("[update-docs] No new completed MOCs to document."); }
    if (jsonOutput) { console.log(JSON.stringify({ scanned: mocs.length, added: 0 })); }
    return;
  }

  if (!jsonOutput) {
    console.log(`[update-docs] Found ${newlyCompleted.length} completed MOCs to document.`);
  }

  // Build new table rows
  const today = new Date().toISOString().split("T")[0];
  const newRows = [];

  for (const moc of newlyCompleted) {
    const section = changeTypeToSection(moc.changeType);
    const title = (moc.title || "Untitled").replace(/\[.*?\]\s*/g, "").slice(0, 70);
    const source = mocToSource(moc);
    const verifiedTag = moc.verified ? " [verified]" : "";
    const mocNum = moc.platformMocNumber ? `${moc.platformMocNumber}: ` : "";

    newRows.push(
      `| ${today} | Pipeline       | ${section.padEnd(23)} | ${(mocNum + title + verifiedTag).padEnd(76)} | ${source.padEnd(23)} |`
    );

    if (!dryRun) {
      tracker.documented[moc.id] = { documentedAt: new Date().toISOString() };
    }
  }

  if (dryRun) {
    if (!jsonOutput) {
      console.log("[update-docs] Would add these rows to Change Attribution Log:");
      for (const row of newRows) {
        console.log(`  ${row}`);
      }
    }
    if (jsonOutput) {
      console.log(JSON.stringify({ added: newRows.length, dryRun: true, rows: newRows }));
    }
    return;
  }

  // Find the last row in the Change Attribution Log table and insert after it
  const content = fs.readFileSync(BUILD_SPEC, "utf-8");
  const lines = content.split("\n");

  // Find the table boundary: look for the "---" separator line after the header
  let logHeaderIdx = -1;
  let lastTableRowIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## Change Attribution Log")) {
      logHeaderIdx = i;
    }
    // Once we're in the table, track the last row
    if (logHeaderIdx !== -1 && i > logHeaderIdx && lines[i].startsWith("|")) {
      lastTableRowIdx = i;
    }
    // Stop at the next section
    if (logHeaderIdx !== -1 && lastTableRowIdx !== -1 && lines[i].startsWith("---") && i > lastTableRowIdx) {
      break;
    }
  }

  if (lastTableRowIdx === -1) {
    if (!jsonOutput) { console.log("[update-docs] Could not find Change Attribution Log table."); }
    return;
  }

  // Insert new rows after the last table row
  const before = lines.slice(0, lastTableRowIdx + 1);
  const after = lines.slice(lastTableRowIdx + 1);
  const updated = [...before, ...newRows, ...after].join("\n");

  fs.writeFileSync(BUILD_SPEC, updated);
  saveTracker(tracker);

  if (jsonOutput) {
    console.log(JSON.stringify({ added: newRows.length, total: newlyCompleted.length }));
  } else {
    console.log(`[update-docs] Added ${newRows.length} entries to BUILD-SPEC.md Change Attribution Log.`);
  }
}

main();
