#!/usr/bin/env node

/**
 * Shared Notification Module
 *
 * Dispatches messages via Slack, email (Resend), generic webhook, and local file.
 * Used by diagnostics claw, watchdog, and health heartbeat.
 *
 * Env vars:
 *   E2E_NOTIFY_SLACK_WEBHOOK — Slack incoming webhook URL
 *   E2E_NOTIFY_EMAIL         — Comma-separated emails (requires RESEND_API_KEY)
 *   RESEND_API_KEY            — Resend API key for email delivery
 *   RESEND_FROM               — From address (default: daemon@notifications.local)
 *   E2E_NOTIFY_WEBHOOK       — Generic POST URL; receives JSON body
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Project root detection — walks up from __dirname looking for config files
// ---------------------------------------------------------------------------

function findProjectRoot() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (
      fs.existsSync(path.join(dir, "persona-engine.json")) ||
      fs.existsSync(path.join(dir, "daemon-config.json")) ||
      fs.existsSync(path.join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return path.resolve(__dirname, "..", "..");
}

const ROOT = findProjectRoot();
const STATE_DIR = path.join(ROOT, "e2e", "state");
const NOTIFICATIONS_PATH = path.join(STATE_DIR, "daemon-notifications.json");

// Load env vars if dotenv available
try {
  require("dotenv").config({ path: path.join(ROOT, ".env.local"), quiet: true });
  require("dotenv").config({ path: path.join(ROOT, "e2e", ".env"), quiet: true });
} catch {
  // dotenv not installed — env vars must be set externally
}

/**
 * Send a message to a Slack incoming webhook.
 * @param {string} webhookUrl — Slack incoming webhook URL
 * @param {string} message — Plain text message
 * @param {string} severity — "info" | "warning" | "critical"
 * @returns {Promise<boolean>}
 */
async function sendSlack(webhookUrl, message, severity = "info") {
  if (!webhookUrl) { return false; }
  const icon = severity === "critical" ? ":red_circle:" : severity === "warning" ? ":warning:" : ":white_check_mark:";
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${icon} *[Daemon]* ${message}`,
        blocks: [{
          type: "section",
          text: { type: "mrkdwn", text: `${icon} *Daemon ${severity.toUpperCase()}*\n${message}` },
        }],
      }),
    });
    return res.ok;
  } catch (err) {
    console.error(`[notify] Slack failed: ${err.message}`);
    return false;
  }
}

/**
 * Send an email via the Resend API.
 * @param {string} to — Comma-separated email addresses
 * @param {string} subject — Email subject
 * @param {string} body — Plain text body (will be wrapped in HTML)
 * @returns {Promise<boolean>}
 */
async function sendEmail(to, subject, body) {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!to || !key) { return false; }

  const emails = to.split(",").map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0) { return false; }

  const html = `<h3>${subject}</h3><pre>${body.replace(/</g, "&lt;")}</pre><p><small>Sent by daemon notification system</small></p>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? "daemon@notifications.local",
        to: emails,
        subject,
        html,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error(`[notify] Email failed: ${err.message}`);
    return false;
  }
}

/**
 * POST a JSON payload to a generic webhook URL.
 * @param {string} url — Webhook URL
 * @param {object} payload — JSON payload
 * @returns {Promise<boolean>}
 */
async function sendWebhook(url, payload) {
  if (!url) { return false; }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (err) {
    console.error(`[notify] Webhook failed: ${err.message}`);
    return false;
  }
}

/**
 * Write notification to the local file (always, regardless of channel config).
 * Dashboard reads this file to display recent notifications.
 */
function writeToFile(message, severity) {
  try {
    let notifications = [];
    if (fs.existsSync(NOTIFICATIONS_PATH)) {
      try {
        notifications = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, "utf-8"));
      } catch {
        notifications = [];
      }
    }
    notifications.push({
      message,
      severity,
      at: new Date().toISOString(),
    });
    // Keep last 100 notifications
    if (notifications.length > 100) {
      notifications = notifications.slice(-100);
    }
    const dir = path.dirname(NOTIFICATIONS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = NOTIFICATIONS_PATH + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(notifications, null, 2) + "\n");
    fs.renameSync(tmpPath, NOTIFICATIONS_PATH);
  } catch {
    // Non-fatal
  }
}

/**
 * Dispatch a notification to all configured channels + local file.
 * @param {string} message — Human-readable message
 * @param {"info"|"warning"|"critical"} severity
 */
async function notify(message, severity = "info") {
  // Always write to local file
  writeToFile(message, severity);

  const slackUrl = process.env.E2E_NOTIFY_SLACK_WEBHOOK?.trim();
  const emailTo = process.env.E2E_NOTIFY_EMAIL?.trim();
  const webhookUrl = process.env.E2E_NOTIFY_WEBHOOK?.trim();

  const subject = severity === "critical"
    ? "[Daemon] CRITICAL — action required"
    : severity === "warning"
      ? "[Daemon] Warning"
      : "[Daemon] Status update";

  const payload = {
    source: "daemon",
    severity,
    message,
    timestamp: new Date().toISOString(),
  };

  await Promise.allSettled([
    sendSlack(slackUrl, message, severity),
    sendEmail(emailTo, subject, message),
    sendWebhook(webhookUrl, payload),
  ]);
}

module.exports = { sendSlack, sendEmail, sendWebhook, notify, writeToFile, NOTIFICATIONS_PATH };
