#!/usr/bin/env node

/**
 * claude-finding-synthesizer.js — Semantic clustering of findings via Claude CLI.
 *
 * Multiple personas often report the SAME underlying issue on different pages
 * with different wording. For example:
 *   - Oscar reports "can see other org data" on /mocs
 *   - Norma reports "field appears null" on /mocs/[id]
 *   → Same root cause: missing org filter in DB query
 *
 * This script uses Claude CLI (haiku) to semantically cluster findings that
 * share the same root cause, even when described differently. The resulting
 * clusters are written to e2e/state/finding-clusters.json for downstream
 * consumption by findings-to-mocs.js.
 *
 * Usage:
 *   node scripts/e2e/claude-finding-synthesizer.js                    # Full clustering
 *   node scripts/e2e/claude-finding-synthesizer.js --dry-run           # Analyze, don't write
 *   node scripts/e2e/claude-finding-synthesizer.js --min-findings 10   # Min open findings to run
 *   node scripts/e2e/claude-finding-synthesizer.js --max-batches 5     # Limit Claude calls
 *   node scripts/e2e/claude-finding-synthesizer.js --json              # Machine-readable output
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

let _llmE2e = null;
function getLlmE2e() {
  if (_llmE2e) return _llmE2e;
  try {
    _llmE2e = require("./llm-e2e.js");
    return _llmE2e;
  } catch {
    return null;
  }
}

const ROOT = path.resolve(__dirname, "..", "..");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const CLUSTERS_FILE = path.join(ROOT, "e2e", "state", "finding-clusters.json");
const PROMPT_FILE = path.join(ROOT, "e2e", "state", "fix-prompt-synthesizer.md");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const cliArgs = process.argv.slice(2);
const DRY_RUN = cliArgs.includes("--dry-run");
const JSON_MODE = cliArgs.includes("--json");

function getArgValue(name, defaultVal) {
  const idx = cliArgs.indexOf(name);
  if (idx !== -1 && cliArgs[idx + 1]) {
    return parseInt(cliArgs[idx + 1], 10);
  }
  return defaultVal;
}

const MIN_FINDINGS = getArgValue("--min-findings", 5);
const MAX_BATCHES = getArgValue("--max-batches", 10);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  if (!JSON_MODE) {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    console.log(`[${ts}] [finding-synthesizer] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// UUID normalization — strip dynamic IDs from page paths
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function normalizePath(p) {
  if (!p) { return ""; }
  const noQuery = p.split("?")[0].split("#")[0];
  return noQuery.replace(UUID_RE, "[id]");
}

/**
 * Get a broader page area for grouping findings into batches.
 * Uses up to the first 2 path segments (broader than root-cause's 3-segment groups)
 * so that related sub-pages cluster together for semantic analysis.
 *
 *   /mocs/[id]/hotspots  ->  /mocs
 *   /mocs/[id]           ->  /mocs
 *   /admin/people        ->  /admin/people
 *   /admin/permissions   ->  /admin/permissions
 *   /review/role-inbox   ->  /review/role-inbox
 */
function getPageArea(pagePath) {
  const normalized = normalizePath(pagePath);
  const segments = normalized.replace(/^\//, "").split("/").filter(Boolean);
  // Use 2 segments, but collapse [id] sub-paths of /mocs into /mocs
  const groupSegments = segments.filter((s) => s !== "[id]").slice(0, 2);
  return "/" + groupSegments.join("/") || "/";
}

// ---------------------------------------------------------------------------
// Claude CLI availability check
// ---------------------------------------------------------------------------

function isClaudeAvailable() {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Load open findings from findings.json
// ---------------------------------------------------------------------------

/**
 * Load all "open" findings that are candidates for clustering.
 * Includes: pending_fix, open, regressed, noise (for re-evaluation).
 * Excludes: resolved, in_moc, in_moc_archived.
 */
function loadOpenFindings() {
  if (!fs.existsSync(FINDINGS_FILE)) {
    return [];
  }
  try {
    const all = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
    if (!Array.isArray(all)) { return []; }
    const excludeStatuses = new Set(["resolved", "in_moc", "in_moc_archived"]);
    return all.filter((f) => !excludeStatuses.has(f.status));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Group findings into batches by page area
// ---------------------------------------------------------------------------

/**
 * Group findings by normalized page area.
 * Returns array of { pageArea, findings } sorted by descending count.
 */
function groupByPageArea(findings) {
  const groups = {};
  for (const f of findings) {
    const area = getPageArea(f.page || "");
    if (!groups[area]) {
      groups[area] = [];
    }
    groups[area].push(f);
  }

  return Object.entries(groups)
    .map(([pageArea, areaFindings]) => ({ pageArea, findings: areaFindings }))
    .sort((a, b) => b.findings.length - a.findings.length);
}

/**
 * Split large groups into batches of at most `batchSize` findings.
 * Each batch retains its pageArea for context.
 */
function splitIntoBatches(groups, batchSize = 20) {
  const batches = [];
  for (const group of groups) {
    if (group.findings.length <= batchSize) {
      batches.push(group);
    } else {
      for (let i = 0; i < group.findings.length; i += batchSize) {
        batches.push({
          pageArea: group.pageArea,
          findings: group.findings.slice(i, i + batchSize),
        });
      }
    }
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Build the Claude prompt for a batch of findings
// ---------------------------------------------------------------------------

function buildPrompt(batch) {
  const findingSummaries = batch.findings.map((f, idx) => {
    const desc = (f.description || f.summary || "").slice(0, 250);
    const persona = f.persona || "unknown";
    const page = normalizePath(f.page || "");
    const severity = f.severity || "unknown";
    const failureType = f.failureType || "";
    return {
      index: idx,
      persona,
      page,
      severity,
      failureType,
      description: desc,
    };
  });

  const lines = [
    "You are analyzing bug findings from an automated E2E persona testing system.",
    "Multiple personas test the same web application and may report the same underlying issue",
    "with different wording, on different sub-pages, or from different perspectives.",
    "",
    `Page area: ${batch.pageArea}`,
    `Number of findings: ${batch.findings.length}`,
    "",
    "Findings:",
    JSON.stringify(findingSummaries, null, 2),
    "",
    "TASK: Group these findings by root cause. Findings that describe the same underlying",
    "bug or issue should be in the same cluster, even if:",
    "- They use different wording",
    "- They were reported by different personas",
    "- They are on slightly different sub-pages of the same area",
    "- One describes a symptom and another describes the same root cause",
    "",
    "Respond with ONLY a JSON object (no markdown fences, no explanation):",
    "{",
    '  "clusters": [',
    "    {",
    '      "canonical_title": "Short title describing the root cause",',
    '      "root_cause": "One-sentence explanation of the underlying issue",',
    '      "finding_indices": [0, 3, 7],',
    '      "affected_personas": ["oscar-outsider", "norma-null"],',
    '      "affected_pages": ["/mocs/[id]", "/mocs"],',
    '      "severity": "bug",',
    '      "suggested_fix_direction": "Brief description of how to fix"',
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    "- Every finding index must appear in exactly ONE cluster",
    "- Single-finding clusters are fine (no merge needed for unique issues)",
    "- Use the highest severity among grouped findings",
    "- severity must be one of: bug, security, ux, suggestion, product",
    "- Keep canonical_title under 80 characters",
    "- Keep root_cause under 200 characters",
    "- Keep suggested_fix_direction under 200 characters",
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Call Claude CLI and parse response
// ---------------------------------------------------------------------------

/**
 * Send a prompt to Claude CLI (haiku model) and parse JSON response.
 * Returns parsed object or null on failure.
 */
function callClaude(prompt) {
  try {
    fs.writeFileSync(PROMPT_FILE, prompt, "utf-8");
    const result = execSync(
      `claude --print --dangerously-skip-permissions --model haiku --max-budget-usd 0.15 < "${PROMPT_FILE.replace(/\\/g, "/")}"`,
      {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
        env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE: "" },
      }
    );

    const output = result.toString().trim();
    // Token accounting
    try {
      const _tl = require("./lib/token-logger");
      const _inEst = Math.ceil((fs.existsSync(PROMPT_FILE) ? fs.statSync(PROMPT_FILE).size : 0) / 4);
      const _outEst = Math.ceil(output.length / 4);
      _tl.logTokenUsage({ component: "finding-synthesizer", inputTokens: _inEst, outputTokens: _outEst, provider: "claude", model: "haiku" });
    } catch { /* non-fatal */ }
    return parseClaudeJson(output);
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().slice(0, 200) : (err.message || "").slice(0, 200);
    log(`Claude CLI error: ${msg}`);
    return null;
  } finally {
    try { fs.unlinkSync(PROMPT_FILE); } catch { /* ignore */ }
  }
}

/**
 * Call Gemini API when Claude CLI is unavailable. Classification/clustering task — Gemini is sufficient.
 * Env: E2E_SYNTHESIZER_MODEL (default: gemini-2.5-flash).
 */
async function callGeminiFallback(prompt) {
  const llm = getLlmE2e();
  if (!llm) return null;
  try {
    const model = process.env.E2E_SYNTHESIZER_MODEL ?? "gemini-2.5-flash";
    const raw = await llm.callLLMWithRetry({
      prompt,
      model,
      component: "finding-synthesizer",
      maxTokens: 2048,
    });
    const output = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    return parseClaudeJson(output);
  } catch (err) {
    log(`Gemini fallback error: ${(err.message ?? "").slice(0, 100)}`);
    return null;
  }
}

/**
 * Extract JSON from Claude's response, handling markdown code fences.
 */
function parseClaudeJson(output) {
  if (!output) { return null; }

  let jsonStr = output;

  // Strip markdown code fences
  const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Extract the outermost JSON object
  const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    jsonStr = braceMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.clusters || !Array.isArray(parsed.clusters)) {
      log("Parsed response missing 'clusters' array");
      return null;
    }
    return parsed;
  } catch (e) {
    log(`JSON parse error: ${e.message.slice(0, 100)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validate and normalize a Claude cluster response
// ---------------------------------------------------------------------------

function validateClusters(response, batchSize) {
  if (!response || !Array.isArray(response.clusters)) {
    return null;
  }

  const valid = [];
  const usedIndices = new Set();

  for (const cluster of response.clusters) {
    if (!cluster.finding_indices || !Array.isArray(cluster.finding_indices)) {
      continue;
    }
    // Filter invalid indices
    const indices = cluster.finding_indices.filter(
      (i) => typeof i === "number" && i >= 0 && i < batchSize && !usedIndices.has(i)
    );
    if (indices.length === 0) {
      continue;
    }
    for (const i of indices) {
      usedIndices.add(i);
    }

    const VALID_SEVERITIES = new Set(["bug", "security", "ux", "suggestion", "product"]);
    valid.push({
      canonical_title: (cluster.canonical_title || "Untitled cluster").slice(0, 80),
      root_cause: (cluster.root_cause || "").slice(0, 200),
      finding_indices: indices,
      affected_personas: Array.isArray(cluster.affected_personas) ? cluster.affected_personas : [],
      affected_pages: Array.isArray(cluster.affected_pages) ? cluster.affected_pages : [],
      severity: VALID_SEVERITIES.has(cluster.severity) ? cluster.severity : "bug",
      suggested_fix_direction: (cluster.suggested_fix_direction || "").slice(0, 200),
    });
  }

  return valid.length > 0 ? valid : null;
}

// ---------------------------------------------------------------------------
// Main synthesis logic
// ---------------------------------------------------------------------------

/**
 * Run semantic clustering on open findings.
 * Returns { clusters, stats } or null if skipped.
 *
 * Exported for require() usage by other scripts.
 */
async function synthesize(opts = {}) {
  const dryRun = opts.dryRun ?? DRY_RUN;
  const minFindings = opts.minFindings ?? MIN_FINDINGS;
  const maxBatches = opts.maxBatches ?? MAX_BATCHES;
  const jsonMode = opts.jsonMode ?? JSON_MODE;

  // Load open findings
  const openFindings = loadOpenFindings();
  if (openFindings.length < minFindings) {
    log(`Only ${openFindings.length} open findings (min: ${minFindings}). Skipping clustering.`);
    return null;
  }

  log(`Loaded ${openFindings.length} open findings.`);

  // Claude or Gemini required — skip only if neither available
  const useClaude = !dryRun && isClaudeAvailable();
  const llm = getLlmE2e();
  const useGemini = !dryRun && !useClaude && llm && (process.env.GEMINI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
  if (!dryRun && !useClaude && !useGemini) {
    log("Claude CLI and API LLM (Gemini/OpenAI) not available. Skipping clustering.");
    return null;
  }
  if (useGemini) {
    log("Using Gemini fallback (Claude CLI not available).");
  }

  // Group by page area and split into batches
  const groups = groupByPageArea(openFindings);
  const batches = splitIntoBatches(groups, 20);

  log(`Grouped into ${groups.length} page areas, ${batches.length} batches.`);

  // Limit batches to cap Claude spend
  const effectiveBatches = batches.slice(0, maxBatches);
  if (batches.length > maxBatches) {
    log(`Capping to ${maxBatches} batches (of ${batches.length} total).`);
  }

  const allClusters = [];
  let totalInputFindings = 0;
  let batchesProcessed = 0;
  let batchesFailed = 0;

  for (const batch of effectiveBatches) {
    totalInputFindings += batch.findings.length;

    // Skip tiny batches (1 finding = nothing to cluster)
    if (batch.findings.length < 2) {
      // Single finding is its own trivial cluster
      const f = batch.findings[0];
      allClusters.push({
        canonical_title: (f.description || f.summary || "").slice(0, 80),
        root_cause: "",
        finding_indices: [0],
        affected_personas: [f.persona || "unknown"],
        affected_pages: [normalizePath(f.page || "")],
        severity: f.severity || "bug",
        suggested_fix_direction: "",
        _source_batch: batch.pageArea,
        _original_findings: [buildFindingRef(f)],
      });
      continue;
    }

    if (dryRun) {
      log(`[DRY RUN] Would cluster ${batch.findings.length} findings for ${batch.pageArea}`);
      batchesProcessed++;
      continue;
    }

    // Build prompt and call Claude or Gemini
    const prompt = buildPrompt(batch);
    log(`Clustering ${batch.findings.length} findings for ${batch.pageArea}...`);
    const response = useClaude ? callClaude(prompt) : await callGeminiFallback(prompt);
    const validated = validateClusters(response, batch.findings.length);

    if (!validated) {
      batchesFailed++;
      log(`LLM failed for ${batch.pageArea}. Falling back to keyword similarity clustering.`);
      // Heuristic fallback: cluster by keyword similarity instead of 1:1
      const heuristicClusters = heuristicCluster(batch);
      for (const c of heuristicClusters) {
        allClusters.push(c);
      }
      continue;
    }

    batchesProcessed++;

    // Enrich clusters with original finding references
    for (const cluster of validated) {
      cluster._source_batch = batch.pageArea;
      cluster._original_findings = cluster.finding_indices.map((idx) => {
        return buildFindingRef(batch.findings[idx]);
      });
      allClusters.push(cluster);
    }
  }

  const stats = {
    totalInputFindings,
    totalClusters: allClusters.length,
    reductionPercent: totalInputFindings > 0
      ? Math.round((1 - allClusters.length / totalInputFindings) * 100)
      : 0,
    batchesProcessed,
    batchesFailed,
    multiFindings: allClusters.filter((c) => c.finding_indices.length > 1).length,
    timestamp: new Date().toISOString(),
  };

  if (!dryRun) {
    const output = {
      version: 1,
      generatedAt: new Date().toISOString(),
      stats,
      clusters: allClusters,
    };
    const dir = path.dirname(CLUSTERS_FILE);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(CLUSTERS_FILE, JSON.stringify(output, null, 2) + "\n", "utf-8");
    log(`Wrote ${allClusters.length} clusters to ${path.relative(ROOT, CLUSTERS_FILE)}`);
  }

  log(`Summary: ${totalInputFindings} findings -> ${allClusters.length} clusters (${stats.reductionPercent}% reduction)`);
  if (stats.multiFindings > 0) {
    log(`  ${stats.multiFindings} clusters contain multiple findings (semantic merges).`);
  }

  return { clusters: allClusters, stats };
}

// ---------------------------------------------------------------------------
// Heuristic clustering fallback (when Claude fails)
// ---------------------------------------------------------------------------

/** Tokenize a description into normalized words. */
function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Jaccard similarity between two word sets. */
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) { return 0; }
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) { intersection++; }
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Heuristic clustering: merge findings with >50% word overlap.
 * Returns clusters in the same format as Claude's output.
 */
function heuristicCluster(batch, threshold = 0.5) {
  const findings = batch.findings;
  const tokenSets = findings.map((f) => new Set(tokenize(f.description || f.summary || "")));
  const assigned = new Array(findings.length).fill(-1);
  const groups = [];

  for (let i = 0; i < findings.length; i++) {
    if (assigned[i] >= 0) { continue; }
    const group = [i];
    assigned[i] = groups.length;

    for (let j = i + 1; j < findings.length; j++) {
      if (assigned[j] >= 0) { continue; }
      // Must share same severity category for heuristic merge
      if (findings[i].severity !== findings[j].severity) { continue; }
      const sim = jaccard(tokenSets[i], tokenSets[j]);
      if (sim >= threshold) {
        group.push(j);
        assigned[j] = groups.length;
      }
    }
    groups.push(group);
  }

  // Build cluster objects
  const VALID_SEVERITIES = new Set(["bug", "security", "ux", "suggestion", "product"]);
  return groups.map((indices) => {
    const firstFinding = findings[indices[0]];
    const personas = [...new Set(indices.map((i) => findings[i].persona || "unknown"))];
    const pages = [...new Set(indices.map((i) => normalizePath(findings[i].page || "")))];
    const severity = VALID_SEVERITIES.has(firstFinding.severity) ? firstFinding.severity : "bug";
    return {
      canonical_title: (firstFinding.description || firstFinding.summary || "").slice(0, 80),
      root_cause: indices.length > 1 ? "Merged by keyword similarity" : "",
      finding_indices: indices,
      affected_personas: personas,
      affected_pages: pages,
      severity,
      suggested_fix_direction: "",
      _source_batch: batch.pageArea,
      _original_findings: indices.map((i) => buildFindingRef(findings[i])),
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a lightweight reference to a finding for embedding in cluster output.
 */
function buildFindingRef(finding) {
  return {
    persona: finding.persona || "unknown",
    page: normalizePath(finding.page || ""),
    severity: finding.severity || "unknown",
    description: (finding.description || finding.summary || "").slice(0, 200),
    status: finding.status || "unknown",
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const result = await synthesize();

  if (JSON_MODE) {
    if (result) {
      console.log(JSON.stringify(result.stats));
    } else {
      console.log(JSON.stringify({ skipped: true }));
    }
  }
}

// ---------------------------------------------------------------------------
// Exports for require() usage
// ---------------------------------------------------------------------------

module.exports = {
  synthesize,
  loadOpenFindings,
  groupByPageArea,
  splitIntoBatches,
  normalizePath,
  getPageArea,
  parseClaudeJson,
  heuristicCluster,
  tokenize,
  jaccard,
};

// ---------------------------------------------------------------------------
// Run when invoked directly
// ---------------------------------------------------------------------------

if (require.main === module) {
  main().catch((err) => {
    console.error("[finding-synthesizer] Fatal:", err.message);
    process.exit(1);
  });
}
