#!/usr/bin/env node

/**
 * correlate-errors.js — Error-Finding Correlation Engine.
 *
 * Links error_logs (Supabase) to findings.json (local) by:
 *   1. Querying error_logs (source='e2e_test', last 7d)
 *   2. Loading open findings from findings.json
 *   3. Matching by normalized page/endpoint overlap + timestamp proximity + persona name
 *   4. Enriching matched findings with linkedErrorIds[] and errorContext
 *   5. Writing enriched findings back to findings.json
 *   6. Writing summary signal to e2e/state/error-correlation.json
 *   7. Depositing synthetic pheromones on high-correlation pages in hotspot-map.json
 *
 * Graceful fallback: exits 0 with warning if SUPABASE_SERVICE_ROLE_KEY is missing.
 *
 * Usage:
 *   node scripts/e2e/correlate-errors.js              # Full correlation
 *   node scripts/e2e/correlate-errors.js --dry-run    # Preview only
 *   node scripts/e2e/correlate-errors.js --json       # Machine-readable output
 *   node scripts/e2e/correlate-errors.js --since 24h  # Time window
 */

try {
  require("dotenv").config({ path: require("path").resolve(__dirname, "..", "..", ".env.local") });
} catch {
  // dotenv not required
}

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const CORRELATION_FILE = path.join(ROOT, "e2e", "state", "error-correlation.json");
const HOTSPOT_FILE = path.join(ROOT, "e2e", "state", "hotspot-map.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const JSON_OUTPUT = args.includes("--json");
const sinceIdx = args.indexOf("--since");
const SINCE = sinceIdx !== -1 ? args[sinceIdx + 1] : "7d";

function log(msg) {
  if (!JSON_OUTPUT) {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    console.log(`[${ts}] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Time window parsing
// ---------------------------------------------------------------------------

function parseSince(since) {
  const match = since.match(/^(\d+)(h|d|m)$/);
  if (!match) { return 7 * 24 * 60 * 60 * 1000; } // default 7d
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { h: 3600000, d: 86400000, m: 60000 };
  return value * (multipliers[unit] || 86400000);
}

const TIME_WINDOW_MS = parseSince(SINCE);

// ---------------------------------------------------------------------------
// UUID normalization (shared with simulation.ts)
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function normalizePath(p) {
  return (p || "").replace(UUID_RE, "[id]");
}

// ---------------------------------------------------------------------------
// File helpers with retry (Windows file locking)
// ---------------------------------------------------------------------------

function withFileRetry(fn, maxRetries = 3, baseDelayMs = 100) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt === maxRetries) { throw err; }
      const code = err.code || "";
      const msg = err.message || "";
      if (code === "EACCES" || code === "EBUSY" || code === "UNKNOWN" || msg.includes("unknown error")) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 50;
        const end = Date.now() + delay;
        while (Date.now() < end) { /* busy-wait */ }
      } else {
        throw err;
      }
    }
  }
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) { return null; }
  try {
    return withFileRetry(() => JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return null;
  }
}

function saveJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  withFileRetry(() => fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n"));
}

// ---------------------------------------------------------------------------
// Supabase query
// ---------------------------------------------------------------------------

async function fetchRecentErrors() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return null; // Caller handles graceful exit
  }

  const since = new Date(Date.now() - TIME_WINDOW_MS).toISOString();
  const encodedSince = encodeURIComponent(since);

  // Query error_logs via PostgREST — match E2E error types (server errors + promoted findings)
  const url = `${supabaseUrl}/rest/v1/error_logs?or=(error_type.eq.E2E_SERVER_ERROR,error_type.eq.E2E_TEST_FINDING)&created_at=gte.${encodedSince}&order=created_at.desc&limit=500`;

  try {
    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`  Supabase query failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
      return [];
    }
    return await res.json();
  } catch (err) {
    log(`  Supabase fetch error: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Correlation matching
// ---------------------------------------------------------------------------

/**
 * Extract endpoint path from error URL or message.
 * Handles both full URLs and relative paths.
 */
function extractEndpoint(error) {
  const url = error.url || error.page_url || "";
  if (url) {
    try {
      const parsed = new URL(url, "https://placeholder");
      return normalizePath(parsed.pathname);
    } catch {
      return normalizePath(url);
    }
  }
  // Try extracting from message: "E2E: GET /api/mocs/... returned 500"
  const msgMatch = (error.message || "").match(/(?:GET|POST|PATCH|PUT|DELETE)\s+(\/[^\s]+)/i);
  if (msgMatch) {
    return normalizePath(msgMatch[1]);
  }
  return "";
}

/**
 * Extract persona name from error message or metadata.
 * Parses "for persona <Name> (<role>)" from E2E error messages.
 */
function extractPersonaFromError(error) {
  const msg = error.message || "";
  // "...for persona Frank Doorman (admin)" -> "frank-doorman"
  const match = msg.match(/persona\s+([^(]+?)\s*\(/i);
  if (match) {
    return match[1].trim().toLowerCase().replace(/\s+/g, "-");
  }
  // Check metadata
  if (error.metadata?.persona) {
    return error.metadata.persona;
  }
  if (error.metadata?.personaName) {
    return error.metadata.personaName.toLowerCase().replace(/\s+/g, "-");
  }
  return "";
}

/**
 * Parse finding timestamp to epoch ms.
 * Handles both ISO and Central time formats.
 */
function toEpochMs(ts) {
  if (!ts) { return 0; }
  try {
    return new Date(ts).getTime();
  } catch {
    return 0;
  }
}

/**
 * Score how well an error matches a finding.
 * Returns 0 (no match) to 1 (perfect match).
 */
function correlationScore(error, finding) {
  let score = 0;
  const maxScore = 3; // normalize to 0-1

  const errorEndpoint = extractEndpoint(error);
  const findingPage = normalizePath(finding.page || "");

  // 1. Page/endpoint overlap (most important signal)
  if (errorEndpoint && findingPage) {
    // Direct match
    if (errorEndpoint === findingPage) {
      score += 1.5;
    }
    // Partial overlap: /api/mocs matches /mocs, or /admin/people matches /admin/people
    else if (errorEndpoint.includes(findingPage) || findingPage.includes(errorEndpoint)) {
      score += 1.0;
    }
    // API endpoint matches page pattern: /api/mocs/[id]/review matches /mocs/[id]
    else {
      const errorParts = errorEndpoint.split("/").filter(Boolean);
      const findingParts = findingPage.split("/").filter(Boolean);
      const overlap = errorParts.filter((p) => findingParts.includes(p)).length;
      if (overlap >= 2) {
        score += 0.5;
      }
    }
  }

  // 2. Timestamp proximity (within 30 seconds = strong signal)
  const errorTime = toEpochMs(error.created_at);
  const findingTime = toEpochMs(finding.timestamp || finding.lastSeen);
  if (errorTime && findingTime) {
    const diffMs = Math.abs(errorTime - findingTime);
    if (diffMs < 30000) {
      score += 1.0; // Within 30s
    } else if (diffMs < 120000) {
      score += 0.5; // Within 2 min
    } else if (diffMs < 600000) {
      score += 0.2; // Within 10 min
    }
  }

  // 3. Persona match
  const errorPersona = extractPersonaFromError(error);
  const findingPersona = (finding.persona || "").toLowerCase();
  if (errorPersona && findingPersona && (errorPersona === findingPersona || errorPersona.includes(findingPersona) || findingPersona.includes(errorPersona))) {
    score += 0.5;
  }

  return Math.min(score / maxScore, 1.0);
}

/**
 * Run the correlation engine.
 * Returns { correlations, signal }.
 */
async function correlate() {
  // Load findings
  const findingsData = loadJson(FINDINGS_FILE);
  const allFindings = Array.isArray(findingsData)
    ? findingsData
    : Array.isArray(findingsData?.findings)
      ? findingsData.findings
      : [];

  const openFindings = allFindings.filter(
    (f) => f.status === "open" || f.status === "in_moc" || f.status === "pending_fix"
  );

  if (openFindings.length === 0) {
    log("No open findings to correlate.");
    return { correlations: [], signal: null };
  }

  // Fetch errors from Supabase
  const errors = await fetchRecentErrors();
  if (errors === null) {
    log("SUPABASE_SERVICE_ROLE_KEY not set — skipping error correlation.");
    return { correlations: [], signal: null };
  }

  if (errors.length === 0) {
    log("No recent E2E errors found in error_logs.");
    return { correlations: [], signal: null };
  }

  log(`Loaded ${openFindings.length} open findings and ${errors.length} recent errors.`);

  // Match errors to findings
  const THRESHOLD = 0.3; // Minimum correlation score
  const correlations = [];
  const pageCorrelationCounts = {};
  const personaErrorCounts = {};

  for (const finding of openFindings) {
    const matchedErrors = [];

    for (const error of errors) {
      const score = correlationScore(error, finding);
      if (score >= THRESHOLD) {
        matchedErrors.push({ error, score });
      }
    }

    if (matchedErrors.length > 0) {
      // Sort by score descending, take top 10
      matchedErrors.sort((a, b) => b.score - a.score);
      const topMatches = matchedErrors.slice(0, 10);

      // Deduplicate error IDs — check existing linkedErrorIds
      const existingIds = new Set(finding.linkedErrorIds || []);
      const newErrorIds = topMatches
        .map((m) => m.error.id)
        .filter((id) => id && !existingIds.has(id));

      if (newErrorIds.length === 0 && finding.linkedErrorIds?.length > 0) {
        continue; // Already fully correlated
      }

      // Build error context
      const allMatchedErrors = topMatches.map((m) => m.error);
      const endpoints = [...new Set(allMatchedErrors.map((e) => extractEndpoint(e)).filter(Boolean))];
      const statusCodes = [...new Set(allMatchedErrors.map((e) => e.metadata?.httpStatus || e.error_type || "unknown"))];
      const errorTypes = [...new Set(allMatchedErrors.map((e) => e.error_type || "unknown"))];
      const messages = [...new Set(allMatchedErrors.map((e) => (e.message || "").slice(0, 150)).filter(Boolean))].slice(0, 5);

      correlations.push({
        findingIndex: allFindings.indexOf(finding),
        finding,
        errorIds: [...existingIds, ...newErrorIds],
        errorContext: {
          endpoints,
          statusCodes,
          errorTypes,
          messages,
          count: topMatches.length,
          bestScore: topMatches[0]?.score ?? 0,
        },
      });

      // Track page-level and persona-level stats
      const page = normalizePath(finding.page || "");
      if (page) {
        pageCorrelationCounts[page] = (pageCorrelationCounts[page] || 0) + 1;
      }
      const persona = finding.persona || "unknown";
      personaErrorCounts[persona] = (personaErrorCounts[persona] || 0) + 1;
    }
  }

  // Build signal
  const totalPersonaFindings = {};
  for (const f of openFindings) {
    const p = f.persona || "unknown";
    totalPersonaFindings[p] = (totalPersonaFindings[p] || 0) + 1;
  }
  const personaErrorRates = {};
  for (const [persona, errorCount] of Object.entries(personaErrorCounts)) {
    const total = totalPersonaFindings[persona] || 1;
    personaErrorRates[persona] = Math.round((errorCount / total) * 100) / 100;
  }

  // Sort pages by correlation count
  const highCorrelationPages = Object.entries(pageCorrelationCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([page]) => page);

  const signal = {
    timestamp: new Date().toISOString(),
    timeWindow: SINCE,
    totalFindings: openFindings.length,
    totalErrors: errors.length,
    correlatedFindings: correlations.length,
    correlationRate: openFindings.length > 0
      ? Math.round((correlations.length / openFindings.length) * 100) / 100
      : 0,
    highCorrelationPages,
    personaErrorRates,
  };

  return { correlations, signal, allFindings };
}

// ---------------------------------------------------------------------------
// Hotspot pheromone deposits
// ---------------------------------------------------------------------------

function depositCorrelationPheromones(signal) {
  if (!signal || !signal.highCorrelationPages || signal.highCorrelationPages.length === 0) {
    return;
  }

  let hotspotData = loadJson(HOTSPOT_FILE);
  if (!hotspotData || !hotspotData.hotspots) {
    // Initialize hotspot-map.json if it doesn't exist or is missing the hotspots key
    hotspotData = { hotspots: {}, lastUpdated: null, version: 1 };
  }

  let deposited = 0;
  for (const page of signal.highCorrelationPages) {
    const entry = hotspotData.hotspots[page];
    if (entry) {
      // Boost existing hotspot
      entry.pheromone += 0.5;
      entry.lastDeposit = new Date().toISOString();
      entry.totalDeposits += 1;
      if (!entry.recentDeposits) { entry.recentDeposits = []; }
      entry.recentDeposits.push({
        personaId: "error-correlation",
        severity: "bug",
        description: `Error-finding correlation: ${signal.personaErrorRates[page] ?? "multiple"} error associations`,
        timestamp: new Date().toISOString(),
        strength: 0.5,
      });
      deposited++;
    } else {
      // Create new hotspot entry
      hotspotData.hotspots[page] = {
        pheromone: 0.5,
        personas: ["error-correlation"],
        totalDeposits: 1,
        lastDeposit: new Date().toISOString(),
        lastDecay: new Date().toISOString(),
        triangulated: false,
        recentDeposits: [{
          personaId: "error-correlation",
          severity: "bug",
          description: `Error-finding correlation signal`,
          timestamp: new Date().toISOString(),
          strength: 0.5,
        }],
      };
      deposited++;
    }
  }

  if (deposited > 0) {
    hotspotData.lastUpdated = new Date().toISOString();
    saveJson(HOTSPOT_FILE, hotspotData);
    log(`Deposited pheromones on ${deposited} hotspot page(s).`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("=== Error-Finding Correlation Engine ===\n");

  const { correlations, signal, allFindings } = await correlate();

  if (!signal) {
    if (JSON_OUTPUT) {
      console.log(JSON.stringify({ status: "skipped", reason: "No data or missing credentials" }));
    }
    process.exit(0);
  }

  log(`\nCorrelation results:`);
  log(`  Findings checked: ${signal.totalFindings}`);
  log(`  Errors queried: ${signal.totalErrors}`);
  log(`  Correlated: ${signal.correlatedFindings} (${Math.round(signal.correlationRate * 100)}%)`);
  log(`  High-correlation pages: ${signal.highCorrelationPages.join(", ") || "none"}`);

  if (correlations.length > 0) {
    log(`\nTop correlations:`);
    for (const c of correlations.slice(0, 10)) {
      const persona = c.finding.persona || "unknown";
      const page = normalizePath(c.finding.page || "");
      const score = c.errorContext.bestScore?.toFixed(2) || "?";
      log(`  [${persona}] ${page} — ${c.errorIds.length} errors (score: ${score})`);
      for (const msg of c.errorContext.messages.slice(0, 2)) {
        log(`    ${msg}`);
      }
    }
  }

  if (!DRY_RUN && correlations.length > 0 && allFindings) {
    // Enrich findings with correlation data
    for (const c of correlations) {
      const finding = allFindings[c.findingIndex];
      if (!finding) { continue; }
      finding.linkedErrorIds = c.errorIds;
      finding.errorContext = c.errorContext;
    }
    saveJson(FINDINGS_FILE, allFindings);
    log(`\nEnriched ${correlations.length} findings with error correlation data.`);

    // Write signal file
    saveJson(CORRELATION_FILE, signal);

    // Deposit pheromones on high-correlation pages (Phase C5)
    depositCorrelationPheromones(signal);
  } else if (DRY_RUN) {
    log(`\n[DRY RUN] Would enrich ${correlations.length} findings and write signal file.`);
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(signal, null, 2));
  }

  log("\nDone.");
}

main().catch((err) => {
  console.error(`correlate-errors.js: ${err.message}`);
  process.exit(1);
});
