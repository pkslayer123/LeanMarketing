/**
 * Batch LLM Utility
 *
 * Batches multiple items into a single LLM prompt with structured JSON output.
 * Amortizes prompt overhead and reduces round-trips.
 *
 * Example: instead of 20 separate oracle calls for 20 findings,
 * send 1 call with all 20 findings and parse structured results.
 *
 * Usage:
 *   const { batchClassify, batchSummarize, buildBatchPrompt } = require("./lib/batch-llm");
 *   const results = await batchClassify(findings, { maxBatchSize: 20 });
 */

const MAX_BATCH_SIZE = 20;
const MAX_PROMPT_CHARS = 30000; // Keep under token limits

/**
 * Build a batch prompt with structured output instructions.
 *
 * @param {Array<{ id: string, text: string }>} items — Items to batch
 * @param {string} systemPrompt — Instructions for the LLM
 * @param {string} outputSchema — JSON schema description for output
 * @returns {{ prompt: string, itemCount: number, truncated: boolean }}
 */
function buildBatchPrompt(items, systemPrompt, outputSchema) {
  let truncated = false;
  let batch = items.slice(0, MAX_BATCH_SIZE);

  // Build item section
  let itemsText = batch.map((item, i) =>
    `[ITEM ${i + 1}] id="${item.id}"\n${item.text}`
  ).join("\n\n---\n\n");

  // Truncate if too long
  if (itemsText.length > MAX_PROMPT_CHARS) {
    while (batch.length > 1 && itemsText.length > MAX_PROMPT_CHARS) {
      batch = batch.slice(0, -1);
      truncated = true;
      itemsText = batch.map((item, i) =>
        `[ITEM ${i + 1}] id="${item.id}"\n${item.text}`
      ).join("\n\n---\n\n");
    }
  }

  const prompt = `${systemPrompt}

## Items to Process (${batch.length} items)

${itemsText}

## Output Format

Respond with a JSON array. Each element corresponds to one item above.
${outputSchema}

Respond ONLY with the JSON array, no markdown fences, no commentary.`;

  return { prompt, itemCount: batch.length, truncated };
}

/**
 * Parse a batch LLM response into an array of results.
 * Handles common LLM output quirks (markdown fences, trailing commas).
 */
function parseBatchResponse(text) {
  let cleaned = text.trim();

  // Remove markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  // Remove trailing commas before ] or }
  cleaned = cleaned.replace(/,\s*([\]}])/g, "$1");

  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Try to extract JSON array from response
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0].replace(/,\s*([\]}])/g, "$1"));
      } catch {}
    }
    return null;
  }
}

/**
 * Split items into batches respecting size and token limits.
 *
 * @param {Array} items
 * @param {number} maxBatchSize
 * @param {number} maxCharsPerBatch
 * @returns {Array<Array>} — Array of batches
 */
function splitIntoBatches(items, maxBatchSize = MAX_BATCH_SIZE, maxCharsPerBatch = MAX_PROMPT_CHARS) {
  const batches = [];
  let currentBatch = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = (item.text ?? item.description ?? JSON.stringify(item)).length;

    if (currentBatch.length >= maxBatchSize || (currentChars + itemChars > maxCharsPerBatch && currentBatch.length > 0)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(item);
    currentChars += itemChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Pre-built batch prompts for common operations
// ---------------------------------------------------------------------------

const BATCH_PROMPTS = {
  classifyFindings: {
    system: `You are a QA finding classifier. For each finding, determine:
- severity: "security" | "bug" | "ux" | "suggestion" | "inconsistency"
- theme: one of [dark-mode, loading-states, null-safety, permission-access, error-handling, form-validation, accessibility, layout-responsive, navigation-routing, data-display, api-integration, workflow-stages, other]
- actionable: true if this needs code changes, false if noise/FP
- confidence: 0.0-1.0 how certain you are`,
    schema: `[{ "id": "item-id", "severity": "...", "theme": "...", "actionable": true/false, "confidence": 0.8 }]`,
  },

  classifyErrors: {
    system: `You are an error triage classifier. For each error, determine:
- classification: "noise" (transient/expected) | "bug" (real issue) | "critical" (security/data)
- reason: brief explanation
- confidence: 0.0-1.0`,
    schema: `[{ "id": "item-id", "classification": "...", "reason": "...", "confidence": 0.8 }]`,
  },

  summarizeThemes: {
    system: `You are a finding theme consolidator. Group the provided findings into coherent themes.
For each theme, provide:
- themeId: short kebab-case identifier
- title: human-readable title
- severity: dominant severity across findings
- findingIds: which item IDs belong to this theme
- rootCause: what's causing these findings
- suggestedFix: brief fix approach`,
    schema: `[{ "themeId": "...", "title": "...", "severity": "...", "findingIds": ["..."], "rootCause": "...", "suggestedFix": "..." }]`,
  },
};

/**
 * Get a pre-built batch prompt configuration.
 */
function getBatchPrompt(name) {
  return BATCH_PROMPTS[name] ?? null;
}

module.exports = {
  buildBatchPrompt,
  parseBatchResponse,
  splitIntoBatches,
  getBatchPrompt,
  MAX_BATCH_SIZE,
  MAX_PROMPT_CHARS,
};
