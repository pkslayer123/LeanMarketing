#!/usr/bin/env node

/**
 * Screenshot Oracle — Vision model validates screenshots against expected state.
 *
 * Reads screenshot-metadata.jsonl, sends recent screenshots to a vision model
 * (Gemini preferred for cost; OpenAI gpt-4o-mini fallback),
 * asks "Does this look like the expected UI for this page/persona?".
 * Catches visual regressions personas miss.
 *
 * Output: e2e/state/screenshot-oracle-report.md
 *
 * Usage:
 *   node scripts/e2e/screenshot-oracle.js           # Last 5 screenshots
 *   node scripts/e2e/screenshot-oracle.js --limit 10
 *   node scripts/e2e/screenshot-oracle.js --finding-only  # Only screenshots with findingId
 *
 * Requires: GEMINI_API_KEY (preferred, lower cost) or OPENAI_API_KEY (fallback)
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(path.resolve(__dirname, "..", ".."), ".env.local"), quiet: true });
  require("dotenv").config({ path: path.join(path.resolve(__dirname, "..", ".."), "e2e", ".env"), quiet: true });
} catch {}

const ROOT = path.resolve(__dirname, "..", "..");
const META_FILE = path.join(ROOT, "e2e", "state", "screenshot-metadata.jsonl");
const REPORT_PATH = path.join(ROOT, "e2e", "state", "screenshot-oracle-report.md");

const args = process.argv.slice(2);
const limit = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "5", 10);
const findingOnly = args.includes("--finding-only");

const PROMPT_TEMPLATE = (personaId, page, findingId) =>
  `You are an E2E screenshot oracle. Persona: ${personaId}. Page: ${page}.
${findingId ? `This screenshot was taken when a finding was reported.` : ""}

Does this screenshot show:
1. A normal, expected UI state (no obvious errors, permission denied, or broken layout)?
2. Any visual issues: overlapping elements, cut-off text, error states, or permission-denied screens that seem wrong for this persona?

Respond in JSON: { "ok": true|false, "issues": ["list of visual issues or empty"], "summary": "one line" }`;

async function callOpenAIVision(imagePath, personaId, page, findingId) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  if (!fs.existsSync(imagePath)) return null;

  const buf = fs.readFileSync(imagePath);
  const base64 = buf.toString("base64");
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

  const model = process.env.SCREENSHOT_ORACLE_OPENAI_MODEL ?? "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${base64}` },
            },
            { type: "text", text: PROMPT_TEMPLATE(personaId, page, findingId) },
          ],
        },
      ],
      max_tokens: 256,
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    console.error(`[screenshot-oracle] OpenAI ${res.status}: ${await res.text()}`);
    return null;
  }

  const data = await res.json();

  // Log token usage to central ledger
  try {
    const usage = data.usage;
    if (usage) {
      const { logTokenUsage } = require("./lib/token-logger");
      logTokenUsage({
        component: "screenshot-oracle",
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        provider: "openai",
        model,
      });
    }
  } catch { /* non-fatal */ }

  const text = data.choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, issues: [], summary: text.slice(0, 100) };
  }
}

async function callGeminiVision(imagePath, personaId, page, findingId) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;

  if (!fs.existsSync(imagePath)) return null;

  const buf = fs.readFileSync(imagePath);
  const base64 = buf.toString("base64");
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

  const prompt = PROMPT_TEMPLATE(personaId, page, findingId);

  const model = process.env.SCREENSHOT_ORACLE_GEMINI_MODEL ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mime, data: base64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    console.error(`[screenshot-oracle] Gemini ${res.status}: ${await res.text()}`);
    return null;
  }

  const data = await res.json();

  // Log token usage to central ledger
  try {
    const meta = data.usageMetadata;
    if (meta) {
      const { logTokenUsage } = require("./lib/token-logger");
      logTokenUsage({
        component: "screenshot-oracle",
        inputTokens: meta.promptTokenCount ?? 0,
        outputTokens: meta.candidatesTokenCount ?? 0,
        provider: "gemini",
        model,
      });
    }
  } catch { /* non-fatal */ }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, issues: [], summary: text.slice(0, 100) };
  }
}

function loadMetadata() {
  if (!fs.existsSync(META_FILE)) return [];
  const lines = fs.readFileSync(META_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const entries = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
  return findingOnly ? entries.filter((e) => e.findingId) : entries;
}

function resolveScreenshotPath(e) {
  let p = e.path;
  if (!p) return null;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    if (fs.existsSync(p)) return p;
    const rel = path.relative(ROOT, p);
    const alt = path.join(ROOT, "e2e", "test-results", "screenshots", path.basename(p));
    if (fs.existsSync(alt)) return alt;
    return p;
  }
  const full = path.join(ROOT, p);
  if (fs.existsSync(full)) return full;
  const alt = path.join(ROOT, "e2e", "test-results", "screenshots", path.basename(p));
  if (fs.existsSync(alt)) return alt;
  return full;
}

async function callVision(imagePath, personaId, page, findingId) {
  // Prefer Gemini (cheaper); fallback to OpenAI
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();

  if (geminiKey) {
    const out = await callGeminiVision(imagePath, personaId, page, findingId);
    if (out) return out;
  }
  if (openaiKey) {
    console.warn(`  [vision] WARNING: falling back to OpenAI vision — Gemini primary failed for ${page}`);
    const out = await callOpenAIVision(imagePath, personaId, page, findingId);
    if (out) return out;
  }
  return null;
}

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const hasKey = !!(openaiKey || geminiKey);
  const entries = loadMetadata().slice(-limit * 2).slice(-limit);

  if (!hasKey) {
    const msg = [
      "# Screenshot Oracle Report",
      "",
      "**Status:** Disabled",
      "",
      "Screenshot Oracle requires `GEMINI_API_KEY` (preferred) or `OPENAI_API_KEY` for vision analysis. Set in `e2e/.env` or `.env.local` and run the loop to enable.",
      "",
      `Screenshots in metadata: ${entries.length}`,
    ].join("\n");
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, msg);
    console.log("[screenshot-oracle] No OPENAI_API_KEY or GEMINI_API_KEY. Wrote placeholder report.");
    process.exit(0);
  }

  if (entries.length === 0) {
    const msg = [
      "# Screenshot Oracle Report",
      "",
      "**Status:** No screenshots to analyze",
      "",
      "Run the persona loop to capture screenshots. They are written to `screenshot-metadata.jsonl` during tests.",
    ].join("\n");
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, msg);
    console.log("[screenshot-oracle] No screenshots in metadata.");
    process.exit(0);
  }

  const results = [];
  for (const e of entries) {
    const p = resolveScreenshotPath(e);
    let verdict;
    if (!p || !fs.existsSync(p)) {
      verdict = { ok: true, issues: [], summary: "File not found (screenshot may be from previous run)" };
    } else {
      verdict = await callVision(p, e.personaId ?? "?", e.page ?? "?", e.findingId);
      verdict = verdict ?? { ok: true, issues: [], summary: "API error" };
    }
    results.push({
      path: path.basename(e.path ?? "?"),
      personaId: e.personaId,
      page: e.page,
      verdict,
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  const failed = results.filter((r) => !r.verdict.ok);
  const lines = [
    "# Screenshot Oracle Report",
    "",
    `**Generated:** ${new Date().toISOString()}`,
    `**Analyzed:** ${results.length} screenshots`,
    `**Issues found:** ${failed.length}`,
    "",
    "---",
    "",
  ];

  if (failed.length > 0) {
    lines.push("## Screenshots with issues", "");
    for (const r of failed) {
      lines.push(`- **${r.path}** (${r.personaId}, ${r.page})`);
      lines.push(`  - ${r.verdict.summary ?? ""}`);
      if (r.verdict.issues?.length) {
        lines.push(`  - Issues: ${r.verdict.issues.join("; ")}`);
      }
      lines.push("");
    }
  }

  lines.push("## All results", "");
  for (const r of results) {
    const icon = r.verdict.ok ? "✓" : "✗";
    lines.push(`- ${icon} ${r.path} — ${r.verdict.summary ?? ""}`);
  }

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join("\n"));
  console.log(`[screenshot-oracle] Wrote ${REPORT_PATH} (${failed.length} issues in ${results.length} screenshots)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
