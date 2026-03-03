#!/usr/bin/env node

/**
 * MOC Commit Tracker — Verifies approved MOCs via auto-fix commit evidence.
 *
 * STRICT matching to prevent false positives:
 *   1. Only matches commits from moc-auto-fix.js (structured commit messages)
 *   2. Requires commit to touch at least one file in moc.sourceFiles
 *   3. Sets status to "committed" (intermediate), NOT "implemented"
 *   4. Full "implemented" status requires verify-fix-impact.js confirmation
 *
 * Usage:
 *   node scripts/e2e/moc-commit-tracker.js              # Scan and update
 *   node scripts/e2e/moc-commit-tracker.js --dry-run     # Preview only
 *   node scripts/e2e/moc-commit-tracker.js --json        # Machine-readable output
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { loadQueue, saveQueue } = require("./submit-moc.js");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const jsonOutput = args.includes("--json");

/**
 * Find auto-fix commits that match a specific MOC.
 * Only matches structured commit messages from moc-auto-fix.js.
 */
function findAutoFixCommits(moc) {
  const matches = [];

  try {
    // Strategy 1: Search for commits with the MOC's local ID in the message
    if (moc.id) {
      const idCommits = gitGrep(moc.id);
      matches.push(...idCommits);
    }

    // Strategy 2: Search for auto-fix commit pattern with MOC title keywords
    // moc-auto-fix.js commits look like: "fix: auto-fix N MOC(s) — MOC-2026-NNNNNN"
    // Tightened: require 3+ keyword overlap to prevent false positives (was 2)
    const autoFixCommits = gitGrep("fix: auto-fix");
    const titleWords = extractKeywords(moc.title);

    for (const commit of autoFixCommits) {
      if (matches.some((m) => m.sha === commit.sha)) { continue; }
      const msgWords = extractKeywords(commit.message);
      const overlap = titleWords.filter((w) => msgWords.includes(w));
      if (overlap.length >= 3) {
        matches.push(commit);
      }
    }

    // Strategy 3: Search by platform MOC number if available
    if (moc.platformMocNumber) {
      const numCommits = gitGrep(moc.platformMocNumber);
      for (const c of numCommits) {
        if (!matches.some((m) => m.sha === c.sha)) {
          matches.push(c);
        }
      }
    }
  } catch {
    // git not available
  }

  // Filter: commit must touch at least one file in moc.sourceFiles (exact path match)
  const sourceFiles = moc.sourceFiles ?? [];
  if (sourceFiles.length > 0 && matches.length > 0) {
    return matches.filter((commit) => {
      const changedFiles = getCommitFiles(commit.sha);
      return sourceFiles.some((sf) => {
        const normalized = sf.replace(/\\/g, "/");
        return changedFiles.some((cf) => cf === normalized || normalized.endsWith("/" + cf) || cf.endsWith("/" + normalized));
      });
    });
  }

  // No sourceFiles — require BOTH auto-fix pattern AND platform MOC number
  if (moc.platformMocNumber) {
    return matches.filter((c) =>
      (c.message.includes("auto-fix") || c.message.includes("fix(auto)")) &&
      c.message.includes(moc.platformMocNumber)
    );
  }
  // No sourceFiles AND no platformMocNumber — can't verify, skip to avoid false positives
  return [];
}

/**
 * Search git log for commits matching a grep pattern.
 */
function gitGrep(pattern) {
  try {
    const output = execSync(
      `git log --oneline --since="14 days ago" --grep="${pattern.replace(/"/g, '\\"')}"`,
      { encoding: "utf-8", timeout: 5000, cwd: ROOT }
    ).trim();
    if (!output) { return []; }
    return output.split("\n").map((line) => {
      const [sha, ...rest] = line.split(" ");
      return { sha, message: rest.join(" ") };
    });
  } catch {
    return [];
  }
}

/**
 * Get files changed in a specific commit.
 */
function getCommitFiles(sha) {
  try {
    const output = execSync(
      `git diff-tree --no-commit-id --name-only -r ${sha}`,
      { encoding: "utf-8", timeout: 5000, cwd: ROOT }
    ).trim();
    return output ? output.split("\n") : [];
  } catch {
    return [];
  }
}

/**
 * Extract significant keywords from a title for fuzzy matching.
 */
function extractKeywords(text) {
  if (!text) { return []; }
  const stopWords = new Set([
    "the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or",
    "not", "no", "with", "auto", "fix", "bug", "moc", "page", "area",
    "findings", "finding", "vision", "should", "does", "across",
  ]);
  return text
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

function main() {
  const queue = loadQueue();
  const mocs = queue.mocs ?? [];

  // Find approved MOCs that haven't been committed yet
  const candidates = mocs.filter(
    (m) => (m.status === "approved" || m.status === "pending_fix") &&
           !m.commit_sha && !m.implementedAt
  );

  if (candidates.length === 0) {
    if (!jsonOutput) {
      console.log("[moc-commit-tracker] No unverified approved MOCs to scan.");
    }
    if (jsonOutput) {
      console.log(JSON.stringify({ scanned: 0, committed: 0, unverified: 0 }));
    }
    return;
  }

  if (!jsonOutput) {
    console.log(`[moc-commit-tracker] Scanning ${candidates.length} approved MOCs for auto-fix commits...`);
  }

  let committed = 0;
  let unverified = 0;
  const results = [];

  for (const moc of candidates) {
    const commits = findAutoFixCommits(moc);

    if (commits.length > 0) {
      if (!dryRun) {
        // Set to "committed" — NOT "implemented"
        // verify-fix-impact.js promotes to "implemented" after confirming findings resolved
        moc.status = "committed";
        moc.commit_sha = commits[0].sha;
        moc.commit_refs = commits.map((c) => c.sha);
        moc.verificationStatus = "committed";
        moc.committedAt = new Date().toISOString();
        moc.implementationNotes = "Commit found — awaiting finding verification";
        // Track cycles since commit for verification timeout
        moc._verificationCyclesSinceCommit = 0;
      }
      committed++;
      results.push({
        id: moc.id,
        title: moc.title,
        status: "committed",
        commits: commits.length,
        latestSha: commits[0].sha,
      });
      if (!jsonOutput) {
        const tag = moc.platformMocNumber ? ` [${moc.platformMocNumber}]` : "";
        console.log(`  [COMMITTED]${tag} ${moc.title} (${commits.length} commit(s), latest: ${commits[0].sha})`);
      }
    } else {
      unverified++;
      results.push({
        id: moc.id,
        title: moc.title,
        status: "pending",
        commits: 0,
      });
    }
  }

  if (!dryRun && committed > 0) {
    saveQueue(queue);
  }

  // Write state file for observer pipeline health monitoring
  try {
    const statePath = path.join(STATE_DIR, "commit-tracker-last.json");
    fs.writeFileSync(statePath, JSON.stringify({
      at: new Date().toISOString(),
      scanned: candidates.length,
      committed,
      unverified,
      falsePositiveGuard: { minKeywordOverlap: 3, requireExactFilePath: true },
    }, null, 2), "utf-8");
  } catch { /* non-fatal */ }

  if (jsonOutput) {
    console.log(JSON.stringify({ scanned: candidates.length, committed, unverified, results }));
  } else {
    console.log(`\n[moc-commit-tracker] Summary: ${committed} committed, ${unverified} still pending`);
    if (dryRun) {
      console.log("  (dry run — no changes saved)");
    }
  }
}

main();
