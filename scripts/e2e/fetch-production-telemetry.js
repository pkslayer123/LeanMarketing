#!/usr/bin/env node

/**
 * fetch-production-telemetry.js — Query production feature usage and error data.
 *
 * Queries Supabase REST API for feature_usage_events and error_logs tables.
 * Computes per-page traffic scores and error density.
 * Writes production-telemetry.json for consumption by the intelligence pipeline
 * (test strategy, curiosity engine, persona ROI).
 *
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   node scripts/e2e/fetch-production-telemetry.js              # Fetch and write
 *   node scripts/e2e/fetch-production-telemetry.js --json        # Machine-readable output
 *   node scripts/e2e/fetch-production-telemetry.js --dry-run     # Preview queries only
 *   node scripts/e2e/fetch-production-telemetry.js --days 7      # Custom lookback (default: 7)
 */

const path = require("path");
const fs = require("fs");
const https = require("https");

const ROOT = path.resolve(__dirname, "..", "..");
try {
  require("dotenv").config({ path: path.join(ROOT, ".env.local"), quiet: true });
  require("dotenv").config({ path: path.join(ROOT, "e2e", ".env"), quiet: true });
} catch {}

const OUTPUT_PATH = path.join(ROOT, "e2e", "state", "production-telemetry.json");

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const dryRun = args.includes("--dry-run");
const daysIdx = args.indexOf("--days");
const LOOKBACK_DAYS = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : 7;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function log(msg) {
  if (!jsonMode) {
    console.log(`[production-telemetry] ${msg}`);
  }
}

/**
 * Make an HTTPS GET request to Supabase REST API.
 */
function supabaseGet(tableName, query) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      reject(new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"));
      return;
    }

    const url = new URL(`${SUPABASE_URL}/rest/v1/${tableName}`);
    for (const [key, val] of Object.entries(query)) {
      url.searchParams.set(key, val);
    }

    const options = {
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "count=exact",
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const countHeader = res.headers["content-range"];
          const count = countHeader ? parseInt(countHeader.split("/")[1], 10) : null;
          resolve({ data, count, status: res.statusCode });
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end();
  });
}

async function fetchFeatureUsage() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const result = await supabaseGet("feature_usage_events", {
      "select": "feature_key,page_path,created_at",
      "created_at": `gte.${since}`,
      "limit": "5000",
      "order": "created_at.desc",
    });

    if (result.status !== 200) {
      log(`Feature usage query returned ${result.status}`);
      return [];
    }

    return Array.isArray(result.data) ? result.data : [];
  } catch (err) {
    log(`Feature usage query failed: ${err.message}`);
    return [];
  }
}

async function fetchErrorLogs() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const result = await supabaseGet("error_logs", {
      "select": "endpoint,error_type,severity,created_at,source",
      "created_at": `gte.${since}`,
      "limit": "5000",
      "order": "created_at.desc",
    });

    if (result.status !== 200) {
      log(`Error logs query returned ${result.status}`);
      return [];
    }

    return Array.isArray(result.data) ? result.data : [];
  } catch (err) {
    log(`Error logs query failed: ${err.message}`);
    return [];
  }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    const msg = "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set in .env.local.";
    if (jsonMode) { console.log(JSON.stringify({ error: msg })); }
    else { console.error(`[production-telemetry] ${msg}`); }
    return;
  }

  if (dryRun) {
    log(`Would query feature_usage_events and error_logs for last ${LOOKBACK_DAYS} days.`);
    log(`Supabase URL: ${SUPABASE_URL}`);
    return;
  }

  log(`Fetching production data for last ${LOOKBACK_DAYS} days...`);

  const [usageEvents, errorLogs] = await Promise.all([
    fetchFeatureUsage(),
    fetchErrorLogs(),
  ]);

  // Aggregate per-page traffic
  const pageTraffic = {};
  for (const event of usageEvents) {
    const page = event.page_path || "unknown";
    if (!pageTraffic[page]) {
      pageTraffic[page] = { views: 0, features: new Set() };
    }
    pageTraffic[page].views++;
    if (event.feature_key) {
      pageTraffic[page].features.add(event.feature_key);
    }
  }

  // Aggregate per-page errors
  const pageErrors = {};
  for (const error of errorLogs) {
    const endpoint = error.endpoint || "unknown";
    // Normalize API paths to page areas
    const page = endpoint.replace(/^\/api\//, "/").split("/").slice(0, 3).join("/");
    if (!pageErrors[page]) {
      pageErrors[page] = { count: 0, types: new Set(), e2e: 0, production: 0 };
    }
    pageErrors[page].count++;
    if (error.error_type) { pageErrors[page].types.add(error.error_type); }
    if (error.source === "e2e_test") { pageErrors[page].e2e++; }
    else { pageErrors[page].production++; }
  }

  // Compute per-page scores
  const pages = {};
  const allPages = new Set([...Object.keys(pageTraffic), ...Object.keys(pageErrors)]);
  for (const page of allPages) {
    const traffic = pageTraffic[page] || { views: 0, features: new Set() };
    const errors = pageErrors[page] || { count: 0, types: new Set(), e2e: 0, production: 0 };

    const trafficScore = Math.min(traffic.views / 100, 1.0); // Normalize to 0-1
    const errorScore = Math.min(errors.production / 10, 1.0); // Production errors only
    const riskScore = Math.round((trafficScore * 0.4 + errorScore * 0.6) * 100) / 100;

    pages[page] = {
      views: traffic.views,
      featureCount: traffic.features.size,
      errorCount: errors.count,
      productionErrors: errors.production,
      e2eErrors: errors.e2e,
      trafficScore: Math.round(trafficScore * 100) / 100,
      errorScore: Math.round(errorScore * 100) / 100,
      riskScore,
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    summary: {
      totalUsageEvents: usageEvents.length,
      totalErrors: errorLogs.length,
      uniquePages: allPages.size,
      productionErrors: errorLogs.filter((e) => e.source !== "e2e_test").length,
      e2eErrors: errorLogs.filter((e) => e.source === "e2e_test").length,
    },
    pages,
  };

  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n");

  if (jsonMode) {
    console.log(JSON.stringify(report));
  } else {
    log(`Fetched ${usageEvents.length} usage events, ${errorLogs.length} errors across ${allPages.size} pages.`);
    // Show top risk pages
    const topRisk = Object.entries(pages).sort((a, b) => b[1].riskScore - a[1].riskScore).slice(0, 5);
    if (topRisk.length > 0) {
      log("Top risk pages:");
      for (const [page, data] of topRisk) {
        log(`  ${page}: risk=${data.riskScore} (${data.views} views, ${data.productionErrors} prod errors)`);
      }
    }
  }
}

main().catch((err) => {
  console.error(`[production-telemetry] Fatal: ${err.message}`);
  process.exit(1);
});
