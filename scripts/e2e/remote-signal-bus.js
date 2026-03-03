#!/usr/bin/env node
/**
 * RemoteSignalBus — Unified signal routing for local and multi-machine daemon operation.
 *
 * When CHANGEPILOT_SERVICE_KEY is set, signals route through the ChangePilot API
 * so two machines can coordinate. Otherwise falls back to the local claw-signals.json
 * filesystem (existing behavior, zero overhead).
 *
 * This is a drop-in wrapper — claw.js delegates emitSignal/consumeSignals through it.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

try { require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") }); } catch { /* no dotenv */ }

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");

const CHANGEPILOT_API_URL = process.env.CHANGEPILOT_API_URL ?? "https://moc-ai.vercel.app";
const CHANGEPILOT_SERVICE_KEY = process.env.CHANGEPILOT_SERVICE_KEY;
const MACHINE_ID = `${os.hostname()}-${os.userInfo().username}`;

class RemoteSignalBus {
  constructor() {
    this.remote = Boolean(CHANGEPILOT_SERVICE_KEY);
    this.headers = CHANGEPILOT_SERVICE_KEY
      ? { "Authorization": `Bearer ${CHANGEPILOT_SERVICE_KEY}`, "Content-Type": "application/json" }
      : {};
    this._pendingRemoteSignals = [];
    this._lastPollAt = 0;
    this._pollIntervalMs = 15000;
  }

  get isNetworkMode() { return this.remote; }

  /**
   * Emit a signal. In network mode, sends to both local file AND remote API.
   * Local write ensures same-machine claws react immediately;
   * remote write ensures cross-machine claws see it.
   */
  async emitSignal(name, data, localWriter) {
    localWriter(name, data);

    if (!this.remote) { return; }

    try {
      await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/signal`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ signal: name, payload: { ...data, machine_id: MACHINE_ID } }),
      });
    } catch {
      // Non-fatal — local signal still works
    }
  }

  /**
   * Poll for remote signals from other machines.
   * Returns array of { signal, from, payload, sent_at }.
   * Called during shouldRun() checks.
   */
  async pollRemoteSignals() {
    if (!this.remote) { return []; }

    const now = Date.now();
    if (now - this._lastPollAt < this._pollIntervalMs) {
      return this._pendingRemoteSignals;
    }
    this._lastPollAt = now;

    try {
      const res = await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/signal`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ signal: "heartbeat-poll", payload: { machine_id: MACHINE_ID, poll: true } }),
      });

      if (res.ok) {
        const data = await res.json();
        this._pendingRemoteSignals = data.pending_signals ?? [];
        return this._pendingRemoteSignals;
      }
    } catch { /* non-fatal */ }

    return this._pendingRemoteSignals;
  }

  /**
   * Check if a specific signal was received from a remote machine.
   * Used by shouldRun() to trigger on cross-machine signals.
   */
  hasRemoteSignal(signalName, afterTimestamp) {
    for (const sig of this._pendingRemoteSignals) {
      if (sig.signal === signalName) {
        if (!afterTimestamp || new Date(sig.sent_at) > new Date(afterTimestamp)) {
          return sig;
        }
      }
    }
    return null;
  }

  /**
   * Report token exhaustion to the network.
   * Other machines can pick up work this machine can't do.
   */
  async reportTokenExhaustion(provider, rateLimitedUntil) {
    if (!this.remote) { return; }

    try {
      await Promise.all([
        fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/signal`, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({
            signal: "tokens-exhausted",
            payload: { provider, rate_limited_until: rateLimitedUntil, machine_id: MACHINE_ID },
          }),
        }),
        fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/budget`, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({
            updates: [{ provider, rate_limited_until: rateLimitedUntil }],
          }),
        }),
      ]);
    } catch { /* non-fatal */ }
  }

  /**
   * Report token recovery.
   */
  async reportTokenAvailable(provider) {
    if (!this.remote) { return; }

    try {
      await Promise.all([
        fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/signal`, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({
            signal: "tokens-available",
            payload: { provider, machine_id: MACHINE_ID },
          }),
        }),
        fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/budget`, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({
            updates: [{ provider, rate_limited_until: null }],
          }),
        }),
      ]);
    } catch { /* non-fatal */ }
  }

  /**
   * Request claw migration — ask another machine to pick up specific claws.
   */
  async requestClawMigration(clawNames, reason) {
    if (!this.remote) { return; }

    try {
      await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/signal`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          signal: "claw-migration",
          payload: { claws: clawNames, reason, machine_id: MACHINE_ID },
        }),
      });
    } catch { /* non-fatal */ }
  }

  /**
   * Check network budget: which providers are available on which machines.
   */
  async getNetworkBudgetStatus() {
    if (!this.remote) { return null; }

    try {
      const res = await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/budget`, {
        method: "GET",
        headers: this.headers,
      });
      if (res.ok) {
        return res.json();
      }
    } catch { /* non-fatal */ }
    return null;
  }

  /**
   * Send heartbeat with CPU load for load-shedding decisions.
   */
  async heartbeat(status, convergenceState, metadata = {}) {
    if (!this.remote) { return null; }

    try {
      const loadAvg = os.loadavg();
      const cpuCount = os.cpus().length;
      const res = await fetch(`${CHANGEPILOT_API_URL}/api/daemon-network/heartbeat`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          machine_id: MACHINE_ID,
          status,
          convergence_state: convergenceState ?? "unknown",
          metadata: {
            ...metadata,
            cpu_load_1m: loadAvg[0] / cpuCount,
            cpu_load_5m: loadAvg[1] / cpuCount,
            cpu_count: cpuCount,
            platform: os.platform(),
          },
        }),
      });
      if (res.ok) { return res.json(); }
    } catch { /* non-fatal */ }
    return null;
  }
}

const VALID_NETWORK_SIGNALS = [
  "tokens-exhausted", "tokens-available",
  "fix-available", "fix-needed",
  "convergence-reached", "divergence-detected",
  "learning-published", "spec-updated",
  "deploy-detected", "claw-migration",
  "takeover-requested", "load-shedding",
  "heartbeat-poll",
];

const instance = new RemoteSignalBus();

module.exports = { RemoteSignalBus, instance, MACHINE_ID, VALID_NETWORK_SIGNALS };
