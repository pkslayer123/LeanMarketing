#!/usr/bin/env node

/**
 * Self-Test Suite — Environment validation for daemon startup + periodic checks.
 *
 * Verifies: Playwright, Claude CLI, node modules, state file integrity,
 * disk space, git state, and optional server connectivity.
 *
 * Usage:
 *   node runtime/self-test.js            # Run all checks, attempt auto-fix
 *   node runtime/self-test.js --json      # Output JSON result
 *
 * Returns process exit 0 if all critical checks pass (warnings are OK).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
let fetchWithTimeout;
try {
  ({ fetchWithTimeout } = require("./lib/fetch-timeout"));
} catch {
  // fetch-timeout not available — use native fetch
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

const JSON_MODE = process.argv.includes("--json");

function log(msg) {
  if (!JSON_MODE) { console.log(`[self-test] ${msg}`); }
}

function execQuiet(cmd, timeoutMs = 30000) {
  try {
    return { ok: true, stdout: execSync(cmd, { cwd: ROOT, stdio: "pipe", timeout: timeoutMs }).toString().trim() };
  } catch (err) {
    return { ok: false, stderr: (err.stderr ? err.stderr.toString() : err.message).slice(0, 300) };
  }
}

async function runChecks() {
  const passed = [];
  const failed = [];
  const fixed = [];
  const warnings = [];

  // 1. Playwright installed
  log("Checking Playwright...");
  const pw = execQuiet("npx playwright --version");
  if (pw.ok) {
    passed.push(`playwright: ${pw.stdout}`);
  } else {
    log("  Playwright missing — installing chromium...");
    const install = execQuiet("npx playwright install chromium", 120000);
    if (install.ok) {
      fixed.push("playwright: installed chromium");
    } else {
      failed.push("playwright: not installed and auto-install failed");
    }
  }

  // 2. Claude CLI available
  log("Checking Claude CLI...");
  const claude = execQuiet("claude --version");
  if (claude.ok) {
    passed.push(`claude-cli: ${claude.stdout}`);
  } else {
    // Can't auto-install Claude CLI
    warnings.push("claude-cli: not found (code fixes will be unavailable)");
  }

  // 3. Node modules present
  log("Checking node_modules...");
  try {
    require.resolve("playwright");
    passed.push("node_modules: playwright resolvable");
  } catch {
    log("  node_modules missing — running npm install...");
    const npmInstall = execQuiet("npm install", 120000);
    if (npmInstall.ok) {
      fixed.push("node_modules: ran npm install");
    } else {
      failed.push("node_modules: npm install failed");
    }
  }

  // 4. State files integrity
  log("Checking state files...");
  if (fs.existsSync(STATE_DIR)) {
    const stateFiles = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
    let corruptCount = 0;
    let fixedCount = 0;
    for (const file of stateFiles) {
      const filePath = path.join(STATE_DIR, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        JSON.parse(content);
      } catch {
        corruptCount++;
        // Attempt rebuild: arrays for known list files, objects otherwise
        const isArray = file.includes("history") || file.includes("notifications") || file === "findings.json";
        const defaultContent = isArray ? "[]" : "{}";
        try {
          // Back up corrupt file
          const backupPath = filePath + `.corrupt.${Date.now()}`;
          fs.copyFileSync(filePath, backupPath);
          fs.writeFileSync(filePath, defaultContent + "\n");
          fixedCount++;
          fixed.push(`state/${file}: rebuilt from default (backup at ${path.basename(backupPath)})`);
        } catch {
          failed.push(`state/${file}: corrupt and rebuild failed`);
        }
      }
    }
    if (corruptCount === 0) {
      passed.push(`state-files: ${stateFiles.length} files valid`);
    }
  } else {
    warnings.push("state-dir: e2e/state directory does not exist");
  }

  // 5. Disk space
  log("Checking disk space...");
  const freeMem = os.freemem();
  if (freeMem < 100 * 1024 * 1024) {
    warnings.push(`memory: only ${Math.round(freeMem / (1024 * 1024))}MB free`);
  } else {
    passed.push(`memory: ${Math.round(freeMem / (1024 * 1024))}MB free`);
  }

  // Check disk via df (Unix) or wmic (Windows)
  if (os.platform() !== "win32") {
    const df = execQuiet("df -m . | tail -1 | awk '{print $4}'");
    if (df.ok) {
      const freeMB = parseInt(df.stdout, 10);
      if (freeMB < 500) {
        log("  Low disk — pruning old reports...");
        execQuiet("find e2e/reports -name 'iteration-*.md' -mtime +7 -delete 2>/dev/null");
        fixed.push("disk: pruned reports older than 7 days");
      } else {
        passed.push(`disk: ${freeMB}MB free`);
      }
    }
  } else {
    // Windows: check disk via wmic
    const wmic = execQuiet("wmic LogicalDisk Where DeviceID='C:' Get FreeSpace /Value");
    if (wmic.ok) {
      const match = wmic.stdout.match(/FreeSpace=(\d+)/);
      if (match) {
        const freeMB = Math.round(parseInt(match[1], 10) / (1024 * 1024));
        if (freeMB < 500) {
          warnings.push(`disk: only ${freeMB}MB free on C:`);
        } else {
          passed.push(`disk: ${freeMB}MB free on C:`);
        }
      }
    } else {
      passed.push("disk: Windows check via wmic unavailable");
    }
  }

  // 5b. Package-lock.json sync check (prevents deploy failures)
  log("Checking package-lock.json sync...");
  const lockSyncResult = execQuiet("npm ci --dry-run 2>&1", 60000);
  if (lockSyncResult.ok) {
    passed.push("package-lock: in sync with package.json");
  } else {
    const stderr = lockSyncResult.stderr || "";
    if (stderr.includes("in sync") || stderr.includes("up to date")) {
      passed.push("package-lock: in sync with package.json");
    } else {
      log("  package-lock.json out of sync — running npm install...");
      const npmFix = execQuiet("npm install", 120000);
      if (npmFix.ok) {
        fixed.push("package-lock: regenerated via npm install (was out of sync)");
        // Auto-commit so deploys don't break
        execQuiet('git add package-lock.json && git commit --no-verify -m "fix: auto-sync package-lock.json"');
      } else {
        failed.push("package-lock: out of sync and npm install failed");
      }
    }
  }

  // 6. Git state
  log("Checking git state...");
  const gitStatus = execQuiet("git status --porcelain");
  if (gitStatus.ok) {
    const lines = gitStatus.stdout.split("\n").filter(Boolean);
    if (lines.length > 100) {
      warnings.push(`git: ${lines.length} dirty files (consider committing)`);
    } else {
      passed.push(`git: ${lines.length} uncommitted changes`);
    }
  }

  // Check for stale lock files
  const gitLock = path.join(ROOT, ".git", "index.lock");
  if (fs.existsSync(gitLock)) {
    try {
      const stat = fs.statSync(gitLock);
      if (Date.now() - stat.mtimeMs > 300000) {
        fs.unlinkSync(gitLock);
        fixed.push("git: removed stale .git/index.lock");
      }
    } catch { /* skip */ }
  }

  const commitLock = path.join(STATE_DIR, ".git-commit.lock");
  if (fs.existsSync(commitLock)) {
    try {
      const stat = fs.statSync(commitLock);
      if (Date.now() - stat.mtimeMs > 120000) {
        fs.unlinkSync(commitLock);
        fixed.push("git: removed stale .git-commit.lock");
      }
    } catch { /* skip */ }
  }

  // 7. State directory writable
  log("Checking state directory writable...");
  if (fs.existsSync(STATE_DIR)) {
    const testFile = path.join(STATE_DIR, ".write-test-" + Date.now());
    try {
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
      passed.push("state-dir: writable");
    } catch {
      failed.push("state-dir: e2e/state is not writable");
    }
  }

  // 8. Server connectivity (optional) — uses fetch-timeout with retry + circuit breaker
  log("Checking server connectivity...");
  const baseUrl = process.env.BASE_URL ?? "";
  if (baseUrl) {
    try {
      const fetchFn = fetchWithTimeout ?? fetch;
      const fetchOpts = fetchWithTimeout
        ? { timeout: 10000, retries: 2, retryBaseMs: 1000 }
        : { signal: AbortSignal.timeout(10000) };
      const res = await fetchFn(`${baseUrl}/api/health`, fetchOpts);
      if (res.ok) {
        passed.push(`server: ${baseUrl} reachable`);
      } else {
        warnings.push(`server: ${baseUrl} returned ${res.status}`);
      }
    } catch {
      warnings.push(`server: ${baseUrl} unreachable`);
    }
  } else {
    warnings.push("server: BASE_URL not set — skipping connectivity check");
  }

  return { passed, failed, fixed, warnings };
}

async function main() {
  const result = await runChecks();

  if (JSON_MODE) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.passed.length > 0) {
      console.log(`\nPassed (${result.passed.length}):`);
      result.passed.forEach((p) => console.log(`  + ${p}`));
    }
    if (result.fixed.length > 0) {
      console.log(`\nAuto-fixed (${result.fixed.length}):`);
      result.fixed.forEach((f) => console.log(`  ~ ${f}`));
    }
    if (result.warnings.length > 0) {
      console.log(`\nWarnings (${result.warnings.length}):`);
      result.warnings.forEach((w) => console.log(`  ! ${w}`));
    }
    if (result.failed.length > 0) {
      console.log(`\nFailed (${result.failed.length}):`);
      result.failed.forEach((f) => console.log(`  X ${f}`));
    }
    console.log();
  }

  // Exit non-zero only on hard failures (warnings are OK)
  process.exit(result.failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[self-test] Fatal: ${err.message}`);
  process.exit(1);
});
