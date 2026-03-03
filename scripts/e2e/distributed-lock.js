#!/usr/bin/env node
/**
 * DistributedLock — Multi-machine lock coordination via Supabase RPCs.
 *
 * Falls back to local filesystem locks when not in network mode (CHANGEPILOT_SERVICE_KEY unset).
 * This ensures zero overhead for single-machine operation.
 */

const fs = require("fs");
const path = require("path");

try { require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") }); } catch {}

const { MACHINE_ID } = require("./remote-signal-bus");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USE_REMOTE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY && process.env.CHANGEPILOT_SERVICE_KEY);

const STATE_DIR = path.join(__dirname, "..", "..", "e2e", "state");

class DistributedLock {
  /**
   * Acquire a distributed lock.
   * @param {string} lockKey - Unique identifier (e.g., "git-commit", "moc-fix:uuid")
   * @param {string} clawName - Claw requesting the lock
   * @param {number} ttlSeconds - Lock TTL (default 30 minutes)
   * @returns {Promise<boolean>} true if acquired
   */
  static async acquire(lockKey, clawName, ttlSeconds = 1800) {
    if (!USE_REMOTE) {
      return DistributedLock._acquireLocal(lockKey);
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/acquire_distributed_lock`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_lock_key: lockKey,
          p_holder_machine: MACHINE_ID,
          p_holder_claw: clawName,
          p_ttl_seconds: ttlSeconds,
        }),
      });

      if (res.ok) {
        const result = await res.json();
        return result === true;
      }
    } catch {
      // Remote unavailable — fall back to local
    }

    return DistributedLock._acquireLocal(lockKey);
  }

  /**
   * Release a distributed lock.
   * @param {string} lockKey
   * @returns {Promise<boolean>}
   */
  static async release(lockKey) {
    if (!USE_REMOTE) {
      return DistributedLock._releaseLocal(lockKey);
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/release_distributed_lock`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_lock_key: lockKey,
          p_holder_machine: MACHINE_ID,
        }),
      });

      if (res.ok) {
        return true;
      }
    } catch {
      // Fall back to local release
    }

    return DistributedLock._releaseLocal(lockKey);
  }

  /**
   * Claim a MOC for processing (distributed-safe).
   * @param {string} mocId - MOC ID
   * @param {string} clawName - Claiming claw
   * @param {number} leaseMins - Lease duration in minutes (default 30)
   * @returns {Promise<boolean>}
   */
  static async claimMoc(mocId, clawName, leaseMins = 30) {
    return DistributedLock.acquire(`moc-fix:${mocId}`, clawName, leaseMins * 60);
  }

  /**
   * Release a MOC claim.
   * @param {string} mocId
   * @returns {Promise<boolean>}
   */
  static async releaseMoc(mocId) {
    return DistributedLock.release(`moc-fix:${mocId}`);
  }

  // --- Local filesystem fallback ---

  static _acquireLocal(lockKey) {
    const lockPath = path.join(STATE_DIR, `.lock-${lockKey.replace(/[/:]/g, "_")}`);
    const lockData = JSON.stringify({ pid: process.pid, machine: MACHINE_ID, at: new Date().toISOString() });

    try {
      fs.writeFileSync(lockPath, lockData, { flag: "wx" });
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const existing = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
          const lockAge = Date.now() - new Date(existing.at).getTime();

          // Lease expiry: locks older than 45min are expired (covers max MOC fix time)
          if (lockAge > 45 * 60 * 1000) {
            try { fs.unlinkSync(lockPath); } catch {}
            fs.writeFileSync(lockPath, lockData, { flag: "wx" });
            return true;
          }

          // PID check: if holder process is dead, reclaim lock immediately
          if (existing.pid && existing.machine === MACHINE_ID) {
            let holderAlive = false;
            try { process.kill(existing.pid, 0); holderAlive = true; } catch {}
            if (!holderAlive) {
              try { fs.unlinkSync(lockPath); } catch {}
              fs.writeFileSync(lockPath, lockData, { flag: "wx" });
              return true;
            }
          }

          // Short lock age (< 60s) for non-MOC locks: fast expiry
          if (!lockKey.startsWith("moc-fix:") && lockAge > 60000) {
            try { fs.unlinkSync(lockPath); } catch {}
            fs.writeFileSync(lockPath, lockData, { flag: "wx" });
            return true;
          }
        } catch {
          try { fs.unlinkSync(lockPath); } catch {}
          return false;
        }
        return false;
      }
      return false;
    }
  }

  static _releaseLocal(lockKey) {
    const lockPath = path.join(STATE_DIR, `.lock-${lockKey.replace(/[/:]/g, "_")}`);
    try { fs.unlinkSync(lockPath); return true; } catch { return false; }
  }
}

module.exports = { DistributedLock };
