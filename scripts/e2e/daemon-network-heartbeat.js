#!/usr/bin/env node
/**
 * Daemon Network Heartbeat — Reports this daemon's status to the ChangePilot hub.
 *
 * Sends: status, token inventory, convergence state, spec compliance score.
 * Receives: other nodes' status + any pending signals.
 *
 * When CHANGEPILOT_SERVICE_KEY is not set, this script is a no-op (single-machine mode).
 *
 * Usage: node scripts/e2e/daemon-network-heartbeat.js [--json]
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

try { require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") }); } catch { /* no dotenv */ }

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");

const CHANGEPILOT_API_URL = process.env.CHANGEPILOT_API_URL ?? "https://moc-ai.vercel.app";
const CHANGEPILOT_SERVICE_KEY = process.env.CHANGEPILOT_SERVICE_KEY;
const MACHINE_ID = `${os.hostname()}-${os.userInfo().username}`;

function loadJSON(filepath) {
  if (!fs.existsSync(filepath)) { return null; }
  try { return JSON.parse(fs.readFileSync(filepath, "utf-8")); } catch { return null; }
}

function detectTokenInventory() {
  const inventory = {};

  if (process.env.ANTHROPIC_API_KEY) {
    inventory.claude = { available: true, key_prefix: process.env.ANTHROPIC_API_KEY.slice(0, 8) };
  }
  if (process.env.GEMINI_API_KEY) {
    inventory.gemini = { available: true };
  }
  if (process.env.OPENAI_API_KEY) {
    inventory.openai = { available: true };
  }

  // Check for rate limits from budget-exhausted state
  const budgetState = loadJSON(path.join(STATE_DIR, "budget-exhausted.json"));
  if (budgetState) {
    for (const [provider, state] of Object.entries(budgetState)) {
      if (inventory[provider] && state.exhausted) {
        inventory[provider].rate_limited = true;
        inventory[provider].rate_limited_until = state.until ?? null;
      }
    }
  }

  return inventory;
}

function getConvergenceState() {
  const health = loadJSON(path.join(STATE_DIR, "daemon-health-summary.json"));
  return health?.convergence?.state ?? "unknown";
}

function getSpecComplianceScore() {
  const builderState = loadJSON(path.join(STATE_DIR, "builder-state.json"));
  return builderState?.specCompletionRate ?? 0;
}

function getDaemonVersion() {
  try {
    const pkg = loadJSON(path.join(ROOT, "package.json"));
    return pkg?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function sendHeartbeat() {
  const headers = {
    "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  const body = {
    machine_id: MACHINE_ID,
    status: "active",
    token_inventory: detectTokenInventory(),
    daemon_version: getDaemonVersion(),
    stack: process.env.DAEMON_STACK_TAG ?? "nextjs-supabase",
    convergence_state: getConvergenceState(),
    spec_compliance_score: getSpecComplianceScore(),
    metadata: {
      uptime_hours: process.uptime() / 3600,
      node_version: process.version,
      platform: os.platform(),
    },
  };

  const res = await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/heartbeat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Heartbeat failed: ${res.status} ${text.slice(0, 200)}`);
  }

  return res.json();
}

async function reportBudget() {
  const inventory = detectTokenInventory();
  const updates = [];

  for (const [provider, state] of Object.entries(inventory)) {
    updates.push({
      provider,
      rate_limited_until: state.rate_limited ? (state.rate_limited_until ?? null) : null,
    });
  }

  if (updates.length === 0) { return; }

  await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/budget`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ updates }),
  }).catch(() => { /* non-fatal */ });
}

async function main() {
  const asJson = process.argv.includes("--json");

  if (!CHANGEPILOT_SERVICE_KEY) {
    if (asJson) {
      console.log(JSON.stringify({ mode: "single-machine", skipped: true }));
    } else {
      console.log("[daemon-heartbeat] No CHANGEPILOT_SERVICE_KEY — single-machine mode, skipping");
    }
    return;
  }

  try {
    const result = await sendHeartbeat();
    await reportBudget();

    // Write received network state to local file for other scripts to read
    const networkState = {
      node_id: result.node_id,
      network_nodes: result.network_nodes ?? [],
      last_heartbeat: new Date().toISOString(),
      machine_id: MACHINE_ID,
    };
    fs.writeFileSync(
      path.join(STATE_DIR, "daemon-network-state.json"),
      JSON.stringify(networkState, null, 2) + "\n"
    );

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const nodeCount = (result.network_nodes ?? []).length;
      console.log(`[daemon-heartbeat] OK — node registered, ${nodeCount} other node(s) in network`);
    }
  } catch (err) {
    console.error(`[daemon-heartbeat] Error: ${err.message}`);
    if (asJson) {
      console.log(JSON.stringify({ error: err.message }));
    }
  }
}

if (require.main === module) { main(); }
module.exports = { sendHeartbeat, detectTokenInventory, MACHINE_ID };
