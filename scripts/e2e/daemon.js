#!/usr/bin/env node

/**
 * Daemon — Long-running process manager for 5 independent claws.
 *
 * Spawns claw processes, monitors heartbeats, restarts on crash,
 * handles graceful shutdown, and exposes an HTTP status endpoint.
 *
 * Usage:
 *   node scripts/e2e/daemon.js                    # Start all claws
 *   node scripts/e2e/daemon.js --claw test-runner # Start single claw
 *   node scripts/e2e/daemon.js --status           # Show claw statuses
 *   node scripts/e2e/daemon.js --pause fix-engine # Pause a claw
 *   node scripts/e2e/daemon.js --resume fix-engine # Resume a claw
 *   node scripts/e2e/daemon.js --trigger test-runner # Trigger immediate run
 *   node scripts/e2e/daemon.js --full-cycle       # Run all claws sequentially (like loop.sh)
 *   node scripts/e2e/daemon.js --tail fix-engine  # Stream claw output
 *   node scripts/e2e/daemon.js --signal deploy-detected --sha abc123
 *   node scripts/e2e/daemon.js --stop             # Graceful shutdown
 *   node scripts/e2e/daemon.js --detach          # Start as hidden background process (survives terminal close)
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

const ROOT = path.resolve(__dirname, "..", "..");
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

const CLAW_FILES = {
  "test-runner": path.join(__dirname, "claws", "test-runner.js"),
  "finding-pipeline": path.join(__dirname, "claws", "finding-pipeline.js"),
  "builder": path.join(__dirname, "claws", "builder.js"),
  "cp-meta": path.join(__dirname, "claws", "cp-meta.js"),
  "fix-engine": path.join(__dirname, "claws", "fix-engine.js"),
  "intelligence": path.join(__dirname, "claws", "intelligence.js"),
  "health-deploy": path.join(__dirname, "claws", "health-deploy.js"),
  "diagnostics": path.join(__dirname, "claws", "diagnostics.js"),
  "observer": path.join(__dirname, "claws", "observer.js"),
  "test-regen": path.join(__dirname, "claws", "test-regen.js"),
  "docs-sync": path.join(__dirname, "claws", "docs-sync.js"),
};

const CLAW_ORDER = ["test-runner", "finding-pipeline", "builder", "cp-meta", "fix-engine", "intelligence", "health-deploy", "diagnostics", "observer", "test-regen", "docs-sync"];

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
  const defaultExpiryMs = (config.daemon?.signalExpiryHours ?? 6) * 60 * 60 * 1000;
  const now = Date.now();

  // Notification-only signals expire fast (1h) — they're events, not triggers
  const FAST_EXPIRY_SIGNALS = [
    "circuit-broken", "diagnostics-requested", "diagnostics-complete",
    "intelligence-complete", "cp-meta-complete", "build-complete",
  ];
  const FAST_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

  withSignalsLock((signals) => {
    for (const [name, data] of Object.entries(signals.signals)) {
      if (name.startsWith("_cmd_")) { continue; }
      if (!data.at) { continue; }
      const ageMs = now - new Date(data.at).getTime();
      const expiryMs = FAST_EXPIRY_SIGNALS.includes(name) ? FAST_EXPIRY_MS : defaultExpiryMs;
      if (ageMs > expiryMs) {
        delete signals.signals[name];
        log(`gc: expired signal ${name} (age: ${Math.round(ageMs / 3600000)}h)`);
      }
    }
  });

  // Clean stale lock files (older than 1 hour)
  try {
    const lockFiles = fs.readdirSync(STATE_DIR).filter((f) => f.startsWith(".lock-"));
    for (const lf of lockFiles) {
      const lockPath = path.join(STATE_DIR, lf);
      try {
        const stat = fs.statSync(lockPath);
        if (now - stat.mtimeMs > 3600000) {
          fs.unlinkSync(lockPath);
          log(`gc: removed stale lock ${lf}`);
        }
      } catch {}
    }
  } catch {}
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

// --detach: Spawn daemon as a hidden background process that survives terminal close.
// On Windows uses PowerShell Start-Process -WindowStyle Hidden.
// On Unix uses child_process.spawn with detached + unref.
if (hasArg("--detach")) {
  // Clear stale markers before detaching
  try { fs.unlinkSync(path.join(STATE_DIR, "daemon.suspend")); } catch {}
  try { fs.unlinkSync(path.join(STATE_DIR, "daemon.shutdown")); } catch {}

  const scriptPath = path.resolve(__dirname, "daemon.js");
  const extraArgs = args.filter((a) => a !== "--detach");

  // Strip Claude Code env vars so daemon children can spawn `claude --print`
  // even when daemon is started from within a Claude Code session
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE;

  if (os.platform() === "win32") {
    const nodeExe = process.execPath.replace(/\\/g, "\\\\");
    const argStr = [scriptPath, ...extraArgs].map((a) => `'${a}'`).join(",");
    const psCmd = `Start-Process -FilePath '${nodeExe}' -ArgumentList ${argStr} -WorkingDirectory '${ROOT.replace(/\\/g, "\\\\")}' -WindowStyle Hidden`;
    try {
      execSync(`powershell.exe -Command "${psCmd}"`, { stdio: "inherit", timeout: 10000 });
      console.log("Daemon launched as hidden background process.");
      console.log("Check status: node scripts/e2e/daemon.js --status");
      console.log("Stop:         node scripts/e2e/daemon.js --stop");
    } catch (err) {
      console.error("Failed to detach:", err.message);
      process.exit(1);
    }
  } else {
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log(`Daemon launched as background process (pid ${child.pid}).`);
    console.log("Check status: node scripts/e2e/daemon.js --status");
    console.log("Stop:         node scripts/e2e/daemon.js --stop");
  }

  // Wait briefly and verify it started
  setTimeout(() => {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (pid > 0) {
        console.log(`Verified: daemon running (pid ${pid})`);
      }
    } catch {
      console.log("Daemon PID not yet written — check --status in a few seconds.");
    }
    process.exit(0);
  }, 3000);
} else if (hasArg("--full-cycle")) {
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
      body: JSON.stringify({ machine_id: MACHINE_ID, status: "paused" }),
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
          body: JSON.stringify({ machine_id: MACHINE_ID, status: "paused" }),
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
  // Strip Claude Code nesting guards so children can spawn `claude --print`
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE;

  // Top-level crash handler — prevents silent death on startup errors
  process.on("uncaughtException", (err) => {
    try { log(`FATAL uncaughtException: ${err.message}\n${err.stack || ""}`); } catch { /* ignore */ }
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [daemon] FATAL: ${err.message}\n`); } catch { /* ignore */ }
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    try { log(`FATAL unhandledRejection: ${reason}`); } catch { /* ignore */ }
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [daemon] FATAL rejection: ${reason}\n`); } catch { /* ignore */ }
  });

  const config = loadConfig();
  const daemonConfig = config.daemon ?? {};
  const maxRestartsPerHour = daemonConfig.maxRestartsPerHour ?? 3;
  const healthPort = daemonConfig.healthPort ?? 9100;
  const heartbeatStaleMs = (daemonConfig.heartbeatStaleThresholdMinutes ?? 5) * 60 * 1000;
  const zombieDetect = {}; // name -> first-seen timestamp (for claws that never send heartbeat)
  const daemonStartedAt = new Date().toISOString();

  // Prevent duplicate daemons — check if another instance is already running.
  // This was causing the daemon to sometimes appear under Cursor and also as a
  // standalone Windows process (two instances fighting over the same state files).
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (existingPid && existingPid !== process.pid) {
      let alive = false;
      try { process.kill(existingPid, 0); alive = true; } catch {}
      if (alive) {
        log(`daemon already running (pid ${existingPid}) — killing it before starting new instance`);
        try {
          if (os.platform() === "win32") {
            execSync(`taskkill /PID ${existingPid} /T /F`, { stdio: "ignore", timeout: 10000 });
          } else {
            process.kill(existingPid, "SIGTERM");
          }
          // Brief wait for old daemon to die
          const waitStart = Date.now();
          while (Date.now() - waitStart < 5000) {
            try { process.kill(existingPid, 0); } catch { break; }
            execSync("timeout /T 1 /NOBREAK >NUL 2>&1 || sleep 1", { stdio: "ignore", timeout: 3000 });
          }
        } catch {}
      }
    }
  }

  // Write PID file and clear stale shutdown/suspend markers
  fs.writeFileSync(PID_FILE, String(process.pid));
  try { fs.unlinkSync(SHUTDOWN_MARKER); } catch {}
  try { fs.unlinkSync(SUSPEND_FILE); } catch {}

  // Clear stale _cmd_shutdown signal — prevents a --stop aimed at a dead daemon
  // from killing the next daemon that starts
  withSignalsLock((signals) => {
    const staleKeys = Object.keys(signals.signals).filter((k) => k.startsWith("_cmd_"));
    for (const key of staleKeys) {
      log(`cleared stale signal: ${key}`);
      delete signals.signals[key];
    }
  });

  log(`daemon started (pid ${process.pid})`);

  // Run signal GC immediately on startup to clean stale state from previous runs
  gcSignals();

  // Clear stale test-runner signals from previous daemon run.
  // Without this, observer reads the old tests-complete (total:0 from a killed run)
  // and immediately force-triggers restarts, creating a kill-restart loop that
  // prevents the first test cycle from ever completing.
  withSignalsLock((signals) => {
    const staleTestSignals = ["tests-complete", "observer-alert", "circuit-broken", "claw-crashed"];
    for (const name of staleTestSignals) {
      if (signals.signals[name]) {
        log(`cleared stale signal from previous run: ${name}`);
        delete signals.signals[name];
      }
    }
    // Write daemon-started-at so observer can skip zero-result checks during warmup
    signals.signals["daemon-started"] = {
      timestamp: daemonStartedAt,
      at: daemonStartedAt,
      from: "daemon",
      pid: process.pid,
    };
  });

  // Kill any orphaned node processes from previous daemon runs
  if (os.platform() === "win32") {
    try {
      const output = execSync(
        'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
        { stdio: "pipe", timeout: 10000, windowsHide: true }
      ).toString();
      let orphansKilled = 0;
      for (const line of output.split("\n")) {
        // Only target moc-ai/e2e/eslint processes, skip MCP servers and ourselves
        if (!line.includes("moc-ai") && !line.includes("e2e\\") && !line.includes("eslint")) { continue; }
        // Skip MCP servers, Claude Code IDE (but NOT claude --print spawned by auto-fix), and daemon itself
        if (line.includes("modelcontextprotocol") || line.includes("daemon.js")) { continue; }
        if (line.includes("claude") && !line.includes("claude --print") && !line.includes("moc-auto-fix")) { continue; }
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

    // Handle crash — NEVER permanently disable. Always retry with increasing backoff.
    // Crashed claws enter the self-healing pipeline (diagnostics → repair MOC → fix → verify).
    child.on("exit", (code, signal) => {
      log(`claw ${name} exited (code=${code}, signal=${signal})`);
      delete children[name];

      // Don't restart during shutdown
      if (shuttingDown) { return; }

      // Track restart count (hourly window)
      if (!restartCounts[name]) { restartCounts[name] = { timestamps: [], healingMode: false }; }
      const now = Date.now();
      restartCounts[name].timestamps = restartCounts[name].timestamps.filter((t) => now - t < 3600000);
      restartCounts[name].timestamps.push(now);

      const restartsThisHour = restartCounts[name].timestamps.length;

      if (restartsThisHour > maxRestartsPerHour && !restartCounts[name].healingMode) {
        // Enter healing mode — emit crash signal for self-healing pipeline,
        // but NEVER give up. Use extended backoff (5min) instead of disabling.
        restartCounts[name].healingMode = true;
        log(`claw ${name} exceeded ${maxRestartsPerHour} restarts/hour — entering healing mode (5min backoff)`);
        withSignalsLock((signals) => {
          if (!signals.claws[name]) { signals.claws[name] = {}; }
          signals.claws[name].status = "crashed";
          signals.claws[name].lastError = `exceeded max restarts — in healing mode (5min backoff)`;
          signals.signals["claw-crashed"] = {
            at: new Date().toISOString(),
            emittedBy: "daemon",
            claw: name,
            reason: `exceeded max restarts (${restartsThisHour}/hour) — healing mode`,
          };
          // Also request diagnostics immediately
          signals.signals["diagnostics-requested"] = {
            at: new Date().toISOString(),
            emittedBy: "daemon",
            reason: `repeated-crash: ${name} crashed ${restartsThisHour} times in 1h`,
            source: "daemon",
            claw: name,
          };
        });

        // Special case: diagnostics can't repair itself, so daemon creates
        // the repair MOC directly when diagnostics is the one that crashed
        if (name === "diagnostics") {
          try {
            const queuePath = path.join(STATE_DIR, "moc-queue.json");
            const queue = fs.existsSync(queuePath)
              ? JSON.parse(fs.readFileSync(queuePath, "utf-8"))
              : { version: 2, mocs: [] };
            const mocs = Array.isArray(queue?.mocs) ? queue.mocs : [];
            const existing = mocs.find((m) =>
              m.tier === "claw_repair" &&
              !["archived", "implemented", "needs_human"].includes(m.status) &&
              m.title?.includes("[CLAW-REPAIR:diagnostics]")
            );
            if (!existing) {
              const mocId = `moc-claw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
              mocs.push({
                id: mocId,
                platformMocId: null,
                platformMocNumber: null,
                title: `[CLAW-REPAIR:diagnostics] repeated crashes — daemon-created repair`,
                description: `**Tier:** claw_repair\n**Source:** daemon (diagnostics self-protection bypass)\n**Claw:** diagnostics\n\n### Problem\nDiagnostics claw crashed ${restartsThisHour} times in 1h. Daemon continues retrying with extended backoff.\n\n### Scope\n- scripts/e2e/claws/diagnostics.js\n- scripts/e2e/lib/health-checks.js\n\n### Validation\n1. node -c scripts/e2e/claws/diagnostics.js\n2. node scripts/e2e/self-test.js`,
                tier: "claw_repair",
                category: "pipeline",
                status: "approved",
                source: "daemon",
                persona: null,
                changeType: "bug_fix",
                changeTypeLabel: "Claw Repair",
                riskLevel: "high",
                reviewDepth: "Standard",
                routedDepartments: ["Engineering"],
                requiresManagement: false,
                findings: [],
                affectedFiles: ["scripts/e2e/claws/diagnostics.js", "scripts/e2e/lib/health-checks.js"],
                submittedAt: new Date().toISOString(),
                approvedAt: new Date().toISOString(),
              });
              queue.mocs = mocs;
              atomicWriteSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
              log(`created claw_repair MOC for crashed diagnostics: ${mocId}`);
              withSignalsLock((signals) => {
                signals.signals["mocs-ready"] = {
                  at: new Date().toISOString(),
                  emittedBy: "daemon",
                  source: "daemon-diagnostics-repair",
                };
              });
            }
          } catch (err) {
            log(`failed to create diagnostics repair MOC: ${err.message}`);
          }
        }
      }

      // Reset healing mode after 1h of no crashes (clears the extended backoff)
      if (restartCounts[name].healingMode && restartsThisHour <= 1) {
        restartCounts[name].healingMode = false;
        log(`claw ${name} stable — exiting healing mode`);
      }

      // Backoff: normal = 10s→20s→40s→60s. Healing mode = 300s (5min).
      // After healing mode, on deploy-detected signal, reset to try immediately.
      const backoff = restartCounts[name].healingMode
        ? 300000  // 5min in healing mode — keeps retrying, never gives up
        : Math.min(60000, 10000 * Math.pow(2, restartsThisHour - 1));
      log(`restarting claw ${name} in ${backoff / 1000}s (restart ${restartsThisHour}/${maxRestartsPerHour}, healing=${restartCounts[name].healingMode})`);
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
  const daemonStartTime = Date.now();

  const idleChecker = setInterval(() => {
    const activeClaws = Object.keys(children);
    if (activeClaws.length === 0) { return; }

    // Don't auto-shutdown within first 45 minutes (allow claws time to complete initial cycles)
    if (Date.now() - daemonStartTime < 45 * 60 * 1000) { return; }

    // Check signals to see which claws are actively running — never count those as idle
    let signals;
    try { signals = loadSignals(); } catch { return; }

    const allIdle = activeClaws.every((name) => {
      // If claw is running according to signals, it's NOT idle regardless of idle state
      const clawSig = signals.claws?.[name];
      if (clawSig?.status === "running") { return false; }

      const state = idleState[name];
      if (!state) { return false; }
      // Only trust idle cycles from THIS daemon session (cap at minutes since start)
      const maxPlausibleCycles = Math.floor((Date.now() - daemonStartTime) / idleCheckIntervalMs);
      const effectiveIdleCycles = Math.min(state.idleCycles, maxPlausibleCycles);
      return effectiveIdleCycles >= idleShutdownThreshold ||
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
  const NON_ESSENTIAL_CLAWS = ["intelligence", "health-deploy", "diagnostics", "builder", "observer", "test-regen", "docs-sync"];

  // Capture baseline memory at startup (before claws spawn)
  const baselineUsedBytes = os.totalmem() - os.freemem();
  log(`baseline memory at startup: ${(baselineUsedBytes / 1024 / 1024 / 1024).toFixed(1)} GB (${((baselineUsedBytes / os.totalmem()) * 100).toFixed(1)}%)`);

  // Expected max node processes: daemon(1) + claws(7) + watchdog(1) = 9
  // Each claw may have 1 active child = up to 16 total. Anything above 25 is likely zombies.
  // 11 claws + daemon + watchdog + up to 2 children per claw = ~35
  const MAX_EXPECTED_NODE_PROCESSES = 40;

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
        // Skip MCP servers and Claude Code IDE (but NOT claude --print spawned by auto-fix)
        if (line.includes("modelcontextprotocol")) { continue; }
        if (line.includes("claude") && !line.includes("claude --print") && !line.includes("moc-auto-fix")) { continue; }
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
    { name: "persona-token-usage.jsonl", maxLines: 3000 },
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
    // --- Suspend file check (instant kill switch) ---
    try {
      if (fs.existsSync(SUSPEND_FILE)) {
        const uptimeMs = Date.now() - new Date(daemonStartedAt).getTime();
        if (uptimeMs < 60000) {
          try { fs.unlinkSync(SUSPEND_FILE); } catch {}
          return;
        }
        log("suspend file detected — initiating graceful shutdown");
        setImmediate(() => gracefulShutdown("suspend-file"));
        return;
      }
    } catch (err) {
      log(`poll: suspend check error: ${err.message}`);
    }

    let signals;
    try {
      signals = loadSignals();
    } catch (err) {
      log(`poll: failed to load signals: ${err.message}`);
      return; // Can't do anything without signals
    }

    // --- Broadcast signals to children via IPC ---
    try {
      for (const [bcastName, bcastChild] of Object.entries(children)) {
        try {
          bcastChild.send({ type: "signals-update", signals: signals.signals, claws: signals.claws });
        } catch {}
      }
    } catch (err) {
      log(`poll: broadcast error: ${err.message}`);
    }

    // --- Deploy-detected: reset healing mode for all claws (new code might fix the crash) ---
    try {
      const deploySig = signals.signals?.["deploy-detected"];
      if (deploySig?.at) {
        for (const [cname, cdata] of Object.entries(restartCounts)) {
          if (cdata.healingMode) {
            const deployAge = Date.now() - new Date(deploySig.at).getTime();
            if (deployAge < 60000) { // Only if deploy in last 60s (avoid stale signals)
              cdata.healingMode = false;
              cdata.timestamps = [];
              log(`deploy-detected: reset healing mode for ${cname} — immediate retry`);
              // If claw is not currently running, spawn it immediately
              if (!children[cname]) {
                spawnClaw(cname);
              } else {
                try { children[cname].send({ type: "trigger" }); } catch {}
              }
            }
          }
        }
      }
    } catch (err) {
      log(`poll: deploy-reset error: ${err.message}`);
    }

    // --- Process force-trigger signals from claws (immediate IPC trigger) ---
    try {
      const forceTriggerKeys = Object.keys(signals.signals).filter((k) => k.startsWith("_force_trigger_"));
      if (forceTriggerKeys.length > 0) {
        withSignalsLock((sigs) => {
          for (const key of forceTriggerKeys) {
            const targetClaw = key.replace("_force_trigger_", "");
            const child = children[targetClaw];
            if (child) {
              try { child.send({ type: "trigger" }); } catch {}
              log(`force-triggered ${targetClaw} via IPC (requested by ${sigs.signals[key]?.from ?? "unknown"})`);
            } else if (!shuttingDown) {
              // Claw isn't running — spawn it fresh
              log(`force-trigger: ${targetClaw} not running — spawning`);
              spawnClaw(targetClaw);
            }
            delete sigs.signals[key];
          }
        });
      }
    } catch (err) {
      log(`poll: force-trigger error: ${err.message}`);
    }

    // --- Process CLI commands ---
    try {
      const cmdKeys = Object.keys(signals.signals).filter((k) => k.startsWith("_cmd_"));
      if (cmdKeys.length > 0) {
        withSignalsLock((sigs) => {
          for (const key of cmdKeys) {
            const cmd = sigs.signals[key];

            if (key === "_cmd_shutdown") {
              delete sigs.signals[key];
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
    } catch (err) {
      log(`poll: command processing error: ${err.message}`);
    }

    // --- Heartbeat monitoring: detect hung/stale claws ---
    // Runs independently — signal/command errors don't skip it
    try {
      const config = loadConfig?.() ?? {};
      const clawConfigs = config.claws ?? {};

      for (const name of Object.keys(children)) {
        const clawState = signals.claws?.[name];
        if (!clawState?.heartbeat) { continue; }
        const hbAge = Date.now() - new Date(clawState.heartbeat).getTime();

        // Case 1: Running claw with stale heartbeat — hung process
        if (hbAge > heartbeatStaleMs && clawState.status === "running") {
          log(`claw ${name} heartbeat stale (${Math.round(hbAge / 60000)}min) — killing hung process`);
          const child = children[name];
          if (child) {
            try {
              if (os.platform() === "win32") {
                execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", timeout: 10000 });
              } else {
                process.kill(-child.pid, "SIGKILL");
              }
            } catch {}
          }
          continue;
        }

        // Case 2: Idle claw way overdue — silently stuck (>4x interval, min 1h)
        if (clawState.status === "idle" && clawState.lastRun) {
          const intervalMin = clawConfigs[name]?.intervalMinutes ?? 60;
          const overdueMs = intervalMin * 4 * 60 * 1000;
          const idleSince = Date.now() - new Date(clawState.lastRun).getTime();
          if (idleSince > overdueMs && idleSince > 3600000) {
            log(`claw ${name} idle and overdue (${Math.round(idleSince / 60000)}min since last run, interval=${intervalMin}min) — force-restarting`);
            const child = children[name];
            if (child) {
              try {
                if (os.platform() === "win32") {
                  execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", timeout: 10000 });
                } else {
                  process.kill(-child.pid, "SIGKILL");
                }
              } catch {}
            }
          }
        }

        // Case 3: Spawned but never reached "running" — zombie claw (no heartbeat after 5min)
        if (!clawState?.heartbeat && children[name]) {
          if (!zombieDetect[name]) { zombieDetect[name] = Date.now(); }
          const zombieAge = Date.now() - zombieDetect[name];
          if (zombieAge > 300000) { // 5 minutes with no heartbeat
            log(`claw ${name} spawned ${Math.round(zombieAge / 60000)}min ago but never sent heartbeat — killing zombie`);
            const child = children[name];
            if (child) {
              try {
                if (os.platform() === "win32") {
                  execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", timeout: 10000 });
                } else {
                  process.kill(-child.pid, "SIGKILL");
                }
              } catch {}
            }
            delete zombieDetect[name];
          }
        } else {
          delete zombieDetect[name];
        }
      }
    } catch (err) {
      log(`poll: heartbeat monitoring error: ${err.message}`);
    }
  }, 5000);

  // ---------------------------------------------------------------------------
  // Periodic signal GC (every hour)
  // ---------------------------------------------------------------------------

  // Run signal GC every 30min (was 1h) — stale signals cause false alarms in diagnostics
  const gcInterval = setInterval(() => {
    gcSignals();
  }, 1800000);

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
            status: shuttingDown ? "offline" : "active",
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

    // Retry port binding with backoff (handles TIME_WAIT from previous daemon)
    let portRetries = 0;
    const maxPortRetries = 5;
    const tryListen = () => {
      httpServer.listen(healthPort, "127.0.0.1", () => {
        log(`health endpoint: http://127.0.0.1:${healthPort}/health`);
      });
    };

    httpServer.on("error", (err) => {
      if (err.code === "EADDRINUSE" && portRetries < maxPortRetries) {
        portRetries++;
        const delay = portRetries * 2000; // 2s, 4s, 6s, 8s, 10s
        log(`health port ${healthPort} in use, retry ${portRetries}/${maxPortRetries} in ${delay / 1000}s`);
        setTimeout(tryListen, delay);
      } else if (err.code === "EADDRINUSE") {
        // Fall back to next port
        const fallbackPort = healthPort + 1;
        log(`health port ${healthPort} still in use after ${maxPortRetries} retries, trying ${fallbackPort}`);
        httpServer.listen(fallbackPort, "127.0.0.1", () => {
          log(`health endpoint: http://127.0.0.1:${fallbackPort}/health (fallback port)`);
        });
      } else {
        log(`health endpoint error (port ${healthPort}): ${err.message}`);
      }
    });

    tryListen();
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

    // Leave watchdog alive — it respects the shutdown marker for 30min
    // then auto-restarts the daemon. For permanent stop, use --stop --permanent.
    const permanentStop = process.argv.includes("--permanent");
    if (permanentStop) {
      const wdPidFile = path.join(STATE_DIR, "watchdog.pid");
      if (fs.existsSync(wdPidFile)) {
        try {
          const wdPid = parseInt(fs.readFileSync(wdPidFile, "utf-8").trim(), 10);
          killProcessTree(wdPid, "SIGTERM");
          log(`killed watchdog tree (pid ${wdPid}) — permanent stop`);
        } catch {}
      }
      // Write permanent marker so scheduled task also respects it
      try {
        fs.writeFileSync(
          path.join(STATE_DIR, "daemon.shutdown"),
          JSON.stringify({ at: new Date().toISOString(), reason: reason || "permanent-stop", pid: process.pid, permanent: true }) + "\n"
        );
      } catch {}
    } else {
      log(`watchdog left alive — daemon will auto-restart in 30m (use --stop --permanent to fully stop)`);
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
              // Skip MCP servers and daemon itself. Allow claude --print / moc-auto-fix children to be swept.
              if (line.includes("modelcontextprotocol") || line.includes("daemon.js")) { continue; }
              if (line.includes("claude") && !line.includes("claude --print") && !line.includes("moc-auto-fix")) { continue; }
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
