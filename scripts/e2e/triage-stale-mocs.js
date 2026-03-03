#!/usr/bin/env node

/**
 * triage-stale-mocs.js -- Deduplicate and triage stale implemented MOCs.
 *
 * Each E2E iteration creates new MOCs for the same pages, resulting in dozens
 * of duplicates per page path. This script consolidates them by:
 *
 *   1. Grouping stale implemented MOCs by page path
 *   2. Keeping the newest MOC per page as the "representative"
 *   3. Merging unique findings from older duplicates into the representative
 *   4. Marking older duplicates as status: "consolidated"
 *   5. Scoring representatives by priority (critical bugs > cosmetic > informational)
 *   6. Resetting representatives to "approved" so they re-enter the pipeline
 *   7. Marking verified MOCs (those with commit_sha) with verified: true
 *
 * A MOC is "stale" if it is implemented AND autoClosed AND has no commit_sha.
 * MOCs that are awaiting_approval, pending, pending_review, or approved are
 * never touched. MOCs with commit_sha or that weren't autoClosed are left alone.
 *
 * Usage:
 *   node scripts/e2e/triage-stale-mocs.js                    # Full triage
 *   node scripts/e2e/triage-stale-mocs.js --dry-run           # Preview without writing
 *   node scripts/e2e/triage-stale-mocs.js --priority 3        # Only reset priority <= 3
 *   node scripts/e2e/triage-stale-mocs.js --verbose           # Show per-page consolidation
 *
 * @see scripts/e2e/verify-implemented.js (upstream: categorizes implemented MOCs)
 * @see scripts/e2e/moc-auto-fix.js (downstream: processes approved MOCs)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MOC_QUEUE_FILE = path.join(ROOT, "e2e", "state", "moc-queue.json");
const REPORT_FILE = path.join(ROOT, "e2e", "reports", "stale-triage-report.md");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");
const priorityIdx = args.indexOf("--priority");
const PRIORITY_CUTOFF = priorityIdx !== -1 ? parseInt(args[priorityIdx + 1], 10) : Infinity;

// ---------------------------------------------------------------------------
// Priority tiers
// ---------------------------------------------------------------------------

const PRIORITY_LABELS = {
  1: "Critical (500/error bug fix)",
  2: "High (security patch)",
  3: "Medium (bug fix)",
  4: "Medium (API change)",
  5: "Low (cosmetic / UI/UX)",
  6: "Low (infrastructure / process)",
  7: "Informational (vision / oracle suggestion)",
};

/**
 * Score a MOC by priority. Lower number = higher priority.
 */
function scorePriority(moc) {
  const title = (moc.title || "").toLowerCase();
  const changeType = (moc.changeType || "").toLowerCase();
  const changeTypeLabel = (moc.changeTypeLabel || "").toLowerCase();

  // Priority 1: Bug fix with 500 or error in title
  if (
    (changeType === "bug_fix" || changeTypeLabel.includes("bug fix")) &&
    (/\b500\b/.test(title) || /\berror\b/.test(title))
  ) {
    return 1;
  }

  // Priority 2: Security patch
  if (changeType === "security" || changeTypeLabel.includes("security")) {
    return 2;
  }

  // Priority 3: Other bug fixes
  if (changeType === "bug_fix" || changeTypeLabel.includes("bug fix")) {
    return 3;
  }

  // Priority 4: API change
  if (changeType === "api_change" || changeTypeLabel.includes("api change")) {
    return 4;
  }

  // Priority 5: UI/UX redesign (cosmetic)
  if (changeType === "ui_ux" || changeTypeLabel.includes("ui/ux")) {
    return 5;
  }

  // Priority 6: Infrastructure change (process)
  if (changeType === "infrastructure" || changeTypeLabel.includes("infrastructure")) {
    return 6;
  }

  // Priority 7: Vision insight / Oracle suggestion
  if (/\[vision/i.test(title) || /\[oracle/i.test(title)) {
    return 7;
  }

  // Default: treat as medium
  return 5;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function loadQueue() {
  if (!fs.existsSync(MOC_QUEUE_FILE)) {
    console.error("ERROR: moc-queue.json not found at", MOC_QUEUE_FILE);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(MOC_QUEUE_FILE, "utf-8"));
  } catch (err) {
    console.error("ERROR: Failed to parse moc-queue.json:", err.message);
    process.exit(1);
  }
}

function saveQueue(queue) {
  fs.writeFileSync(MOC_QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Page path extraction
// ---------------------------------------------------------------------------

/**
 * Extract the page path from a MOC description or title.
 * Returns a normalized path string (e.g., "/mocs", "/admin/permissions").
 */
function extractPagePath(moc) {
  const desc = moc.description || "";
  const title = moc.title || "";

  // Try explicit **Page area:** from description first
  const pageAreaMatch = desc.match(/\*\*Page area:\*\*\s*(\S+)/);
  if (pageAreaMatch) {
    return normalizePagePath(pageAreaMatch[1]);
  }

  // Look for URL paths in title
  const titlePathMatch = title.match(/\/(admin|mocs?|review|account|my-department|auth|api|pricing|free-onboarding)[/\w-]*/);
  if (titlePathMatch) {
    return normalizePagePath(titlePathMatch[0]);
  }

  // Try description for URL paths
  const descPathMatch = desc.match(/\/(admin|mocs?|review|account|my-department|auth|api|pricing|free-onboarding)[/\w-]*/);
  if (descPathMatch) {
    return normalizePagePath(descPathMatch[0]);
  }

  return "unknown";
}

/**
 * Normalize a page path by removing UUIDs and trailing slashes.
 * /moc/53532d74-c92c-4e13-a52f-010307d7b4ed/stage-3 -> /moc/[id]/stage-3
 */
function normalizePagePath(pagePath) {
  let cleaned = pagePath
    // Remove UUIDs
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/[id]")
    // Remove trailing slash
    .replace(/\/$/, "");
  return cleaned || "/";
}

// ---------------------------------------------------------------------------
// Findings extraction from description
// ---------------------------------------------------------------------------

/**
 * Extract individual finding lines from a MOC description.
 * Returns an array of finding text strings (deduplicated).
 */
function extractFindingsFromDescription(moc) {
  const desc = moc.description || "";
  const findings = [];

  // Match lines like "- [Persona] finding text\n  Classification: ..."
  const findingPattern = /^- \[([^\]]+)\]\s*(.+)/gm;
  let match;
  while ((match = findingPattern.exec(desc)) !== null) {
    const persona = match[1];
    let text = match[2].trim();
    // Remove trailing classification line if it got captured
    text = text.replace(/\s*Classification:.*$/i, "");
    findings.push({ persona, text });
  }

  return findings;
}

/**
 * Deduplicate findings by normalizing their text (lowercase, trim, collapse whitespace).
 */
function deduplicateFindings(allFindings) {
  const seen = new Set();
  const unique = [];

  for (const f of allFindings) {
    const key = f.text.toLowerCase().replace(/\s+/g, " ").trim().substring(0, 200);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(f);
    }
  }

  return unique;
}

// ---------------------------------------------------------------------------
// Main triage logic
// ---------------------------------------------------------------------------

function main() {
  console.log("=== Stale MOC Triage ===\n");

  const queue = loadQueue();
  const allMocs = queue.mocs;

  // Identify the different categories
  const staleMocs = allMocs.filter(
    (m) => m.status === "implemented" && m.autoClosed === true && !m.commit_sha
  );
  const verifiedMocs = allMocs.filter(
    (m) => m.status === "implemented" && !!m.commit_sha
  );
  const manualMocs = allMocs.filter(
    (m) => m.status === "implemented" && m.autoClosed !== true && !m.commit_sha
  );
  const nonImplemented = allMocs.filter((m) => m.status !== "implemented");

  console.log(`Total MOCs in queue: ${allMocs.length}`);
  console.log(`  Stale (autoClosed, no commit_sha): ${staleMocs.length}`);
  console.log(`  Verified (has commit_sha): ${verifiedMocs.length}`);
  console.log(`  Manual (not autoClosed, no commit_sha): ${manualMocs.length}`);
  console.log(`  Non-implemented: ${nonImplemented.length}`);
  console.log();

  if (staleMocs.length === 0) {
    console.log("No stale MOCs to triage.");
    return;
  }

  // Step 1: Mark verified MOCs
  let verifiedCount = 0;
  for (const moc of verifiedMocs) {
    if (!moc.verified) {
      moc.verified = true;
      verifiedCount++;
    }
  }
  if (verifiedCount > 0) {
    console.log(`Marked ${verifiedCount} verified MOCs with verified: true`);
  }

  // Step 2: Group stale MOCs by page path
  const pageGroups = {};
  for (const moc of staleMocs) {
    const page = extractPagePath(moc);
    if (!pageGroups[page]) {
      pageGroups[page] = [];
    }
    pageGroups[page].push(moc);
  }

  const pageCount = Object.keys(pageGroups).length;
  console.log(`Grouped ${staleMocs.length} stale MOCs into ${pageCount} page groups.\n`);

  // Step 3: For each page group, consolidate
  const representatives = [];
  let totalConsolidated = 0;

  // Build a lookup of MOC id -> MOC object for direct mutation
  const mocById = {};
  for (const moc of allMocs) {
    mocById[moc.id] = moc;
  }

  for (const [page, mocs] of Object.entries(pageGroups)) {
    // Sort by submittedAt descending -- newest first
    mocs.sort((a, b) => {
      const dateA = a.submittedAt ? new Date(a.submittedAt).getTime() : 0;
      const dateB = b.submittedAt ? new Date(b.submittedAt).getTime() : 0;
      return dateB - dateA;
    });

    const representative = mocs[0];
    const duplicates = mocs.slice(1);

    // Collect all unique findings from all MOCs in this group
    const allFindings = [];
    const allFindingIds = new Set();

    for (const moc of mocs) {
      // Union finding IDs
      if (moc.findings && Array.isArray(moc.findings)) {
        for (const fid of moc.findings) {
          allFindingIds.add(fid);
        }
      }

      // Extract findings text from descriptions
      const descFindings = extractFindingsFromDescription(moc);
      allFindings.push(...descFindings);
    }

    const uniqueFindings = deduplicateFindings(allFindings);

    // Score the representative
    const priority = scorePriority(representative);

    // Mark duplicates as consolidated
    for (const dup of duplicates) {
      const target = mocById[dup.id];
      if (target) {
        target.status = "consolidated";
        target.consolidatedInto = representative.id;
      }
    }
    totalConsolidated += duplicates.length;

    // Append consolidated findings section to representative description
    if (duplicates.length > 0 && uniqueFindings.length > 0) {
      const rep = mocById[representative.id];
      const consolidatedSection = buildConsolidatedSection(
        uniqueFindings,
        duplicates.length
      );
      rep.description = (rep.description || "") + "\n\n" + consolidatedSection;
    }

    // Union finding IDs into representative
    const rep = mocById[representative.id];
    rep.findings = [...allFindingIds];

    // Mark representative as triaged (dedup only — no re-entry into pipeline)
    if (priority <= PRIORITY_CUTOFF) {
      rep.status = "triaged";
      rep.triaged = true;
      rep.triagedAt = new Date().toISOString();
      rep.triageNote = `Consolidated from ${duplicates.length + 1} duplicates (${duplicates.length} merged). Priority: ${priority} (${PRIORITY_LABELS[priority] || "unknown"})`;
    }

    representatives.push({
      moc: rep,
      page,
      priority,
      duplicateCount: duplicates.length,
      uniqueFindingCount: uniqueFindings.length,
      reset: priority <= PRIORITY_CUTOFF,
    });

    if (VERBOSE) {
      console.log(`  Page: ${page}`);
      console.log(`    Representative: ${representative.platformMocNumber} — ${representative.title.substring(0, 60)}`);
      console.log(`    Duplicates consolidated: ${duplicates.length}`);
      console.log(`    Unique findings: ${uniqueFindings.length}`);
      console.log(`    Priority: ${priority} (${PRIORITY_LABELS[priority] || "unknown"})`);
      console.log(`    Triaged: ${priority <= PRIORITY_CUTOFF ? "yes" : "no (filtered by --priority)"}`);
      console.log();
    }
  }

  // Sort representatives by priority
  representatives.sort((a, b) => a.priority - b.priority);

  const resetCount = representatives.filter((r) => r.reset).length;
  const skippedCount = representatives.filter((r) => !r.reset).length;

  // Step 4: Summary output
  console.log("--- Summary ---");
  console.log(`  Stale MOCs processed: ${staleMocs.length}`);
  console.log(`  Consolidated (marked as duplicates): ${totalConsolidated}`);
  console.log(`  Representative MOCs: ${representatives.length}`);
  console.log(`  Marked as "triaged": ${resetCount}`);
  if (skippedCount > 0) {
    console.log(`  Skipped (below priority cutoff): ${skippedCount}`);
  }
  console.log();

  // By priority tier
  console.log("--- By Priority ---");
  const byPriority = {};
  for (const r of representatives) {
    if (!byPriority[r.priority]) {
      byPriority[r.priority] = [];
    }
    byPriority[r.priority].push(r);
  }
  for (let p = 1; p <= 7; p++) {
    const group = byPriority[p];
    if (group && group.length > 0) {
      console.log(`  Priority ${p} (${PRIORITY_LABELS[p]}): ${group.length} MOCs`);
    }
  }
  console.log();

  // By page (top pages by finding count)
  console.log("--- Top Pages by Duplicates ---");
  const sorted = [...representatives].sort((a, b) => b.duplicateCount - a.duplicateCount);
  for (const r of sorted.slice(0, 15)) {
    console.log(`  ${r.page}: ${r.duplicateCount + 1} total (${r.duplicateCount} consolidated) — P${r.priority}`);
  }
  if (sorted.length > 15) {
    console.log(`  ... and ${sorted.length - 15} more pages`);
  }
  console.log();

  // Step 5: Generate report
  const report = generateReport(representatives, staleMocs.length, totalConsolidated, resetCount, verifiedCount);
  const reportsDir = path.dirname(REPORT_FILE);
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  if (DRY_RUN) {
    console.log("[DRY RUN] Would write report to:", path.relative(ROOT, REPORT_FILE));
    console.log("[DRY RUN] Would modify moc-queue.json:");
    console.log(`  - Mark ${totalConsolidated} MOCs as "consolidated"`);
    console.log(`  - Mark ${resetCount} representatives as "triaged"`);
    console.log(`  - Mark ${verifiedCount} MOCs with verified: true`);
    console.log(`  - Increment version from ${queue.version} to ${queue.version + 1}`);
  } else {
    // Write report
    fs.writeFileSync(REPORT_FILE, report, "utf-8");
    console.log(`Report written to: ${path.relative(ROOT, REPORT_FILE)}`);

    // Save queue with incremented version
    queue.version = (queue.version || 1) + 1;
    saveQueue(queue);
    console.log(`Queue saved (version ${queue.version}). ${totalConsolidated} consolidated, ${resetCount} reset.`);
  }
}

// ---------------------------------------------------------------------------
// Consolidated findings section builder
// ---------------------------------------------------------------------------

function buildConsolidatedSection(uniqueFindings, duplicateCount) {
  const lines = [];
  lines.push(`### Consolidated Findings (from ${duplicateCount} duplicate MOCs)`);
  lines.push("");

  for (const f of uniqueFindings) {
    lines.push(`- [${f.persona}] ${f.text}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function generateReport(representatives, totalStale, totalConsolidated, resetCount, verifiedCount) {
  const now = new Date().toISOString().split("T")[0];
  const lines = [];

  lines.push("# Stale MOC Triage Report");
  lines.push(`Generated: ${now}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Stale implemented MOCs processed | ${totalStale} |`);
  lines.push(`| Consolidated as duplicates | ${totalConsolidated} |`);
  lines.push(`| Representative MOCs | ${representatives.length} |`);
  lines.push(`| Marked as "triaged" | ${resetCount} |`);
  lines.push(`| Verified MOCs (commit_sha marked) | ${verifiedCount} |`);
  lines.push("");

  // By priority
  lines.push("## By Priority");
  lines.push("");
  lines.push("| Priority | Label | Count |");
  lines.push("| --- | --- | --- |");

  const byPriority = {};
  for (const r of representatives) {
    if (!byPriority[r.priority]) {
      byPriority[r.priority] = 0;
    }
    byPriority[r.priority]++;
  }

  for (let p = 1; p <= 7; p++) {
    const count = byPriority[p] || 0;
    if (count > 0) {
      lines.push(`| ${p} | ${PRIORITY_LABELS[p]} | ${count} |`);
    }
  }
  lines.push(`| | **Total** | **${representatives.length}** |`);
  lines.push("");

  // By page (sorted by duplicate count)
  lines.push("## By Page (most duplicates first)");
  lines.push("");
  lines.push("| Page | Duplicates | Findings | Priority | Representative |");
  lines.push("| --- | --- | --- | --- | --- |");

  const sorted = [...representatives].sort((a, b) => b.duplicateCount - a.duplicateCount);
  for (const r of sorted) {
    const mocRef = r.moc.platformMocNumber || r.moc.id;
    lines.push(
      `| ${r.page} | ${r.duplicateCount} | ${r.uniqueFindingCount} | P${r.priority} | ${mocRef} |`
    );
  }
  lines.push("");

  // Full list of representatives by priority
  lines.push("## Representative MOCs (sorted by priority)");
  lines.push("");

  for (let p = 1; p <= 7; p++) {
    const group = representatives.filter((r) => r.priority === p);
    if (group.length === 0) {
      continue;
    }

    lines.push(`### Priority ${p}: ${PRIORITY_LABELS[p]} (${group.length})`);
    lines.push("");

    for (const r of group) {
      const title = (r.moc.title || "").substring(0, 100);
      const mocRef = r.moc.platformMocNumber || r.moc.id;
      const resetLabel = r.reset ? "TRIAGED" : "kept as implemented";
      lines.push(`- **${mocRef}** [${resetLabel}] ${title}`);
      lines.push(`  Page: \`${r.page}\` | Duplicates merged: ${r.duplicateCount} | Unique findings: ${r.uniqueFindingCount}`);
      lines.push(`  Change type: ${r.moc.changeTypeLabel || r.moc.changeType || "unknown"} | Risk: ${r.moc.riskLevel || "unknown"}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main();
