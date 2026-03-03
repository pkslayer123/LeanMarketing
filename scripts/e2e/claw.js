#!/usr/bin/env node

/**
 * Claw — Base class for long-running daemon claws.
 *
 * Each claw is a standalone process that:
 * - Watches for signals from other claws (via claw-signals.json)
 * - Runs work cycles on a schedule or in response to signals
 * - Writes heartbeats so the daemon can monitor health
 * - Handles graceful shutdown on SIGTERM/SIGINT
 * - Tracks budget (API spend) per cycle AND per hour
 *
 * Subclasses override:
 *   run()        — execute one cycle of work
 *   shouldRun()  — check if conditions are met (signal, timer, manual trigger)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn } = require("child_process");

function findProjectRoot() {
  // When running from scripts/e2e/ inside a project
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
const GIT_LOCK_PATH = path.join(STATE_DIR, ".git-commit.lock");
const SUSPEND_FILE = path.join(STATE_DIR, "daemon.suspend");

// ---------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024;   // 5 MB — rotate daemon.log beyond this
const MAX_JSONL_LINES = 2000;                   // Keep last N lines in .jsonl files
const MAX_EXEC_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MB — cap stdout/stderr from child processes
const SIGNALS_CACHE_TTL_MS = 2000;              // Cache signals file reads for 2s

// Shared signals cache — avoids 50+ disk reads/minute from 7 claws + daemon
let _signalsCacheData = null;
let _signalsCacheTime = 0;

let remoteSignalBus, MACHINE_ID;
try {
  const rsb = require("./remote-signal-bus");
  remoteSignalBus = rsb.instance;
  MACHINE_ID = rsb.MACHINE_ID;
} catch {
  // remote-signal-bus not available in standalone mode
  MACHINE_ID = `${os.hostname()}-${os.userInfo().username}`;
  remoteSignalBus = {
    isNetworkMode: false,
    emitSignal: async (name, data, localWriter) => { localWriter(name, data); },
    heartbeat: async () => {},
    pollRemoteSignals: async () => {},
    hasRemoteSignal: () => false,
  };
}

// Cache bash path on Windows (checked once at startup)
let _bashPath = null;
let _bashChecked = false;
function getBashPath() {
  if (os.platform() !== "win32") { return "bash"; }
  if (_bashChecked) { return _bashPath; }
  _bashChecked = true;
  // Try common Git Bash locations, then fall back to PATH
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "usr", "bin", "bash.exe"),
    "bash",
  ];
  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "pipe", timeout: 5000 });
      _bashPath = candidate;
      return _bashPath;
    } catch { /* try next */ }
  }
  _bashPath = null;
  return null;
}

// ---------------------------------------------------------------------------
// Atomic file write — write to temp, then rename (prevents corruption)
// ---------------------------------------------------------------------------

function atomicWriteSync(filePath, data) {
  const tmpPath = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

/**
 * Prune a JSONL file to keep only the last N lines.
 * Prevents unbounded growth of append-only log files.
 */
function pruneJsonlFile(filePath, maxLines) {
  try {
    if (!fs.existsSync(filePath)) { return; }
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length <= maxLines) { return; }
    const pruned = lines.slice(-maxLines).join("\n") + "\n";
    atomicWriteSync(filePath, pruned);
  } catch {
    // Non-fatal
  }
}

/**
 * Read only the last N bytes of a file (tail-read).
 * Avoids loading entire multi-MB files into memory.
 */
function readFileTail(filePath, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) {
      return fs.readFileSync(filePath, "utf-8");
    }
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    fs.closeSync(fd);
    const content = buf.toString("utf-8");
    // Skip the first partial line
    const firstNewline = content.indexOf("\n");
    return firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
  } catch {
    return "";
  }
}

/**
 * Clean up orphaned temp files and stale locks from prior crashes.
 */
function cleanupOrphanedFiles() {
  try {
    const files = fs.readdirSync(STATE_DIR);
    let cleaned = 0;
    for (const f of files) {
      const fp = path.join(STATE_DIR, f);
      // Clean .tmp files from dead processes
      if (f.includes(".tmp.")) {
        const pidMatch = f.match(/\.tmp\.(\d+)$/);
        if (pidMatch) {
          const pid = parseInt(pidMatch[1], 10);
          let alive = false;
          try { process.kill(pid, 0); alive = true; } catch {}
          if (!alive) {
            try { fs.unlinkSync(fp); cleaned++; } catch {}
          }
        }
      }
      // Clean stale .lock-moc-fix files older than 1 hour
      if (f.startsWith(".lock-moc-fix")) {
        try {
          const stat = fs.statSync(fp);
          if (Date.now() - stat.mtimeMs > 3600000) {
            fs.unlinkSync(fp);
            cleaned++;
          }
        } catch {}
      }
    }
    return cleaned;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// File-based advisory lock for shared resources
// ---------------------------------------------------------------------------

function acquireLock(lockPath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const lockData = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  const MAX_ATTEMPTS = Math.ceil(timeoutMs / 50);
  let attempts = 0;

  while (Date.now() < deadline && attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      fs.writeFileSync(lockPath, lockData, { flag: "wx" });
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const existing = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
          const lockAge = Date.now() - new Date(existing.at).getTime();
          if (lockAge > 30000) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }
          // Check if holder PID is dead
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
        // Yield CPU instead of busy-waiting — use Atomics.wait if available, otherwise short spin
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + Math.random() * 100); } catch {
          const end = Date.now() + 20;
          while (Date.now() < end) { /* minimal fallback spin */ }
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

class Claw {
  constructor(name, opts = {}) {
    this.name = name;
    this.running = false;
    this.shuttingDown = false;
    this._paused = false;
    this.currentCycle = 0;
    this.lastRunAt = null;
    this.lastError = null;
    this.cyclePromise = null;

    // Config from daemon-config.json
    this.config = this._loadConfig();
    this.clawConfig = this.config.claws?.[name] ?? {};
    this.daemonConfig = this.config.daemon ?? {};

    // Schedule
    this.intervalMs = (this.clawConfig.intervalMinutes ?? 60) * 60 * 1000;
    this.triggerSignals = this.clawConfig.triggerOn ?? [];
    this.enabled = this.clawConfig.enabled !== false;

    // Circuit breaker
    this._circuitBroken = false;
    this._consecutiveFailures = 0;
    this._lastErrorMessage = null;
    this._sameErrorCount = 0;
    const cbConfig = this.config.circuitBreakers ?? {};
    this._cbConfig = cbConfig[name] ?? cbConfig.default ?? {};
    this._cbMaxFailures = this._cbConfig.maxConsecutiveFailures ?? 5;

    // Heartbeat
    this.heartbeatInterval = null;
    this.heartbeatMs = (this.daemonConfig.heartbeatIntervalSeconds ?? 60) * 1000;

    // Budget tracking — per-cycle AND per-hour
    this.budgetSpent = 0;
    this.budgetLimit = this.clawConfig.budgetPerCycle ?? Infinity;
    this._hourlySpend = [];  // Array of { amount, at } for rolling window
    this._hourlyBudgetLimit = this.clawConfig.budgetPerHour ?? Infinity;

    // Signal expiry (default 24h)
    this._signalExpiryMs = (this.daemonConfig.signalExpiryHours ?? 24) * 60 * 60 * 1000;

    // Idle cycle tracking — for daemon auto-shutdown coordination
    this._consecutiveIdleCycles = 0;

    // IPC signal relay from daemon — avoids per-claw filesystem reads
    this._ipcSignals = null;
    this._ipcSignalsTime = 0;

    // Track spawned child processes for cleanup on shutdown (prevents orphans)
    this._activeChildren = new Set();

    // Restore lastRunAt from persisted state (crash recovery)
    this._restoreLastRunAt();

    // Clean up orphaned files from prior crashes (first claw to start does this)
    if (!Claw._cleanupDone) {
      Claw._cleanupDone = true;
      const cleaned = cleanupOrphanedFiles();
      if (cleaned > 0) { this.log(`startup: cleaned ${cleaned} orphaned temp/lock files`); }
    }

    // Wire up shutdown
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("message", (msg) => this._onMessage(msg));
  }

  // ---------------------------------------------------------------------------
  // Override in subclass
  // ---------------------------------------------------------------------------

  /** Execute one cycle of work. Return { ok: boolean, summary: string }. */
  async run() {
    throw new Error(`${this.name}: run() not implemented`);
  }

  /**
   * Check if this claw should run right now.
   * Default: run if a trigger signal is pending OR timer has elapsed.
   */
  shouldRun() {
    // Check for pending local signals (only non-expired signals)
    for (const sig of this.triggerSignals) {
      const signal = this._getSignal(sig);
      if (signal && signal.at) {
        const signalAge = Date.now() - new Date(signal.at).getTime();
        if (signalAge > this._signalExpiryMs) { continue; }
        if (!this.lastRunAt || new Date(signal.at) > new Date(this.lastRunAt)) {
          return { run: true, reason: `signal: ${sig}` };
        }
      }
    }

    // Check remote signals in network mode
    if (remoteSignalBus.isNetworkMode) {
      for (const sig of this.triggerSignals) {
        const remoteSig = remoteSignalBus.hasRemoteSignal(sig, this.lastRunAt);
        if (remoteSig) {
          return { run: true, reason: `remote-signal: ${sig}` };
        }
      }
    }

    // Check timer (continuous claws with intervalMs = 0 always run)
    if (this.intervalMs === 0) {
      return { run: true, reason: "continuous" };
    }

    if (this.lastRunAt) {
      const elapsed = Date.now() - new Date(this.lastRunAt).getTime();
      if (elapsed >= this.intervalMs) {
        return { run: true, reason: "timer" };
      }
    } else {
      return { run: true, reason: "initial" };
    }

    return { run: false, reason: "waiting" };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start the claw's run loop. */
  async start() {
    if (!this.enabled) {
      this.log("disabled in config, exiting");
      return;
    }

    // Trap unhandled rejections to prevent silent crashes
    process.on("unhandledRejection", (reason) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      this.log(`UNHANDLED REJECTION: ${msg.slice(0, 200)}`);
      this._recordFailure(msg);
      // Emit crash signal so diagnostics can investigate
      try {
        this.emitSignal("claw-crashed", {
          claw: this.name,
          reason: `unhandledRejection: ${msg.slice(0, 150)}`,
          at: new Date().toISOString(),
        });
      } catch { /* non-fatal */ }
    });

    this.running = true;
    this._paused = false;
    this.log("started");
    this._writeStatus("idle");

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => this._heartbeat(), this.heartbeatMs);
    this._heartbeat();

    // Main loop
    while (this.running && !this.shuttingDown) {
      try {
        // Suspend file check — instant kill switch
        if (fs.existsSync(SUSPEND_FILE)) {
          this.log("suspend file detected — shutting down");
          this.shutdown("suspend-file");
          break;
        }

        if (this._circuitBroken) {
          // Check reset conditions while tripped
          if (this._shouldResetCircuitBreaker()) {
            this._resetCircuitBreaker("reset condition met");
          }
          // Skip run() while circuit is broken — report idle
          this._reportIdleState();
        } else if (this._paused) {
          this._reportIdleState();
        } else {
          const check = this.shouldRun();
          if (check.run) {
            this._consecutiveIdleCycles = 0;
            await this._executeCycle(check.reason);
          } else {
            this._consecutiveIdleCycles++;
            this._reportIdleState();
          }
        }
      } catch (err) {
        this.log(`loop error: ${err.message}`);
        this.lastError = err.message;
      }

      // Poll interval — check every 15s (signals arrive via IPC from daemon)
      if (this.running && !this.shuttingDown) {
        await this._sleep(15000);
      }
    }

    this.log("stopped");
    this._writeStatus("stopped");
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /** Graceful shutdown. */
  async shutdown(reason = "unknown") {
    if (this.shuttingDown) { return; }
    this.shuttingDown = true;
    this.running = false;
    this.log(`shutting down (${reason})`);

    // Kill all active child processes (and their trees on Windows)
    if (this._activeChildren.size > 0) {
      this.log(`killing ${this._activeChildren.size} active child process(es)`);
      for (const child of this._activeChildren) {
        try {
          if (os.platform() === "win32") {
            execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", timeout: 10000 });
          } else {
            child.kill("SIGKILL");
          }
        } catch {}
      }
      this._activeChildren.clear();
    }

    // Wait for current cycle to finish (with timeout)
    if (this.cyclePromise) {
      const timeout = Math.min(this.daemonConfig.gracefulShutdownTimeoutMs ?? 30000, 10000);
      await Promise.race([
        this.cyclePromise,
        this._sleep(timeout),
      ]);
    }

    this._writeStatus("stopped");
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Helpers for subclasses
  // ---------------------------------------------------------------------------

  /** Emit a signal for other claws to pick up (local + remote in network mode). */
  emitSignal(name, data = {}) {
    const localWriter = (sigName, sigData) => {
      this._withSignalsLock((signals) => {
        signals.signals[sigName] = {
          at: new Date().toISOString(),
          emittedBy: this.name,
          ...sigData,
        };
      });
    };

    remoteSignalBus.emitSignal(name, data, localWriter).catch(() => {});
    this.log(`emitted signal: ${name}${remoteSignalBus.isNetworkMode ? " (local+remote)" : ""}`);
  }

  /** Run a shell command synchronously. Returns { ok, stdout, stderr }. */
  exec(cmd, opts = {}) {
    const timeout = opts.timeoutMs ?? 120000;
    const label = opts.label ?? cmd.split(" ").slice(0, 3).join(" ");
    this.log(`  exec: ${label}`);
    const startTime = Date.now();
    try {
      // Use bash shell on Windows for consistent Unix-style command support (if available)
      const bashPath = os.platform() === "win32" ? getBashPath() : null;
      const shellOpts = bashPath ? { shell: bashPath } : {};
      const stdout = execSync(cmd, {
        cwd: ROOT,
        stdio: "pipe",
        timeout,
        env: { ...process.env, ...opts.env },
        windowsHide: true,
        ...shellOpts,
      });
      const duration = Date.now() - startTime;
      this.log(`  done: ${label} (${(duration / 1000).toFixed(1)}s)`);
      return { ok: true, stdout: stdout.toString(), stderr: "", durationMs: duration };
    } catch (err) {
      const duration = Date.now() - startTime;
      const stderr = err.stderr ? err.stderr.toString().slice(0, 500) : err.message;
      this.log(`  fail: ${label} — ${stderr.slice(0, 200)}`);
      return { ok: false, stdout: "", stderr, durationMs: duration };
    }
  }

  /** Run a shell command asynchronously via spawn. Returns a Promise. */
  execAsync(cmd, opts = {}) {
    return new Promise((resolve) => {
      const timeout = opts.timeoutMs ?? 120000;
      const label = opts.label ?? cmd.split(" ").slice(0, 3).join(" ");
      this.log(`  exec-async: ${label}`);
      const startTime = Date.now();

      // Cross-platform: use cmd.exe on Windows if bash is unavailable
      let shell, shellArgs;
      const bashExe = getBashPath();
      if (os.platform() === "win32" && !bashExe) {
        shell = process.env.COMSPEC || "cmd.exe";
        shellArgs = ["/c", cmd];
      } else {
        shell = bashExe || "bash";
        shellArgs = ["-c", cmd];
      }

      const child = spawn(shell, shellArgs, {
        cwd: ROOT,
        stdio: "pipe",
        env: { ...process.env, ...opts.env },
        windowsHide: true,
      });

      // Track child for cleanup on shutdown
      this._activeChildren.add(child);

      let stdout = "";
      let stderr = "";
      let stdoutOverflow = false;
      let stderrOverflow = false;
      child.stdout.on("data", (d) => {
        if (stdoutOverflow) { return; }
        stdout += d.toString();
        if (stdout.length > MAX_EXEC_OUTPUT_BYTES) {
          stdout = stdout.slice(-MAX_EXEC_OUTPUT_BYTES);
          stdoutOverflow = true;
        }
      });
      child.stderr.on("data", (d) => {
        if (stderrOverflow) { return; }
        stderr += d.toString();
        if (stderr.length > MAX_EXEC_OUTPUT_BYTES) {
          stderr = stderr.slice(-MAX_EXEC_OUTPUT_BYTES);
          stderrOverflow = true;
        }
      });

      const timer = setTimeout(() => {
        // Kill entire process tree on timeout (prevents orphans on Windows)
        try {
          if (os.platform() === "win32") {
            execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", timeout: 10000 });
          } else {
            child.kill("SIGKILL");
          }
        } catch {}
        this._activeChildren.delete(child);
        resolve({ ok: false, stdout, stderr: "timeout", durationMs: Date.now() - startTime });
      }, timeout);

      child.on("close", (code) => {
        this._activeChildren.delete(child);
        clearTimeout(timer);
        const duration = Date.now() - startTime;
        if (code === 0) {
          this.log(`  done: ${label} (${(duration / 1000).toFixed(1)}s)`);
        } else {
          this.log(`  fail: ${label} (exit ${code})`);
        }
        resolve({ ok: code === 0, stdout, stderr: stderr.slice(0, 500), durationMs: duration });
      });

      child.on("error", (err) => {
        this._activeChildren.delete(child);
        clearTimeout(timer);
        this.log(`  fail: ${label} (spawn error: ${err.message})`);
        resolve({ ok: false, stdout, stderr: err.message, durationMs: Date.now() - startTime });
      });
    });
  }

  /** Log a message with timestamp and claw name. */
  log(msg) {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    const line = `[${ts}] [${this.name}] ${msg}`;
    console.log(line);
    this._appendLog(line);
  }

  /** Read a JSON state file. */
  readState(filename) {
    const filePath = path.join(STATE_DIR, filename);
    if (!fs.existsSync(filePath)) { return null; }
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  /** Write a JSON state file (atomic). */
  writeState(filename, data) {
    const filePath = path.join(STATE_DIR, filename);
    atomicWriteSync(filePath, JSON.stringify(data, null, 2) + "\n");
  }

  /** Check if per-cycle budget is exhausted. */
  isBudgetExhausted() {
    return this.budgetSpent >= this.budgetLimit;
  }

  /** Check if hourly budget is exhausted. */
  isHourlyBudgetExhausted() {
    this._pruneHourlySpend();
    const hourlyTotal = this._hourlySpend.reduce((sum, e) => sum + e.amount, 0);
    return hourlyTotal >= this._hourlyBudgetLimit;
  }

  /** Track spend (per-cycle and hourly rolling window). */
  addBudgetSpend(amount) {
    this.budgetSpent += amount;
    this._hourlySpend.push({ amount, at: Date.now() });
    this._pruneHourlySpend();

    const hourlyTotal = this._hourlySpend.reduce((sum, e) => sum + e.amount, 0);

    if (this.budgetSpent >= this.budgetLimit) {
      this.log(`cycle budget exhausted: $${this.budgetSpent.toFixed(2)} / $${this.budgetLimit.toFixed(2)}`);
    }
    if (hourlyTotal >= this._hourlyBudgetLimit) {
      this.log(`hourly budget exhausted: $${hourlyTotal.toFixed(2)} / $${this._hourlyBudgetLimit.toFixed(2)}`);
    }
  }

  /**
   * Acquire a git commit lock. Returns true if acquired.
   * Use this before any git add/commit operations.
   */
  acquireGitLock(timeoutMs = 15000) {
    const acquired = acquireLock(GIT_LOCK_PATH, timeoutMs);
    if (!acquired) {
      this.log("could not acquire git lock — another claw is committing");
    }
    return acquired;
  }

  /** Release the git commit lock. */
  releaseGitLock() {
    releaseLock(GIT_LOCK_PATH);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async _executeCycle(reason) {
    // Hot-reload config so auto-tune changes take effect without restart
    this._reloadConfig();

    this.currentCycle++;
    this.log(`cycle ${this.currentCycle} starting (${reason})`);
    this._writeStatus("running", { phase: "starting", cycle: this.currentCycle });

    const startTime = Date.now();
    let result;

    try {
      this.cyclePromise = this.run();
      result = await this.cyclePromise;
    } catch (err) {
      result = { ok: false, summary: `error: ${err.message}` };
      this.lastError = err.message;
    } finally {
      this.cyclePromise = null;
    }

    const duration = Date.now() - startTime;
    this.lastRunAt = new Date().toISOString();
    this.budgetSpent = 0; // Reset per-cycle budget (hourly budget persists)

    // Persist lastRunAt so crash recovery doesn't re-process signals
    this._persistLastRunAt();

    // Circuit breaker tracking
    this._trackCircuitBreaker(result);

    this.log(`cycle ${this.currentCycle} complete (${(duration / 1000).toFixed(1)}s) — ${result?.summary ?? "no summary"}`);
    this._writeStatus("idle", { lastCycleDurationMs: duration, lastCycleResult: result?.ok ? "ok" : "error" });

    // Record cycle history (structured, for trend analysis)
    this._recordCycleHistory(duration, result);

    // Notify parent process
    if (process.send) {
      try {
        process.send({ type: "cycle-complete", claw: this.name, cycle: this.currentCycle, duration, result });
      } catch {
        // Parent may have died
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker
  // ---------------------------------------------------------------------------

  /** Track consecutive failures and trip the circuit breaker if threshold exceeded. */
  _trackCircuitBreaker(result) {
    if (result?.ok) {
      this._consecutiveFailures = 0;
      this._sameErrorCount = 0;
      this._lastErrorMessage = null;
      return;
    }

    this._consecutiveFailures++;

    // Track repeated identical errors
    const errMsg = result?.summary ?? "";
    if (errMsg && errMsg === this._lastErrorMessage) {
      this._sameErrorCount++;
    } else {
      this._sameErrorCount = 1;
      this._lastErrorMessage = errMsg;
    }

    // Check trip conditions
    const shouldTrip =
      this._consecutiveFailures >= this._cbMaxFailures ||
      this._sameErrorCount >= (this._cbConfig.maxSameError ?? 5);

    if (shouldTrip) {
      this._tripCircuitBreaker(`${this._consecutiveFailures} consecutive failures (same error x${this._sameErrorCount})`);
    }
  }

  /** Trip the circuit breaker — pause this claw until reset conditions are met. */
  _tripCircuitBreaker(reason) {
    if (this._circuitBroken) { return; }
    this._circuitBroken = true;
    this.log(`CIRCUIT BREAKER TRIPPED: ${reason}`);
    this._writeStatus("circuit_broken");

    // Emit signal for diagnostics claw
    this.emitSignal("circuit-broken", {
      claw: this.name,
      reason,
      consecutiveFailures: this._consecutiveFailures,
    });

    // Write notification
    try {
      const { writeToFile } = require("./lib/notify");
      writeToFile(`Circuit breaker tripped for ${this.name}: ${reason}`, "warning");
    } catch { /* notify module may not be available */ }
  }

  /** Check if circuit breaker should auto-reset. */
  _shouldResetCircuitBreaker() {
    // Reset on deploy-detected signal (new code might fix the issue)
    const deploySignal = this._getSignal("deploy-detected");
    if (deploySignal?.at) {
      const signals = this._loadSignals();
      const tripTime = signals.claws?.[this.name]?.heartbeat;
      if (tripTime && new Date(deploySignal.at) > new Date(tripTime)) {
        return true;
      }
    }

    // Reset if diagnostics claw fixed the root cause
    const diagSignal = this._getSignal("diagnostics-complete");
    if (diagSignal?.at) {
      const signals = this._loadSignals();
      const tripTime = signals.claws?.[this.name]?.heartbeat;
      if (tripTime && new Date(diagSignal.at) > new Date(tripTime)) {
        return true;
      }
    }

    return false;
  }

  /** Reset the circuit breaker. */
  _resetCircuitBreaker(reason) {
    this._circuitBroken = false;
    this._consecutiveFailures = 0;
    this._sameErrorCount = 0;
    this._lastErrorMessage = null;
    this.log(`circuit breaker reset: ${reason}`);
    this._writeStatus("idle");
  }

  /** Persist lastRunAt to signals file so crash recovery doesn't re-process old signals. */
  _persistLastRunAt() {
    this._withSignalsLock((signals) => {
      if (!signals.claws[this.name]) { signals.claws[this.name] = {}; }
      signals.claws[this.name].lastRun = this.lastRunAt;
      signals.claws[this.name].cycle = this.currentCycle;
    });
  }

  /** Restore lastRunAt from signals file on startup (crash recovery). */
  _restoreLastRunAt() {
    try {
      const signals = this._loadSignals();
      const clawState = signals.claws?.[this.name];
      if (clawState?.lastRun) {
        this.lastRunAt = clawState.lastRun;
        this.currentCycle = clawState.cycle ?? 0;
        this.log(`restored state: lastRun=${this.lastRunAt}, cycle=${this.currentCycle}`);
      }
    } catch {
      // First run or corrupt file — start fresh
    }
  }

  /** Record structured cycle history for trend analysis. */
  _recordCycleHistory(durationMs, result) {
    try {
      const historyPath = path.join(STATE_DIR, "claw-history.jsonl");
      const entry = {
        claw: this.name,
        cycle: this.currentCycle,
        at: new Date().toISOString(),
        durationMs,
        ok: result?.ok ?? false,
        summary: result?.summary ?? "",
      };
      fs.appendFileSync(historyPath, JSON.stringify(entry) + "\n");

      // Prune every 50 cycles to prevent unbounded growth
      if (this.currentCycle % 50 === 0) {
        pruneJsonlFile(historyPath, MAX_JSONL_LINES);
      }
    } catch {
      // Non-fatal
    }
  }

  _heartbeat() {
    const status = this._paused ? "paused" : (this.cyclePromise ? "running" : "idle");
    this._writeStatus(status);

    // In network mode, send remote heartbeat and poll for remote signals
    if (remoteSignalBus.isNetworkMode) {
      remoteSignalBus.heartbeat(status, null, { claw: this.name, cycle: this.currentCycle }).catch(() => {});
      remoteSignalBus.pollRemoteSignals().catch(() => {});
    }
  }

  _writeStatus(status, extra = {}) {
    this._withSignalsLock((signals) => {
      signals.claws[this.name] = {
        ...signals.claws[this.name],
        status,
        pid: process.pid,
        lastRun: this.lastRunAt,
        nextRun: this.intervalMs > 0 && this.lastRunAt
          ? new Date(new Date(this.lastRunAt).getTime() + this.intervalMs).toISOString()
          : null,
        heartbeat: new Date().toISOString(),
        cycle: this.currentCycle,
        ...extra,
      };
    });
  }

  _getSignal(name) {
    const signals = this._loadSignals();
    return signals.signals?.[name] ?? null;
  }

  /**
   * Read-modify-write signals file under an advisory lock.
   * Prevents race conditions between concurrent claws.
   */
  _withSignalsLock(mutator) {
    const lockPath = SIGNALS_PATH + ".lock";
    let locked = false;
    try {
      locked = acquireLock(lockPath, 5000);
      // Bypass cache for read-modify-write — need fresh data under lock
      let signals;
      try {
        signals = fs.existsSync(SIGNALS_PATH)
          ? JSON.parse(fs.readFileSync(SIGNALS_PATH, "utf-8"))
          : { signals: {}, claws: {} };
      } catch {
        signals = { signals: {}, claws: {} };
      }
      mutator(signals);
      atomicWriteSync(SIGNALS_PATH, JSON.stringify(signals, null, 2) + "\n");
      // Invalidate cache so next read sees fresh data
      _signalsCacheData = signals;
      _signalsCacheTime = Date.now();
    } catch {
      // Non-fatal — don't break the claw over a status write
    } finally {
      if (locked) { releaseLock(lockPath); }
    }
  }

  _loadSignals() {
    // Prefer IPC-provided signals from daemon (no disk I/O)
    const now = Date.now();
    if (this._ipcSignals && (now - this._ipcSignalsTime) < 10000) {
      return JSON.parse(JSON.stringify(this._ipcSignals));
    }

    // Fallback: shared cache to avoid 50+ disk reads/minute
    if (_signalsCacheData && (now - _signalsCacheTime) < SIGNALS_CACHE_TTL_MS) {
      return JSON.parse(JSON.stringify(_signalsCacheData));
    }
    if (!fs.existsSync(SIGNALS_PATH)) {
      return { signals: {}, claws: {} };
    }
    try {
      const data = JSON.parse(fs.readFileSync(SIGNALS_PATH, "utf-8"));
      _signalsCacheData = data;
      _signalsCacheTime = now;
      return JSON.parse(JSON.stringify(data));
    } catch {
      return { signals: {}, claws: {} };
    }
  }

  /** Report idle state to daemon via IPC for auto-shutdown coordination. */
  _reportIdleState() {
    // Report every 5 idle cycles to avoid IPC spam
    if (this._consecutiveIdleCycles % 5 !== 0) { return; }
    if (!process.send) { return; }
    try {
      process.send({
        type: "idle-report",
        claw: this.name,
        idleCycles: this._consecutiveIdleCycles,
        budgetExhausted: this.isHourlyBudgetExhausted(),
        circuitBroken: this._circuitBroken,
      });
    } catch {
      // Parent may have died
    }
  }

  _loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
      return { claws: {}, daemon: {} };
    }
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      return { claws: {}, daemon: {} };
    }
  }

  _reloadConfig() {
    const fresh = this._loadConfig();
    this.config = fresh;
    this.clawConfig = fresh.claws?.[this.name] ?? {};
    this.daemonConfig = fresh.daemon ?? {};
    this.intervalMs = (this.clawConfig.intervalMinutes ?? 60) * 60 * 1000;
    this.triggerSignals = this.clawConfig.triggerOn ?? [];
    this.budgetLimit = this.clawConfig.budgetPerCycle ?? Infinity;
    this._hourlyBudgetLimit = this.clawConfig.budgetPerHour ?? Infinity;
  }

  _onMessage(msg) {
    if (msg?.type === "pause") {
      this.log("paused by daemon");
      this._paused = true;
      this._writeStatus("paused");
    } else if (msg?.type === "resume") {
      this.log("resumed by daemon");
      this._paused = false;
      this._writeStatus("idle");
    } else if (msg?.type === "trigger") {
      this.log("triggered by daemon");
      this.lastRunAt = null; // Force immediate run
    } else if (msg?.type === "shutdown") {
      this.shutdown("daemon");
    } else if (msg?.type === "signals-update") {
      // IPC signal relay from daemon — avoid per-claw filesystem reads
      this._ipcSignals = { signals: msg.signals, claws: msg.claws };
      this._ipcSignalsTime = Date.now();
    }
  }

  _appendLog(line) {
    try {
      const logFile = this.daemonConfig.logFile
        ? path.join(ROOT, this.daemonConfig.logFile)
        : path.join(STATE_DIR, "daemon.log");
      fs.appendFileSync(logFile, line + "\n");
      this._rotateLogIfNeeded(logFile);
    } catch {
      // Non-fatal
    }
  }

  _rotateLogIfNeeded(logFile) {
    // Throttle rotation checks to once per 100 log writes
    if (!this._logWriteCount) { this._logWriteCount = 0; }
    this._logWriteCount++;
    if (this._logWriteCount % 100 !== 0) { return; }
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > MAX_LOG_SIZE_BYTES) {
        const rotated = logFile + ".old";
        try { fs.unlinkSync(rotated); } catch {}
        fs.renameSync(logFile, rotated);
        fs.writeFileSync(logFile, `[${new Date().toISOString()}] [${this.name}] log rotated (was ${(stat.size / 1024 / 1024).toFixed(1)}MB)\n`);
      }
    } catch {
      // Non-fatal
    }
  }

  _pruneHourlySpend() {
    const oneHourAgo = Date.now() - 3600000;
    this._hourlySpend = this._hourlySpend.filter((e) => e.at > oneHourAgo);
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { Claw, ROOT, STATE_DIR, SIGNALS_PATH, GIT_LOCK_PATH, acquireLock, releaseLock, atomicWriteSync, pruneJsonlFile, readFileTail, cleanupOrphanedFiles, remoteSignalBus, MACHINE_ID };
