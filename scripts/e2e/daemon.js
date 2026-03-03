#!/usr/bin/env node

/**
 * Daemon — Long-running process manager for independent claws.
 *
 * Generic version for @changepilot/persona-engine.
 * Spawns claw processes, monitors heartbeats, restarts on crash,
 * handles graceful shutdown, and exposes an HTTP status endpoint.
 *
 * Usage:
 *   node runtime/daemon.js                    # Start all claws
 *   node runtime/daemon.js --claw test-runner # Start single claw
 *   node runtime/daemon.js --status           # Show claw statuses
 *   node runtime/daemon.js --pause fix-engine # Pause a claw
 *   node runtime/daemon.js --resume fix-engine # Resume a claw
 *   node runtime/daemon.js --trigger test-runner # Trigger immediate run
 *   node runtime/daemon.js --full-cycle       # Run all claws sequentially (like loop.sh)
 *   node runtime/daemon.js --tail fix-engine  # Stream claw output
 *   node runtime/daemon.js --signal deploy-detected --sha abc123
 *   node runtime/daemon.js --stop             # Graceful shutdown
 */

const { fork, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

/**
 * Kill a process and its entire tree. On Windows, process.kill() only kills
 * the direct process — grandchildren (e.g. ESLint spawned by npm spawned by
 * felix-fix spawned by a claw) become orphans that leak memory indefinitely.
 * taskkill /T kills the whole tree.
 */
function killProcessTree(pid, signal) {
  try {
    if (os.platform() === "win32") {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", timeout: 10000 });
    } else {
      // On Unix, kill the process group
      try { process.kill(-pid, signal || "SIGKILL"); } catch {}
      try { process.kill(pid, signal || "SIGKILL"); } catch {}
    }
  } catch {
    // taskkill may fail if process already exited — that's fine
    try { process.kill(pid, signal || "SIGKILL"); } catch {}
  }
}

function findProjectRoot() {
  let dir = path.resolve(__dirname, "..", "..");
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "persona-engine.json")) || fs.existsSync(path.join(dir, "daemon-config.json")) || fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, "..", "..");
}
const ROOT = findProjectRoot();
const STATE_DIR = path.join(ROOT, "e2e", "state");
const SIGNALS_PATH = path.join(STATE_DIR, "claw-signals.json");
const CONFIG_PATH = path.join(ROOT, "daemon-config.json");
const PID_FILE = path.join(STATE_DIR, "daemon.pid");
const LOG_FILE = path.join(STATE_DIR, "daemon.log");
const NETWORK_STATE_PATH = path.join(STATE_DIR, "daemon-network-state.json");
const SUSPEND_FILE = path.join(STATE_DIR, "daemon.suspend");
const SHUTDOWN_MARKER = path.join(STATE_DIR, "daemon.shutdown");

try { require("dotenv").config({ path: path.join(ROOT, ".env.local") }); } catch {}

const CHANGEPILOT_SERVICE_KEY = process.env.CHANGEPILOT_SERVICE_KEY;
const CHANGEPILOT_API_URL = process.env.CHANGEPILOT_API_URL ?? "https://moc-ai.vercel.app";
const MACHINE_ID = `${os.hostname()}-${os.userInfo().username}`;

let remoteSignalBus;
try {
  remoteSignalBus = require("./remote-signal-bus");
} catch {
  remoteSignalBus = null;
}

function loadClawFiles() {
  const clawDir = path.join(__dirname, "claws");
  const configPath = path.join(ROOT, "daemon-config.json");
  const defaultClaws = {};

  // Discover from claws directory
  try {
    const files = fs.readdirSync(clawDir).filter(f => f.endsWith(".js"));
    for (const f of files) {
      const name = f.replace(".js", "");
      defaultClaws[name] = path.join(clawDir, f);
    }
  } catch {}

  // Config may override
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (config.claws) {
      for (const name of Object.keys(config.claws)) {
        if (!defaultClaws[name]) {
          const possiblePath = path.join(clawDir, `${name}.js`);
          if (fs.existsSync(possiblePath)) {
            defaultClaws[name] = possiblePath;
          }
        }
      }
    }
  } catch {}

  return defaultClaws;
}

const CLAW_FILES = loadClawFiles();

const CLAW_ORDER = Object.keys(CLAW_FILES);

// ---------------------------------------------------------------------------
// Atomic write (import from claw.js or inline for standalone use)
// ---------------------------------------------------------------------------

function atomicWriteSync(filePath, data) {
  const tmpPath = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// CLI Parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function hasArg(name) {
  return args.includes(name);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
let _daemonLogWrites = 0;

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = `[${ts}] [daemon] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
    _daemonLogWrites++;
    if (_daemonLogWrites % 100 === 0) {
      try {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size > MAX_LOG_SIZE) {
          const rotated = LOG_FILE + ".old";
          try { fs.unlinkSync(rotated); } catch {}
          fs.renameSync(LOG_FILE, rotated);
          fs.writeFileSync(LOG_FILE, `[${ts}] [daemon] log rotated (was ${(stat.size / 1024 / 1024).toFixed(1)}MB)\n`);
        }
      } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// State helpers (with locking)
// ---------------------------------------------------------------------------

const LOCK_PATH = SIGNALS_PATH + ".lock";

function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const lockData = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  let attempts = 0;
  const maxAttempts = Math.ceil(timeoutMs / 50);
  while (Date.now() < deadline && attempts < maxAttempts) {
    attempts++;
    try {
      fs.writeFileSync(lockPath, lockData, { flag: "wx" });
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const existing = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
          if (Date.now() - new Date(existing.at).getTime() > 30000) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }
          if (existing.pid) {
            try { process.kill(existing.pid, 0); } catch {
              try { fs.unlinkSync(lockPath); } catch {}
              continue;
            }
          }
        } catch {
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } catch {
          const end = Date.now() + 20;
          while (Date.now() < end) { /* minimal fallback */ }
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch {}
}

function withSignalsLock(mutator) {
  let locked = false;
  try {
    locked = acquireLock(LOCK_PATH, 5000);
    const signals = loadSignals();
    mutator(signals);
    atomicWriteSync(SIGNALS_PATH, JSON.stringify(signals, null, 2) + "\n");
  } catch (err) {
    log(`signals write error: ${err.message}`);
  } finally {
    if (locked) { releaseLock(LOCK_PATH); }
  }
}

function loadSignals() {
  if (!fs.existsSync(SIGNALS_PATH)) { return { signals: {}, claws: {} }; }
  try { return JSON.parse(fs.readFileSync(SIGNALS_PATH, "utf-8")); } catch { return { signals: {}, claws: {} }; }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) { return { claws: {}, daemon: {} }; }
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { return { claws: {}, daemon: {} }; }
}

// ---------------------------------------------------------------------------
// Signal garbage collection — remove expired signals
// ---------------------------------------------------------------------------

function gcSignals() {
  const config = loadConfig();
  const expiryMs = (config.daemon?.signalExpiryHours ?? 24) * 60 * 60 * 1000;
  const now = Date.now();

  withSignalsLock((signals) => {
    for (const [name, data] of Object.entries(signals.signals)) {
      // Never GC command signals (they're deleted after processing)
      if (name.startsWith("_cmd_")) { continue; }
      if (data.at && (now - new Date(data.at).getTime()) > expiryMs) {
        delete signals.signals[name];
        log(`gc: expired signal ${name} (age: ${Math.round((now - new Date(data.at).getTime()) / 3600000)}h)`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// CLI Commands (non-daemon modes)
// ---------------------------------------------------------------------------

if (hasArg("--status")) {
  printStatus();
  process.exit(0);
}

if (hasArg("--stop")) {
  stopDaemon();
  process.exit(0);
}

if (hasArg("--pause")) {
  sendCommandToRunningDaemon("pause", getArg("--pause"));
  process.exit(0);
}

if (hasArg("--resume")) {
  sendCommandToRunningDaemon("resume", getArg("--resume"));
  process.exit(0);
}

if (hasArg("--trigger")) {
  sendCommandToRunningDaemon("trigger", getArg("--trigger"));
  process.exit(0);
}

if (hasArg("--signal")) {
  injectSignal(getArg("--signal"), {
    sha: getArg("--sha"),
    data: getArg("--data"),
  });
  process.exit(0);
}

if (hasArg("--tail")) {
  tailClaw(getArg("--tail"));
  // Does not exit — streams output
}

if (hasArg("--full-cycle")) {
  fullCycle().then((ok) => process.exit(ok ? 0 : 1));
} else {
  const singleClaw = getArg("--claw");
  const joinMode = hasArg("--join");
  const takeoverMode = hasArg("--takeover");
  negotiateAndStart(singleClaw, { join: joinMode, takeover: takeoverMode });
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function printStatus() {
  const signals = loadSignals();
  const config = loadConfig();

  console.log("\n=== Daemon Status ===\n");

  // Check if daemon is running
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    console.log(`Daemon PID: ${pid} (check if running with: kill -0 ${pid})`);
  } else {
    console.log("Daemon: not running (no PID file)");
  }

  console.log("\n--- Claws ---\n");
  for (const name of CLAW_ORDER) {
    const claw = signals.claws?.[name] ?? {};
    const cfg = config.claws?.[name] ?? {};
    const enabled = cfg.enabled !== false ? "enabled" : "DISABLED";
    const status = claw.status ?? "unknown";
    const pid = claw.pid ?? "-";
    const lastRun = claw.lastRun ? timeSince(claw.lastRun) : "never";
    const nextRun = claw.nextRun ? timeUntil(claw.nextRun) : "-";
    const heartbeat = claw.heartbeat ? timeSince(claw.heartbeat) : "no heartbeat";
    const cycle = claw.cycle ?? 0;
    const phase = claw.phase ? ` (${claw.phase})` : "";

    // Warn if heartbeat is stale (possible hang)
    const hbStaleMs = (config.daemon?.heartbeatStaleThresholdMinutes ?? 5) * 60 * 1000;
    const hbAge = claw.heartbeat ? Date.now() - new Date(claw.heartbeat).getTime() : Infinity;
    const staleWarning = (hbAge > hbStaleMs && claw.status === "running") ? " ⚠ STALE" : "";

    console.log(`  ${name.padEnd(20)} ${status.padEnd(10)} pid:${String(pid).padEnd(7)} cycle:${cycle} last:${lastRun} next:${nextRun} hb:${heartbeat}${staleWarning} [${enabled}]${phase}`);
  }

  // Check watchdog
  const watchdogPidFile = path.join(STATE_DIR, "watchdog.pid");
  if (fs.existsSync(watchdogPidFile)) {
    const wdPid = parseInt(fs.readFileSync(watchdogPidFile, "utf-8").trim(), 10);
    console.log(`\nWatchdog PID: ${wdPid}`);
  } else {
    console.log("\nWatchdog: not running");
  }

  // Health summary
  const healthSummaryPath = path.join(STATE_DIR, "daemon-health-summary.json");
  if (fs.existsSync(healthSummaryPath)) {
    try {
      const hs = JSON.parse(fs.readFileSync(healthSummaryPath, "utf-8"));
      console.log(`\nLast heartbeat: ${hs.at ? timeSince(hs.at) + " ago" : "never"}`);
      console.log(`  ${hs.summary ?? "no summary"}`);
    } catch {}
  }

  console.log("\n--- Signals ---\n");
  const sigs = signals.signals ?? {};
  if (Object.keys(sigs).length === 0) {
    console.log("  (none)");
  }
  for (const [name, data] of Object.entries(sigs)) {
    const age = data.at ? timeSince(data.at) : "unknown";
    const extra = Object.entries(data).filter(([k]) => !["at", "emittedBy"].includes(k)).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`  ${name.padEnd(20)} ${age} ago  from:${data.emittedBy ?? "?"} ${extra}`);
  }

  console.log();
}

function timeSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) { return `${Math.round(ms / 1000)}s`; }
  if (ms < 3600000) { return `${Math.round(ms / 60000)}m`; }
  return `${(ms / 3600000).toFixed(1)}h`;
}

function timeUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) { return "overdue"; }
  if (ms < 60000) { return `${Math.round(ms / 1000)}s`; }
  if (ms < 3600000) { return `${Math.round(ms / 60000)}m`; }
  return `${(ms / 3600000).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// Signal injection
// ---------------------------------------------------------------------------

function injectSignal(name, data) {
  if (!name) {
    console.error("Usage: --signal <name> [--sha <sha>] [--data <json>]");
    return;
  }
  withSignalsLock((signals) => {
    signals.signals[name] = {
      at: new Date().toISOString(),
      emittedBy: "cli",
      ...data,
    };
  });
  log(`injected signal: ${name}`);
}

// ---------------------------------------------------------------------------
// Send command to running daemon via signal file
// ---------------------------------------------------------------------------

function sendCommandToRunningDaemon(command, clawName) {
  if (!clawName) {
    console.error(`Usage: --${command} <claw-name>`);
    return;
  }
  if (!CLAW_FILES[clawName]) {
    console.error(`Unknown claw: ${clawName}. Available: ${CLAW_ORDER.join(", ")}`);
    return;
  }

  withSignalsLock((signals) => {
    signals.signals[`_cmd_${command}_${clawName}`] = {
      at: new Date().toISOString(),
      emittedBy: "cli",
      command,
      claw: clawName,
    };
  });
  log(`sent ${command} command to ${clawName}`);
}

// ---------------------------------------------------------------------------
// Stop daemon
// ---------------------------------------------------------------------------

function stopDaemon() {
  if (!fs.existsSync(PID_FILE)) {
    console.log("No daemon PID file found. Sending stop signal anyway.");
  }

  withSignalsLock((signals) => {
    signals.signals["_cmd_shutdown"] = {
      at: new Date().toISOString(),
      emittedBy: "cli",
    };
  });

  // Also try SIGTERM if we have a PID
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      process.kill(pid, "SIGTERM");
      log(`sent SIGTERM to daemon (pid ${pid})`);
    } catch (err) {
      log(`could not signal daemon: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tail claw output (using fs.watch when available, polling fallback)
// ---------------------------------------------------------------------------

function tailClaw(clawName) {
  if (!clawName) {
    console.error("Usage: --tail <claw-name>");
    process.exit(1);
  }

  const logPath = LOG_FILE;
  if (!fs.existsSync(logPath)) {
    console.error("No daemon log found at:", logPath);
    process.exit(1);
  }

  // Print last 50 lines for this claw
  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.includes(`[${clawName}]`));
  for (const line of lines.slice(-50)) {
    console.log(line);
  }

  console.log(`\n--- Tailing [${clawName}] (Ctrl+C to stop) ---\n`);
  let lastSize = fs.statSync(logPath).size;

  function readNewLines() {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > lastSize) {
        const fd = fs.openSync(logPath, "r");
        const buf = Buffer.alloc(stat.size - lastSize);
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;

        const newLines = buf.toString().split("\n").filter((l) => l.includes(`[${clawName}]`));
        for (const line of newLines) {
          if (line.trim()) { console.log(line); }
        }
      } else if (stat.size < lastSize) {
        // Log was truncated/rotated — reset
        lastSize = stat.size;
      }
    } catch {}
  }

  // Try fs.watch first, fall back to polling
  try {
    const watcher = fs.watch(logPath, { persistent: true }, () => readNewLines());
    watcher.on("error", () => {
      // Fall back to polling
      setInterval(readNewLines, 1000);
    });
  } catch {
    setInterval(readNewLines, 1000);
  }
}

// ---------------------------------------------------------------------------
// Full Cycle (sequential, like old loop.sh)
// ---------------------------------------------------------------------------

async function fullCycle() {
  log("full-cycle mode: running all claws sequentially");

  for (const name of CLAW_ORDER) {
    const config = loadConfig();
    if (config.claws?.[name]?.enabled === false) {
      log(`full-cycle: skipping ${name} (disabled)`);
      continue;
    }

    // Validate claw file exists before requiring
    if (!fs.existsSync(CLAW_FILES[name])) {
      log(`full-cycle: ${name} file not found at ${CLAW_FILES[name]}, skipping`);
      continue;
    }

    log(`full-cycle: running ${name}`);
    let clawModule;
    try {
      clawModule = require(CLAW_FILES[name]);
    } catch (err) {
      log(`full-cycle: ${name} failed to load — ${err.message}`);
      continue;
    }

    const ClawClass = Object.values(clawModule).find((v) => typeof v === "function" && v.prototype?.run);

    if (!ClawClass) {
      log(`full-cycle: ${name} has no Claw class, skipping`);
      continue;
    }

    const claw = new ClawClass();
    try {
      const result = await claw.run();
      log(`full-cycle: ${name} complete — ${result?.summary ?? "no summary"}`);
    } catch (err) {
      log(`full-cycle: ${name} error — ${err.message}`);
    }
  }

  log("full-cycle: complete");
  return true;
}

// ---------------------------------------------------------------------------
// Network negotiation — detect existing nodes, decide join/takeover/solo
// ---------------------------------------------------------------------------

async function negotiateAndStart(singleClaw, opts = {}) {
  if (!CHANGEPILOT_SERVICE_KEY) {
    log("no CHANGEPILOT_SERVICE_KEY — starting in solo mode");
    startDaemon(singleClaw, { mode: "solo", assignedClaws: null });
    return;
  }

  log("network mode: checking for existing daemon nodes...");
  let existingNodes = [];

  try {
    const res = await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/heartbeat`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ machine_id: MACHINE_ID, status: "negotiating" }),
    });

    if (res.ok) {
      const data = await res.json();
      existingNodes = (data.network_nodes ?? []).filter(
        (n) => n.machine_id !== MACHINE_ID && n.status === "active" &&
        (Date.now() - new Date(n.last_heartbeat).getTime() < 5 * 60 * 1000)
      );
    }
  } catch (err) {
    log(`network check failed (${err.message}) — starting in solo mode`);
    startDaemon(singleClaw, { mode: "solo", assignedClaws: null });
    return;
  }

  if (existingNodes.length === 0) {
    log("no active nodes found — starting as primary");
    startDaemon(singleClaw, { mode: "primary", assignedClaws: null });
    return;
  }

  const activeNode = existingNodes[0];
  log(`found active node: ${activeNode.machine_id} (status: ${activeNode.status})`);

  if (opts.takeover) {
    log(`sending takeover request to ${activeNode.machine_id}`);
    try {
      await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/signal`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          signal: "takeover-requested",
          payload: { machine_id: MACHINE_ID, target: activeNode.machine_id },
        }),
      });
    } catch {}

    log("waiting for remote daemon to release (up to 60s)...");
    let released = false;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const checkRes = await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/heartbeat`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ machine_id: MACHINE_ID, status: "negotiating" }),
        });
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          const stillActive = (checkData.network_nodes ?? []).filter(
            (n) => n.machine_id === activeNode.machine_id && n.status === "active" &&
            (Date.now() - new Date(n.last_heartbeat).getTime() < 30000)
          );
          if (stillActive.length === 0) { released = true; break; }
        }
      } catch {}
    }

    if (!released) {
      log("remote daemon did not release — starting anyway as primary (stale node)");
    }
    startDaemon(singleClaw, { mode: "primary", assignedClaws: null });
    return;
  }

  if (opts.join) {
    const remoteClaws = activeNode.metadata?.active_claws ?? [];
    const allClaws = CLAW_ORDER;
    const config = loadConfig();

    const localClaws = allClaws.filter((name) => {
      if (config.claws?.[name]?.enabled === false) { return false; }
      return !remoteClaws.includes(name);
    });

    if (localClaws.length === 0) {
      log("remote node is running all claws — nothing to join. Use --takeover to replace.");
      process.exit(0);
    }

    log(`joining network — local claws: [${localClaws.join(", ")}], remote: [${remoteClaws.join(", ")}]`);
    startDaemon(null, { mode: "joined", assignedClaws: localClaws });
    return;
  }

  // Interactive: prompt user (only when stdin is a TTY)
  if (process.stdin.isTTY) {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question(
        `Daemon already running on ${activeNode.machine_id}.\n  [j]oin  [t]akeover  [c]ancel: `,
        resolve,
      );
    });
    rl.close();

    const choice = (answer ?? "").trim().toLowerCase();
    if (choice === "j" || choice === "join") {
      return negotiateAndStart(singleClaw, { join: true });
    }
    if (choice === "t" || choice === "takeover") {
      return negotiateAndStart(singleClaw, { takeover: true });
    }
    log("cancelled");
    process.exit(0);
  }

  // Non-interactive (CI, cron): default to join
  log("non-interactive + existing node — defaulting to join mode");
  return negotiateAndStart(singleClaw, { join: true });
}

// ---------------------------------------------------------------------------
// Daemon Mode — spawn and manage claw processes
// ---------------------------------------------------------------------------

function startDaemon(singleClaw, networkOpts = {}) {
  const config = loadConfig();
  const daemonConfig = config.daemon ?? {};
  const maxRestartsPerHour = daemonConfig.maxRestartsPerHour ?? 3;
  const healthPort = daemonConfig.healthPort ?? 9100;
  const heartbeatStaleMs = (daemonConfig.heartbeatStaleThresholdMinutes ?? 5) * 60 * 1000;
  const daemonStartedAt = new Date().toISOString();

  // Write PID file and clear stale shutdown marker
  fs.writeFileSync(PID_FILE, String(process.pid));
  try { fs.unlinkSync(SHUTDOWN_MARKER); } catch {}
  log(`daemon started (pid ${process.pid})`);

  // Kill any orphaned node processes from previous daemon runs
  if (os.platform() === "win32") {
    try {
      const output = execSync(
        'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
        { stdio: "pipe", timeout: 10000, windowsHide: true }
      ).toString();
      let orphansKilled = 0;
      for (const line of output.split("\n")) {
        // Only target moc-ai/e2e/eslint processes, skip MCP servers, Claude, and ourselves
        if (!line.includes("moc-ai") && !line.includes("e2e\\") && !line.includes("eslint")) { continue; }
        if (line.includes("modelcontextprotocol") || line.includes("claude") || line.includes("daemon.js")) { continue; }
        const parts = line.split(",");
        const pid = parseInt(parts[parts.length - 1], 10);
        if (!pid || pid === process.pid) { continue; }
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", timeout: 10000 });
          orphansKilled++;
        } catch {}
      }
      if (orphansKilled > 0) {
        log(`startup: killed ${orphansKilled} orphaned processes from previous runs`);
      }
    } catch {}
  }

  // Run signal GC on startup
  gcSignals();

  // Run self-test before spawning claws
  log("running startup self-test...");
  try {
    const { execSync: execSyncSt } = require("child_process");
    const selfTestResult = execSyncSt("node scripts/e2e/self-test.js", {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 180000,
    });
    log(`self-test passed: ${selfTestResult.toString().split("\n").filter((l) => l.includes("Passed") || l.includes("Auto-fixed")).join("; ").slice(0, 200)}`);
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().slice(0, 300) : err.message;
    log(`self-test had failures (continuing anyway): ${stderr}`);
  }

  // Spawn watchdog as sibling process (not child — survives daemon crash)
  const watchdogConfig = config.watchdog ?? {};
  const watchdogPidFile = path.join(STATE_DIR, "watchdog.pid");
  if (watchdogConfig.enabled !== false) {
    let watchdogAlive = false;
    if (fs.existsSync(watchdogPidFile)) {
      try {
        const existingPid = parseInt(fs.readFileSync(watchdogPidFile, "utf-8").trim(), 10);
        process.kill(existingPid, 0);
        watchdogAlive = true;
        log(`watchdog already running (pid ${existingPid}), skipping spawn`);
      } catch {
        try { fs.unlinkSync(watchdogPidFile); } catch {}
      }
    }
    if (!watchdogAlive) {
      try {
        const resources = daemonConfig.resources ?? {};
        const watchdogHeapMB = resources.watchdogHeapMB ?? 128;
        const watchdogChild = fork(path.join(__dirname, "watchdog.js"), [], {
          cwd: ROOT,
          detached: true,
          stdio: "ignore",
          env: process.env,
          windowsHide: true,
          execArgv: [`--max-old-space-size=${watchdogHeapMB}`],
        });
        watchdogChild.unref();
        log(`watchdog spawned (pid ${watchdogChild.pid})`);
      } catch (err) {
        log(`could not spawn watchdog: ${err.message}`);
      }
    }
  }

  // Clean up orphaned files from prior crashes
  try {
    const stateFiles = fs.readdirSync(STATE_DIR);
    let cleaned = 0;
    for (const f of stateFiles) {
      if (f.includes(".tmp.")) {
        const pidMatch = f.match(/\.tmp\.(\d+)$/);
        if (pidMatch) {
          const tmpPid = parseInt(pidMatch[1], 10);
          let alive = false;
          try { process.kill(tmpPid, 0); alive = true; } catch {}
          if (!alive) {
            try { fs.unlinkSync(path.join(STATE_DIR, f)); cleaned++; } catch {}
          }
        }
      }
      if (f.startsWith(".lock-moc-fix")) {
        try {
          const stat = fs.statSync(path.join(STATE_DIR, f));
          if (Date.now() - stat.mtimeMs > 3600000) {
            fs.unlinkSync(path.join(STATE_DIR, f));
            cleaned++;
          }
        } catch {}
      }
    }
    if (cleaned > 0) { log(`cleaned ${cleaned} orphaned temp/lock files`); }
  } catch {}

  // Prune large JSONL files on startup
  try {
    const jsonlFiles = [
      { name: "claw-history.jsonl", maxLines: 2000 },
      { name: "run-log.jsonl", maxLines: 5000 },
      { name: "loop-performance.jsonl", maxLines: 2000 },
      { name: "oracle-feedback.jsonl", maxLines: 5000 },
      { name: "screenshot-metadata.jsonl", maxLines: 3000 },
    ];
    for (const { name, maxLines } of jsonlFiles) {
      const fp = path.join(STATE_DIR, name);
      if (!fs.existsSync(fp)) { continue; }
      try {
        const content = fs.readFileSync(fp, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        if (lines.length > maxLines) {
          const pruned = lines.slice(-maxLines).join("\n") + "\n";
          const tmpPath = fp + `.tmp.${process.pid}`;
          fs.writeFileSync(tmpPath, pruned);
          fs.renameSync(tmpPath, fp);
          log(`pruned ${name}: ${lines.length} → ${maxLines} lines`);
        }
      } catch {}
    }
  } catch {}

  // Compact large JSON state files (re-save to trigger internal caps)
  try {
    const maxJsonSizeMB = 5;
    const largeJsonFiles = ["fix-effectiveness.json", "auto-fix-log.json", "green-history.json"];
    for (const name of largeJsonFiles) {
      const fp = path.join(STATE_DIR, name);
      if (!fs.existsSync(fp)) { continue; }
      try {
        const stat = fs.statSync(fp);
        if (stat.size > maxJsonSizeMB * 1024 * 1024) {
          const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
          // Cap arrays to prevent bloat
          if (Array.isArray(data.entries) && data.entries.length > 50) {
            data.entries = data.entries.slice(-50);
          }
          if (data.findingSnapshots && typeof data.findingSnapshots === "object") {
            const keys = Object.keys(data.findingSnapshots).sort();
            while (keys.length > 3) {
              delete data.findingSnapshots[keys.shift()];
            }
          }
          if (Array.isArray(data.verifiedFixes) && data.verifiedFixes.length > 200) {
            data.verifiedFixes = data.verifiedFixes.slice(-200);
          }
          if (Array.isArray(data.fixes) && data.fixes.length > 200) {
            data.fixes = data.fixes.slice(-200);
          }
          if (Array.isArray(data.history) && data.history.length > 500) {
            data.history = data.history.slice(-500);
          }
          const tmpPath = fp + `.tmp.${process.pid}`;
          fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
          fs.renameSync(tmpPath, fp);
          const newSize = fs.statSync(fp).size;
          log(`compacted ${name}: ${(stat.size / 1024 / 1024).toFixed(1)}MB → ${(newSize / 1024 / 1024).toFixed(1)}MB`);
        }
      } catch {}
    }
  } catch {}

  // Determine which claws to spawn
  const networkMode = networkOpts.mode ?? "solo";
  const assignedClaws = networkOpts.assignedClaws;
  const clawsToSpawn = singleClaw
    ? [singleClaw]
    : assignedClaws
      ? assignedClaws.filter((name) => config.claws?.[name]?.enabled !== false)
      : CLAW_ORDER.filter((name) => config.claws?.[name]?.enabled !== false);

  log(`network mode: ${networkMode}, claws: [${clawsToSpawn.join(", ")}]`);

  // Track child processes
  const children = {};
  const restartCounts = {}; // name -> [timestamp]

  // Spawn each claw
  for (const name of clawsToSpawn) {
    spawnClaw(name);
  }

  function spawnClaw(name) {
    if (!CLAW_FILES[name]) {
      log(`unknown claw: ${name}`);
      return;
    }

    // Validate claw file exists
    if (!fs.existsSync(CLAW_FILES[name])) {
      log(`claw file not found: ${CLAW_FILES[name]}`);
      return;
    }

    const resources = daemonConfig.resources ?? {};
    const defaultHeapMB = resources.maxHeapMB ?? 256;
    const heapMB = resources.clawHeapOverrides?.[name] ?? defaultHeapMB;
    log(`spawning claw: ${name} (heap: ${heapMB}MB)`);
    let child;
    try {
      child = fork(CLAW_FILES[name], [], {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: process.env,
        windowsHide: true,
        execArgv: [`--max-old-space-size=${heapMB}`],
      });
    } catch (err) {
      log(`failed to fork ${name}: ${err.message}`);
      return;
    }

    children[name] = child;

    // Pipe output to daemon log
    child.stdout?.on("data", (data) => {
      process.stdout.write(data);
    });

    child.stderr?.on("data", (data) => {
      process.stderr.write(data);
    });

    // Handle claw messages
    child.on("message", (msg) => {
      if (msg?.type === "cycle-complete") {
        log(`claw ${msg.claw} cycle ${msg.cycle} complete (${(msg.duration / 1000).toFixed(1)}s)`);
        // Reset idle state on successful cycle
        idleState[msg.claw] = { idleCycles: 0, budgetExhausted: false, circuitBroken: false };
      }
      if (msg?.type === "idle-report") {
        idleState[msg.claw] = {
          idleCycles: msg.idleCycles,
          budgetExhausted: msg.budgetExhausted,
          circuitBroken: msg.circuitBroken,
        };
      }
    });

    // Handle crash — restart with backoff, permanently disable after max restarts
    child.on("exit", (code, signal) => {
      log(`claw ${name} exited (code=${code}, signal=${signal})`);
      delete children[name];

      // Don't restart during shutdown
      if (shuttingDown) { return; }

      // Track restart count (hourly window + session total)
      if (!restartCounts[name]) { restartCounts[name] = { timestamps: [], disabledForSession: false }; }
      if (restartCounts[name].disabledForSession) {
        log(`claw ${name} is disabled for this session — not restarting`);
        return;
      }
      const now = Date.now();
      restartCounts[name].timestamps = restartCounts[name].timestamps.filter((t) => now - t < 3600000);
      restartCounts[name].timestamps.push(now);

      if (restartCounts[name].timestamps.length > maxRestartsPerHour) {
        restartCounts[name].disabledForSession = true;
        log(`claw ${name} exceeded max restarts (${maxRestartsPerHour}/hour) — disabled for session`);
        withSignalsLock((signals) => {
          if (!signals.claws[name]) { signals.claws[name] = {}; }
          signals.claws[name].status = "crashed";
          signals.claws[name].lastError = `exceeded max restarts — disabled for session`;
          signals.signals["claw-crashed"] = {
            at: new Date().toISOString(),
            emittedBy: "daemon",
            claw: name,
            reason: `exceeded max restarts (${maxRestartsPerHour}/hour) — permanently disabled`,
          };
        });
        return;
      }

      // Restart with exponential backoff: 10s, 20s, 40s, 60s max
      const backoff = Math.min(60000, 10000 * Math.pow(2, restartCounts[name].timestamps.length - 1));
      log(`restarting claw ${name} in ${backoff / 1000}s (restart ${restartCounts[name].timestamps.length}/${maxRestartsPerHour})`);
      setTimeout(() => {
        if (!shuttingDown) { spawnClaw(name); }
      }, backoff);
    });

    // Handle fork errors (e.g., file not found after initial check)
    child.on("error", (err) => {
      log(`claw ${name} fork error: ${err.message}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Idle state tracking — auto-shutdown when all claws are idle/exhausted
  // ---------------------------------------------------------------------------

  const idleState = {}; // name -> { idleCycles, budgetExhausted, circuitBroken }
  const idleShutdownThreshold = daemonConfig.idleShutdownThreshold ?? 30;
  const idleCheckIntervalMs = daemonConfig.idleCheckIntervalMs ?? 60000;

  const idleChecker = setInterval(() => {
    const activeClaws = Object.keys(children);
    if (activeClaws.length === 0) { return; }

    const allIdle = activeClaws.every((name) => {
      const state = idleState[name];
      if (!state) { return false; }
      return state.idleCycles >= idleShutdownThreshold ||
             state.budgetExhausted ||
             state.circuitBroken;
    });

    if (allIdle) {
      const reasons = activeClaws.map((name) => {
        const s = idleState[name];
        if (s.budgetExhausted) { return `${name}:budget`; }
        if (s.circuitBroken) { return `${name}:circuit`; }
        return `${name}:idle(${s.idleCycles})`;
      });
      log(`all claws idle/exhausted: ${reasons.join(", ")} — auto-shutting down`);
      gracefulShutdown("all-claws-idle");
    }
  }, idleCheckIntervalMs);

  // ---------------------------------------------------------------------------
  // System resource monitoring — pause/shutdown on high memory
  // ---------------------------------------------------------------------------

  const resourceCheckIntervalMs = daemonConfig.resourceCheckIntervalMs ?? 30000;
  const memoryThresholdPercent = daemonConfig.memoryThresholdPercent ?? 85;
  const emergencyMemoryPercent = daemonConfig.emergencyMemoryPercent ?? 92;
  let consecutiveHighMemory = 0;
  const HIGH_MEMORY_SHUTDOWN_COUNT = 5;
  const NON_ESSENTIAL_CLAWS = ["intelligence", "health-deploy", "diagnostics", "builder"];

  // Capture baseline memory at startup (before claws spawn)
  const baselineUsedBytes = os.totalmem() - os.freemem();
  log(`baseline memory at startup: ${(baselineUsedBytes / 1024 / 1024 / 1024).toFixed(1)} GB (${((baselineUsedBytes / os.totalmem()) * 100).toFixed(1)}%)`);

  // Expected max node processes: daemon(1) + claws(7) + watchdog(1) = 9
  // Each claw may have 1 active child = up to 16 total. Anything above 25 is likely zombies.
  const MAX_EXPECTED_NODE_PROCESSES = 25;

  /**
   * Count node.exe processes on Windows that belong to this project.
   * Returns count and total memory of moc-ai related node processes.
   */
  function countProjectNodeProcesses() {
    if (os.platform() !== "win32") { return { count: 0, memoryMB: 0 }; }
    try {
      const output = execSync(
        'wmic process where "name=\'node.exe\'" get CommandLine,WorkingSetSize /format:csv',
        { stdio: "pipe", timeout: 10000, windowsHide: true }
      ).toString();
      let count = 0;
      let memoryBytes = 0;
      for (const line of output.split("\n")) {
        if (line.includes("moc-ai") || line.includes("e2e") || line.includes("eslint")) {
          count++;
          const parts = line.split(",");
          const ws = parseInt(parts[parts.length - 1], 10);
          if (ws > 0) { memoryBytes += ws; }
        }
      }
      return { count, memoryMB: Math.round(memoryBytes / 1024 / 1024) };
    } catch {
      return { count: 0, memoryMB: 0 };
    }
  }

  /**
   * Kill zombie node processes that aren't tracked daemon children.
   */
  function killZombieProcesses() {
    if (os.platform() !== "win32") { return 0; }
    const knownPids = new Set([process.pid]);
    for (const child of Object.values(children)) {
      if (child?.pid) { knownPids.add(child.pid); }
    }
    // Also spare watchdog
    const wdPidFile = path.join(STATE_DIR, "watchdog.pid");
    try {
      const wdPid = parseInt(fs.readFileSync(wdPidFile, "utf-8").trim(), 10);
      knownPids.add(wdPid);
    } catch {}

    let killed = 0;
    try {
      const output = execSync(
        'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
        { stdio: "pipe", timeout: 10000, windowsHide: true }
      ).toString();
      for (const line of output.split("\n")) {
        if (!line.includes("moc-ai") && !line.includes("e2e") && !line.includes("eslint")) { continue; }
        // Skip MCP servers and Claude Code processes
        if (line.includes("modelcontextprotocol") || line.includes("claude")) { continue; }
        const parts = line.split(",");
        const pid = parseInt(parts[parts.length - 1], 10);
        if (!pid || knownPids.has(pid)) { continue; }
        // Check if this is a child of a known claw (claw children are fine)
        // But orphaned processes (no known parent) should be killed
        try {
          const parentCheck = execSync(
            `wmic process where "processid=${pid}" get ParentProcessId /format:csv`,
            { stdio: "pipe", timeout: 5000, windowsHide: true }
          ).toString();
          const parentParts = parentCheck.split(",");
          const parentPid = parseInt(parentParts[parentParts.length - 1], 10);
          if (parentPid && knownPids.has(parentPid)) {
            knownPids.add(pid); // Track as known child
            continue;
          }
        } catch {}
        // This is an orphan — kill it
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", timeout: 10000 });
          killed++;
          log(`killed zombie process (pid ${pid}): ${line.slice(0, 100)}`);
        } catch {}
      }
    } catch {}
    return killed;
  }

  let zombieCheckCounter = 0;
  const resourceMonitor = setInterval(() => {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedPercent = ((totalMem - freeMem) / totalMem) * 100;

      // Emergency: immediate shutdown
      if (usedPercent >= emergencyMemoryPercent) {
        log(`EMERGENCY: system memory at ${usedPercent.toFixed(1)}% (threshold: ${emergencyMemoryPercent}%) — force shutdown`);
        gracefulShutdown("emergency-memory");
        return;
      }

      // Zombie process check — every 5th resource check (~2.5 min)
      zombieCheckCounter++;
      if (zombieCheckCounter % 5 === 0) {
        const { count, memoryMB } = countProjectNodeProcesses();
        if (count > MAX_EXPECTED_NODE_PROCESSES) {
          log(`ZOMBIE ALERT: ${count} moc-ai node processes detected (expected max ${MAX_EXPECTED_NODE_PROCESSES}), using ${memoryMB} MB`);
          const killed = killZombieProcesses();
          if (killed > 0) {
            log(`killed ${killed} zombie processes`);
          }
        }
      }

      // High memory: progressive response
      if (usedPercent >= memoryThresholdPercent) {
        consecutiveHighMemory++;
        log(`WARNING: system memory at ${usedPercent.toFixed(1)}% (${consecutiveHighMemory}/${HIGH_MEMORY_SHUTDOWN_COUNT} checks)`);

        // First warning: kill zombies before pausing claws
        if (consecutiveHighMemory === 1) {
          const killed = killZombieProcesses();
          if (killed > 0) {
            log(`killed ${killed} zombie processes on high memory — rechecking next cycle`);
            return; // Give memory time to recover before pausing claws
          }
        }

        // Second warning: pause non-essential claws
        if (consecutiveHighMemory === 2) {
          for (const n of NON_ESSENTIAL_CLAWS) {
            if (children[n]) {
              try { children[n].send({ type: "pause" }); } catch {}
              log(`paused ${n} due to high memory`);
            }
          }
        }

        // Persistent high memory: shutdown
        if (consecutiveHighMemory >= HIGH_MEMORY_SHUTDOWN_COUNT) {
          log(`system memory consistently above ${memoryThresholdPercent}% — shutting down`);
          gracefulShutdown("high-memory");
        }
      } else {
        if (consecutiveHighMemory > 0) {
          log(`memory recovered: ${usedPercent.toFixed(1)}%`);
          for (const n of NON_ESSENTIAL_CLAWS) {
            if (children[n]) {
              try { children[n].send({ type: "resume" }); } catch {}
            }
          }
        }
        consecutiveHighMemory = 0;
      }
    } catch (err) {
      log(`resource monitor error: ${err.message}`);
    }
  }, resourceCheckIntervalMs);

  // ---------------------------------------------------------------------------
  // Runtime log pruning (every 30 minutes)
  // ---------------------------------------------------------------------------

  const LOG_PRUNE_INTERVAL_MS = 30 * 60 * 1000;
  const JSONL_PRUNE_LIST = [
    { name: "claw-history.jsonl", maxLines: 2000 },
    { name: "run-log.jsonl", maxLines: 5000 },
    { name: "loop-performance.jsonl", maxLines: 2000 },
    { name: "oracle-feedback.jsonl", maxLines: 5000 },
    { name: "screenshot-metadata.jsonl", maxLines: 3000 },
  ];

  const logPruneInterval = setInterval(() => {
    try {
      for (const { name, maxLines } of JSONL_PRUNE_LIST) {
        const fp = path.join(STATE_DIR, name);
        if (!fs.existsSync(fp)) { continue; }
        try {
          const stat = fs.statSync(fp);
          if (stat.size < 2 * 1024 * 1024) { continue; }
          const content = fs.readFileSync(fp, "utf-8");
          const lines = content.split("\n").filter(Boolean);
          if (lines.length > maxLines) {
            const pruned = lines.slice(-maxLines).join("\n") + "\n";
            atomicWriteSync(fp, pruned);
            log(`runtime prune: ${name} ${lines.length} → ${maxLines} lines`);
          }
        } catch {}
      }

      // Prune old iteration reports (keep last 20)
      const reportsDir = path.join(ROOT, "e2e", "reports");
      if (fs.existsSync(reportsDir)) {
        try {
          const reports = fs.readdirSync(reportsDir)
            .filter((f) => f.startsWith("iteration-") && f.endsWith(".md"))
            .sort();
          if (reports.length > 20) {
            const toDelete = reports.slice(0, reports.length - 20);
            for (const f of toDelete) {
              try { fs.unlinkSync(path.join(reportsDir, f)); } catch {}
            }
            log(`runtime prune: deleted ${toDelete.length} old iteration reports`);
          }
        } catch {}
      }
    } catch (err) {
      log(`log prune error: ${err.message}`);
    }
  }, LOG_PRUNE_INTERVAL_MS);

  // ---------------------------------------------------------------------------
  // Command polling + heartbeat monitoring
  // ---------------------------------------------------------------------------

  const commandPollInterval = setInterval(() => {
    try {
      // --- Suspend file check (instant kill switch) ---
      if (fs.existsSync(SUSPEND_FILE)) {
        log("suspend file detected — initiating graceful shutdown");
        setImmediate(() => gracefulShutdown("suspend-file"));
        return;
      }

      const signals = loadSignals();

      // --- Broadcast signals to children via IPC (reduces per-claw fs reads) ---
      for (const [bcastName, bcastChild] of Object.entries(children)) {
        try {
          bcastChild.send({ type: "signals-update", signals: signals.signals, claws: signals.claws });
        } catch {}
      }

      // --- Process CLI commands ---
      const cmdKeys = Object.keys(signals.signals).filter((k) => k.startsWith("_cmd_"));
      if (cmdKeys.length > 0) {
        withSignalsLock((sigs) => {
          for (const key of cmdKeys) {
            const cmd = sigs.signals[key];

            if (key === "_cmd_shutdown") {
              delete sigs.signals[key];
              // Defer shutdown to after lock release
              setImmediate(() => gracefulShutdown("cli-command"));
              return;
            }

            const { command, claw: clawName } = cmd;
            const child = children[clawName];

            if (command === "pause" && child) {
              try { child.send({ type: "pause" }); } catch {}
              log(`sent pause to ${clawName}`);
            } else if (command === "resume" && child) {
              try { child.send({ type: "resume" }); } catch {}
              log(`sent resume to ${clawName}`);
            } else if (command === "trigger" && child) {
              try { child.send({ type: "trigger" }); } catch {}
              log(`sent trigger to ${clawName}`);
            }

            delete sigs.signals[key];
          }
        });
      }

      // --- Heartbeat monitoring: detect hung claws ---
      for (const name of Object.keys(children)) {
        const clawState = signals.claws?.[name];
        if (!clawState?.heartbeat) { continue; }
        const hbAge = Date.now() - new Date(clawState.heartbeat).getTime();
        if (hbAge > heartbeatStaleMs && clawState.status === "running") {
          log(`claw ${name} heartbeat stale (${Math.round(hbAge / 60000)}min) — killing hung process`);
          const child = children[name];
          if (child) {
            try { child.kill("SIGKILL"); } catch {}
            // The exit handler will restart it
          }
        }
      }
    } catch {}
  }, 5000);

  // ---------------------------------------------------------------------------
  // Periodic signal GC (every hour)
  // ---------------------------------------------------------------------------

  const gcInterval = setInterval(() => {
    gcSignals();
  }, 3600000);

  // ---------------------------------------------------------------------------
  // Network heartbeat — report active claws so remote daemons can join/takeover
  // ---------------------------------------------------------------------------

  let networkHeartbeatInterval = null;
  if (CHANGEPILOT_SERVICE_KEY) {
    const sendNetworkHeartbeat = async () => {
      try {
        await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/heartbeat`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            machine_id: MACHINE_ID,
            status: shuttingDown ? "stopping" : "active",
            metadata: { active_claws: Object.keys(children), network_mode: networkMode },
          }),
        });
      } catch {}

      // Check for takeover signals
      try {
        const res = await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/signal`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ signal: "heartbeat-poll", payload: { machine_id: MACHINE_ID, poll: true } }),
        });
        if (res.ok) {
          const data = await res.json();
          const pending = data.pending_signals ?? [];
          for (const sig of pending) {
            if (sig.signal === "takeover-requested" && sig.payload?.target === MACHINE_ID) {
              log(`takeover requested by ${sig.payload.machine_id} — initiating graceful shutdown`);
              gracefulShutdown("takeover");
            }
            if (sig.signal === "claw-migration" && sig.payload?.machine_id !== MACHINE_ID) {
              const clawsToMigrate = sig.payload.claws ?? [];
              for (const clawName of clawsToMigrate) {
                if (children[clawName]) { continue; }
                log(`claw-migration: starting ${clawName} from remote request`);
                spawnClaw(clawName);
              }
            }
          }
        }
      } catch {}

      // Forward signals via remote signal bus if available
      if (remoteSignalBus) {
        try {
          await remoteSignalBus.syncSignals(loadSignals());
        } catch {}
      }
    };

    sendNetworkHeartbeat();
    networkHeartbeatInterval = setInterval(sendNetworkHeartbeat, 30000);
  }

  // ---------------------------------------------------------------------------
  // HTTP Health endpoint
  // ---------------------------------------------------------------------------

  let httpServer;
  try {
    httpServer = http.createServer((req, res) => {
      if (req.url === "/health" || req.url === "/") {
        const signals = loadSignals();
        let notifications = [];
        try {
          const notifPath = path.join(STATE_DIR, "daemon-notifications.json");
          if (fs.existsSync(notifPath)) {
            const notifData = JSON.parse(fs.readFileSync(notifPath, "utf-8"));
            notifications = (notifData.notifications ?? []).slice(-20);
          }
        } catch { /* non-fatal */ }

        const status = {
          daemon: { pid: process.pid, uptime: process.uptime(), startedAt: daemonStartedAt, networkMode, machineId: MACHINE_ID },
          claws: signals.claws,
          signals: signals.signals,
          activeChildren: Object.keys(children),
          notifications,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status, null, 2));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    httpServer.listen(healthPort, "127.0.0.1", () => {
      log(`health endpoint: http://127.0.0.1:${healthPort}/health`);
    });

    httpServer.on("error", (err) => {
      log(`health endpoint error (port ${healthPort}): ${err.message}`);
    });
  } catch (err) {
    log(`could not start health endpoint: ${err.message}`);
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  let shuttingDown = false;

  function gracefulShutdown(reason) {
    if (shuttingDown) { return; }
    shuttingDown = true;
    log(`shutting down (${reason})`);

    clearInterval(commandPollInterval);
    clearInterval(gcInterval);
    clearInterval(idleChecker);
    clearInterval(resourceMonitor);
    clearInterval(logPruneInterval);
    if (networkHeartbeatInterval) { clearInterval(networkHeartbeatInterval); }

    // Report offline to network
    if (CHANGEPILOT_SERVICE_KEY) {
      fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/heartbeat`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ machine_id: MACHINE_ID, status: "offline", metadata: { active_claws: [] } }),
      }).catch(() => {});
    }

    // Kill watchdog so it doesn't restart us
    const wdPidFile = path.join(STATE_DIR, "watchdog.pid");
    if (fs.existsSync(wdPidFile)) {
      try {
        const wdPid = parseInt(fs.readFileSync(wdPidFile, "utf-8").trim(), 10);
        killProcessTree(wdPid, "SIGTERM");
        log(`killed watchdog tree (pid ${wdPid})`);
      } catch {}
    }

    // Send shutdown to all children, then kill their process trees
    for (const [name, child] of Object.entries(children)) {
      try {
        child.send({ type: "shutdown" });
        log(`sent shutdown to ${name} (pid ${child.pid})`);
      } catch {
        // IPC failed — kill tree immediately
        killProcessTree(child.pid, "SIGTERM");
        log(`killed ${name} tree (pid ${child.pid}) — IPC unavailable`);
      }
    }

    // Wait for children to exit (max 15s — then force-kill entire trees)
    const timeout = Math.min(daemonConfig.gracefulShutdownTimeoutMs ?? 30000, 15000);
    const deadline = Date.now() + timeout;

    const waitInterval = setInterval(() => {
      const alive = Object.keys(children);
      if (alive.length === 0 || Date.now() > deadline) {
        clearInterval(waitInterval);

        // Force kill remaining — kill ENTIRE process trees to prevent orphans
        for (const [name, child] of Object.entries(children)) {
          try {
            killProcessTree(child.pid, "SIGKILL");
            log(`force-killed ${name} tree (pid ${child.pid})`);
          } catch {}
        }

        // Nuclear sweep: kill ANY moc-ai/e2e node processes we missed
        // Windows bash intermediaries can break parent-child chains,
        // so tree kills don't always reach deep grandchildren
        if (os.platform() === "win32") {
          try {
            const output = execSync(
              'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
              { stdio: "pipe", timeout: 10000, windowsHide: true }
            ).toString();
            let swept = 0;
            for (const line of output.split("\n")) {
              if (!line.includes("moc-ai") && !line.includes("e2e\\") && !line.includes("eslint")) { continue; }
              if (line.includes("modelcontextprotocol") || line.includes("claude") || line.includes("daemon.js")) { continue; }
              const parts = line.split(",");
              const pid = parseInt(parts[parts.length - 1], 10);
              if (!pid || pid === process.pid) { continue; }
              try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", timeout: 5000 }); swept++; } catch {}
            }
            if (swept > 0) { log(`sweep: killed ${swept} remaining orphan processes`); }
          } catch {}
        }

        // Cleanup — write shutdown marker BEFORE deleting PID file
        if (httpServer) { try { httpServer.close(); } catch {} }
        try {
          fs.writeFileSync(SHUTDOWN_MARKER, JSON.stringify({
            at: new Date().toISOString(),
            reason,
            pid: process.pid,
          }));
        } catch {}
        try { fs.unlinkSync(PID_FILE); } catch {}
        log("daemon stopped");
        process.exit(0);
      }
    }, 1000);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}
