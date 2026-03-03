#!/usr/bin/env node

/**
 * consolidate-themes.js — Cross-page theme aggregation for findings.
 *
 * Takes per-page clusters from finding-clusters.json and groups them into
 * ~20-30 actionable themes. Two-pass approach:
 *   1. Heuristic keyword matching for obvious patterns (no LLM)
 *   2. Claude Sonnet single pass for remaining uncategorized clusters
 *
 * Usage:
 *   node scripts/e2e/consolidate-themes.js              # Full consolidation
 *   node scripts/e2e/consolidate-themes.js --dry-run     # Analyze only
 *   node scripts/e2e/consolidate-themes.js --json        # Machine-readable output
 *   node scripts/e2e/consolidate-themes.js --no-llm      # Heuristic only, skip Claude
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { splitIntoBatches, buildBatchPrompt, parseBatchResponse, getBatchPrompt } = require("./lib/batch-llm");
const { withStateLock } = require("./claw");

let _llmE2e = null;
function getLlmE2e() {
  if (_llmE2e) return _llmE2e;
  try {
    _llmE2e = require("./llm-e2e.js");
    return _llmE2e;
  } catch {
    return null;
  }
}

function isClaudeAvailable() {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const ROOT = path.resolve(__dirname, "../..");
const STATE = path.join(ROOT, "e2e", "state");
const CLUSTERS_FILE = path.join(STATE, "finding-clusters.json");
const THEMES_FILE = path.join(STATE, "finding-themes.json");
const PROMPT_FILE = path.join(STATE, "fix-prompt-themes.md");

const cliArgs = process.argv.slice(2);
const DRY_RUN = cliArgs.includes("--dry-run");
const JSON_MODE = cliArgs.includes("--json");
const NO_LLM = cliArgs.includes("--no-llm");

function log(msg) {
  if (!JSON_MODE) {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    console.log(`[${ts}] [consolidate-themes] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Predefined theme patterns — keyword matching, no LLM needed
// ---------------------------------------------------------------------------

const THEME_PATTERNS = [
  {
    id: "dark-mode",
    title: "Dark mode styling issues",
    keywords: ["dark", "dark:", "contrast", "bg-gray", "bg-white", "dark mode", "light mode", "theme"],
    severity: "ux",
    suggestedAction: "Run scripts/fix-dark-mode.js --dry-run to identify missing dark: classes",
  },
  {
    id: "loading-states",
    title: "Missing or broken loading states",
    keywords: ["loading", "skeleton", "spinner", "shimmer", "placeholder", "flash of", "flicker"],
    severity: "ux",
    suggestedAction: "Add skeleton components or loading.tsx for affected routes",
  },
  {
    id: "null-safety",
    title: "Null/undefined data handling",
    keywords: ["null", "undefined", "missing", "empty state", "no data", "cannot read", "typeerror"],
    severity: "bug",
    suggestedAction: "Add null guards and empty-state UI for affected components",
  },
  {
    id: "permission-access",
    title: "Permission and access control issues",
    keywords: ["permission", "unauthorized", "403", "access denied", "forbidden", "role", "not allowed"],
    severity: "security",
    suggestedAction: "Verify requireGranularPermission and hasMinRole checks on affected routes",
  },
  {
    id: "error-handling",
    title: "Error handling and recovery gaps",
    keywords: ["error", "catch", "fallback", "500", "server error", "failed to", "unhandled", "crash"],
    severity: "bug",
    suggestedAction: "Add try-catch, error boundaries, or user-facing error messages",
  },
  {
    id: "form-validation",
    title: "Form validation and input handling",
    keywords: ["validation", "required", "invalid", "form", "input", "submit", "field"],
    severity: "bug",
    suggestedAction: "Add client-side validation and server-side checks for affected forms",
  },
  {
    id: "accessibility",
    title: "Accessibility (WCAG) issues",
    keywords: ["aria", "screen reader", "focus", "tab order", "contrast ratio", "keyboard", "alt text", "wcag", "a11y"],
    severity: "ux",
    suggestedAction: "Add ARIA labels, focus management, and keyboard navigation support",
  },
  {
    id: "spec-completeness",
    title: "Feature completeness gaps (spec grading)",
    keywords: ["grade", "spec", "completeness", "missing feature", "not implemented", "incomplete", "expected feature"],
    severity: "product",
    suggestedAction: "Review BUILD-SPEC.md for intended functionality and implement missing pieces",
  },
  {
    id: "layout-responsive",
    title: "Layout and responsive design issues",
    keywords: ["layout", "overflow", "truncat", "responsive", "mobile", "viewport", "breakpoint", "width", "alignment"],
    severity: "ux",
    suggestedAction: "Fix Tailwind responsive classes and overflow handling",
  },
  {
    id: "navigation-routing",
    title: "Navigation and routing problems",
    keywords: ["navigation", "route", "redirect", "link", "broken link", "404", "not found", "breadcrumb"],
    severity: "bug",
    suggestedAction: "Fix broken links, missing routes, and navigation state",
  },
  {
    id: "data-display",
    title: "Data display and formatting issues",
    keywords: ["display", "format", "date", "number", "currency", "truncated", "wrong value", "stale", "outdated"],
    severity: "bug",
    suggestedAction: "Fix data formatting helpers and ensure fresh data fetching",
  },
  {
    id: "api-integration",
    title: "API and backend integration issues",
    keywords: ["api", "fetch", "endpoint", "request", "response", "timeout", "network", "cors"],
    severity: "bug",
    suggestedAction: "Fix API error handling, timeout configuration, and response parsing",
  },
  {
    id: "notification-feedback",
    title: "Missing user feedback and notifications",
    keywords: ["notification", "feedback", "toast", "alert", "confirm", "success", "message", "status"],
    severity: "ux",
    suggestedAction: "Add toast notifications and success/error feedback for user actions",
  },
  {
    id: "workflow-stages",
    title: "MOC workflow stage issues",
    keywords: ["stage", "workflow", "advance", "review", "approve", "decision", "closeout", "routing"],
    severity: "product",
    suggestedAction: "Review stage transition logic and UI state management",
  },
  {
    id: "search-filter",
    title: "Search and filtering functionality",
    keywords: ["search", "filter", "sort", "pagination", "query", "results", "no results"],
    severity: "ux",
    suggestedAction: "Implement or fix search/filter functionality on affected pages",
  },
];

/** Severity weight for priority ranking */
const SEVERITY_WEIGHT = {
  security: 5,
  bug: 3,
  product: 2,
  ux: 1.5,
  suggestion: 1,
};

// ---------------------------------------------------------------------------
// Theme matching
// ---------------------------------------------------------------------------

/**
 * Match a cluster's text content against theme patterns.
 * Returns the best-matching theme ID or null.
 */
function matchTheme(cluster) {
  const text = [
    cluster.canonical_title || "",
    cluster.root_cause || "",
    cluster.suggested_fix_direction || "",
    ...(cluster._original_findings || []).map((f) => f.description || ""),
  ]
    .join(" ")
    .toLowerCase();

  let bestMatch = null;
  let bestScore = 0;

  for (const theme of THEME_PATTERNS) {
    let score = 0;
    for (const kw of theme.keywords) {
      if (text.includes(kw.toLowerCase())) {
        score++;
      }
    }
    // Require at least 2 keyword matches for confidence
    if (score >= 2 && score > bestScore) {
      bestScore = score;
      bestMatch = theme.id;
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// Claude LLM pass for uncategorized clusters
// ---------------------------------------------------------------------------

function callClaudeSonnet(prompt) {
  try {
    fs.writeFileSync(PROMPT_FILE, prompt, "utf-8");
    const result = execSync(
      `claude --print --dangerously-skip-permissions --model sonnet --max-budget-usd 0.50 < "${PROMPT_FILE.replace(/\\/g, "/")}"`,
      {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
        env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE: "" },
      }
    );
    const output = result.toString().trim();

    // Token accounting
    try {
      const _tl = require("./lib/token-logger");
      const _inEst = Math.ceil((fs.existsSync(PROMPT_FILE) ? fs.statSync(PROMPT_FILE).size : 0) / 4);
      const _outEst = Math.ceil(output.length / 4);
      _tl.logTokenUsage({ component: "consolidate-themes", inputTokens: _inEst, outputTokens: _outEst, provider: "claude", model: "sonnet" });
    } catch { /* non-fatal */ }

    // Parse JSON from response
    let jsonStr = output;
    const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      jsonStr = braceMatch[0];
    }
    return JSON.parse(jsonStr);
  } catch (err) {
    const msg = err.message ? err.message.slice(0, 200) : "Unknown error";
    log(`Claude Sonnet error: ${msg}`);
    return null;
  } finally {
    try { fs.unlinkSync(PROMPT_FILE); } catch { /* ignore */ }
  }
}

function classifyRemainingWithClaude(uncategorized, existingThemeIds) {
  if (uncategorized.length === 0) {
    return {};
  }

  // Build compact summaries for the prompt
  const summaries = uncategorized.map((c, idx) => ({
    idx,
    title: c.canonical_title || "",
    severity: c.severity || "bug",
    pages: (c.affected_pages || []).slice(0, 3).join(", "),
    root_cause: (c.root_cause || "").slice(0, 100),
  }));

  // Split into batches if many uncategorized clusters (batch-llm handles size limits)
  const batches = splitIntoBatches(
    summaries.map((s) => ({ id: String(s.idx), text: `${s.title} | ${s.severity} | ${s.pages} | ${s.root_cause}` })),
    20,  // max items per batch
    25000 // max chars per batch (leave room for system prompt)
  );

  if (batches.length > 1) {
    log(`Splitting ${summaries.length} uncategorized clusters into ${batches.length} batches`);
  }

  const prompt = [
    "You are categorizing test findings into themes for a SaaS web application.",
    "",
    "Existing theme categories:",
    existingThemeIds.map((id) => `  - ${id}`).join("\n"),
    "",
    `${summaries.length} uncategorized findings:`,
    JSON.stringify(summaries, null, 2),
    "",
    "TASK: Assign each finding to an existing theme or create a new theme.",
    "Respond with ONLY a JSON object (no markdown fences):",
    "{",
    '  "assignments": {',
    '    "0": "dark-mode",',
    '    "1": "new-theme-name",',
    '    "2": "error-handling"',
    "  },",
    '  "newThemes": {',
    '    "new-theme-name": {',
    '      "title": "Human-readable theme title",',
    '      "severity": "bug",',
    '      "suggestedAction": "Brief suggested fix direction"',
    "    }",
    "  }",
    "}",
    "",
    "Rules:",
    "- Use kebab-case for new theme IDs",
    "- Every finding index must be assigned to exactly one theme",
    "- Prefer existing themes over creating new ones",
    "- Only create a new theme if 3+ findings share a pattern not covered by existing themes",
    "- Otherwise assign to 'uncategorized'",
  ].join("\n");

  return callClaudeSonnet(prompt);
}

/**
 * Call Gemini API when Claude CLI is unavailable. Theme categorization — Gemini is sufficient.
 * Env: E2E_THEMES_MODEL (default: gemini-2.5-flash).
 */
async function callGeminiForThemes(prompt) {
  const llm = getLlmE2e();
  if (!llm) return null;
  try {
    const model = process.env.E2E_THEMES_MODEL ?? "gemini-2.5-flash";
    const raw = await llm.callLLMWithRetry({
      prompt,
      model,
      component: "consolidate-themes",
      maxTokens: 2048,
    });
    const output = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    let jsonStr = output;
    const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];
    return JSON.parse(jsonStr);
  } catch (err) {
    log(`Gemini fallback error: ${(err.message ?? "").slice(0, 100)}`);
    return null;
  }
}

/**
 * Classify uncategorized clusters — Claude first, Gemini fallback.
 */
async function classifyRemaining(uncategorized, existingThemeIds) {
  if (uncategorized.length === 0) return {};
  const summaries = uncategorized.map((c, idx) => ({
    idx,
    title: c.canonical_title || "",
    severity: c.severity || "bug",
    pages: (c.affected_pages || []).slice(0, 3).join(", "),
    root_cause: (c.root_cause || "").slice(0, 100),
  }));
  const batches = splitIntoBatches(
    summaries.map((s) => ({ id: String(s.idx), text: `${s.title} | ${s.severity} | ${s.pages} | ${s.root_cause}` })),
    20,
    25000
  );
  if (batches.length > 1) {
    log(`Splitting ${summaries.length} uncategorized clusters into ${batches.length} batches`);
  }
  const prompt = [
    "You are categorizing test findings into themes for a SaaS web application.",
    "",
    "Existing theme categories:",
    existingThemeIds.map((id) => `  - ${id}`).join("\n"),
    "",
    `${summaries.length} uncategorized findings:`,
    JSON.stringify(summaries, null, 2),
    "",
    "TASK: Assign each finding to an existing theme or create a new theme.",
    "Respond with ONLY a JSON object (no markdown fences):",
    "{",
    '  "assignments": {',
    '    "0": "dark-mode",',
    '    "1": "new-theme-name",',
    '    "2": "error-handling"',
    "  },",
    '  "newThemes": {',
    '    "new-theme-name": {',
    '      "title": "Human-readable theme title",',
    '      "severity": "bug",',
    '      "suggestedAction": "Brief suggested fix direction"',
    "    }",
    "  }",
    "}",
    "",
    "Rules:",
    "- Use kebab-case for new theme IDs",
    "- Every finding index must be assigned to exactly one theme",
    "- Prefer existing themes over creating new ones",
    "- Only create a new theme if 3+ findings share a pattern not covered by existing themes",
    "- Otherwise assign to 'uncategorized'",
  ].join("\n");

  const useClaude = isClaudeAvailable();
  const useGemini = !useClaude && getLlmE2e() && (process.env.GEMINI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());

  if (useClaude) {
    return classifyRemainingWithClaude(uncategorized, existingThemeIds);
  }
  if (useGemini) {
    log("Using Gemini fallback (Claude CLI not available).");
    return callGeminiForThemes(prompt);
  }
  log("Claude CLI and API LLM not available — skipping theme classification.");
  return null;
}

// ---------------------------------------------------------------------------
// Main consolidation
// ---------------------------------------------------------------------------

async function main() {
  // Load clusters
  const clustersRaw = loadJSON(CLUSTERS_FILE);
  if (!clustersRaw || !Array.isArray(clustersRaw.clusters)) {
    log("No clusters file found. Run claude-finding-synthesizer.js first.");
    if (JSON_MODE) {
      console.log(JSON.stringify({ error: "no_clusters" }));
    }
    return;
  }

  const clusters = clustersRaw.clusters;
  log(`Loaded ${clusters.length} clusters from finding-clusters.json`);

  // Pass 1: Heuristic keyword matching
  const themeMap = {}; // themeId -> { ...theme, clusters: [] }
  const uncategorized = [];

  for (const THEME_PATTERNS_ENTRY of THEME_PATTERNS) {
    themeMap[THEME_PATTERNS_ENTRY.id] = {
      ...THEME_PATTERNS_ENTRY,
      clusters: [],
      findingCount: 0,
      affectedPages: new Set(),
      affectedPersonas: new Set(),
    };
  }

  for (const cluster of clusters) {
    const themeId = matchTheme(cluster);
    if (themeId && themeMap[themeId]) {
      themeMap[themeId].clusters.push(cluster);
      themeMap[themeId].findingCount += (cluster._original_findings || []).length || 1;
      const pages = cluster.affected_pages || [];
      if (pages.length === 0 && cluster._source_batch) {
        pages.push(cluster._source_batch);
      }
      for (const p of pages) {
        themeMap[themeId].affectedPages.add(p);
      }
      for (const per of cluster.affected_personas || []) {
        themeMap[themeId].affectedPersonas.add(per);
      }
    } else {
      uncategorized.push(cluster);
    }
  }

  const heuristicMatched = clusters.length - uncategorized.length;
  log(`Pass 1 (heuristic): ${heuristicMatched}/${clusters.length} clusters matched to ${THEME_PATTERNS.length} themes`);
  log(`Uncategorized: ${uncategorized.length} clusters`);

  // Pass 2: Claude or Gemini for remaining (unless --no-llm)
  if (uncategorized.length > 0 && !NO_LLM && !DRY_RUN) {
    log(`Pass 2: Sending ${uncategorized.length} uncategorized clusters to LLM...`);
    const existingIds = Object.keys(themeMap);
    const claudeResult = await classifyRemaining(uncategorized, existingIds);

    if (claudeResult && claudeResult.assignments) {
      // Add new themes
      if (claudeResult.newThemes) {
        for (const [id, def] of Object.entries(claudeResult.newThemes)) {
          if (!themeMap[id]) {
            themeMap[id] = {
              id,
              title: def.title || id,
              severity: def.severity || "suggestion",
              suggestedAction: def.suggestedAction || "",
              keywords: [],
              clusters: [],
              findingCount: 0,
              affectedPages: new Set(),
              affectedPersonas: new Set(),
            };
          }
        }
      }

      // Apply assignments
      let assigned = 0;
      for (const [idxStr, themeId] of Object.entries(claudeResult.assignments)) {
        const idx = parseInt(idxStr, 10);
        if (idx >= 0 && idx < uncategorized.length && themeMap[themeId]) {
          const cluster = uncategorized[idx];
          themeMap[themeId].clusters.push(cluster);
          themeMap[themeId].findingCount += (cluster._original_findings || []).length || 1;
          const clPages = cluster.affected_pages || [];
          if (clPages.length === 0 && cluster._source_batch) { clPages.push(cluster._source_batch); }
          for (const p of clPages) {
            themeMap[themeId].affectedPages.add(p);
          }
          for (const per of cluster.affected_personas || []) {
            themeMap[themeId].affectedPersonas.add(per);
          }
          assigned++;
        }
      }
      log(`Pass 2: LLM assigned ${assigned}/${uncategorized.length} clusters`);

      // Handle truly unassigned
      const assignedIdxs = new Set(Object.keys(claudeResult.assignments).map(Number));
      for (let i = 0; i < uncategorized.length; i++) {
        if (!assignedIdxs.has(i)) {
          if (!themeMap.uncategorized) {
            themeMap.uncategorized = {
              id: "uncategorized",
              title: "Uncategorized findings",
              severity: "suggestion",
              suggestedAction: "Review individually — no common pattern detected",
              keywords: [],
              clusters: [],
              findingCount: 0,
              affectedPages: new Set(),
              affectedPersonas: new Set(),
            };
          }
          const cluster = uncategorized[i];
          themeMap.uncategorized.clusters.push(cluster);
          themeMap.uncategorized.findingCount += (cluster._original_findings || []).length || 1;
        }
      }
    } else {
      log("LLM pass failed. Putting remaining in 'uncategorized' theme.");
      themeMap.uncategorized = {
        id: "uncategorized",
        title: "Uncategorized findings",
        severity: "suggestion",
        suggestedAction: "Review individually — no common pattern detected",
        keywords: [],
        clusters: [],
        findingCount: 0,
        affectedPages: new Set(),
        affectedPersonas: new Set(),
      };
      for (const cluster of uncategorized) {
        themeMap.uncategorized.clusters.push(cluster);
        themeMap.uncategorized.findingCount += (cluster._original_findings || []).length || 1;
      }
    }
  } else if (uncategorized.length > 0) {
    // No LLM or dry run — put in uncategorized
    themeMap.uncategorized = {
      id: "uncategorized",
      title: "Uncategorized findings",
      severity: "suggestion",
      suggestedAction: "Review individually",
      keywords: [],
      clusters: [],
      findingCount: 0,
      affectedPages: new Set(),
      affectedPersonas: new Set(),
    };
    for (const cluster of uncategorized) {
      themeMap.uncategorized.clusters.push(cluster);
      themeMap.uncategorized.findingCount += (cluster._original_findings || []).length || 1;
    }
  }

  // Build output themes (only themes with clusters)
  const themes = Object.values(themeMap)
    .filter((t) => t.clusters.length > 0)
    .map((t, idx) => {
      const pages = [...(t.affectedPages || [])];
      const personas = [...(t.affectedPersonas || [])];
      const weight = SEVERITY_WEIGHT[t.severity] || 1;
      return {
        id: `theme-${t.id}`,
        title: t.findingCount > 1
          ? `${t.title} across ${pages.length} page${pages.length !== 1 ? "s" : ""}`
          : t.title,
        pattern: t.id,
        severity: t.severity,
        findingCount: t.findingCount,
        clusterCount: t.clusters.length,
        affectedPages: pages.slice(0, 20),
        affectedPersonas: personas.slice(0, 20),
        suggestedAction: t.suggestedAction || "",
        priority: parseFloat((t.findingCount * weight).toFixed(1)),
      };
    })
    .sort((a, b) => b.priority - a.priority);

  // Assign final priority ranks
  themes.forEach((t, i) => {
    t.priority = i + 1;
  });

  const result = {
    generatedAt: new Date().toISOString(),
    stats: {
      totalFindings: clustersRaw.stats?.totalInputFindings || clusters.length,
      totalClusters: clusters.length,
      totalThemes: themes.length,
      heuristicMatched,
      llmAssigned: clusters.length - heuristicMatched - (themeMap.uncategorized?.clusters.length || 0),
      uncategorized: themeMap.uncategorized?.clusters.length || 0,
    },
    themes,
  };

  if (!DRY_RUN) {
    fs.writeFileSync(THEMES_FILE, JSON.stringify(result, null, 2));
    log(`Wrote ${themes.length} themes to finding-themes.json`);
  }

  if (JSON_MODE) {
    console.log(JSON.stringify(result));
    return;
  }

  // Markdown summary
  console.log(`\n## Finding Themes (${themes.length} themes from ${clusters.length} clusters)\n`);
  console.log("| # | Theme | Findings | Clusters | Pages | Severity |");
  console.log("|---|-------|----------|----------|-------|----------|");
  for (const t of themes) {
    console.log(
      `| ${t.priority} | ${t.title} | ${t.findingCount} | ${t.clusterCount} | ${t.affectedPages.length} | ${t.severity} |`
    );
  }
  console.log();

  if (themes.length > 0) {
    console.log("### Top 5 Actionable Themes\n");
    for (const t of themes.slice(0, 5)) {
      console.log(`**${t.priority}. ${t.title}** (${t.findingCount} findings)`);
      console.log(`   Action: ${t.suggestedAction}`);
      console.log(`   Pages: ${t.affectedPages.slice(0, 5).join(", ")}`);
      console.log();
    }
  }
}

function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Theme-to-MOC batch generation
// ---------------------------------------------------------------------------

const QUEUE_PATH = path.join(STATE, "moc-queue.json");

const THEME_MOC_ELIGIBLE_SEVERITIES = new Set(["security", "bug", "ux"]);
const THEME_MOC_MIN_FINDINGS = 5;

/**
 * Generate batch MOCs from high-priority themes.
 *
 * NOTE (2026-02-25): Theme MOCs are now TRACKING/UMBRELLA MOCs only, not fix targets.
 * findings-to-mocs.js creates per-issue MOCs with fine-grained cluster keys
 * (tier::changeType::pageGroup::issueSignature). Those are what gets auto-fixed.
 * Theme MOCs provide cross-cutting visibility but should NOT go to auto-fix.
 *
 * Returns the number of MOCs created.
 */
function generateThemeMocs() {
  const themesData = loadJSON(THEMES_FILE);
  if (!themesData || !Array.isArray(themesData.themes)) {
    log("No themes data — skipping theme-to-MOC generation");
    return 0;
  }

  // Load existing queue
  let created = 0;

  withStateLock("moc-queue.json", (queue) => {
    if (!Array.isArray(queue.mocs)) {
      queue.mocs = [];
    }

    // Index existing theme-sourced MOCs for dedup
    const existingThemePatterns = new Set();
    for (const moc of queue.mocs) {
      if (moc.source === "theme-consolidation" && moc.status !== "archived") {
        const patternMatch = moc._themePattern || "";
        if (patternMatch) {
          existingThemePatterns.add(patternMatch);
        }
      }
    }

    for (const theme of themesData.themes) {
      if (theme.findingCount < THEME_MOC_MIN_FINDINGS) {
        continue;
      }
      if (!THEME_MOC_ELIGIBLE_SEVERITIES.has(theme.severity)) {
        continue;
      }
      if (theme.pattern === "uncategorized") {
        continue;
      }
      if (existingThemePatterns.has(theme.pattern)) {
        log(`Dedup: theme "${theme.pattern}" already has active MOC — skipping`);
        continue;
      }

      const tier = theme.severity === "security" ? "needs_approval" : "auto_approve";
      const changeType = theme.severity === "security" ? "security"
        : theme.severity === "bug" ? "bug_fix"
        : "ui_ux";

      const id = `moc-theme-${theme.pattern}-${Date.now().toString(36)}`;
      const pages = (theme.affectedPages || []).slice(0, 10).join(", ") || "multiple";
      const personas = (theme.affectedPersonas || []).slice(0, 10).join(", ") || "various";
      const primaryPage = (theme.affectedPages || [])[0] || null;

      const moc = {
        id,
        title: `[Theme] ${theme.title}`,
        description: [
          `**Tier:** ${tier}`,
          `**Theme:** ${theme.pattern} (${theme.findingCount} findings across ${theme.clusterCount} clusters)`,
          `**Severity:** ${theme.severity}`,
          `**Page area:** ${pages}`,
          `**Personas:** ${personas}`,
          "",
          `### Suggested Action`,
          theme.suggestedAction || "Review affected areas",
        ].join("\n"),
        tier,
        category: "standard",
        status: "implemented",
        source: "theme-consolidation",
        _trackingOnly: true,
        implementedAt: new Date().toISOString(),
        implementationNotes: "Tracking MOC — individual per-issue MOCs handle actual fixes via findings-to-mocs.js",
        pageGroup: primaryPage,
        persona: (theme.affectedPersonas || [])[0] || "System",
        changeType,
        changeTypeLabel: changeType === "security" ? "Security" : changeType === "bug_fix" ? "Bug Fix" : "UI/UX Redesign",
        riskLevel: tier === "needs_approval" ? "high" : "medium",
        reviewDepth: tier === "needs_approval" ? "Full" : "Standard",
        routedDepartments: ["Engineering"],
        requiresManagement: false,
        findings: [],
        affectedFiles: [],
        submittedAt: new Date().toISOString(),
        iteration: 0,
        autoFixFailures: 0,
        _themePattern: theme.pattern,
        _themeFindingCount: theme.findingCount,
        _themeClusterCount: theme.clusterCount,
      };

      moc.approvedAt = new Date().toISOString();
      moc.managementApprovers = [];

      queue.mocs.push(moc);
      existingThemePatterns.add(theme.pattern);
      created++;
      log(`Created theme MOC: [${tier}] ${theme.title} (${theme.findingCount} findings)`);
    }
  }, { version: 2, mocs: [] });

  if (created > 0) {
    log(`Wrote ${created} theme MOCs to moc-queue.json`);
  } else {
    log("No new theme MOCs needed");
  }

  return created;
}

if (require.main === module) {
  main()
    .then(() => {
      if (!DRY_RUN) {
        generateThemeMocs();
      }
    })
    .catch((err) => {
      console.error(`[consolidate-themes] ${err.message}`);
      process.exit(1);
    });
}

module.exports = { main, generateThemeMocs, THEME_PATTERNS, matchTheme };
