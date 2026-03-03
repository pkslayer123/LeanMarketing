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
    // Load orgKey from persona-engine.json
    try {
      const pe = JSON.parse(fs.readFileSync(path.join(ROOT, "persona-engine.json"), "utf-8"));
      this.orgKey = pe.changepilot?.orgKey;
      if (!this.cpUrl || this.cpUrl === "https://moc-ai.vercel.app") {
        this.cpUrl = pe.changepilot?.url || this.cpUrl;
      }
    } catch { /* ignore */ }
  }

  async run() {
    if (!this.serviceKey) {
      return { ok: true, summary: "no service key — standalone mode" };
    }
    if (!this.orgKey) {
      return { ok: true, summary: "no orgKey — standalone mode" };
    }

    const queue = this.readState("moc-queue.json");
    if (!queue?.mocs?.length) {
      return { ok: true, summary: "no MOCs to push" };
    }

    // Collect unpushed MOCs
    const unpushed = queue.mocs.filter((m) => !m.pushed);
    if (unpushed.length === 0) {
      return { ok: true, summary: "all MOCs already pushed" };
    }

    // Map to API format and batch (max 50 per request)
    const batches = [];
    for (let i = 0; i < unpushed.length; i += 50) {
      batches.push(unpushed.slice(i, i + 50));
    }

    let pushed = 0;
    let errors = 0;

    for (const batch of batches) {
      try {
        const apiMocs = batch.map((moc) => ({
          title: moc.title,
          description: moc.description || moc.summary || "",
          tier: this._classificationToTier(moc.classification),
          severity: moc.severity,
          page: moc.page,
          persona: moc.persona,
          findingIds: moc.findings?.map((f) => f.id || f) || [],
          iteration: moc.iteration,
        }));

        const res = await fetch(`${this.cpUrl}/api/mocs/external`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            orgKey: this.orgKey,
            mocs: apiMocs,
          }),
        });

        if (res.ok) {
          const result = await res.json();
          this.log(`pushed ${result.created} MOCs to ChangePilot`);
          for (const moc of batch) {
            moc.pushed = true;
            moc.pushedAt = new Date().toISOString();
          }
          pushed += result.created;
          if (result.errors?.length > 0) {
            errors += result.errors.length;
            for (const err of result.errors) {
              this.log(`MOC push warning: ${err}`);
            }
          }
        } else {
          const errBody = await res.text().catch(() => "");
          errors += batch.length;
          this.log(`MOC batch push failed (${res.status}): ${errBody.slice(0, 200)}`);
        }
      } catch (err) {
        errors += batch.length;
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

  _classificationToTier(classification) {
    // Map daemon classification to ChangePilot API tier
    if (!classification) return "needs_approval";
    const c = classification.toLowerCase();
    if (c === "auto_fix" || c === "autofix") return "auto_fix";
    if (c === "auto_approve" || c === "autoapprove") return "auto_approve";
    return "needs_approval";
  }
}

const claw = new CpMetaClaw();
claw.start();
