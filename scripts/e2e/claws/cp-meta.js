#!/usr/bin/env node

/**
 * cp-meta claw (external project version)
 *
 * Pushes MOCs to ChangePilot via API instead of Playwright UI navigation.
 * Each external project has its own ChangePilot organization.
 *
 * In ChangePilot itself, the cp-meta claw uses Playwright to advance MOCs through
 * the 6-stage workflow. For external projects, we use the API instead since the
 * external project doesn't have direct access to the ChangePilot UI.
 *
 * Schedule: Triggered by mocs-ready or build-complete signal, or periodic (30min).
 * Reads: moc-queue.json
 * Writes: moc-queue.json (status updates)
 * Emits: mocs-pushed signal
 */

const path = require("path");
const fs = require("fs");
const { Claw } = require("../claw");

function findProjectRoot() {
  let dir = path.resolve(__dirname, "..", "..", "..");
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "persona-engine.json")) || fs.existsSync(path.join(dir, "daemon-config.json")) || fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, "..", "..", "..");
}
const ROOT = findProjectRoot();

class CpMetaClaw extends Claw {
  constructor() {
    super("cp-meta");
    this.cpUrl = process.env.CHANGEPILOT_API_URL || "https://moc-ai.vercel.app";
    this.serviceKey = process.env.CHANGEPILOT_SERVICE_KEY;
  }

  async run() {
    if (!this.serviceKey) {
      return { ok: true, summary: "no service key — standalone mode" };
    }

    const queue = this.readState("moc-queue.json");
    if (!queue?.mocs?.length) {
      return { ok: true, summary: "no MOCs to push" };
    }

    let pushed = 0;
    let errors = 0;

    for (const moc of queue.mocs) {
      if (moc.pushed) { continue; }

      try {
        const res = await fetch(`${this.cpUrl}/api/mocs/external`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: moc.title,
            description: moc.description,
            classification: moc.classification,
            findings: moc.findings,
            source: "persona-engine",
          }),
        });

        if (res.ok) {
          moc.pushed = true;
          moc.pushedAt = new Date().toISOString();
          pushed++;
        } else {
          errors++;
          this.log(`MOC push failed (${res.status}): ${moc.title}`);
        }
      } catch (err) {
        errors++;
        this.log(`MOC push error: ${err.message}`);
      }
    }

    // Save updated queue
    this.writeState("moc-queue.json", queue);

    if (pushed > 0) {
      this.emitSignal("mocs-pushed", { count: pushed });
    }

    return { ok: errors === 0, summary: `pushed ${pushed} MOCs, ${errors} errors` };
  }
}

const claw = new CpMetaClaw();
claw.start();
