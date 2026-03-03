#!/usr/bin/env node

/**
 * Watchdog — Independent daemon process monitor.
 *
 * Runs as a sibling process (not a child) to the daemon.
 * Checks daemon health every 30s and auto-restarts if needed.
 *
 * Usage:
 *   node scripts/e2e/watchdog.js            # Start watchdog
 *   node scripts/e2e/watchdog.js --once     # Single check, then exit
 *
 * Self-protection: only one watchdog runs at a time (PID file).
 * The daemon auto-spawns this on start; can also run via OS scheduler (cron/Task Scheduler).
 */

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const DAEMON_PID_FILE = path.join(STATE_DIR, "daemon.pid");
const WATCHDOG_PID_FILE = path.join(STATE_DIR, "watchdog.pid");
const SIGNALS_PATH = path.join(STATE_DIR, "claw-signals.json");
const CONFIG_PATH = path.join(ROOT, "daemon-config.json");
const LOG_FILE = path.join(STATE_DIR, "daemon.log");
const DAEMON_SCRIPT = path.join(__dirname, "daemon.js");
const SUSPEND_FILE = path.join(STATE_DIR, "daemon.suspend");
const SHUTDOWN_MARKER = path.join(STATE_DIR, "daemon.shutdown");

const ONCE = process.argv.includes("--once");
const INSTALL_TASK = process.argv.includes("--install-task");
const UNINSTALL_TASK = process.argv.includes("--uninstall-task");

const TASK_NAME = "MOC-AI-Watchdog";

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = `[${ts}] [watchdog] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { return {}; }
}

function loadSignals() {
  try { return JSON.parse(fs.readFileSync(SIGNALS_PATH, "utf-8")); } catch { return { signals: {}, claws: {} }; }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if another watchdog is already running.
 * Returns true if we should exit (another watchdog is active).
 */
function anotherWatchdogRunning() {
  if (!fs.existsSync(WATCHDOG_PID_FILE)) { return false; }
  try {
    const pid = parseInt(fs.readFileSync(WATCHDOG_PID_FILE, "utf-8").trim(), 10);
    if (pid === process.pid) { return false; }
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

/** Write our own PID file. */
function writePid() {
  fs.writeFileSync(WATCHDOG_PID_FILE, String(process.pid));
}

/** Restart the daemon as a detached process. Verifies it's alive after 10s. */
function restartDaemon() {
  log("restarting daemon...");

  // Clean up stale state that could prevent startup
  try { fs.unlinkSync(path.join(STATE_DIR, "daemon.suspend")); } catch {}
  try { fs.unlinkSync(path.join(STATE_DIR, "daemon.shutdown")); } catch {}

  try {
    const child = fork(DAEMON_SCRIPT, [], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    const childPid = child.pid;
    log(`daemon restarted (pid ${childPid})`);

    // Verify the daemon is actually alive after a delay
    setTimeout(() => {
      if (!isPidAlive(childPid)) {
        log(`WARNING: daemon pid ${childPid} died shortly after restart — startup crash likely`);
        log(`  Check daemon.log for FATAL errors. Common causes:`);
        log(`  - Port 9100 still in TIME_WAIT (health endpoint EADDRINUSE)`);
        log(`  - Corrupt state files (claw-signals.json, daemon-config.json)`);
        log(`  - Out of memory during startup self-test`);
      } else {
        log(`daemon pid ${childPid} verified alive after 10s`);
      }
    }, 10000);

    return true;
  } catch (err) {
    log(`failed to restart daemon: ${err.message}`);
    return false;
  }
}

/**
 * Core health check — returns { healthy: boolean, issue: string }.
 */
function checkDaemonHealth() {
  // 1. Daemon PID alive?
  if (!fs.existsSync(DAEMON_PID_FILE)) {
    // Check if this was an intentional shutdown
    if (fs.existsSync(SHUTDOWN_MARKER)) {
      try {
        const marker = JSON.parse(fs.readFileSync(SHUTDOWN_MARKER, "utf-8"));
        // Permanent stop — never auto-restart (user must manually start)
        if (marker.permanent) {
          log(`permanent shutdown — will not auto-restart (use daemon.js --detach to start)`);
          return { healthy: true, issue: "" };
        }
        // Normal stop — respect for 30min only, then auto-restart
        const age = Date.now() - new Date(marker.at).getTime();
        const GRACE_MS = 30 * 60 * 1000;
        if (age < GRACE_MS) {
          const remainMin = Math.round((GRACE_MS - age) / 60000);
          log(`intentional shutdown ${Math.round(age / 60000)}m ago — auto-restart in ${remainMin}m`);
          return { healthy: true, issue: "" };
        }
        log(`shutdown grace expired (${Math.round(age / 60000)}m > 30m) — restarting daemon`);
      } catch {}
    }
    return { healthy: false, issue: "no daemon PID file" };
  }

  let daemonPid;
  try {
    daemonPid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
  } catch {
    return { healthy: false, issue: "corrupt daemon PID file" };
  }

  if (!isPidAlive(daemonPid)) {
    return { healthy: false, issue: `daemon pid ${daemonPid} not running` };
  }

  // 2. Signals file valid?
  if (fs.existsSync(SIGNALS_PATH)) {
    try {
      JSON.parse(fs.readFileSync(SIGNALS_PATH, "utf-8"));
    } catch {
      // Corrupt signals file — rebuild
      log("signals file corrupt — rebuilding from defaults");
      try {
        const backup = SIGNALS_PATH + `.corrupt.${Date.now()}`;
        fs.copyFileSync(SIGNALS_PATH, backup);
        fs.writeFileSync(SIGNALS_PATH, JSON.stringify({ signals: {}, claws: {} }, null, 2) + "\n");
        log("signals file rebuilt");
      } catch (err) {
        log(`could not rebuild signals file: ${err.message}`);
      }
    }
  }

  // 3. All claws crashed? Or critical claw crashed for >30min?
  const signals = loadSignals();
  const claws = signals.claws ?? {};
  const clawNames = Object.keys(claws);
  if (clawNames.length > 0) {
    const allCrashed = clawNames.every((name) => claws[name].status === "crashed");
    if (allCrashed) {
      return { healthy: false, issue: "all claws in crashed state" };
    }
    // Check if any critical claw has been crashed for >30min (healing mode should fix, but watchdog is backup)
    const CRITICAL_CLAWS = ["observer", "test-runner", "fix-engine", "diagnostics"];
    for (const name of CRITICAL_CLAWS) {
      const state = claws[name];
      if (state?.status === "crashed" && state.heartbeat) {
        const crashAge = Date.now() - new Date(state.heartbeat).getTime();
        if (crashAge > 30 * 60 * 1000) {
          return { healthy: false, issue: `critical claw ${name} crashed for ${Math.round(crashAge / 60000)}min` };
        }
      }
    }
  }

  // 4. Check for overdue claws — TWO thresholds:
  //    a) Any CRITICAL claw (observer, test-runner, fix-engine) overdue >2h = unhealthy
  //    b) 3+ any claws overdue >2h = unhealthy
  try {
    const config = loadConfig();
    const clawConfigs = config.claws ?? {};
    const CRITICAL_CLAWS = ["observer", "test-runner", "fix-engine", "diagnostics"];
    const overdueClaws = [];
    for (const name of clawNames) {
      const state = claws[name];
      if (state.status === "stopped" || state.status === "crashed") { continue; }
      if (!state.lastRun) { continue; }
      const intervalMin = clawConfigs[name]?.intervalMinutes ?? 60;
      const overdueMs = intervalMin * 4 * 60 * 1000;
      const idleSince = Date.now() - new Date(state.lastRun).getTime();
      if (idleSince > overdueMs && idleSince > 7200000) {
        overdueClaws.push(name);
      }
    }
    // Single critical claw stuck = daemon unhealthy
    const criticalOverdue = overdueClaws.filter((n) => CRITICAL_CLAWS.includes(n));
    if (criticalOverdue.length > 0) {
      return { healthy: false, issue: `critical claw(s) overdue: ${criticalOverdue.join(", ")}` };
    }
    // 3+ any claws overdue = daemon unhealthy
    if (overdueClaws.length >= 3) {
      return { healthy: false, issue: `${overdueClaws.length} claws overdue: ${overdueClaws.join(", ")}` };
    }
  } catch {}

  return { healthy: true, issue: "" };
}

let restartAttempts = 0;
let lastGaveUpAt = 0;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown before retrying

function runCheck() {
  // Suspend file check — do not restart a suspended daemon
  if (fs.existsSync(SUSPEND_FILE)) {
    log("daemon suspended (suspend file exists) — skipping health check");
    restartAttempts = 0;
    return;
  }

  const { healthy, issue } = checkDaemonHealth();

  if (healthy) {
    restartAttempts = 0;
    return;
  }

  log(`daemon unhealthy: ${issue}`);

  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    // Reset after cooldown so we try again automatically
    if (lastGaveUpAt && Date.now() - lastGaveUpAt > RESTART_COOLDOWN_MS) {
      log(`cooldown elapsed (${Math.round(RESTART_COOLDOWN_MS / 60000)}m) — resetting restart attempts`);
      restartAttempts = 0;
      lastGaveUpAt = 0;
    } else {
      if (!lastGaveUpAt) {
        lastGaveUpAt = Date.now();
        log(`max restart attempts (${MAX_RESTART_ATTEMPTS}) exceeded — cooling down for ${Math.round(RESTART_COOLDOWN_MS / 60000)}m before retrying`);
        try {
          const { writeToFile } = require("./lib/notify");
          writeToFile(`Watchdog: daemon failed ${MAX_RESTART_ATTEMPTS} restarts. Cooling down. Issue: ${issue}`, "critical");
        } catch {}
      }
      return;
    }
  }

  restartAttempts++;

  // Clean up stale PID file
  if (fs.existsSync(DAEMON_PID_FILE)) {
    try { fs.unlinkSync(DAEMON_PID_FILE); } catch {}
  }

  const ok = restartDaemon();
  if (ok) {
    log(`restart attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS} succeeded`);
    try {
      const { writeToFile } = require("./lib/notify");
      writeToFile(`Watchdog restarted daemon (attempt ${restartAttempts}). Reason: ${issue}`, "warning");
    } catch {}
  } else {
    log(`restart attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS} failed`);
  }
}

function main() {
  // Self-protection: only one watchdog at a time
  if (anotherWatchdogRunning()) {
    log("another watchdog is already running, exiting");
    process.exit(0);
  }

  writePid();
  log(`watchdog started (pid ${process.pid})`);

  if (ONCE) {
    runCheck();
    // If no persistent watchdog is running, spawn one as a detached sibling
    if (!anotherWatchdogRunning()) {
      try {
        const wd = fork(__filename, [], { cwd: ROOT, detached: true, stdio: "ignore", env: process.env });
        wd.unref();
        log(`no persistent watchdog found — spawned one (pid ${wd.pid})`);
      } catch (err) {
        log(`could not spawn persistent watchdog: ${err.message}`);
      }
    }
    process.exit(0);
  }

  const config = loadConfig();
  const intervalMs = (config.watchdog?.checkIntervalSeconds ?? 30) * 1000;

  // Run first check immediately
  runCheck();

  // Then on interval
  const timer = setInterval(runCheck, intervalMs);

  // Cleanup on exit
  function cleanup() {
    clearInterval(timer);
    try { fs.unlinkSync(WATCHDOG_PID_FILE); } catch {}
    log("watchdog stopped");
    process.exit(0);
  }

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}

// ---------------------------------------------------------------------------
// Windows Task Scheduler — ultimate fallback ("watchdog of the watchdog")
// Runs `watchdog.js --once` every 5 minutes. Survives reboots.
// ---------------------------------------------------------------------------

function installScheduledTask() {
  const { execSync } = require("child_process");
  const nodePath = process.execPath.replace(/\//g, "\\");
  const scriptPath = __filename.replace(/\//g, "\\");
  const cmd = [
    "schtasks", "/Create",
    "/TN", `"${TASK_NAME}"`,
    "/TR", `"${nodePath} ${scriptPath} --once"`,
    "/SC", "MINUTE",
    "/MO", "5",
    "/F",                   // force overwrite if exists
    "/RL", "LIMITED",       // run with limited privileges
  ].join(" ");

  try {
    execSync(cmd, { stdio: "pipe" });
    log(`scheduled task "${TASK_NAME}" installed (every 5 minutes)`);
    console.log(`Installed Windows scheduled task "${TASK_NAME}" — runs watchdog --once every 5 minutes`);
  } catch (err) {
    log(`failed to install scheduled task: ${err.message}`);
    console.error(`Failed to install scheduled task. Try running as Administrator.`);
    console.error(`Manual command: ${cmd}`);
  }
}

function uninstallScheduledTask() {
  const { execSync } = require("child_process");
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "pipe" });
    log(`scheduled task "${TASK_NAME}" removed`);
    console.log(`Removed Windows scheduled task "${TASK_NAME}"`);
  } catch (err) {
    log(`no scheduled task to remove (${err.message})`);
    console.log(`No task "${TASK_NAME}" found or already removed.`);
  }
}

// Handle --install-task / --uninstall-task before main()
if (INSTALL_TASK) {
  installScheduledTask();
  process.exit(0);
}
if (UNINSTALL_TASK) {
  uninstallScheduledTask();
  process.exit(0);
}

main();
