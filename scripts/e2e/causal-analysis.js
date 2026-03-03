#!/usr/bin/env node

/**
 * Causal Analysis — Spectrum-Based Fault Localization for root cause correlation.
 *
 * Correlates: git commits → files changed → features affected → test findings
 *
 * Uses the Ochiai coefficient (from SBFL research):
 *   suspiciousness(file) = failed(file) / sqrt(totalFailed * totalExecutions(file))
 *
 * Where:
 *   failed(file) = number of findings that touch this file's feature area
 *   totalFailed = total findings across all features
 *   totalExecutions(file) = total test runs touching this file's feature area
 *
 * Produces a ranked list of "most suspicious" code areas — likely root causes
 * for recurring failures.
 *
 * Usage:
 *   node scripts/e2e/causal-analysis.js              # Human-readable
 *   node scripts/e2e/causal-analysis.js --json        # Machine-readable
 *   node scripts/e2e/causal-analysis.js --export      # Write to state file
 *   node scripts/e2e/causal-analysis.js --commits 20  # Analyze last N commits
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_FILE = path.join(ROOT, "e2e", "state", "manifest.json");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const OUTPUT_FILE = path.join(ROOT, "e2e", "state", "causal-analysis.json");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const EXPORT = args.includes("--export");
const commitsIdx = args.indexOf("--commits");
const MAX_COMMITS = commitsIdx >= 0 ? parseInt(args[commitsIdx + 1] ?? "20", 10) : 20;

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git analysis — map commits to files changed
// ---------------------------------------------------------------------------

function getRecentCommits(n) {
  try {
    const log = execSync(
      `git log --oneline --name-only -${n} --no-merges`,
      { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    const commits = [];
    let current = null;

    for (const line of log.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      // Commit line: hash + message
      const commitMatch = line.match(/^([a-f0-9]{7,}) (.+)$/);
      if (commitMatch) {
        if (current) {
          commits.push(current);
        }
        current = {
          hash: commitMatch[1],
          message: commitMatch[2],
          files: [],
        };
      } else if (current && line.trim()) {
        current.files.push(line.trim());
      }
    }
    if (current) {
      commits.push(current);
    }
    return commits;
  } catch {
    return [];
  }
}

/**
 * Map files to manifest features via codeAreas matching.
 */
function filesToFeatures(files, manifest) {
  const features = manifest?.features ?? {};
  const matched = new Set();

  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    for (const [featureKey, config] of Object.entries(features)) {
      const codeAreas = config.codeAreas ?? [];
      for (const area of codeAreas) {
        if (normalized.startsWith(area) || normalized.includes(area)) {
          matched.add(featureKey);
        }
      }
    }
  }

  return [...matched];
}

// ---------------------------------------------------------------------------
// Ochiai Coefficient — Spectrum-Based Fault Localization
// ---------------------------------------------------------------------------

/**
 * Compute Ochiai suspiciousness for each code area.
 *
 * Ochiai(s) = failed(s) / sqrt(totalFailed * executed(s))
 *
 * Where:
 *   s = a code area / feature
 *   failed(s) = findings linked to this area
 *   executed(s) = total persona runs that cover this area
 *   totalFailed = total open findings across all areas
 */
function computeOchiai(manifest, findings, learning) {
  const features = manifest?.features ?? {};
  const allFindings = Array.isArray(findings)
    ? findings
    : (findings?.findings ?? []);

  const openFindings = allFindings.filter((f) => f.status !== "resolved");
  const totalFailed = openFindings.length;

  if (totalFailed === 0) {
    return [];
  }

  const results = [];

  for (const [featureKey, config] of Object.entries(features)) {
    const personas = config.personas ?? [];
    const pages = config.pages ?? [];
    const codeAreas = config.codeAreas ?? [];

    // Count findings for this feature area
    const featureFindings = openFindings.filter((f) => {
      if (pages.some((p) => f.page?.includes(p))) {
        return true;
      }
      if (codeAreas.some((a) => f.page?.includes(a) || f.description?.includes(a))) {
        return true;
      }
      return false;
    });

    const failed = featureFindings.length;
    if (failed === 0) {
      continue;
    }

    // Count total executions (persona runs touching this feature)
    let executed = 0;
    const personaData = learning?.personas ?? {};
    for (const pid of personas) {
      const entry = personaData[pid];
      if (entry) {
        executed += entry.totalRuns ?? 0;
      }
    }

    // Ochiai coefficient
    const denominator = Math.sqrt(totalFailed * Math.max(executed, 1));
    const suspiciousness = failed / denominator;

    results.push({
      featureKey,
      suspiciousness: Math.round(suspiciousness * 1000) / 1000,
      findings: failed,
      executions: executed,
      personas: personas.slice(0, 5),
      codeAreas,
      topFindings: featureFindings.slice(0, 3).map((f) => ({
        page: f.page,
        severity: f.severity,
        description: (f.description ?? "").slice(0, 80),
      })),
    });
  }

  // Sort by suspiciousness descending
  results.sort((a, b) => b.suspiciousness - a.suspiciousness);
  return results;
}

// ---------------------------------------------------------------------------
// Commit-Finding correlation
// ---------------------------------------------------------------------------

/**
 * Correlate recent commits with findings to find which commits
 * introduced the most problems.
 */
function commitFindingCorrelation(commits, manifest, findings) {
  const allFindings = Array.isArray(findings)
    ? findings
    : (findings?.findings ?? []);
  const openFindings = allFindings.filter((f) => f.status !== "resolved");

  return commits
    .map((commit) => {
      const affectedFeatures = filesToFeatures(commit.files, manifest);
      const relatedFindings = openFindings.filter((f) => {
        return affectedFeatures.some((feat) => {
          const config = manifest?.features?.[feat];
          const pages = config?.pages ?? [];
          const codeAreas = config?.codeAreas ?? [];
          return (
            pages.some((p) => f.page?.includes(p)) ||
            codeAreas.some((a) => f.page?.includes(a) || f.description?.includes(a))
          );
        });
      });

      return {
        hash: commit.hash,
        message: commit.message.slice(0, 80),
        filesChanged: commit.files.length,
        affectedFeatures,
        relatedFindings: relatedFindings.length,
      };
    })
    .filter((c) => c.relatedFindings > 0)
    .sort((a, b) => b.relatedFindings - a.relatedFindings);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const manifest = loadJson(MANIFEST_FILE);
  const findings = loadJson(FINDINGS_FILE);
  const learning = loadJson(LEARNING_FILE);

  if (!manifest) {
    console.error("Manifest not found. Run: node scripts/e2e/sync-manifest.js");
    process.exit(1);
  }

  const commits = getRecentCommits(MAX_COMMITS);
  const ochiai = computeOchiai(manifest, findings, learning);
  const commitCorrelation = commitFindingCorrelation(commits, manifest, findings);

  const output = {
    ochiai,
    commitCorrelation,
    meta: {
      totalCommitsAnalyzed: commits.length,
      totalOpenFindings: (Array.isArray(findings)
        ? findings
        : (findings?.findings ?? [])
      ).filter((f) => f.status !== "resolved").length,
      totalFeatures: Object.keys(manifest.features ?? {}).length,
      generatedAt: new Date().toISOString(),
    },
  };

  if (EXPORT) {
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");
    console.log(`Causal analysis written to: ${OUTPUT_FILE}`);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Human-readable output
  console.log("\n--- Causal Analysis (Spectrum-Based Fault Localization) ---");
  console.log(`Commits: ${commits.length} | Features: ${Object.keys(manifest.features ?? {}).length} | Open findings: ${output.meta.totalOpenFindings}\n`);

  if (ochiai.length === 0) {
    console.log("No suspicious code areas detected (no open findings).");
  } else {
    console.log("Most Suspicious Code Areas (Ochiai coefficient):");
    console.log("─".repeat(80));
    for (let i = 0; i < Math.min(ochiai.length, 10); i++) {
      const o = ochiai[i];
      console.log(
        `  ${(i + 1).toString().padStart(2)}. ${o.featureKey.padEnd(25)} ` +
          `suspiciousness=${o.suspiciousness.toFixed(3)} ` +
          `findings=${o.findings} executions=${o.executions}`
      );
      for (const f of o.topFindings) {
        console.log(`      → ${f.severity}: ${f.description}`);
      }
    }
  }

  if (commitCorrelation.length > 0) {
    console.log("\nCommits Correlated with Open Findings:");
    console.log("─".repeat(80));
    for (const c of commitCorrelation.slice(0, 5)) {
      console.log(
        `  ${c.hash} (${c.relatedFindings} findings, ${c.filesChanged} files) ${c.message}`
      );
      if (c.affectedFeatures.length > 0) {
        console.log(`    Features: ${c.affectedFeatures.join(", ")}`);
      }
    }
  }
}

main();
