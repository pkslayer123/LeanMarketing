/**
 * Token usage logger — central append-only log for all persona LLM calls.
 *
 * Enables visibility into token cost over time and per-component breakdown.
 * Used by: llm-e2e, Oracle (via token-budget), claude-cli wrappers, moc-auto-fix,
 * finding-synthesizer, consolidate-themes, root-cause, spec-decomposer, etc.
 *
 * Log format (JSONL): { ts, component, inputTokens, outputTokens, costUSD, provider?, model?, persona?, runId?, checkType? }
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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
const LOG_FILE = path.join(ROOT, "e2e", "state", "persona-token-usage.jsonl");

// ---------------------------------------------------------------------------
// Pricing tables (per token)
// ---------------------------------------------------------------------------

// OpenAI gpt-4o-mini
const OPENAI_INPUT = 0.15 / 1_000_000;
const OPENAI_OUTPUT = 0.6 / 1_000_000;

// Gemini Flash
const GEMINI_INPUT = 0.075 / 1_000_000;
const GEMINI_OUTPUT = 0.3 / 1_000_000;

// Gemini Flash Lite
const GEMINI_LITE_INPUT = 0.0375 / 1_000_000;
const GEMINI_LITE_OUTPUT = 0.15 / 1_000_000;

// Claude Opus
const CLAUDE_OPUS_INPUT = 15.0 / 1_000_000;
const CLAUDE_OPUS_OUTPUT = 75.0 / 1_000_000;

// Claude Sonnet
const CLAUDE_SONNET_INPUT = 3.0 / 1_000_000;
const CLAUDE_SONNET_OUTPUT = 15.0 / 1_000_000;

// Claude Haiku
const CLAUDE_HAIKU_INPUT = 0.25 / 1_000_000;
const CLAUDE_HAIKU_OUTPUT = 1.25 / 1_000_000;

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the cost of an LLM call based on token counts.
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} [provider="gemini"] - "openai" | "gemini" | "claude"
 * @param {string} [model=""] - Model name for granular pricing (e.g. "opus", "sonnet", "haiku", "flash-lite")
 * @returns {number} Estimated cost in USD
 */
function estimateCost(inputTokens, outputTokens, provider = "gemini", model = "") {
  // Model-based pricing takes priority
  if (model) {
    const m = model.toLowerCase();
    if (m.includes("opus")) {
      return inputTokens * CLAUDE_OPUS_INPUT + outputTokens * CLAUDE_OPUS_OUTPUT;
    }
    if (m.includes("sonnet")) {
      return inputTokens * CLAUDE_SONNET_INPUT + outputTokens * CLAUDE_SONNET_OUTPUT;
    }
    if (m.includes("haiku")) {
      return inputTokens * CLAUDE_HAIKU_INPUT + outputTokens * CLAUDE_HAIKU_OUTPUT;
    }
    if (m.includes("lite") || m.includes("flash-lite")) {
      return inputTokens * GEMINI_LITE_INPUT + outputTokens * GEMINI_LITE_OUTPUT;
    }
    if (m.includes("flash") || m.includes("gemini")) {
      return inputTokens * GEMINI_INPUT + outputTokens * GEMINI_OUTPUT;
    }
    if (m.includes("gpt") || m.includes("4o")) {
      return inputTokens * OPENAI_INPUT + outputTokens * OPENAI_OUTPUT;
    }
  }

  // Fall back to provider-based pricing
  if (provider === "gemini") {
    return inputTokens * GEMINI_INPUT + outputTokens * GEMINI_OUTPUT;
  }
  if (provider === "claude") {
    // Default to sonnet pricing for unspecified Claude models
    return inputTokens * CLAUDE_SONNET_INPUT + outputTokens * CLAUDE_SONNET_OUTPUT;
  }
  // Default: OpenAI
  return inputTokens * OPENAI_INPUT + outputTokens * OPENAI_OUTPUT;
}

// ---------------------------------------------------------------------------
// Central logging
// ---------------------------------------------------------------------------

/**
 * Append a token usage entry to the central log.
 *
 * @param {object} opts
 * @param {string} opts.component - e.g. "oracle", "moc-auto-fix", "finding-synthesizer", "consolidate-themes"
 * @param {number} opts.inputTokens
 * @param {number} opts.outputTokens
 * @param {string} [opts.provider] - "openai" | "gemini" | "claude"
 * @param {string} [opts.model] - Specific model name (e.g. "opus", "sonnet", "haiku", "flash-lite")
 * @param {string} [opts.persona]
 * @param {string} [opts.runId]
 * @param {string} [opts.checkType] - for oracle: page_semantics, api_validation, etc.
 */
function logTokenUsage(opts) {
  const {
    component,
    inputTokens = 0,
    outputTokens = 0,
    provider = "openai",
    model,
    persona,
    runId,
    checkType,
  } = opts;

  if (inputTokens === 0 && outputTokens === 0) { return; }

  const costUSD = estimateCost(inputTokens, outputTokens, provider, model || "");
  const entry = {
    ts: new Date().toISOString(),
    component,
    inputTokens,
    outputTokens,
    costUSD: Math.round(costUSD * 1e6) / 1e6,
    provider,
    ...(model && { model }),
    ...(persona && { persona }),
    ...(runId && { runId }),
    ...(checkType && { checkType }),
  };

  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.warn("[token-logger] Failed to append:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Read recent entries
// ---------------------------------------------------------------------------

/**
 * Read recent entries from the log (last N lines).
 */
function readRecentEntries(n = 100) {
  if (!fs.existsSync(LOG_FILE)) { return []; }
  const raw = fs.readFileSync(LOG_FILE, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines.slice(-n)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Claude CLI wrapper
// ---------------------------------------------------------------------------

/**
 * Execute a Claude CLI command and log token usage.
 * Estimates tokens from prompt file size and output length (~4 chars per token).
 *
 * @param {string} cmd - The full claude --print command
 * @param {object} [execOpts] - execSync options (cwd, env, timeout, etc.)
 * @param {object} [logOpts] - { component, persona, runId, checkType }
 * @returns {{ ok: boolean, stdout: string, inputTokens: number, outputTokens: number, model: string, error?: string }}
 */
function wrapClaudeCli(cmd, execOpts = {}, logOpts = {}) {
  try {
    const stdout = execSync(cmd, {
      ...execOpts,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();

    // Extract model from command
    const modelMatch = cmd.match(/--model\s+(\S+)/);
    const model = modelMatch ? modelMatch[1] : "sonnet";

    // Read prompt from stdin redirect if present
    let promptSize = 0;
    const stdinMatch = cmd.match(/< "([^"]+)"/);
    if (stdinMatch && stdinMatch[1]) {
      try { promptSize = fs.statSync(stdinMatch[1]).size; } catch { /* ignore */ }
    }

    const inputTokens = Math.ceil(promptSize / 4);
    const outputTokens = Math.ceil(stdout.length / 4);

    logTokenUsage({
      component: logOpts.component || "claude-cli",
      inputTokens,
      outputTokens,
      provider: "claude",
      model,
      persona: logOpts.persona,
      runId: logOpts.runId,
      ...(logOpts.checkType && { checkType: logOpts.checkType }),
    });

    return { ok: true, stdout, inputTokens, outputTokens, model };
  } catch (err) {
    return { ok: false, stdout: "", error: (err.message || "").slice(0, 500), inputTokens: 0, outputTokens: 0, model: "" };
  }
}

// ---------------------------------------------------------------------------
// Spend summary for budget enforcement
// ---------------------------------------------------------------------------

/**
 * Returns current period spend for budget enforcement.
 *
 * @param {number} [periodHours=1] - How many hours of history to consider
 * @returns {{ periodHours: number, totalCost: number, calls: number, byComponent: Record<string, number>, byProvider: Record<string, number>, byModel: Record<string, number> }}
 */
function getSpendSummary(periodHours = 1) {
  const entries = readRecentEntries(5000);
  const cutoff = new Date(Date.now() - periodHours * 3600000).toISOString();
  const recent = entries.filter((e) => e.ts >= cutoff);

  const byComponent = {};
  const byProvider = {};
  const byModel = {};
  let totalCost = 0;

  for (const e of recent) {
    const comp = e.component || "unknown";
    byComponent[comp] = (byComponent[comp] || 0) + (e.costUSD || 0);
    const prov = e.provider || "unknown";
    byProvider[prov] = (byProvider[prov] || 0) + (e.costUSD || 0);
    const mod = e.model || "unknown";
    byModel[mod] = (byModel[mod] || 0) + (e.costUSD || 0);
    totalCost += e.costUSD || 0;
  }

  return { periodHours, totalCost, calls: recent.length, byComponent, byProvider, byModel };
}

module.exports = {
  logTokenUsage,
  readRecentEntries,
  estimateCost,
  wrapClaudeCli,
  getSpendSummary,
  LOG_FILE,
};
