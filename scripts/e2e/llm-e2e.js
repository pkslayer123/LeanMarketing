#!/usr/bin/env node

/**
 * E2E LLM Helper — Retry, fallback, and consistent provider selection.
 *
 * Fixes inconsistent OpenAI behavior:
 * - Retries on 429 (rate limit), 503 (overload), network errors
 * - Falls back to alternate provider when primary fails after retries
 * - Respects LLM_PROVIDER (default: gemini)
 *
 * Env:
 *   LLM_PROVIDER=openai|gemini  (default: gemini) — which provider to use when both keys set
 *   E2E_LLM_RETRY_ATTEMPTS=3   (default: 3) — retries on 429, 503, network errors
 *   E2E_LLM_RETRY_BASE_MS=1000 (exponential backoff base)
 *   E2E_LLM_FALLBACK=1         (default: 1) — try alternate provider when primary fails
 *   E2E_LLM_THROTTLE_MS=0      (default: 0) — delay before each call to avoid rate limits
 */

const path = require("path");
const { logTokenUsage } = require("./lib/token-logger.js");

try {
  const root = path.resolve(__dirname, "..", "..");
  require("dotenv").config({ path: path.join(root, ".env.local"), quiet: true });
  require("dotenv").config({ path: path.join(root, "e2e", ".env"), quiet: true });
} catch {
  // dotenv not installed
}

const RETRY_ATTEMPTS = parseInt(process.env.E2E_LLM_RETRY_ATTEMPTS ?? "3", 10);
const RETRY_BASE_MS = parseInt(process.env.E2E_LLM_RETRY_BASE_MS ?? "1000", 10);
const FALLBACK_ENABLED = process.env.E2E_LLM_FALLBACK !== "0";
const THROTTLE_MS = parseInt(process.env.E2E_LLM_THROTTLE_MS ?? "0", 10);

function getConfig() {
  const openaiKey = process.env.OPENAI_API_KEY?.trim() || null;
  const geminiKey = process.env.GEMINI_API_KEY?.trim() || null;
  // Auto-detect: if only one key set, use it. Otherwise respect LLM_PROVIDER (default: gemini for cost)
  const explicitProvider = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
  const provider =
    openaiKey && !geminiKey
      ? "openai"
      : geminiKey && !openaiKey
        ? "gemini"
        : explicitProvider;

  const primary =
    provider === "openai" && openaiKey
      ? { provider: "openai", key: openaiKey }
      : geminiKey
        ? { provider: "gemini", key: geminiKey }
        : openaiKey
          ? { provider: "openai", key: openaiKey }
          : null;

  const fallback =
    FALLBACK_ENABLED && primary
      ? primary.provider === "openai" && geminiKey
        ? { provider: "gemini", key: geminiKey }
        : primary.provider === "gemini" && openaiKey
          ? { provider: "openai", key: openaiKey }
          : null
      : null;

  return { primary, fallback };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status, errMsg) {
  if (status === 429 || status === 503) return true;
  if (status >= 500) return true;
  const msg = (errMsg ?? "").toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("rate limit")
  );
}

async function callOpenAI(apiKey, prompt, opts = {}) {
  const system = opts.systemPrompt ?? "Respond with valid JSON only.";
  const model = opts.model ?? "gpt-4o-mini";
  const maxTokens = opts.maxTokens ?? 1024;
  const temp = opts.temperature ?? 0.1;
  const jsonMode = opts.jsonMode !== false;

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    temperature: temp,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const usage = data.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? Math.ceil((system.length + prompt.length) / 4);
  const outputTokens = usage.completion_tokens ?? Math.ceil((content?.length ?? 0) / 4);
  return {
    content: jsonMode ? JSON.parse(content) : content,
    inputTokens,
    outputTokens,
  };
}

async function callGemini(apiKey, prompt, opts = {}) {
  const model = opts.model ?? "gemini-2.5-flash";
  const maxTokens = opts.maxTokens ?? 1024;
  const temp = opts.temperature ?? 0.1;
  const jsonMode = opts.jsonMode !== false;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: temp,
      maxOutputTokens: maxTokens,
    },
  };
  if (jsonMode) body.generationConfig.responseMimeType = "application/json";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = JSON.parse(text);
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const usage = data.usageMetadata ?? {};
  const inputTokens = usage.promptTokenCount ?? Math.ceil(prompt.length / 4);
  const outputTokens = usage.candidatesTokenCount ?? Math.ceil((content?.length ?? 0) / 4);
  return {
    content: jsonMode ? JSON.parse(content) : content,
    inputTokens,
    outputTokens,
  };
}

async function callWithRetry(provider, apiKey, prompt, opts, log = () => {}) {
  const fn = provider === "openai" ? callOpenAI : callGemini;
  let lastErr;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (THROTTLE_MS > 0 && attempt === 0) {
      await sleep(THROTTLE_MS);
    }
    try {
      return await fn(apiKey, prompt, opts);
    } catch (err) {
      lastErr = err;
      const status = err.status ?? 0;
      const msg = err.message ?? "";

      if (!isRetryable(status, msg) || attempt === RETRY_ATTEMPTS - 1) {
        throw err;
      }

      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      log(`[LLM] ${provider} ${status || "error"} — retry ${attempt + 1}/${RETRY_ATTEMPTS} in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * Call LLM with retry and optional fallback to alternate provider.
 * Logs token usage to persona-token-usage.jsonl when opts.component is set.
 *
 * @param {object} opts
 * @param {string} opts.prompt - User prompt
 * @param {string} [opts.systemPrompt] - System prompt
 * @param {string} [opts.model] - Model name (provider-specific)
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {boolean} [opts.jsonMode=true]
 * @param {function} [opts.log] - Log function
 * @param {string} [opts.component] - For token logging: oracle, tracy, persona-questions, steerer, etc.
 * @param {string} [opts.persona] - For token logging
 * @param {string} [opts.runId] - For token logging
 * @returns {Promise<object|string>} Parsed JSON or raw text
 */
async function callLLMWithRetry(opts = {}) {
  const { primary, fallback } = getConfig();
  if (!primary) {
    throw new Error("Missing GEMINI_API_KEY or OPENAI_API_KEY");
  }

  const log = opts.log ?? (() => {});

  const handleResult = (result, provider) => {
    if (opts.component && result && typeof result === "object" && "inputTokens" in result) {
      logTokenUsage({
        component: opts.component,
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        provider,
        persona: opts.persona,
        runId: opts.runId,
      });
    }
    return result?.content ?? result;
  };

  try {
    const result = await callWithRetry(primary.provider, primary.key, opts.prompt, opts, log);
    return handleResult(result, primary.provider);
  } catch (err) {
    if (!fallback) throw err;

    if (fallback.provider === "openai") {
      log(`[LLM] WARNING: falling back to OpenAI — Gemini primary failed`);
    } else {
      log(`[LLM] Primary (${primary.provider}) failed, trying fallback (${fallback.provider})`);
    }
    try {
      const result = await callWithRetry(fallback.provider, fallback.key, opts.prompt, opts, log);
      return handleResult(result, fallback.provider);
    } catch (fallbackErr) {
      throw new Error(
        `LLM failed (primary: ${err.message}; fallback: ${fallbackErr.message})`
      );
    }
  }
}

/**
 * callGeminiVision — Send an image to Gemini for vision analysis.
 * Primary vision model for the pipeline (replaces OpenAI gpt-4o/gpt-4o-mini).
 *
 * @param {string} apiKey - Gemini API key
 * @param {string} base64Image - Base64-encoded image data
 * @param {string} prompt - Text prompt for the vision model
 * @param {object} opts - Options: model, maxTokens, temperature, mimeType
 * @returns {Promise<{content: object|string, inputTokens: number, outputTokens: number}>}
 */
async function callGeminiVision(apiKey, base64Image, prompt, opts = {}) {
  const model = opts.model ?? "gemini-2.5-flash";
  const maxTokens = opts.maxTokens ?? 512;
  const temp = opts.temperature ?? 0.1;
  const mime = opts.mimeType ?? "image/png";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mime, data: base64Image } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: temp,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Gemini Vision ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = JSON.parse(text);
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const usage = data.usageMetadata ?? {};
  return {
    content,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
}

module.exports = {
  getConfig,
  callLLMWithRetry,
  callOpenAI,
  callGemini,
  callGeminiVision,
  isRetryable,
  sleep,
};
