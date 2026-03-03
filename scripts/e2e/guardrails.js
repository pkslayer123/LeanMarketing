#!/usr/bin/env node

/**
 * guardrails.js — Autonomous-first guardrails for the test-fix loop
 *
 * Only two categories block the loop (require human decision):
 *   - spec_conflict: Fix contradicts a Protected SME Decision in docs/BUILD-SPEC.md
 *   - migration: Database migration needed (irreversible)
 *
 * Everything else (risky, unclear, persona questions) is auto-resolved — the analyst
 * fixes it and the next test iteration validates.
 *
 * Usage:
 *   node scripts/e2e/guardrails.js --check              # Exit 1 if pending questions exist
 *   node scripts/e2e/guardrails.js --check --json        # JSON output of pending count
 *   node scripts/e2e/guardrails.js --list                # Print all pending questions
 *   node scripts/e2e/guardrails.js --list-answered       # Print answered questions
 *   node scripts/e2e/guardrails.js --add spec_conflict "Q" --context "Protected decision: ..."
 *   node scripts/e2e/guardrails.js --add migration "Q" --context "Why migration is needed"
 *   node scripts/e2e/guardrails.js --answer <id> "text"  # Answer a specific question
 *   node scripts/e2e/guardrails.js --skip <id>          # Mark a question as skipped
 *   node scripts/e2e/guardrails.js --clear-answered     # Remove answered/skipped questions
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const GUARDRAILS_FILE = path.join(ROOT, "e2e", "state", "guardrails.json");

// ---------- Helpers ----------

function nowCentral() {
  return new Date()
    .toLocaleString("sv-SE", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replace(" ", "T") + "-06:00";
}

function loadGuardrails() {
  if (!fs.existsSync(GUARDRAILS_FILE)) {
    return { questions: [] };
  }
  try {
    const raw = fs.readFileSync(GUARDRAILS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!data.questions) {
      data.questions = [];
    }
    return data;
  } catch {
    return { questions: [] };
  }
}

function saveGuardrails(data) {
  const dir = path.dirname(GUARDRAILS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(GUARDRAILS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------- Arg parsing ----------

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) { return null; }
  return args[idx + 1] || null;
}

function hasFlag(name) {
  return args.includes(name);
}

const asJson = hasFlag("--json");

// ---------- Commands ----------

// --check: exit 1 if pending questions, exit 0 otherwise
if (hasFlag("--check")) {
  const data = loadGuardrails();
  const pending = data.questions.filter((q) => q.status === "pending");
  if (asJson) {
    console.log(
      JSON.stringify({
        pendingCount: pending.length,
        pending: pending.map((q) => ({
          id: q.id,
          category: q.category,
          question: q.question,
          context: q.context || "",
          iteration: q.iteration,
          timestamp: q.timestamp,
        })),
      })
    );
  } else {
    if (pending.length > 0) {
      console.log(`${pending.length} pending guardrail question(s).`);
    } else {
      console.log("No pending guardrail questions.");
    }
  }
  process.exit(pending.length > 0 ? 1 : 0);
}

// --list: print pending questions
if (hasFlag("--list")) {
  const data = loadGuardrails();
  const pending = data.questions.filter((q) => q.status === "pending");

  if (pending.length === 0) {
    console.log("No pending questions.");
    process.exit(0);
  }

  const byPersona = hasFlag("--by-persona");
  if (byPersona) {
    const byP = {};
    for (const q of pending) {
      const key = q.persona || "(no persona)";
      if (!byP[key]) byP[key] = [];
      byP[key].push(q);
    }
    console.log(`\nPending Questions by Persona\n`);
    for (const [p, qs] of Object.entries(byP)) {
      console.log(`  ${p} (${qs.length}):`);
      for (const q of qs) {
        console.log(`    [${q.id}] ${q.question.slice(0, 60)}...`);
      }
      console.log("");
    }
  } else {
    console.log(`\nPending Guardrail Questions (${pending.length})\n`);
    console.log("-".repeat(80));
    for (const q of pending) {
      console.log(`  ID:        ${q.id}`);
      if (q.persona) console.log(`  Persona:  ${q.persona}`);
      if (q.page) console.log(`  Page:     ${q.page}`);
      console.log(`  Category:  ${q.category}`);
      console.log(`  Iteration: ${q.iteration}`);
      console.log(`  Time:      ${q.timestamp}`);
      console.log(`  Question:  ${q.question}`);
      if (q.context) {
        console.log(`  Context:   ${q.context}`);
      }
      console.log("-".repeat(80));
    }
  }
  console.log(`\nAnswer: node scripts/e2e/guardrails.js --answer <id> "your answer"`);
  console.log(`Skip:   node scripts/e2e/guardrails.js --skip <id>\n`);
  process.exit(0);
}

// --list-answered: print answered questions (for passing context to Claude)
if (hasFlag("--list-answered")) {
  const data = loadGuardrails();
  const answered = data.questions.filter((q) => q.status === "answered");

  if (asJson) {
    console.log(
      JSON.stringify({
        answeredCount: answered.length,
        answered: answered.map((q) => ({
          id: q.id,
          category: q.category,
          question: q.question,
          answer: q.answer,
          answeredAt: q.answeredAt,
          iteration: q.iteration,
        })),
      })
    );
  } else {
    if (answered.length === 0) {
      console.log("No answered questions.");
      process.exit(0);
    }
    console.log(`\nAnswered Guardrail Questions (${answered.length})\n`);
    console.log("-".repeat(80));
    for (const q of answered) {
      console.log(`  ID:       ${q.id}`);
      console.log(`  Q:        ${q.question}`);
      console.log(`  A:        ${q.answer}`);
      console.log(`  Answered: ${q.answeredAt}`);
      console.log("-".repeat(80));
    }
  }
  process.exit(0);
}

// --answer <id> "text": answer a pending question
const answerId = getArg("--answer");
if (answerId) {
  const answerText = args[args.indexOf("--answer") + 2];
  if (!answerText) {
    console.error('Usage: --answer <id> "your answer text"');
    process.exit(1);
  }

  const data = loadGuardrails();
  const q = data.questions.find((q) => q.id === answerId);
  if (!q) {
    console.error(`Question not found: ${answerId}`);
    process.exit(1);
  }
  if (q.status !== "pending") {
    console.error(`Question ${answerId} is already ${q.status}`);
    process.exit(1);
  }

  q.status = "answered";
  q.answer = answerText;
  q.answeredAt = nowCentral();
  saveGuardrails(data);
  console.log(`Answered question ${answerId}`);
  process.exit(0);
}

// --skip <id>: mark a question as skipped
const skipId = getArg("--skip");
if (skipId) {
  const data = loadGuardrails();
  const q = data.questions.find((q) => q.id === skipId);
  if (!q) {
    console.error(`Question not found: ${skipId}`);
    process.exit(1);
  }

  q.status = "skipped";
  q.answeredAt = nowCentral();
  saveGuardrails(data);
  console.log(`Skipped question ${skipId}`);
  process.exit(0);
}

// --add <category> "question" [--context "context"] [--iteration N] [--persona "Name"] [--page "/path"]: add a new question
const addCategory = getArg("--add");
if (addCategory) {
  const validCategories = ["spec_conflict", "migration"];
  // Legacy categories auto-accepted for backwards compatibility but auto-resolved
  const legacyCategories = ["unclear", "risky", "needs_approval", "persona_question", "persona_hiring"];
  if (!validCategories.includes(addCategory) && !legacyCategories.includes(addCategory)) {
    console.error(`Invalid category: ${addCategory}. Valid: ${validCategories.join(", ")} (legacy: ${legacyCategories.join(", ")})`);
    process.exit(1);
  }

  const questionText = args[args.indexOf("--add") + 2];
  if (!questionText) {
    console.error('Usage: --add <category> "question text" [--context "..."] [--iteration N] [--persona "Name"] [--page "/path"]');
    process.exit(1);
  }

  const context = getArg("--context") || "";
  const iteration = parseInt(getArg("--iteration") || "0", 10);
  const persona = getArg("--persona") || null;
  const page = getArg("--page") || null;

  const data = loadGuardrails();
  // Legacy categories are auto-resolved immediately (analyst should just fix it)
  const isLegacy = legacyCategories.includes(addCategory);
  const newQuestion = {
    id: `q-${Date.now()}`,
    iteration: iteration,
    timestamp: nowCentral(),
    category: addCategory,
    question: questionText,
    context: context,
    status: isLegacy ? "answered" : "pending",
    answer: isLegacy ? "[auto-resolve] Legacy category -- analyst should fix autonomously" : null,
    answeredAt: isLegacy ? nowCentral() : null,
    persona: persona,
    page: page,
  };

  data.questions.push(newQuestion);
  saveGuardrails(data);

  if (asJson) {
    console.log(JSON.stringify({ added: newQuestion }));
  } else {
    if (isLegacy) {
      console.log(`Auto-resolved legacy guardrail: ${newQuestion.id} (${addCategory} -- just fix it)`);
    } else {
      console.log(`Added guardrail question: ${newQuestion.id}`);
    }
    console.log(`  Category: ${addCategory}`);
    console.log(`  Question: ${questionText}`);
  }
  process.exit(0);
}

// --skip-all: mass skip all pending questions
if (hasFlag("--skip-all")) {
  const data = loadGuardrails();
  let skipped = 0;
  const categoryFilter = getArg("--category");
  for (const q of data.questions) {
    if (q.status !== "pending") continue;
    if (categoryFilter && q.category !== categoryFilter) continue;
    q.status = "skipped";
    q.answer = "[mass-skip] Skipped via --skip-all";
    q.answeredAt = nowCentral();
    skipped++;
  }
  saveGuardrails(data);
  console.log(`Skipped ${skipped} pending question(s)${categoryFilter ? ` (category: ${categoryFilter})` : ""}.`);
  process.exit(0);
}

// --auto-resolve-all: resolve all pending questions except spec_conflict and migration
if (hasFlag("--auto-resolve-all")) {
  const data = loadGuardrails();
  let resolved = 0;
  const blockingCategories = ["spec_conflict", "migration"];
  for (const q of data.questions) {
    if (q.status !== "pending") continue;
    if (blockingCategories.includes(q.category)) continue;
    q.status = "answered";
    q.answer = "[auto-resolve] Non-blocking -- analyst fixes autonomously";
    q.answeredAt = nowCentral();
    resolved++;
  }
  saveGuardrails(data);
  const remaining = data.questions.filter((q) => q.status === "pending").length;
  console.log(`Auto-resolved ${resolved} question(s). ${remaining} blocking question(s) remain pending.`);
  process.exit(0);
}

// --clear-answered: remove answered and skipped questions
if (hasFlag("--clear-answered")) {
  const data = loadGuardrails();
  const before = data.questions.length;
  data.questions = data.questions.filter((q) => q.status === "pending");
  const removed = before - data.questions.length;
  saveGuardrails(data);
  console.log(`Cleared ${removed} answered/skipped question(s). ${data.questions.length} pending remain.`);
  process.exit(0);
}

// --lint-titles: warn on test titles with "and" + multiple verbs (topic-of-concern rule)
if (hasFlag("--lint-titles")) {
  const PERSONAS_DIR = path.join(ROOT, "e2e", "tests", "personas");
  const VERB_PATTERN = /\b(should|verify|check|ensure|validate|confirm|test|assert|load|navigate|display|show|create|update|delete|submit|click|open|close|toggle|fetch|render|redirect|prevent|allow|block|deny|accept|reject|handle|process|send)\b/gi;

  if (!fs.existsSync(PERSONAS_DIR)) {
    console.log("No personas directory found.");
    process.exit(0);
  }

  const specFiles = fs.readdirSync(PERSONAS_DIR).filter((f) => f.endsWith(".spec.ts"));
  let warnings = 0;

  for (const file of specFiles) {
    const content = fs.readFileSync(path.join(PERSONAS_DIR, file), "utf-8");
    // Extract test titles from test() and test.describe() calls
    const titleRegex = /test(?:\.describe)?\(\s*["'`]([^"'`]+)["'`]/g;
    let match;
    while ((match = titleRegex.exec(content)) !== null) {
      const title = match[1];
      // Check for " and " in title
      if (!title.includes(" and ")) {
        continue;
      }
      // Count unique verbs
      const verbs = title.match(VERB_PATTERN);
      const uniqueVerbs = new Set((verbs ?? []).map((v) => v.toLowerCase()));
      if (uniqueVerbs.size >= 2) {
        console.warn(`  WARN: ${file}: "${title.slice(0, 70)}..." (${uniqueVerbs.size} verbs: ${[...uniqueVerbs].join(", ")})`);
        warnings++;
      }
    }
  }

  if (warnings > 0) {
    console.log(`\n${warnings} test title warning(s). Consider splitting tests with multiple verbs + "and".`);
  } else {
    console.log("No test title warnings.");
  }
  process.exit(0);
}

// Default: show summary
const data = loadGuardrails();
const pending = data.questions.filter((q) => q.status === "pending");
const answered = data.questions.filter((q) => q.status === "answered");
const skipped = data.questions.filter((q) => q.status === "skipped");

console.log(`\nGuardrails Summary`);
console.log(`  Total:    ${data.questions.length}`);
console.log(`  Pending:  ${pending.length}`);
console.log(`  Answered: ${answered.length}`);
console.log(`  Skipped:  ${skipped.length}`);
console.log(`\nFile: ${GUARDRAILS_FILE}`);
console.log(`\nCommands:`);
console.log(`  --check              Check for pending questions (exit 1 if any)`);
console.log(`  --list               Show pending questions`);
console.log(`  --list --by-persona  Group pending by persona`);
console.log(`  --list-answered      Show answered questions`);
console.log(`  --answer <id> "txt"  Answer a question`);
console.log(`  --skip <id>          Skip a question`);
console.log(`  --add <cat> "txt"    Add a question (cat: spec_conflict, migration). Legacy: unclear, risky, needs_approval, persona_question, persona_hiring (auto-resolved)`);
console.log(`                       Optional: --persona "Name" --page "/path" --context "..."`);
console.log(`  --clear-answered     Remove answered/skipped questions`);
