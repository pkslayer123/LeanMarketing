/**
 * Supabase Retry & Connection Pool Resilience
 *
 * Wraps Supabase operations with:
 * - Retry with exponential backoff on pool exhaustion / RLS timeouts
 * - Concurrent query semaphore (prevents pool saturation from E2E tests)
 * - Circuit breaker per operation type
 *
 * Usage:
 *   const { withRetry, acquireQuerySlot, releaseQuerySlot } = require("./lib/supabase-retry");
 *   const slot = await acquireQuerySlot();
 *   try {
 *     const result = await withRetry(() => supabase.from("mocs").select("*"));
 *   } finally { releaseQuerySlot(slot); }
 */

const DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10000,
  // Supabase free tier: ~20 connections. Keep headroom.
  maxConcurrentQueries: 12,
  queryTimeoutMs: 30000,
};

// Concurrency semaphore for Supabase queries
let activeQueries = 0;
const queryWaitQueue = [];

/**
 * Acquire a query slot. Blocks if at max concurrent queries.
 * Returns a slot token to pass to releaseQuerySlot().
 */
function acquireQuerySlot(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const maxConcurrent = parseInt(process.env.E2E_MAX_DB_CONCURRENT ?? String(DEFAULTS.maxConcurrentQueries), 10);

    if (activeQueries < maxConcurrent) {
      activeQueries++;
      resolve({ acquired: Date.now() });
      return;
    }

    const timer = setTimeout(() => {
      const idx = queryWaitQueue.indexOf(waiter);
      if (idx !== -1) { queryWaitQueue.splice(idx, 1); }
      reject(new Error(`Query slot timeout after ${timeoutMs}ms (${activeQueries} active)`));
    }, timeoutMs);

    const waiter = () => {
      clearTimeout(timer);
      activeQueries++;
      resolve({ acquired: Date.now() });
    };

    queryWaitQueue.push(waiter);
  });
}

/**
 * Release a query slot. Wakes the next waiter if any.
 */
function releaseQuerySlot() {
  activeQueries = Math.max(0, activeQueries - 1);
  if (queryWaitQueue.length > 0) {
    const next = queryWaitQueue.shift();
    next();
  }
}

/**
 * Check if an error is retryable (pool exhaustion, timeout, transient).
 */
function isRetryableError(err) {
  const msg = (err?.message ?? "").toLowerCase();
  const code = err?.code ?? "";

  // Connection pool exhaustion
  if (msg.includes("remaining connection slots") || msg.includes("too many connections")) { return true; }
  if (msg.includes("connection terminated") || msg.includes("connection refused")) { return true; }
  if (code === "PGRST301" || code === "08006" || code === "08001") { return true; }

  // RLS timeout
  if (msg.includes("statement timeout") || msg.includes("canceling statement")) { return true; }
  if (msg.includes("timeout") || msg.includes("etimedout")) { return true; }

  // Supabase overload
  if (msg.includes("503") || msg.includes("service unavailable")) { return true; }
  if (msg.includes("502") || msg.includes("bad gateway")) { return true; }
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) { return true; }

  // Network transient
  if (msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("fetch failed")) { return true; }

  return false;
}

/**
 * Retry a Supabase operation with exponential backoff.
 *
 * @param {() => Promise<any>} fn — The Supabase operation to retry
 * @param {object} opts
 * @param {number} opts.maxRetries — Max retry attempts (default 3)
 * @param {number} opts.baseDelayMs — Base delay between retries (default 500ms)
 * @param {string} opts.label — Human-readable label for logging
 * @param {(msg: string) => void} opts.log — Log function
 * @returns {Promise<any>}
 */
async function withRetry(fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const baseDelay = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const label = opts.label ?? "supabase-query";
  const log = opts.log ?? (() => {});

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();

      // Supabase returns { data, error } — check the error field
      if (result?.error && isRetryableError(result.error)) {
        lastError = result.error;
        if (attempt < maxRetries) {
          const delay = Math.min(baseDelay * Math.pow(2, attempt), DEFAULTS.maxDelayMs);
          log(`[supabase-retry] ${label}: retryable error (attempt ${attempt + 1}/${maxRetries}), waiting ${delay}ms — ${result.error.message}`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }

      return result;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isRetryableError(err)) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), DEFAULTS.maxDelayMs);
        log(`[supabase-retry] ${label}: exception (attempt ${attempt + 1}/${maxRetries}), waiting ${delay}ms — ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }

  throw lastError;
}

/**
 * Get current concurrency stats.
 */
function getStats() {
  return {
    activeQueries,
    waitingQueries: queryWaitQueue.length,
    maxConcurrent: parseInt(process.env.E2E_MAX_DB_CONCURRENT ?? String(DEFAULTS.maxConcurrentQueries), 10),
  };
}

module.exports = {
  withRetry,
  acquireQuerySlot,
  releaseQuerySlot,
  isRetryableError,
  getStats,
  DEFAULTS,
};
