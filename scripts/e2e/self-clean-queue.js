#!/usr/bin/env node
// Self-clean queue — auto-close stale/duplicate entries, resolve linked findings
// Usage: node scripts/e2e/self-clean-queue.js [--execute] [--dry-run]

const fs = require("fs");
const path = require("path");

const EXECUTE = process.argv.includes("--execute");
const FINDINGS_PATH = path.join(process.cwd(), "e2e", "state", "findings", "findings.json");

async function main() {
  let loadAll, updateEntry, deleteEntry;
  try {
    const qdb = require("./lib/queue-db");
    loadAll = qdb.loadAll;
    updateEntry = qdb.updateEntry;
    deleteEntry = qdb.deleteEntry;
  } catch {
    console.error("Failed to load queue-db module");
    process.exit(1);
  }

  const mocs = await loadAll();
  console.log(`Queue: ${mocs.length} entries`);

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const actions = [];

  // Rule 1: Auto-fixes approved >48h → auto_closed_unverified
  for (const m of mocs) {
    if (m.tier === "auto_fix" && m.status === "approved") {
      const age = m.approvedAt ? now - new Date(m.approvedAt).getTime() : 0;
      if (age > 2 * DAY) {
        actions.push({ type: "update", id: m.id, fields: { status: "auto_closed_unverified" }, rule: 1, title: m.title });
      }
    }
  }

  // Rule 2: Auto-approvals approved >7d → auto_closed_unverified
  for (const m of mocs) {
    if (m.tier === "auto_approve" && m.status === "approved") {
      const age = m.approvedAt ? now - new Date(m.approvedAt).getTime() : 0;
      if (age > 7 * DAY) {
        actions.push({ type: "update", id: m.id, fields: { status: "auto_closed_unverified" }, rule: 2, title: m.title });
      }
    }
  }

  // Rule 3: Duplicate titles → archive all but latest
  const byTitle = {};
  for (const m of mocs) {
    if (!byTitle[m.title]) { byTitle[m.title] = []; }
    byTitle[m.title].push(m);
  }
  for (const [title, group] of Object.entries(byTitle)) {
    if (group.length <= 1) { continue; }
    const sorted = group.sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].status !== "archived" && sorted[i].status !== "consolidated") {
        actions.push({ type: "update", id: sorted[i].id, fields: { status: "archived" }, rule: 3, title });
      }
    }
  }

  // Rule 4: Old archived/consolidated >14d → remove
  for (const m of mocs) {
    if ((m.status === "archived" || m.status === "consolidated") && m.closedAt) {
      const age = now - new Date(m.closedAt).getTime();
      if (age > 14 * DAY) {
        actions.push({ type: "delete", id: m.id, rule: 4, title: m.title });
      }
    }
  }

  // Rule 5: Implemented without commit_sha older than 7 days → delete
  for (const m of mocs) {
    if (m.status === "implemented" && !m.commitSha) {
      const ts = m.implementedAt || m.approvedAt || m.submittedAt;
      const age = ts ? now - new Date(ts).getTime() : 0;
      if (age > 7 * DAY) {
        actions.push({ type: "delete", id: m.id, rule: 5, title: m.title });
      }
    }
  }

  // Report
  const byRule = [0, 0, 0, 0, 0, 0];
  for (const a of actions) { byRule[a.rule]++; }
  console.log(`\nActions (${EXECUTE ? "EXECUTING" : "DRY RUN"}):`);
  console.log(`  Rule 1 (stale auto_fix): ${byRule[1]}`);
  console.log(`  Rule 2 (stale auto_approve): ${byRule[2]}`);
  console.log(`  Rule 3 (duplicates): ${byRule[3]}`);
  console.log(`  Rule 4 (old archived): ${byRule[4]}`);
  console.log(`  Rule 5 (unverified implemented): ${byRule[5]}`);
  console.log(`  Total: ${actions.length}`);

  if (!EXECUTE) {
    console.log("\nDry run — pass --execute to apply.");
    return;
  }

  // Execute
  let applied = 0;
  const closedIds = [];
  for (const a of actions) {
    try {
      if (a.type === "update") {
        await updateEntry(a.id, a.fields);
        if (a.fields.status === "auto_closed_unverified" || a.fields.status === "archived") {
          closedIds.push(a.id);
        }
      } else if (a.type === "delete") {
        await deleteEntry(a.id);
      }
      applied++;
    } catch (e) {
      console.warn(`Failed ${a.type} on ${a.id}:`, e.message);
    }
  }

  // Resolve associated findings
  if (closedIds.length > 0 && fs.existsSync(FINDINGS_PATH)) {
    try {
      const findings = JSON.parse(fs.readFileSync(FINDINGS_PATH, "utf-8"));
      let changed = false;
      for (const f of findings) {
        if (closedIds.includes(f.mocId) && f.status !== "resolved") {
          f.status = "resolved";
          f.resolvedAt = new Date().toISOString();
          f.resolvedBy = "self-clean-queue";
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(FINDINGS_PATH, JSON.stringify(findings, null, 2) + "\n", "utf-8");
        console.log("Resolved linked findings for closed MOCs.");
      }
    } catch { /* non-fatal */ }
  }

  console.log(`\nApplied ${applied}/${actions.length} actions.`);
}

main().catch(console.error);
