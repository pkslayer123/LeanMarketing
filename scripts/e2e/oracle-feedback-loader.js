#!/usr/bin/env node

/**
 * oracle-feedback-loader.js — Extract persona+page+textSnippet patterns from oracle-feedback.jsonl.
 *
 * Used to feed "Recent false positives (avoid flagging)" into oracle prompts.
 * Reads last 500 entries, outputs a JSON or text block for prompt injection.
 *
 * Usage:
 *   node scripts/e2e/oracle-feedback-loader.js           # Output JSON (default)
 *   node scripts/e2e/oracle-feedback-loader.js --text    # Output text block for prompt
 *   node scripts/e2e/oracle-feedback-loader.js --limit 200
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FEEDBACK_PATH = path.join(ROOT, "e2e", "state", "oracle-feedback.jsonl");
const OUTPUT_PATH = path.join(ROOT, "e2e", "state", "oracle-feedback-patterns.json");

const args = process.argv.slice(2);
const textOutput = args.includes("--text");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 500;

function main() {
  if (!fs.existsSync(FEEDBACK_PATH)) {
    const empty = { patterns: [], generatedAt: new Date().toISOString() };
    if (textOutput) {
      console.log("");
    } else {
      const dir = path.dirname(OUTPUT_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(empty, null, 2) + "\n");
    }
    return;
  }

  const lines = fs.readFileSync(FEEDBACK_PATH, "utf-8").trim().split("\n").filter(Boolean);
  const entries = [];
  for (let i = Math.max(0, lines.length - LIMIT); i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      entries.push(parsed);
    } catch {
      // skip malformed
    }
  }

  const patterns = [];
  const seen = new Set();
  for (const e of entries) {
    const persona = (e.persona ?? "?").toString();
    const page = (e.page ?? "?").toString();
    const snippet = (e.textSnippet ?? "").toString().slice(0, 120);
    const reason = (e.reason ?? "").toString().slice(0, 80);
    const key = `${persona}::${page}::${snippet.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push({ persona, page, textSnippet: snippet, reason });
  }

  const result = {
    patterns,
    generatedAt: new Date().toISOString(),
    sourceEntries: entries.length,
  };

  if (textOutput) {
    const lines = [
      "Recent false positives (avoid flagging):",
      "",
      ...patterns.slice(-30).map((p) => `- [${p.persona}] ${p.page}: "${p.textSnippet}" — ${p.reason}`),
      "",
    ];
    console.log(lines.join("\n"));
    return;
  }

  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + "\n");
}

main();
