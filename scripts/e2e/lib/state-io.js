/**
 * state-io.js — Atomic file I/O utilities for E2E state files.
 *
 * Prevents data corruption from concurrent writes (parallel personas, daemon claws).
 * Uses write-to-tmp-then-rename for atomicity and O_EXCL lock files for mutual exclusion.
 *
 * Exports:
 *   atomicWriteSync(filePath, content)  — write string atomically via .tmp.PID rename
 *   readJsonSafe(filePath, defaultVal)  — parse JSON with .backup fallback on corruption
 *   writeJsonAtomic(filePath, data)     — create .backup then atomic write JSON
 *   withFileLock(filePath, fn)          — O_EXCL .lock file with 60s stale detection
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// atomicWriteSync — write string content atomically
// ---------------------------------------------------------------------------

/**
 * Write content to filePath atomically.
 * Writes to a .tmp.PID file first, then renames (atomic on same filesystem).
 *
 * @param {string} filePath - Target file path
 * @param {string} content - String content to write
 */
function atomicWriteSync(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up tmp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// readJsonSafe — parse JSON with .backup fallback
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file safely.
 * If the primary file is missing or corrupt, tries filePath.backup.
 * Returns defaultVal if both fail.
 *
 * @param {string} filePath - Path to JSON file
 * @param {*} defaultVal - Default value if file is unreadable
 * @returns {*} Parsed JSON or defaultVal
 */
function readJsonSafe(filePath, defaultVal) {
  // Try primary file
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      // Primary corrupt — try backup
    }
  }

  // Try .backup
  const backupPath = `${filePath}.backup`;
  if (fs.existsSync(backupPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
      // Restore from backup
      try { atomicWriteSync(filePath, JSON.stringify(data, null, 2)); } catch { /* best effort */ }
      return data;
    } catch {
      // Backup also corrupt
    }
  }

  return defaultVal;
}

// ---------------------------------------------------------------------------
// writeJsonAtomic — create .backup then atomic write
// ---------------------------------------------------------------------------

/**
 * Write JSON data atomically, creating a .backup of the previous version first.
 *
 * @param {string} filePath - Path to JSON file
 * @param {*} data - Data to serialize and write
 */
function writeJsonAtomic(filePath, data) {
  const content = JSON.stringify(data, null, 2) + "\n";

  // Create .backup of existing file (best effort)
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.backup`;
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch {
      // Non-fatal — proceed without backup
    }
  }

  atomicWriteSync(filePath, content);
}

// ---------------------------------------------------------------------------
// withFileLock — O_EXCL lock file with stale detection
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 60 * 1000; // 60 seconds

/**
 * Execute fn while holding an exclusive file lock.
 * Uses O_EXCL for atomic lock creation. Stale locks (>60s) are auto-removed.
 *
 * @param {string} filePath - Path to the file being protected (lock is filePath.lock)
 * @param {Function} fn - Async or sync function to execute while holding the lock
 * @returns {*} Return value of fn
 */
async function withFileLock(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  const lockData = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  const maxWait = 10000; // 10s max wait
  const deadline = Date.now() + maxWait;

  // Acquire lock
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lockPath, lockData, { flag: "wx" }); // O_EXCL — fails if exists
      break;
    } catch (err) {
      if (err.code === "EEXIST") {
        // Check for stale lock
        try {
          const existing = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
          const lockAge = Date.now() - new Date(existing.at).getTime();
          if (lockAge > LOCK_STALE_MS) {
            try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
            continue;
          }
        } catch {
          // Can't read lock — remove it
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
          continue;
        }
        // Wait and retry
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
        continue;
      }
      throw err;
    }
  }

  // Check if we actually acquired
  if (!fs.existsSync(lockPath)) {
    throw new Error(`Failed to acquire lock: ${lockPath}`);
  }

  try {
    const lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    if (lockContent.pid !== process.pid) {
      throw new Error(`Lock acquired by different process: ${lockContent.pid}`);
    }
  } catch (err) {
    if (err.message && err.message.includes("Lock acquired by")) { throw err; }
    // Lock file unreadable — proceed cautiously
  }

  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

module.exports = {
  atomicWriteSync,
  readJsonSafe,
  writeJsonAtomic,
  withFileLock,
};
