/**
 * Oracle Content-Hash Memoization
 *
 * Caches oracle verdicts keyed by hash(pageContent + checkType + personaRole).
 * If a page hasn't changed since the last oracle check, returns the cached
 * verdict without making an LLM call.
 *
 * Eliminates 60-80% of oracle LLM calls on unchanged pages between runs.
 *
 * State: e2e/state/oracle-cache.json
 * Eviction: entries older than 24h or cache exceeds 2000 entries.
 *
 * Usage (from llm-oracle.ts):
 *   const { getCache, setCache, computeContentHash } = require("../../../scripts/e2e/lib/oracle-cache");
 *   const hash = computeContentHash(html, checkType, role);
 *   const cached = getCache(hash);
 *   if (cached) return cached;  // skip LLM
 *   ... run LLM ...
 *   setCache(hash, verdict);
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STATE_DIR = path.resolve(__dirname, "..", "..", "..", "e2e", "state");
const CACHE_PATH = path.join(STATE_DIR, "oracle-cache.json");

const MAX_ENTRIES = 2000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

let _cache = null;
let _dirty = false;

/**
 * Compute a content hash from page HTML, check type, and persona role.
 * Strips volatile content (timestamps, session tokens, CSRF) before hashing.
 */
function computeContentHash(html, checkType, role) {
  // Strip volatile content that changes between requests but doesn't affect oracle verdict
  const stable = (html ?? "")
    .replace(/csrf[_-]?token[^"]*"[^"]*"/gi, "")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "[TS]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[UUID]")
    .replace(/sb-[a-z0-9]+-auth-token[^;]*/gi, "[AUTH]")
    .replace(/\s{2,}/g, " ");

  return crypto
    .createHash("sha256")
    .update(`${checkType}:${role}:${stable}`)
    .digest("hex")
    .slice(0, 16); // 16 chars is plenty for dedup
}

function _loadCache() {
  if (_cache) { return _cache; }
  try {
    if (fs.existsSync(CACHE_PATH)) {
      _cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
    } else {
      _cache = {};
    }
  } catch {
    _cache = {};
  }
  return _cache;
}

function _saveCache() {
  if (!_dirty) { return; }
  try {
    const cache = _loadCache();
    const tmpPath = CACHE_PATH + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2) + "\n");
    fs.renameSync(tmpPath, CACHE_PATH);
    _dirty = false;
  } catch {
    // Non-fatal
  }
}

/**
 * Evict stale entries (older than MAX_AGE_MS) and enforce MAX_ENTRIES.
 */
function _evict() {
  const cache = _loadCache();
  const keys = Object.keys(cache);
  const now = Date.now();
  let evicted = 0;

  // Remove expired
  for (const key of keys) {
    if (cache[key].at && now - cache[key].at > MAX_AGE_MS) {
      delete cache[key];
      evicted++;
    }
  }

  // If still over limit, remove oldest
  const remaining = Object.entries(cache);
  if (remaining.length > MAX_ENTRIES) {
    remaining.sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
    const toRemove = remaining.length - MAX_ENTRIES;
    for (let i = 0; i < toRemove; i++) {
      delete cache[remaining[i][0]];
      evicted++;
    }
  }

  if (evicted > 0) { _dirty = true; }
  return evicted;
}

/**
 * Get a cached verdict by content hash.
 * Returns the verdict object or null if not cached / expired.
 */
function getCache(hash) {
  const cache = _loadCache();
  const entry = cache[hash];
  if (!entry) { return null; }
  if (Date.now() - (entry.at ?? 0) > MAX_AGE_MS) {
    delete cache[hash];
    _dirty = true;
    return null;
  }
  entry.hits = (entry.hits ?? 0) + 1;
  _dirty = true;
  return entry.verdict;
}

/**
 * Store a verdict in the cache.
 */
function setCache(hash, verdict) {
  const cache = _loadCache();
  cache[hash] = {
    verdict,
    at: Date.now(),
    hits: 0,
  };
  _dirty = true;

  // Periodic eviction (every 100 writes)
  if (Object.keys(cache).length % 100 === 0) {
    _evict();
  }
}

/**
 * Flush the cache to disk. Call at end of test run.
 */
function flushCache() {
  _evict();
  _saveCache();
}

/**
 * Get cache stats.
 */
function getCacheStats() {
  const cache = _loadCache();
  const entries = Object.values(cache);
  const totalHits = entries.reduce((sum, e) => sum + (e.hits ?? 0), 0);
  return {
    entries: entries.length,
    totalHits,
    oldestMs: entries.length > 0
      ? Date.now() - Math.min(...entries.map((e) => e.at ?? Date.now()))
      : 0,
  };
}

/**
 * Clear the entire cache.
 */
function clearCache() {
  _cache = {};
  _dirty = true;
  _saveCache();
}

module.exports = {
  computeContentHash,
  getCache,
  setCache,
  flushCache,
  getCacheStats,
  clearCache,
};
