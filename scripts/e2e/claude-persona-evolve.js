#!/usr/bin/env node

/**
 * Claude Persona Evolution Analyzer — Uses Claude CLI to analyze persona
 * effectiveness and recommend test scenario changes.
 *
 * Reads persona learning data and recent findings, then asks Claude to
 * recommend new test scenarios, deprecated paths, trait adjustments, and
 * new invariants for each persona with sufficient run history.
 *
 * This is an analysis/classification task (not code generation), so it
 * uses haiku for cost efficiency.
 *
 * Output is written to e2e/state/persona-evolution-recommendations.json
 * for human review. No changes are auto-applied.
 *
 * Usage:
 *   node scripts/e2e/claude-persona-evolve.js              # Analyze all eligible personas
 *   node scripts/e2e/claude-persona-evolve.js --dry-run     # Preview prompts, don't invoke Claude
 *   node scripts/e2e/claude-persona-evolve.js --max 5       # Limit to 5 personas
 *   node scripts/e2e/claude-persona-evolve.js --persona oscar-outsider  # Single persona
 *   node scripts/e2e/claude-persona-evolve.js --json        # Machine-readable output
 *   node scripts/e2e/claude-persona-evolve.js --min-runs 10 # Require 10+ runs (default 5)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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

const ROOT = path.resolve(__dirname, "..", "..");
const STATE = path.join(ROOT, "e2e", "state");
const LEARNING_FILE = path.join(STATE, "persona-learning.json");
const FINDINGS_FILE = path.join(STATE, "findings", "findings.json");
const OUTPUT_FILE = path.join(STATE, "persona-evolution-recommendations.json");
const PROMPT_FILE = path.join(STATE, "evolve-prompt-tmp.md");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const JSON_OUTPUT = args.includes("--json");

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const MAX_PERSONAS = parseInt(getArg("--max") ?? "10", 10);
const MIN_RUNS = parseInt(getArg("--min-runs") ?? "5", 10);
const SINGLE_PERSONA = getArg("--persona");

function log(msg) {
  if (!JSON_OUTPUT) {
    console.log(`[claude-persona-evolve] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function readJson(filePath, defaultVal) {
  if (!fs.existsSync(filePath)) {
    return defaultVal;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return defaultVal;
  }
}

function loadLearningData() {
  return readJson(LEARNING_FILE, { personas: {}, lastUpdated: "" });
}

function loadFindings() {
  return readJson(FINDINGS_FILE, []);
}

// ---------------------------------------------------------------------------
// Claude CLI availability check
// ---------------------------------------------------------------------------

function isClaudeAvailable() {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Persona analysis
// ---------------------------------------------------------------------------

/**
 * Build a summary string for a single persona's learning data.
 */
function buildPersonaSummary(personaId, entry, personaFindings) {
  const lines = [];
  lines.push(`## Persona: ${personaId}`);
  lines.push(`- Total runs: ${entry.totalRuns}`);
  lines.push(`- Total findings: ${entry.totalFindings}`);
  lines.push(`- Finding rate: ${entry.findingRate.toFixed(2)} per run`);
  lines.push(`- Top finding types: ${(entry.topFindingTypes || []).join(", ") || "(none)"}`);
  lines.push(`- Focus areas: ${(entry.focusAreas || []).join(", ") || "(none)"}`);
  lines.push(`- Vision findings: ${entry.visionFindingCount ?? 0}`);
  lines.push(`- Error association rate: ${((entry.errorAssociationRate ?? 0) * 100).toFixed(0)}%`);

  // Current trait shifts
  const shifts = entry.suggestedTraitShift || {};
  if (Object.keys(shifts).length > 0) {
    lines.push(`- Current traits: ${Object.entries(shifts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  } else {
    lines.push(`- Current traits: (none set)`);
  }

  // Friction baselines
  const friction = entry.frictionBaselines || {};
  const frictionEntries = Object.entries(friction);
  if (frictionEntries.length > 0) {
    const avgActions = frictionEntries.reduce((sum, [, b]) => sum + b.avgActionCount, 0) / frictionEntries.length;
    lines.push(`- Avg friction: ${avgActions.toFixed(1)} actions/workflow (${frictionEntries.length} workflows)`);
  }

  // Recent findings from learning data
  const recentFromLearning = (entry.recentFindings || []).slice(0, 5);
  if (recentFromLearning.length > 0) {
    lines.push(`\n### Recent findings (from learning):`);
    for (const f of recentFromLearning) {
      lines.push(`  - [${f.severity}] ${f.page}: ${(f.description || "").slice(0, 120)}`);
    }
  }

  // Recent findings from findings.json for this persona
  const relevantFindings = personaFindings.slice(0, 10);
  if (relevantFindings.length > 0) {
    lines.push(`\n### Recent findings (from findings.json):`);
    for (const f of relevantFindings) {
      const status = f.status || "open";
      lines.push(`  - [${f.severity}] ${status} | ${f.page}: ${(f.description || "").slice(0, 120)}`);
      if (f.occurrences > 1) {
        lines.push(`    (${f.occurrences} occurrences, first: ${f.firstSeen || "?"}, last: ${f.lastSeen || "?"})`);
      }
    }
  }

  // Pages visited (from focus areas) vs pages with findings
  const findingPages = {};
  for (const f of personaFindings) {
    const page = normalizePath(f.page || "");
    if (page) {
      findingPages[page] = (findingPages[page] || 0) + 1;
    }
  }
  if (Object.keys(findingPages).length > 0) {
    lines.push(`\n### Finding distribution by page:`);
    const sorted = Object.entries(findingPages).sort(([, a], [, b]) => b - a).slice(0, 10);
    for (const [page, count] of sorted) {
      lines.push(`  - ${page}: ${count} findings`);
    }
  }

  // Coverage profile
  const coverage = (entry.coverageProfile || []).slice(0, 10);
  if (coverage.length > 0) {
    lines.push(`\n### Code coverage areas (top 10):`);
    for (const c of coverage) {
      lines.push(`  - ${c}`);
    }
  }

  // Triage history summary
  const triage = entry.triageHistory || [];
  if (triage.length > 0) {
    const actionCounts = {};
    for (const t of triage) {
      const action = t.action || "unknown";
      actionCounts[action] = (actionCounts[action] || 0) + 1;
    }
    lines.push(`\n### Triage history (${triage.length} entries):`);
    for (const [action, count] of Object.entries(actionCounts)) {
      lines.push(`  - ${action}: ${count}`);
    }
  }

  return lines.join("\n");
}

/**
 * Normalize a page path by stripping UUIDs.
 */
function normalizePath(p) {
  return p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[id]");
}

/**
 * Build the full Claude prompt for analyzing a batch of personas.
 */
function buildPrompt(personaSummaries) {
  return `You are an expert E2E test strategist analyzing persona-driven testing effectiveness for a SaaS platform (ChangePilot — Management of Change workflows).

Each persona is a simulated user with specific traits (role, department, security focus, etc.) that runs automated E2E tests. The system tracks what each persona finds, where they find it, and how their effectiveness changes over time.

Analyze the following persona data and provide recommendations for each one.

## Recommendation Types

For each persona, recommend zero or more of the following:

1. **add_scenario** — A new test scenario to add (specific page + check type). Use when:
   - A persona's focus area has shifted and they should test new pages
   - A finding pattern suggests an untested related area
   - A page has many findings from OTHER personas but this persona hasn't tested it yet

2. **remove_scenario** — A deprecated test path to remove. Use when:
   - A page/check consistently returns zero findings across many runs (5+)
   - The page is in focus areas but never produces actionable results
   - A page was tested extensively and all issues are resolved

3. **adjust_trait** — A trait adjustment recommendation. Valid traits and values:
   - riskTolerance: cautious | moderate | aggressive
   - patience: low | medium | high
   - intent: compliant | curious | probing | adversarial
   - experience: novice | intermediate | expert
   Use when trait shifts would improve finding quality or efficiency.

4. **add_invariant** — A new invariant or oracle check type. Use when:
   - Recurring finding patterns suggest a systematic check would catch similar issues
   - A persona repeatedly finds the same category of issue across multiple pages

5. **deprioritize** — Reduce this persona's test frequency. Use when:
   - Very low finding rate despite many runs
   - Findings are consistently classified as noise or product suggestions
   - Another persona covers the same ground more effectively

## Confidence Scoring

- 0.9-1.0: Clear data pattern, high certainty
- 0.7-0.89: Strong pattern but some ambiguity
- 0.5-0.69: Suggestive pattern, worth trying
- Below 0.5: Don't include

## Output Format

Respond with ONLY valid JSON (no markdown code fences, no explanation text):

{
  "recommendations": [
    {
      "personaId": "persona-id",
      "type": "add_scenario|remove_scenario|adjust_trait|add_invariant|deprioritize",
      "description": "Clear, actionable description",
      "confidence": 0.8,
      "reasoning": "Why this recommendation based on the data"
    }
  ]
}

---

## Persona Data

${personaSummaries.join("\n\n---\n\n")}

---

Analyze each persona and provide concrete, data-driven recommendations. Focus on actionable changes that would improve testing effectiveness. If a persona is performing well with no changes needed, skip it entirely.`;
}

// ---------------------------------------------------------------------------
// Claude CLI invocation
// ---------------------------------------------------------------------------

/**
 * Invoke Claude CLI for analysis.
 * Returns parsed JSON recommendations or null on failure.
 */
function invokeClaude(prompt) {
  const model = "haiku";
  const budget = "0.20";

  // Write prompt to temp file to avoid shell escaping issues
  fs.writeFileSync(PROMPT_FILE, prompt);

  try {
    const result = execSync(
      `claude --print --dangerously-skip-permissions --model ${model} --max-budget-usd ${budget} < "${PROMPT_FILE}"`,
      {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000, // 2 minutes
        env: {
          ...process.env,
          CLAUDE_CODE_ENTRYPOINT: "claude-persona-evolve",
          // Unset nesting guard so Claude CLI can launch from within a Claude Code session
          CLAUDECODE: "",
          CLAUDE_CODE: "",
        },
      }
    );

    const output = result.toString().trim();

    // Token accounting
    try {
      const _tl = require("./lib/token-logger");
      const _inEst = Math.ceil((fs.existsSync(PROMPT_FILE) ? fs.statSync(PROMPT_FILE).size : 0) / 4);
      const _outEst = Math.ceil(output.length / 4);
      _tl.logTokenUsage({ component: "persona-evolve", inputTokens: _inEst, outputTokens: _outEst, provider: "claude", model: "haiku" });
    } catch { /* non-fatal */ }

    // Claude may wrap JSON in markdown code fences — strip them
    let jsonStr = output;
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    // Find JSON object boundaries
    const startIdx = jsonStr.indexOf("{");
    const endIdx = jsonStr.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      jsonStr = jsonStr.slice(startIdx, endIdx + 1);
    }

    const parsed = JSON.parse(jsonStr);
    return parsed;
  } catch (err) {
    log(`Claude CLI failed: ${err.message || err}`);
    return null;
  } finally {
    // Clean up temp file
    try {
      if (fs.existsSync(PROMPT_FILE)) {
        fs.unlinkSync(PROMPT_FILE);
      }
    } catch {
      // Best effort
    }
  }
}

/**
 * Call Gemini API when Claude CLI is unavailable. Persona evolution is analysis — Gemini is sufficient.
 * Env: E2E_EVOLVE_MODEL (default: gemini-2.5-flash).
 */
async function invokeGeminiFallback(prompt) {
  const llm = getLlmE2e();
  if (!llm) return null;
  try {
    const model = process.env.E2E_EVOLVE_MODEL ?? "gemini-2.5-flash";
    const raw = await llm.callLLMWithRetry({
      prompt,
      model,
      component: "persona-evolve",
      maxTokens: 2048,
    });
    const output = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    let jsonStr = output;
    const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const startIdx = jsonStr.indexOf("{");
    const endIdx = jsonStr.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      jsonStr = jsonStr.slice(startIdx, endIdx + 1);
    }
    return JSON.parse(jsonStr);
  } catch (err) {
    log(`Gemini fallback error: ${(err.message ?? "").slice(0, 100)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Starting persona evolution analysis...");

  // Claude or Gemini required — skip only if neither available
  const useClaude = !DRY_RUN && isClaudeAvailable();
  const useGemini = !DRY_RUN && !useClaude && getLlmE2e() && (process.env.GEMINI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
  if (!DRY_RUN && !useClaude && !useGemini) {
    log("Claude CLI and API LLM (Gemini/OpenAI) not available — writing empty recommendations.");
    const emptyOutput = {
      generatedAt: new Date().toISOString(),
      recommendations: [],
      meta: { error: "Claude CLI and API LLM not available" },
    };
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(emptyOutput, null, 2));
    if (JSON_OUTPUT) {
      console.log(JSON.stringify(emptyOutput));
    }
    process.exit(0);
  }
  if (useGemini) {
    log("Using Gemini fallback (Claude CLI not available).");
  }

  // Load data
  const learningData = loadLearningData();
  const allFindings = loadFindings();

  const personaEntries = Object.entries(learningData.personas || {});
  log(`Loaded ${personaEntries.length} personas from learning data, ${allFindings.length} findings.`);

  // Filter personas with enough run history
  let eligible = personaEntries.filter(([, entry]) => entry.totalRuns >= MIN_RUNS);

  // Filter to single persona if requested
  if (SINGLE_PERSONA) {
    eligible = eligible.filter(([id]) => id === SINGLE_PERSONA);
    if (eligible.length === 0) {
      const entry = learningData.personas[SINGLE_PERSONA];
      if (entry) {
        log(`Persona ${SINGLE_PERSONA} has only ${entry.totalRuns} runs (need ${MIN_RUNS}). Use --min-runs to lower.`);
      } else {
        log(`Persona ${SINGLE_PERSONA} not found in learning data.`);
      }
      process.exit(0);
    }
  }

  // Sort by total runs (most experienced first) and cap
  eligible.sort(([, a], [, b]) => b.totalRuns - a.totalRuns);
  eligible = eligible.slice(0, MAX_PERSONAS);

  log(`Analyzing ${eligible.length} personas (min ${MIN_RUNS} runs, max ${MAX_PERSONAS}).`);

  if (eligible.length === 0) {
    log("No personas eligible for analysis.");
    const emptyOutput = {
      generatedAt: new Date().toISOString(),
      recommendations: [],
      meta: { reason: "No personas with enough runs" },
    };
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(emptyOutput, null, 2));
    if (JSON_OUTPUT) {
      console.log(JSON.stringify(emptyOutput));
    }
    process.exit(0);
  }

  // Index findings by persona (normalized)
  const findingsByPersona = {};
  for (const f of allFindings) {
    const persona = (f.persona || "Unknown").toLowerCase().replace(/\s+/g, "-");
    if (!findingsByPersona[persona]) {
      findingsByPersona[persona] = [];
    }
    findingsByPersona[persona].push(f);
  }

  // Also collect all findings by normalized page for cross-persona comparison
  const findingsByPage = {};
  for (const f of allFindings) {
    const page = normalizePath(f.page || "");
    if (page) {
      if (!findingsByPage[page]) {
        findingsByPage[page] = [];
      }
      findingsByPage[page].push(f);
    }
  }

  // Build per-persona summaries
  const summaries = eligible.map(([personaId, entry]) => {
    const personaFindings = findingsByPersona[personaId] || [];
    // Also include findings from "Unknown" persona that match this persona's focus areas
    const focusAreas = (entry.focusAreas || []).map(normalizePath);
    const unknownFindings = (findingsByPersona["unknown"] || []).filter((f) => {
      const normalizedPage = normalizePath(f.page || "");
      return focusAreas.some((area) => normalizedPage.startsWith(area) || normalizedPage === area);
    });
    const combined = [...personaFindings, ...unknownFindings].slice(0, 20);
    return buildPersonaSummary(personaId, entry, combined);
  });

  const prompt = buildPrompt(summaries);

  if (DRY_RUN) {
    log(`Dry run — prompt is ${prompt.length} chars for ${eligible.length} personas.`);
    log("Prompt preview (first 500 chars of persona data):");
    const dataStart = prompt.indexOf("## Persona Data");
    if (dataStart !== -1) {
      console.log(prompt.slice(dataStart, dataStart + 500) + "\n...");
    }
    // Write prompt to file for inspection
    fs.writeFileSync(PROMPT_FILE, prompt);
    log(`Full prompt written to ${PROMPT_FILE}`);
    process.exit(0);
  }

  // Invoke Claude or Gemini
  log(useClaude ? "Invoking Claude CLI (haiku)..." : "Invoking Gemini API...");
  const result = useClaude ? invokeClaude(prompt) : await invokeGeminiFallback(prompt);

  if (!result || !Array.isArray(result.recommendations)) {
    log("Failed to get valid recommendations from LLM.");
    const errorOutput = {
      generatedAt: new Date().toISOString(),
      recommendations: [],
      meta: { error: "LLM returned invalid output" },
    };
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(errorOutput, null, 2));
    if (JSON_OUTPUT) {
      console.log(JSON.stringify(errorOutput));
    }
    process.exit(0);
  }

  // Validate and filter recommendations
  const validTypes = ["add_scenario", "remove_scenario", "adjust_trait", "add_invariant", "deprioritize"];
  const validPersonaIds = new Set(eligible.map(([id]) => id));

  const validated = result.recommendations.filter((rec) => {
    if (!rec.personaId || !validPersonaIds.has(rec.personaId)) {
      return false;
    }
    if (!rec.type || !validTypes.includes(rec.type)) {
      return false;
    }
    if (typeof rec.confidence !== "number" || rec.confidence < 0.5) {
      return false;
    }
    if (!rec.description || rec.description.length < 10) {
      return false;
    }
    return true;
  });

  // Build output
  const output = {
    generatedAt: new Date().toISOString(),
    recommendations: validated,
    meta: {
      personasAnalyzed: eligible.length,
      totalRecommendations: validated.length,
      byType: {},
      byPersona: {},
    },
  };

  // Compute meta stats
  for (const rec of validated) {
    output.meta.byType[rec.type] = (output.meta.byType[rec.type] || 0) + 1;
    output.meta.byPersona[rec.personaId] = (output.meta.byPersona[rec.personaId] || 0) + 1;
  }

  // Write output
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  // Audit log
  try {
    const audit = require("./audit-log.js");
    audit.appendAuditLog("persona_evolution_analyzed", process.env.E2E_AUDIT_ACTOR ?? "script", {
      personasAnalyzed: eligible.length,
      recommendations: validated.length,
      types: output.meta.byType,
    });
  } catch {
    // Audit is best-effort
  }

  // Summary output
  log(`Analysis complete: ${validated.length} recommendations for ${eligible.length} personas.`);
  if (validated.length > 0) {
    log("Recommendation summary:");
    for (const [type, count] of Object.entries(output.meta.byType)) {
      log(`  ${type}: ${count}`);
    }
    log("");
    for (const rec of validated.slice(0, 10)) {
      log(`  [${rec.type}] ${rec.personaId} (${rec.confidence.toFixed(1)}): ${rec.description.slice(0, 100)}`);
    }
    if (validated.length > 10) {
      log(`  ... and ${validated.length - 10} more`);
    }
  }
  log(`Output written to ${OUTPUT_FILE}`);

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(output));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[claude-persona-evolve] ${err.message}`);
  process.exit(1);
});
