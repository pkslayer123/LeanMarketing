/**
 * Browser Session Pool
 *
 * Reuses authenticated browser storage state across tests for the same persona.
 * Instead of logging in fresh each time, caches the auth cookies/localStorage
 * after first successful login and reuses them.
 *
 * Reduces auth round-trips per test from ~3s to ~0s for subsequent tests.
 *
 * State: e2e/state/session-cache/ directory with per-persona JSON files.
 * Eviction: sessions older than 30min (Supabase session expiry is 1h).
 *
 * Usage (from Playwright fixtures):
 *   const { getSession, saveSession, isSessionValid } = require("../../../scripts/e2e/lib/session-pool");
 *   const cached = getSession(personaId, workerIndex);
 *   if (cached) { await context.addCookies(cached.cookies); }
 *   // ... after successful auth ...
 *   saveSession(personaId, workerIndex, cookies, localStorage);
 */

const fs = require("fs");
const path = require("path");

const STATE_DIR = path.resolve(__dirname, "..", "..", "..", "e2e", "state");
const SESSION_DIR = path.join(STATE_DIR, "session-cache");

const MAX_AGE_MS = 30 * 60 * 1000; // 30 min (Supabase sessions last 1h)

function ensureDir() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function sessionPath(personaId, workerIndex) {
  return path.join(SESSION_DIR, `${personaId}-w${workerIndex}.json`);
}

/**
 * Get cached session for a persona+worker pair.
 * Returns null if no cache or expired.
 *
 * @param {string} personaId
 * @param {number} workerIndex
 * @returns {{ cookies: Array, origins: Array, savedAt: string } | null}
 */
function getSession(personaId, workerIndex = 0) {
  const filePath = sessionPath(personaId, workerIndex);
  try {
    if (!fs.existsSync(filePath)) { return null; }
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!data.savedAt) { return null; }

    // Check age
    if (Date.now() - new Date(data.savedAt).getTime() > MAX_AGE_MS) {
      // Expired — delete and return null
      try { fs.unlinkSync(filePath); } catch {}
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Save a session for reuse.
 *
 * @param {string} personaId
 * @param {number} workerIndex
 * @param {Array} cookies — Browser cookies array
 * @param {Array} origins — localStorage origins array (from storageState)
 */
function saveSession(personaId, workerIndex, cookies, origins = []) {
  ensureDir();
  const filePath = sessionPath(personaId, workerIndex);
  const data = {
    personaId,
    workerIndex,
    cookies: cookies ?? [],
    origins: origins ?? [],
    savedAt: new Date().toISOString(),
  };
  try {
    const tmpPath = filePath + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Non-fatal
  }
}

/**
 * Check if a cached session is still valid (not expired).
 */
function isSessionValid(personaId, workerIndex = 0) {
  const session = getSession(personaId, workerIndex);
  return session !== null && session.cookies.length > 0;
}

/**
 * Invalidate (delete) a cached session.
 */
function invalidateSession(personaId, workerIndex = 0) {
  const filePath = sessionPath(personaId, workerIndex);
  try { fs.unlinkSync(filePath); } catch {}
}

/**
 * Evict all expired sessions.
 * @returns {number} — Number of sessions evicted
 */
function evictExpired() {
  ensureDir();
  let evicted = 0;
  try {
    const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(SESSION_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (!data.savedAt || Date.now() - new Date(data.savedAt).getTime() > MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          evicted++;
        }
      } catch {
        // Corrupt — delete
        try { fs.unlinkSync(filePath); evicted++; } catch {}
      }
    }
  } catch {}
  return evicted;
}

/**
 * Get pool stats.
 */
function getStats() {
  ensureDir();
  try {
    const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
    let valid = 0;
    let expired = 0;
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, file), "utf-8"));
        if (data.savedAt && Date.now() - new Date(data.savedAt).getTime() <= MAX_AGE_MS) {
          valid++;
        } else {
          expired++;
        }
      } catch {
        expired++;
      }
    }
    return { total: files.length, valid, expired };
  } catch {
    return { total: 0, valid: 0, expired: 0 };
  }
}

/**
 * Clear all cached sessions.
 */
function clearAll() {
  ensureDir();
  try {
    const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try { fs.unlinkSync(path.join(SESSION_DIR, file)); } catch {}
    }
  } catch {}
}

module.exports = {
  getSession,
  saveSession,
  isSessionValid,
  invalidateSession,
  evictExpired,
  getStats,
  clearAll,
  MAX_AGE_MS,
};
