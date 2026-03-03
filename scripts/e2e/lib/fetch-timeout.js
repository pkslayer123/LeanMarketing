/**
 * Fetch with Timeout & Retry
 *
 * Wraps native fetch with:
 * - Configurable request timeout (default 30s)
 * - Retry with exponential backoff on transient errors (429, 503, 5xx, network)
 * - Circuit breaker per-host (trips after N consecutive failures)
 *
 * Usage:
 *   const { fetchWithTimeout } = require("./lib/fetch-timeout");
 *   const res = await fetchWithTimeout(url, { timeout: 10000, retries: 3 });
 */

const DEFAULTS = {
  timeout: 30000,
  retries: 3,
  retryBaseMs: 1000,
  retryOn429Ms: 60000,
};

// Per-host circuit breaker state
const hostCircuits = new Map();
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 300000; // 5 min

function getHost(url) {
  try { return new URL(url).host; } catch { return "unknown"; }
}

function isCircuitOpen(host) {
  const circuit = hostCircuits.get(host);
  if (!circuit) { return false; }
  if (circuit.failures >= CIRCUIT_THRESHOLD) {
    if (Date.now() - circuit.lastFailure > CIRCUIT_RESET_MS) {
      // Half-open: allow one request through
      circuit.failures = Math.floor(circuit.failures / 2);
      return false;
    }
    return true;
  }
  return false;
}

function recordSuccess(host) {
  hostCircuits.set(host, { failures: 0, lastFailure: 0 });
}

function recordFailure(host) {
  const circuit = hostCircuits.get(host) ?? { failures: 0, lastFailure: 0 };
  circuit.failures++;
  circuit.lastFailure = Date.now();
  hostCircuits.set(host, circuit);
}

function isRetryable(status, errMsg) {
  if (status === 429 || status === 503) { return true; }
  if (status >= 500) { return true; }
  const msg = (errMsg ?? "").toLowerCase();
  if (msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("econnrefused")) { return true; }
  if (msg.includes("fetch failed") || msg.includes("network") || msg.includes("socket")) { return true; }
  if (msg.includes("aborted") || msg.includes("timeout")) { return true; }
  return false;
}

/**
 * Fetch with timeout, retry, and circuit breaker.
 *
 * @param {string} url
 * @param {RequestInit & { timeout?: number, retries?: number, retryBaseMs?: number }} opts
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, opts = {}) {
  const timeout = opts.timeout ?? DEFAULTS.timeout;
  const retries = opts.retries ?? DEFAULTS.retries;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULTS.retryBaseMs;
  const host = getHost(url);

  // Circuit breaker check
  if (isCircuitOpen(host)) {
    throw new Error(`Circuit breaker open for ${host} — ${CIRCUIT_THRESHOLD} consecutive failures`);
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const res = await fetch(url, {
        ...opts,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.ok || !isRetryable(res.status, "")) {
        recordSuccess(host);
        return res;
      }

      // Retryable HTTP error
      lastError = new Error(`HTTP ${res.status}`);
      lastError.status = res.status;

      if (attempt < retries) {
        const delay = res.status === 429
          ? (opts.retryOn429Ms ?? DEFAULTS.retryOn429Ms)
          : retryBaseMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (err) {
      lastError = err;
      if (attempt < retries && isRetryable(0, err.message)) {
        const delay = retryBaseMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      } else if (!isRetryable(0, err.message)) {
        recordFailure(host);
        throw err;
      }
    }
  }

  recordFailure(host);
  throw lastError;
}

/**
 * Reset circuit breaker for a host (e.g., after deploy).
 */
function resetCircuit(host) {
  hostCircuits.delete(host);
}

/**
 * Reset all circuit breakers.
 */
function resetAllCircuits() {
  hostCircuits.clear();
}

/**
 * Get circuit breaker status for all hosts.
 */
function getCircuitStatus() {
  const status = {};
  for (const [host, circuit] of hostCircuits) {
    status[host] = {
      failures: circuit.failures,
      open: circuit.failures >= CIRCUIT_THRESHOLD,
      lastFailure: circuit.lastFailure ? new Date(circuit.lastFailure).toISOString() : null,
    };
  }
  return status;
}

module.exports = {
  fetchWithTimeout,
  resetCircuit,
  resetAllCircuits,
  getCircuitStatus,
  CIRCUIT_THRESHOLD,
};
