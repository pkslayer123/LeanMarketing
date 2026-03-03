#!/usr/bin/env node

/**
 * Invoke Analyst — Flexible AI backend for the test-fix loop.
 *
 * Replaces hardcoded Claude calls. Supports multiple backends via LOOP_ANALYST env.
 *
 * Usage:
 *   node scripts/e2e/invoke-analyst.js --report <path> [--prompt-file <path>] [--screenshots <path1,path2>] [--iteration N] [--output <path>]
 *
 * Env:
 *   LOOP_ANALYST=claude|cursor|cursor-agent|gemini|openai|none   (default: claude)
 *   LOOP_ANALYST_CMD=<command>        (when LOOP_ANALYST=custom, run this; receives REPORT, PROMPT_FILE, SCREENSHOTS, ITERATION via env)
 *
 * Modes:
 *   claude        — Run `claude -p [prompt] [report] [screenshots]`. Writes output to --output or stdout.
 *   gemini        — Use GEMINI_API_KEY via API. No Anthropic needed. Writes analysis to --output.
 *   openai        — Use OPENAI_API_KEY via API. No Anthropic needed. Writes analysis to --output.
 *   cursor        — Same as cursor-agent: invoke Cursor CLI agent to apply fixes. Loop waits for agent to complete.
 *   cursor-agent  — Write request file, then run `agent -p "..."` to invoke Cursor CLI agent (applies fixes automatically).
 *   none          — Skip. Exit 0.
 *   custom        — Run LOOP_ANALYST_CMD with env vars set.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { callLLMWithRetry, getConfig } = require("./llm-e2e");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const REQUEST_FILE = path.join(STATE_DIR, "loop-analysis-request.md");

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  const getList = (name) => {
    const v = get(name);
    return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
  };
  return {
    report: get("--report"),
    promptFile: get("--prompt-file"),
    screenshots: getList("--screenshots"),
    iteration: parseInt(get("--iteration") ?? "1", 10),
    output: get("--output"),
    outputBranch: process.argv.includes("--output-branch") || process.env.LOOP_ANALYST_OUTPUT_BRANCH === "1",
  };
}

async function runApiAnalyst(provider, reportPath, prompt, outputPath) {
  const prevProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = provider;
  // Cost-effective defaults. Override via LOOP_ANALYST_OPENAI_MODEL or LOOP_ANALYST_GEMINI_MODEL when situation calls for a stronger model.
  const model =
    provider === "openai"
      ? (process.env.LOOP_ANALYST_OPENAI_MODEL ?? "gpt-4o-mini")
      : process.env.LOOP_ANALYST_GEMINI_MODEL ?? "gemini-2.5-flash";
  try {
    const reportContent = fs.readFileSync(reportPath, "utf-8");
    const fullPrompt = `${prompt}\n\n---\n\nReport:\n\n${reportContent.slice(0, 120000)}`;
    const result = await callLLMWithRetry({
      prompt: fullPrompt,
      systemPrompt:
        "You are an E2E test analyst. Analyze the report and produce a markdown analysis with: (1) Executive summary, (2) Top issues to fix, (3) Recommended fixes with affected paths (e.g. /api/..., app/api/.../route.ts). Be concrete. Mention specific files and patterns.",
      maxTokens: 4096,
      temperature: 0.2,
      jsonMode: false,
      model,
      component: "analyst",
    });
    const content = typeof result === "string" ? result : String(result ?? "");
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, content);
      console.log("Analysis written to:", outputPath);
    } else {
      process.stdout.write(content);
    }
    return 0;
  } finally {
    if (prevProvider !== undefined) process.env.LLM_PROVIDER = prevProvider;
    else delete process.env.LLM_PROVIDER;
  }
}

function resolveAnalystDefault() {
  const env = (process.env.LOOP_ANALYST ?? "").trim().toLowerCase();
  if (env && ["claude", "cursor", "cursor-agent", "gemini", "openai", "none", "custom"].includes(env)) {
    return env;
  }
  // Prefer analyst that can make code edits: cursor-agent > claude > gemini/openai (API-only)
  const agentCheck = spawnSync("agent", ["--version"], { cwd: ROOT, encoding: "utf-8", stdio: "pipe" });
  const agentOk = agentCheck.status === 0 || ((agentCheck.stdout ?? "") + (agentCheck.stderr ?? "")).includes("agent");
  if (agentOk) return "cursor-agent";
  const claudeCheck = spawnSync("claude", ["--version"], { cwd: ROOT, encoding: "utf-8", stdio: "pipe" });
  const claudeOk = claudeCheck.status === 0 || ((claudeCheck.stdout ?? "") + (claudeCheck.stderr ?? "")).includes("claude");
  if (claudeOk) return "claude";
  if (process.env.GEMINI_API_KEY?.trim()) return "gemini";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  return "claude";
}

function main() {
  const { report, promptFile, screenshots, iteration, output, outputBranch } = parseArgs();
  const analyst = resolveAnalystDefault();

  // Persona questions: non-blocking design (longer feedback loop).
  // Analyst proceeds; answered questions are in the prompt. Pending can be answered later.
  const guardrailsCheck = spawnSync("node", [path.join(ROOT, "scripts", "e2e", "guardrails.js"), "--check", "--json"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (guardrailsCheck.status === 1) {
    try {
      const out = guardrailsCheck.stdout || guardrailsCheck.stderr || "{}";
      const gr = JSON.parse(out);
      if (gr.pendingCount > 0) {
        console.error(
          "Note:",
          gr.pendingCount,
          "persona question(s) pending. Answer when ready: node scripts/e2e/answer-persona-questions.js"
        );
      }
    } catch {
      // ignore
    }
  }

  if (analyst === "none") {
    console.log("LOOP_ANALYST=none — skipping analysis");
    process.exit(0);
  }

  if (!report || !fs.existsSync(report)) {
    console.error("invoke-analyst: --report path required and must exist");
    process.exit(1);
  }

  const prompt = promptFile && fs.existsSync(promptFile)
    ? fs.readFileSync(promptFile, "utf-8").trim()
    : "Analyze this E2E test report and suggest fixes. Apply fixes you are confident about.";

  function writeCursorRequestFile() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const lines = [
      "# Loop Analysis Request",
      "",
      `Iteration: ${iteration}`,
      `Report: ${report}`,
      "",
      "## Guardrails (all analysts must follow)",
      "",
      "**Before starting:** Check `e2e/state/guardrails.json` for pending questions. If any exist, the human must answer them first (`node scripts/e2e/guardrails.js --answer <id> \"your answer\"`).",
      "",
      "**Autonomous-first:** Fix everything automatically. Only escalate if your fix contradicts a Protected SME Decision in docs/BUILD-SPEC.md (`node scripts/e2e/guardrails.js --add spec_conflict \"...\" --context \"Protected decision: ...\" --iteration " + iteration + "`) or requires a database migration (`node scripts/e2e/guardrails.js --add migration \"...\" --context \"...\" --iteration " + iteration + "`).",
      "",
      "**Answered questions:** Run `node scripts/e2e/guardrails.js --list-answered --json` to see prior answers. Apply those decisions.",
      "",
      "**MOC workflow (ChangePilot dogfooding):** Code changes flow through our own MOC process. Check the prompt for APPROVED MOCs ready to implement. After implementing each, run: `node scripts/e2e/submit-moc.js --complete <moc-id> --notes \"Brief description\"`. Do NOT implement MOCs with status `pending_review` (those need management approval).",
      "",
      "## Prompt",
      "",
      "```",
      prompt,
      "```",
      "",
      "## Screenshots",
      screenshots.length > 0 ? screenshots.map((s) => `- ${s}`).join("\n") : "(none)",
      "",
      "## Instructions",
      "",
      "1. Open e2e/state/loop-dashboard.md — single consolidated view (persona questions, triage, fleet health, iteration report).",
      "2. Open the iteration report file in Cursor.",
      "3. Check guardrails.json for pending questions; answer or skip before proceeding.",
      "",
      "4. Check e2e/state/unresolved-bugs.json — if any unresolved bugs exist, consider addressing the top one.",
      "5. Use the prompt above to analyze findings and apply fixes.",
      "6. Save your analysis to e2e/reports/analysis-iter-" + iteration + "-<timestamp>.md",
      "7. Apply fixes: run `node scripts/e2e/apply-fixes-from-analysis.js e2e/reports/analysis-iter-" + iteration + "-*.md --force` (or the loop will run it on next iteration).",
      "8. Press Enter in the loop terminal to continue.",
      "",
    ];
    fs.writeFileSync(REQUEST_FILE, lines.join("\n"));
    return REQUEST_FILE;
  }

  // cursor and cursor-agent both invoke the Cursor CLI agent — loop waits for fixes before next iteration
  if (analyst === "cursor" || analyst === "cursor-agent") {
    writeCursorRequestFile();
    const outputPath = output ?? path.join(ROOT, "e2e", "reports", `analysis-iter${iteration}-${Date.now()}.md`);
    const relOutput = path.relative(ROOT, outputPath).replace(/\\/g, "/");
    const agentPrompt = [
      "You are the E2E loop analyst. Read e2e/state/loop-analysis-request.md in full.",
      "Apply ALL fixes it describes: edit app code, tests, manifest, and run any suggested commands.",
      `After applying fixes, save your analysis to ${relOutput}`,
      `Then run: node scripts/e2e/apply-fixes-from-analysis.js ${relOutput} --force`,
      "If you resolve any unresolved bugs (from e2e/state/unresolved-bugs.json), add 'Resolved ub-XXX' in your analysis.",
    ].join(" ");
    console.log("Invoking Cursor agent to apply fixes...");
    // Cursor CLI: "agent -p 'prompt'" (cursor.com/install). Fallback: "cursor agent -p" if agent not in PATH.
    let r = spawnSync("agent", ["-p", agentPrompt], { cwd: ROOT, stdio: "inherit", shell: true });
    if (r.error) {
      r = spawnSync("cursor", ["agent", "-p", agentPrompt], { cwd: ROOT, stdio: "inherit", shell: true });
    }
    if (output && fs.existsSync(outputPath)) {
      try {
        fs.copyFileSync(outputPath, output);
      } catch {}
    }
    process.exit(r.status ?? 0);
  }

  if (analyst === "gemini" || analyst === "openai") {
    const config = getConfig();
    if (!config.primary || config.primary.provider !== analyst) {
      const keyName = analyst === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
      console.error(`invoke-analyst: LOOP_ANALYST=${analyst} requires ${keyName}`);
      process.exit(1);
    }
    const outputPath = output ?? path.join(ROOT, "e2e", "reports", `analysis-iter${iteration}-${Date.now()}.md`);
    (async () => {
      try {
        const code = await runApiAnalyst(analyst, report, prompt, outputPath);
        process.exit(code);
      } catch (e) {
        console.error("API analyst failed:", e.message);
        process.exit(1);
      }
    })();
    return;
  }

  if (analyst === "custom") {
    const cmd = process.env.LOOP_ANALYST_CMD;
    if (!cmd) {
      console.error("LOOP_ANALYST=custom requires LOOP_ANALYST_CMD");
      process.exit(1);
    }
    const guardrailsPath = path.join(STATE_DIR, "guardrails.json");
    const env = {
      ...process.env,
      LOOP_REPORT: report,
      LOOP_PROMPT_FILE: promptFile ?? "",
      LOOP_SCREENSHOTS: screenshots.join(","),
      LOOP_ITERATION: String(iteration),
      LOOP_OUTPUT: output ?? "",
      LOOP_GUARDRAILS_FILE: fs.existsSync(guardrailsPath) ? guardrailsPath : "",
    };
    const parts = cmd.split(/\s+/);
    const prog = parts[0];
    const cargs = parts.slice(1);
    const r = spawnSync(prog, cargs, { env, stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  if (analyst === "claude") {
    try {
      // -p = non-interactive. --permission-mode acceptEdits = apply edits without prompting (Claude Code headless).
      const claudeArgs = ["-p", prompt, report, ...screenshots];
      if (process.env.LOOP_CLAUDE_AUTO_ACCEPT !== "0") {
        claudeArgs.push("--permission-mode", "acceptEdits");
      }
      const r = spawnSync("claude", claudeArgs, {
        stdio: ["inherit", "pipe", "inherit"],
        encoding: "utf-8",
      });
      const out = r.stdout ?? "";
      let outputPath = output;
      if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, out);
        console.log("Analysis written to:", outputPath);
      } else {
        process.stdout.write(out);
      }

      if (outputBranch && outputPath && fs.existsSync(outputPath)) {
        const branchName = `analysis/iter-${iteration}`;
        const { execSync } = require("child_process");
        const relPath = path.relative(ROOT, path.resolve(ROOT, outputPath));
        try {
          execSync(`git checkout -b ${branchName}`, { cwd: ROOT, stdio: "pipe" });
          execSync(`git add "${relPath.replace(/\\/g, "/")}"`, { cwd: ROOT, stdio: "pipe" });
          execSync(`git commit -m "analysis: iter ${iteration}"`, { cwd: ROOT, stdio: "pipe" });
          execSync(`git push -u origin ${branchName}`, { cwd: ROOT, stdio: "inherit" });
          console.log("Pushed to branch:", branchName, "- human can open PR to main");
        } catch (e) {
          console.error("Output-branch failed:", e.message);
        }
      }
      process.exit(r.status ?? 0);
    } catch (e) {
      console.error("Claude invocation failed:", e.message);
      process.exit(1);
    }
  }

  console.error("Unknown LOOP_ANALYST:", analyst, "— use claude|cursor|cursor-agent|none|custom");
  process.exit(1);
}

main();
