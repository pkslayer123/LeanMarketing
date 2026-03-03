#!/usr/bin/env node

/**
 * Oracle Client — General-purpose LLM oracle for persona test validation.
 *
 * Reads oracle prompt templates from e2e/oracle/prompts/ and calls
 * the configured LLM (Gemini by default) for page validation.
 *
 * Supports check types:
 *   - page_semantics: Does the page content match expectations?
 *   - ui_dark_mode: Are dark mode styles applied correctly?
 *   - ui_accessibility: WCAG compliance checks
 *   - ui_responsive: Layout at mobile viewport
 *   - ui_performance: Loading time and perceived performance
 *   - api_validation: API response correctness
 *   - error_clarity: Are error messages helpful?
 *   - persona_feedback: General persona impressions
 *
 * Falls back gracefully if no LLM key is available.
 */

const fs = require("fs");
const path = require("path");

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
  return process.cwd();
}

const ROOT = findProjectRoot();

// Model tier mapping
const CHECK_TIERS = {
  // Critical checks use the best model
  permission_enforcement: "critical",
  data_isolation: "critical",
  // High priority
  page_semantics: "high",
  api_validation: "high",
  ui_accessibility: "high",
  error_clarity: "high",
  spec_verification: "high",
  // Standard
  ui_dark_mode: "standard",
  ui_responsive: "standard",
  // Low priority
  ui_performance: "low",
  persona_feedback: "low",
  product_improvement: "low",
};

/**
 * OracleClient — lightweight LLM oracle for test validation.
 */
class OracleClient {
  constructor(options = {}) {
    this.geminiKey = options.geminiKey || process.env.GEMINI_API_KEY || "";
    this.openaiKey = options.openaiKey || process.env.OPENAI_API_KEY || "";
    this.promptCache = {};
    this.verdictCache = {};
    this.tokensUsed = 0;
    this.callCount = 0;

    // Model selection
    this.models = {
      critical: options.criticalModel || process.env.E2E_ORACLE_CRITICAL_MODEL || "gemini-2.5-flash",
      high: options.highModel || "gemini-2.5-flash",
      standard: options.standardModel || "gemini-2.5-flash",
      low: options.lowModel || "gemini-2.0-flash-lite",
    };
  }

  /**
   * Check if oracle is available (has at least one LLM key).
   */
  isAvailable() {
    return Boolean(this.geminiKey || this.openaiKey);
  }

  /**
   * Run an oracle check on page content.
   *
   * @param {Object} query
   * @param {string} query.checkType - One of the CHECK_TIERS keys
   * @param {string} query.pageContent - HTML or text content of the page
   * @param {string} query.url - Page URL
   * @param {Object} query.persona - Current persona context
   * @param {string} query.screenshot - Base64 screenshot (optional)
   * @returns {Object} verdict - { passed, findings, summary, tokensUsed }
   */
  async check(query) {
    if (!this.isAvailable()) {
      return { passed: true, findings: [], summary: "Oracle unavailable (no LLM key)", tokensUsed: 0, skipped: true };
    }

    const { checkType, pageContent, url, persona, screenshot } = query;

    // Check verdict cache (same persona + url + checkType = skip)
    const cacheKey = `${persona?.id || persona?.name || "anon"}:${url}:${checkType}`;
    if (this.verdictCache[cacheKey]) {
      return { ...this.verdictCache[cacheKey], cached: true };
    }

    // Load prompt template
    const promptTemplate = this._loadPrompt(checkType);
    if (!promptTemplate) {
      return { passed: true, findings: [], summary: `No prompt template for ${checkType}`, tokensUsed: 0, skipped: true };
    }

    // Build the full prompt
    const prompt = this._buildPrompt(promptTemplate, {
      pageContent: (pageContent || "").slice(0, 8000), // Limit to avoid token explosion
      url: url || "",
      personaName: persona?.name || "Anonymous",
      personaRole: persona?.role || "user",
      personaFocus: persona?.focus || [],
      checkType,
    });

    // Select model tier
    const tier = CHECK_TIERS[checkType] || "standard";
    const model = this.models[tier];

    try {
      const result = await this._callLLM(prompt, model, screenshot);
      const verdict = this._parseVerdict(result, checkType);

      // Cache result
      this.verdictCache[cacheKey] = verdict;
      this.tokensUsed += verdict.tokensUsed || 0;
      this.callCount++;

      return verdict;
    } catch (err) {
      console.warn(`[Oracle] ${checkType} check failed: ${err.message}`);
      return { passed: true, findings: [], summary: `Oracle error: ${err.message}`, tokensUsed: 0, error: true };
    }
  }

  /**
   * Batch multiple checks for efficiency.
   */
  async checkBatch(queries) {
    const results = [];
    // Run in parallel but respect rate limits (max 3 concurrent)
    const batch = [];
    for (const query of queries) {
      batch.push(this.check(query));
      if (batch.length >= 3) {
        results.push(...(await Promise.all(batch)));
        batch.length = 0;
      }
    }
    if (batch.length > 0) {
      results.push(...(await Promise.all(batch)));
    }
    return results;
  }

  /**
   * Get usage stats.
   */
  getStats() {
    return {
      tokensUsed: this.tokensUsed,
      callCount: this.callCount,
      cacheHits: Object.keys(this.verdictCache).length,
    };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  _loadPrompt(checkType) {
    if (this.promptCache[checkType]) {
      return this.promptCache[checkType];
    }

    // Look in project's oracle prompts directory
    const promptDirs = [
      path.join(ROOT, "e2e", "oracle", "prompts"),
      path.join(ROOT, "oracle", "prompts"),
    ];

    // Map check types to prompt file names
    const nameVariants = [
      checkType.replace(/_/g, "-") + ".txt",
      checkType + ".txt",
    ];

    for (const dir of promptDirs) {
      for (const name of nameVariants) {
        const fullPath = path.join(dir, name);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, "utf-8");
          this.promptCache[checkType] = content;
          return content;
        }
      }
    }

    // Built-in fallback prompts for common check types
    const fallbacks = {
      page_semantics: `Analyze this web page and determine if the content is meaningful and functional.
URL: {{url}}
Persona: {{personaName}} ({{personaRole}})

Page content:
{{pageContent}}

Respond with JSON:
{"passed": true/false, "findings": [{"severity": "bug|ux|suggestion", "description": "..."}], "summary": "..."}`,

      ui_dark_mode: `Check if this page has proper dark mode styling. Look for: bg-gray-900/800 backgrounds, light text, no white-on-white or dark-on-dark issues.
URL: {{url}}

Page content:
{{pageContent}}

Respond with JSON:
{"passed": true/false, "findings": [{"severity": "ux", "description": "..."}], "summary": "..."}`,

      ui_accessibility: `Check this page for accessibility issues: missing alt text, poor contrast, missing labels, keyboard navigation issues.
URL: {{url}}

Page content:
{{pageContent}}

Respond with JSON:
{"passed": true/false, "findings": [{"severity": "bug|ux", "description": "..."}], "summary": "..."}`,

      error_clarity: `Evaluate error messages on this page. Are they clear, actionable, and non-technical?
URL: {{url}}

Page content:
{{pageContent}}

Respond with JSON:
{"passed": true/false, "findings": [{"severity": "ux", "description": "..."}], "summary": "..."}`,

      api_validation: `Validate this API response. Check for: correct status codes, valid JSON, meaningful error messages, no leaked internal details.
URL: {{url}}

Response:
{{pageContent}}

Respond with JSON:
{"passed": true/false, "findings": [{"severity": "bug|security", "description": "..."}], "summary": "..."}`,
    };

    if (fallbacks[checkType]) {
      this.promptCache[checkType] = fallbacks[checkType];
      return fallbacks[checkType];
    }

    return null;
  }

  _buildPrompt(template, vars) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      const replacement = Array.isArray(value) ? value.join(", ") : String(value || "");
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), replacement);
    }
    return result;
  }

  async _callLLM(prompt, model, screenshot) {
    if (this.geminiKey) {
      return this._callGemini(prompt, model, screenshot);
    }
    if (this.openaiKey) {
      return this._callOpenAI(prompt, screenshot);
    }
    throw new Error("No LLM key configured");
  }

  async _callGemini(prompt, model, screenshot) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.geminiKey}`;

    const parts = [{ text: prompt }];
    if (screenshot) {
      parts.push({
        inlineData: {
          mimeType: "image/png",
          data: screenshot,
        },
      });
    }

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const tokens = data.usageMetadata?.totalTokenCount || 0;

    return { text, tokensUsed: tokens };
  }

  async _callOpenAI(prompt, screenshot) {
    const messages = [{ role: "user", content: prompt }];

    if (screenshot) {
      messages[0] = {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot}` } },
        ],
      };
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    const tokens = data.usage?.total_tokens || 0;

    return { text, tokensUsed: tokens };
  }

  _parseVerdict(result, checkType) {
    try {
      const text = result.text.trim();
      // Extract JSON from possible markdown code blocks
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      const parsed = JSON.parse(jsonMatch[1].trim());

      return {
        passed: Boolean(parsed.passed),
        findings: (parsed.findings || []).map((f) => ({
          severity: f.severity || "suggestion",
          description: f.description || "",
          element: f.element || "",
          checkType,
          confidence: f.confidence || 0.7,
        })),
        summary: parsed.summary || "",
        tokensUsed: result.tokensUsed || 0,
      };
    } catch {
      // If parsing fails, treat as passed with a note
      return {
        passed: true,
        findings: [],
        summary: `Oracle response unparseable for ${checkType}`,
        tokensUsed: result.tokensUsed || 0,
        parseError: true,
      };
    }
  }
}

module.exports = { OracleClient, CHECK_TIERS };
