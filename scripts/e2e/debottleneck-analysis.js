#!/usr/bin/env node

/**
 * Debottleneck Analysis — Per-iteration performance and bottleneck detection.
 *
 * Reads loop-performance.jsonl and analyzes:
 *   - Throughput (tests/sec) — primary performance indicator
 *   - Duration trend — are runs getting slower?
 *   - Pass rate — quality indicator (can be test bugs, not load)
 *
 * Pass rate alone is misleading: failures can be test flakiness, not load.
 * We use multi-signal: throughput + duration + pass rate.
 *
 * Usage:
 *   node scripts/e2e/debottleneck-analysis.js
 *   node scripts/e2e/debottleneck-analysis.js --json
 *   node scripts/e2e/debottleneck-analysis.js --last 5
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const PERF_FILE = path.join(ROOT, "e2e", "state", "loop-performance.jsonl");
const SIGNAL_FILE = path.join(ROOT, "e2e", "state", "debottleneck-signal.json");

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const lastIdx = args.indexOf("--last");
const lastN = lastIdx >= 0 && args[lastIdx + 1] ? parseInt(args[lastIdx + 1], 10) : 10;

function loadPerfLines() {
  if (!fs.existsSync(PERF_FILE)) {
    return [];
  }
  const raw = fs.readFileSync(PERF_FILE, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return parsed.slice(-lastN);
}

function analyze(rows) {
  if (rows.length === 0) {
    return {
      signal: "no_data",
      suggestion: "Run loop to collect performance data.",
      throughput: null,
      durationTrend: null,
      passRateTrend: null,
    };
  }

  const latest = rows[rows.length - 1];
  const throughput = latest.total > 0 && latest.duration > 0
    ? (latest.total / latest.duration).toFixed(2)
    : null;

  // Duration trend: use rolling average of last 3+ iterations (not just last 2)
  // Prevents single outlier runs from triggering titration
  let durationTrend = "stable";
  const validDurationRows = rows.filter((r) => r.duration > 0 && r.total > 0);
  if (validDurationRows.length >= 3) {
    const recent = validDurationRows.slice(-3);
    const avgRecent = recent.reduce((s, r) => s + r.duration, 0) / recent.length;
    const older = validDurationRows.slice(-6, -3);
    if (older.length >= 2) {
      const avgOlder = older.reduce((s, r) => s + r.duration, 0) / older.length;
      const pct = ((avgRecent - avgOlder) / avgOlder) * 100;
      if (pct > 20) { durationTrend = "slower"; }
      else if (pct < -20) { durationTrend = "faster"; }
    }
  } else if (rows.length >= 2) {
    // Fallback for sparse data: compare last two non-crash runs
    const prev = validDurationRows[validDurationRows.length - 2];
    if (prev && prev.duration > 0) {
      const pct = ((latest.duration - prev.duration) / prev.duration) * 100;
      if (pct > 25) { durationTrend = "slower"; }
      else if (pct < -25) { durationTrend = "faster"; }
    }
  }

  // Pass rate trend: rolling average of last 3 vs previous 3
  let passRateTrend = "stable";
  const validPassRows = rows.filter((r) => r.total > 0);
  if (validPassRows.length >= 3) {
    const recentPR = validPassRows.slice(-3);
    const avgRecentPR = recentPR.reduce((s, r) => s + parseFloat(r.passRate || 0), 0) / recentPR.length;
    const olderPR = validPassRows.slice(-6, -3);
    if (olderPR.length >= 2) {
      const avgOlderPR = olderPR.reduce((s, r) => s + parseFloat(r.passRate || 0), 0) / olderPR.length;
      const delta = avgRecentPR - avgOlderPR;
      if (delta < -8) { passRateTrend = "dropping"; }
      else if (delta > 8) { passRateTrend = "improving"; }
    }
  } else if (rows.length >= 2) {
    const prev = rows[rows.length - 2];
    const delta = parseFloat(latest.passRate || 0) - parseFloat(prev.passRate || 0);
    if (delta < -10) { passRateTrend = "dropping"; }
    else if (delta > 10) { passRateTrend = "improving"; }
  }

  const isCrash = latest.total === 0;
  const recentCrashes = rows.slice(-3).filter((r) => r.total === 0).length;

  // Multi-signal interpretation
  let signal = "ok";
  let suggestion = null;

  const passRateLow = latest.passRate < 80;
  const durationIncreasing = durationTrend === "slower";
  const passRateDropping = passRateTrend === "dropping";

  if (isCrash && recentCrashes >= 2) {
    signal = "crash_recovery";
    suggestion = `${recentCrashes} crashes in last 3 runs. Likely timeout with too few workers. Resetting to safe default.`;
  } else if (isCrash) {
    signal = "test_quality";
    suggestion = "Playwright crash (0 results). Maintaining current workers — single crash may be transient.";
  } else if (passRateLow && durationIncreasing) {
    signal = "load_bottleneck";
    suggestion = "Pass rate down AND duration up → likely load bottleneck. Reduce workers or investigate slow tests.";
  } else if (passRateLow && !durationIncreasing) {
    signal = "test_quality";
    suggestion = "Pass rate down but duration stable → likely test flakiness or bugs, not load. Fix failing tests before titrating workers.";
  } else if (passRateDropping && latest.passRate >= 80) {
    signal = "watch";
    suggestion = "Pass rate trending down. Monitor next iteration before titrating up.";
  } else if (latest.passRate >= 90 && durationTrend === "faster") {
    signal = "headroom";
    suggestion = "High pass rate and faster runs → safe to try more workers.";
  } else if (latest.passRate >= 90) {
    signal = "headroom";
    suggestion = "High pass rate. Consider titrating up if duration is acceptable.";
  }

  return {
    signal,
    suggestion,
    throughput: throughput ? parseFloat(throughput) : null,
    throughputLabel: throughput ? `${throughput} tests/sec` : "n/a",
    durationTrend,
    passRateTrend,
    latest: {
      iter: latest.iter,
      duration: latest.duration,
      passRate: latest.passRate,
      workers: latest.workers,
      total: latest.total,
    },
    rowsAnalyzed: rows.length,
  };
}

function writeSignalFile(result) {
  const MIN_WORKERS = parseInt(process.env.E2E_MIN_WORKERS ?? "3", 10);
  const MAX_WORKERS = parseInt(process.env.E2E_MAX_WORKERS ?? "12", 10);
  // Normalize workers — may be string "default" or number
  let currentWorkers = parseInt(result.latest?.workers, 10);
  if (isNaN(currentWorkers) || currentWorkers < MIN_WORKERS) {
    currentWorkers = 6;
  }
  let recommendedWorkers = currentWorkers;

  if (result.signal === "crash_recovery") {
    recommendedWorkers = Math.max(MIN_WORKERS, 6);
  } else if (result.signal === "load_bottleneck") {
    recommendedWorkers = Math.max(MIN_WORKERS, Math.floor(currentWorkers * 0.75));
  } else if (result.signal === "headroom") {
    // Faster scale-up: +50% per cycle (was +20%, took too many cycles to respond)
    recommendedWorkers = Math.min(Math.ceil(currentWorkers * 1.5), MAX_WORKERS);
  } else if (result.signal === "flaky") {
    recommendedWorkers = currentWorkers;
  } else if (result.signal === "watch") {
    recommendedWorkers = currentWorkers;
  }

  recommendedWorkers = Math.min(Math.max(MIN_WORKERS, recommendedWorkers), MAX_WORKERS);

  const signalData = {
    signal: result.signal,
    suggestion: result.suggestion,
    passRate: result.latest ? result.latest.passRate : null,
    workers: result.latest ? result.latest.workers : null,
    recommendedWorkers,
    throughput: result.throughput,
    durationTrend: result.durationTrend,
    passRateTrend: result.passRateTrend,
    timestamp: new Date().toISOString(),
  };
  try {
    const dir = path.dirname(SIGNAL_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SIGNAL_FILE, JSON.stringify(signalData, null, 2));
  } catch {
    // Best-effort: don't fail analysis because of file write
  }
}

function main() {
  const rows = loadPerfLines();
  const result = analyze(rows);

  // Always write signal file for loop consumption
  writeSignalFile(result);

  if (jsonMode) {
    console.log(JSON.stringify(result));
    return;
  }

  if (result.signal === "no_data") {
    console.log("[debottleneck] No performance data yet. Run loop to collect.");
    return;
  }

  console.log("\n[debottleneck] Performance analysis (last " + result.rowsAnalyzed + " iterations)");
  console.log("  Throughput:    " + result.throughputLabel);
  console.log("  Duration:     " + result.durationTrend);
  console.log("  Pass rate:    " + result.passRateTrend);
  console.log("  Signal:       " + result.signal);
  if (result.suggestion) {
    console.log("  Suggestion:   " + result.suggestion);
  }
  console.log("");
}

main();
