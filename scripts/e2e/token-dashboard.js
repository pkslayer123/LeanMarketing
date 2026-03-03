#!/usr/bin/env node

/**
 * Token Dashboard — Unified cost visibility across ALL LLM subsystems.
 *
 * Shows: oracle (Gemini), Claude CLI (auto-fix, intelligence, themes),
 * discovery sampling, batch-llm calls. Reads persona-token-usage.jsonl.
 *
 * Usage:
 *   node scripts/e2e/token-dashboard.js              # Last 24h, human-readable
 *   node scripts/e2e/token-dashboard.js --json        # JSON output
 *   node scripts/e2e/token-dashboard.js --hours 168   # Last 7 days
 *   node scripts/e2e/token-dashboard.js --alerts      # Show budget alerts only
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const LOG_FILE = path.join(ROOT, "e2e", "state", "persona-token-usage.jsonl");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");

const args = process.argv.slice(2);
const HOURS = parseInt(args[args.indexOf("--hours") + 1] || "24", 10);
const AS_JSON = args.includes("--json");
const ALERTS_ONLY = args.includes("--alerts");

// Budget alert thresholds (USD per hour)
const ALERT_THRESHOLDS = {
  "moc-auto-fix": 5.0,
  oracle: 1.0,
  "finding-synthesizer": 0.50,
  "consolidate-themes": 0.50,
  "spec-decomposer": 3.0,
  "test-strategy": 1.0,
  _default: 2.0,
};

function loadEntries() {
  if (!fs.existsSync(LOG_FILE)) { return []; }
  const raw = fs.readFileSync(LOG_FILE, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return entries;
}

function loadFindingsCount() {
  try {
    if (!fs.existsSync(FINDINGS_FILE)) { return { total: 0, open: 0, resolved: 0 }; }
    const data = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
    const findings = data.findings || data;
    if (!Array.isArray(findings)) { return { total: 0, open: 0, resolved: 0 }; }
    const open = findings.filter((f) => f.status !== "resolved").length;
    return { total: findings.length, open, resolved: findings.length - open };
  } catch {
    return { total: 0, open: 0, resolved: 0 };
  }
}

function main() {
  const allEntries = loadEntries();
  const cutoff = new Date(Date.now() - HOURS * 3600000).toISOString();
  const recent = allEntries.filter((e) => e.ts >= cutoff);

  if (recent.length === 0 && !AS_JSON) {
    console.log(`\nNo token usage in the last ${HOURS} hours.`);
    return;
  }

  // Aggregations
  const byComponent = {};
  const byProvider = {};
  const byModel = {};
  const byHour = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let totalCalls = 0;

  for (const e of recent) {
    const comp = e.component || "unknown";
    if (!byComponent[comp]) {
      byComponent[comp] = { inputTokens: 0, outputTokens: 0, costUSD: 0, calls: 0 };
    }
    byComponent[comp].inputTokens += e.inputTokens || 0;
    byComponent[comp].outputTokens += e.outputTokens || 0;
    byComponent[comp].costUSD += e.costUSD || 0;
    byComponent[comp].calls += 1;

    const prov = e.provider || "unknown";
    if (!byProvider[prov]) {
      byProvider[prov] = { inputTokens: 0, outputTokens: 0, costUSD: 0, calls: 0 };
    }
    byProvider[prov].inputTokens += e.inputTokens || 0;
    byProvider[prov].outputTokens += e.outputTokens || 0;
    byProvider[prov].costUSD += e.costUSD || 0;
    byProvider[prov].calls += 1;

    const mod = e.model || "unknown";
    if (!byModel[mod]) {
      byModel[mod] = { inputTokens: 0, outputTokens: 0, costUSD: 0, calls: 0 };
    }
    byModel[mod].inputTokens += e.inputTokens || 0;
    byModel[mod].outputTokens += e.outputTokens || 0;
    byModel[mod].costUSD += e.costUSD || 0;
    byModel[mod].calls += 1;

    // Hourly trend
    const hour = (e.ts || "").slice(0, 13); // YYYY-MM-DDTHH
    if (hour) {
      if (!byHour[hour]) {
        byHour[hour] = { costUSD: 0, calls: 0 };
      }
      byHour[hour].costUSD += e.costUSD || 0;
      byHour[hour].calls += 1;
    }

    totalInput += e.inputTokens || 0;
    totalOutput += e.outputTokens || 0;
    totalCost += e.costUSD || 0;
    totalCalls += 1;
  }

  // Budget alerts
  const alerts = [];
  const costPerHour = totalCost / Math.max(HOURS, 1);
  for (const [comp, data] of Object.entries(byComponent)) {
    const compCostPerHour = data.costUSD / Math.max(HOURS, 1);
    const threshold = ALERT_THRESHOLDS[comp] || ALERT_THRESHOLDS._default;
    if (compCostPerHour > threshold) {
      alerts.push({
        component: comp,
        costPerHour: Math.round(compCostPerHour * 10000) / 10000,
        threshold,
        message: `${comp} exceeds $${threshold}/hr: $${compCostPerHour.toFixed(4)}/hr`,
      });
    }
  }

  // Cost efficiency metrics
  const findingsData = loadFindingsCount();
  const costPerFinding = findingsData.total > 0 ? totalCost / findingsData.total : 0;
  const costPerOpenFinding = findingsData.open > 0 ? totalCost / findingsData.open : 0;

  // Sort hourly trend
  const hourlyTrend = Object.entries(byHour)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, data]) => ({ hour, ...data }));

  const report = {
    period: `last ${HOURS} hours`,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalTokens: totalInput + totalOutput,
    totalCostUSD: Math.round(totalCost * 1e6) / 1e6,
    totalCalls,
    costPerHour: Math.round(costPerHour * 10000) / 10000,
    byComponent: Object.fromEntries(
      Object.entries(byComponent).sort(([, a], [, b]) => b.costUSD - a.costUSD)
    ),
    byProvider: Object.fromEntries(
      Object.entries(byProvider).sort(([, a], [, b]) => b.costUSD - a.costUSD)
    ),
    byModel: Object.fromEntries(
      Object.entries(byModel).sort(([, a], [, b]) => b.costUSD - a.costUSD)
    ),
    hourlyTrend,
    alerts,
    efficiency: {
      totalFindings: findingsData.total,
      openFindings: findingsData.open,
      costPerFinding: Math.round(costPerFinding * 10000) / 10000,
      costPerOpenFinding: Math.round(costPerOpenFinding * 10000) / 10000,
    },
  };

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (ALERTS_ONLY) {
    if (alerts.length === 0) {
      console.log("No budget alerts.");
    } else {
      console.log(`\n--- Budget Alerts (${alerts.length}) ---`);
      for (const a of alerts) {
        console.log(`  [!] ${a.message}`);
      }
    }
    return;
  }

  // Human-readable output
  console.log(`\n=== Token Dashboard (${report.period}) ===`);
  console.log(`Total: ${totalTokens(totalInput + totalOutput)} tokens | $${report.totalCostUSD.toFixed(4)} | ${totalCalls} calls | $${report.costPerHour.toFixed(4)}/hr`);

  console.log("\n--- By Component ---");
  for (const [comp, v] of Object.entries(report.byComponent)) {
    console.log(`  ${comp.padEnd(28)} ${totalTokens(v.inputTokens + v.outputTokens).padStart(10)} tokens  $${v.costUSD.toFixed(4).padStart(8)}  (${v.calls} calls)`);
  }

  console.log("\n--- By Provider ---");
  for (const [prov, v] of Object.entries(report.byProvider)) {
    console.log(`  ${prov.padEnd(12)} ${totalTokens(v.inputTokens + v.outputTokens).padStart(10)} tokens  $${v.costUSD.toFixed(4).padStart(8)}  (${v.calls} calls)`);
  }

  console.log("\n--- By Model ---");
  for (const [mod, v] of Object.entries(report.byModel)) {
    console.log(`  ${mod.padEnd(16)} ${totalTokens(v.inputTokens + v.outputTokens).padStart(10)} tokens  $${v.costUSD.toFixed(4).padStart(8)}  (${v.calls} calls)`);
  }

  if (hourlyTrend.length > 0) {
    console.log("\n--- Hourly Trend (last " + Math.min(hourlyTrend.length, 24) + " hours) ---");
    for (const h of hourlyTrend.slice(-24)) {
      const bar = "#".repeat(Math.min(Math.ceil(h.costUSD * 20), 50));
      console.log(`  ${h.hour}  $${h.costUSD.toFixed(4).padStart(8)}  ${h.calls.toString().padStart(3)} calls  ${bar}`);
    }
  }

  console.log("\n--- Efficiency ---");
  console.log(`  Findings: ${findingsData.total} total, ${findingsData.open} open`);
  console.log(`  Cost per finding: $${report.efficiency.costPerFinding.toFixed(4)}`);
  console.log(`  Cost per open finding: $${report.efficiency.costPerOpenFinding.toFixed(4)}`);

  if (alerts.length > 0) {
    console.log(`\n--- Budget Alerts (${alerts.length}) ---`);
    for (const a of alerts) {
      console.log(`  [!] ${a.message}`);
    }
  }

  console.log("");
}

function totalTokens(n) {
  return n.toLocaleString();
}

main();
