#!/usr/bin/env node

/**
 * Evolve Traits — Post-iteration LLM-driven persona trait evolution.
 *
 * Loads persona learning data, calls evolvePersonaTraitsWithLLM() to
 * analyze finding patterns and suggest trait shifts, then saves results.
 *
 * Usage:
 *   node scripts/e2e/evolve-traits.js          # Evolve traits using LLM
 *   node scripts/e2e/evolve-traits.js --dry-run # Show what would evolve without saving
 *   node scripts/e2e/evolve-traits.js --json    # JSON output
 *
 * Called by: run-loop-hooks.js after-iteration phase
 *
 * Requires: OPENAI_API_KEY or GEMINI_API_KEY in environment
 */

const path = require("path");
const fs = require("fs");

// Load .env files for API keys
const ROOT = path.resolve(__dirname, "..", "..");
for (const envFile of [
  path.join(ROOT, ".env.local"),
  path.join(ROOT, "e2e", ".env"),
]) {
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.substring(0, eq).trim();
        let val = trimmed.substring(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const JSON_MODE = args.includes("--json");

const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");

function loadLearningData() {
  if (!fs.existsSync(LEARNING_FILE)) {
    return { personas: {}, lastUpdated: new Date().toISOString() };
  }
  try {
    return JSON.parse(fs.readFileSync(LEARNING_FILE, "utf-8"));
  } catch {
    return { personas: {}, lastUpdated: new Date().toISOString() };
  }
}

function saveLearningData(data) {
  const dir = path.dirname(LEARNING_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(LEARNING_FILE, JSON.stringify(data, null, 2));
}

async function main() {
  const data = loadLearningData();
  const personaCount = Object.keys(data.personas).length;

  if (personaCount === 0) {
    if (JSON_MODE) {
      console.log(JSON.stringify({ evolved: 0, message: "No persona data" }));
    } else {
      console.log("[evolve-traits] No persona learning data yet. Run tests first.");
    }
    return;
  }

  // Check for LLM API key
  const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim();
  const hasGemini = !!process.env.GEMINI_API_KEY?.trim();

  if (!hasOpenAI && !hasGemini) {
    if (JSON_MODE) {
      console.log(JSON.stringify({ evolved: 0, message: "No LLM API key" }));
    } else {
      console.log("[evolve-traits] No OPENAI_API_KEY or GEMINI_API_KEY. Using hardcoded rules only.");
    }
    // Apply hardcoded rules (already in suggestedTraitShift from recordPersonaRun)
    return;
  }

  if (!JSON_MODE) {
    console.log(`[evolve-traits] Evolving traits for ${personaCount} personas via LLM...`);
  }

  try {
    // Dynamic import of the TypeScript module via ts-node or pre-compiled
    // The persona-learner.ts exports evolvePersonaTraitsWithLLM
    // We need to use require with ts-node registration or use the compiled version
    let evolvePersonaTraitsWithLLM;
    try {
      // Try requiring the compiled JS version first
      const learner = require(path.join(ROOT, "e2e", "lib", "persona-learner"));
      evolvePersonaTraitsWithLLM = learner.evolvePersonaTraitsWithLLM;
    } catch {
      // Fallback: register ts-node and require the TS file
      try {
        require("ts-node").register({
          transpileOnly: true,
          compilerOptions: { module: "commonjs" },
        });
        const learner = require(path.join(ROOT, "e2e", "lib", "persona-learner.ts"));
        evolvePersonaTraitsWithLLM = learner.evolvePersonaTraitsWithLLM;
      } catch (err) {
        if (!JSON_MODE) {
          console.log(`[evolve-traits] Cannot load persona-learner: ${err.message}`);
          console.log("[evolve-traits] Skipping LLM evolution (ts-node not available).");
        } else {
          console.log(JSON.stringify({ evolved: 0, message: "Cannot load persona-learner" }));
        }
        return;
      }
    }

    const evolutions = await evolvePersonaTraitsWithLLM(data);

    if (!DRY_RUN) {
      saveLearningData(data);
    }

    if (JSON_MODE) {
      console.log(
        JSON.stringify({
          evolved: evolutions.length,
          dryRun: DRY_RUN,
          evolutions: evolutions.map((e) => ({
            personaId: e.personaId,
            shifts: e.shifts,
            rationale: e.rationale.slice(0, 100),
          })),
        })
      );
    } else {
      if (evolutions.length === 0) {
        console.log("[evolve-traits] No trait shifts suggested by LLM.");
      } else {
        console.log(`[evolve-traits] Evolved ${evolutions.length} persona(s)${DRY_RUN ? " (dry run)" : ""}:`);
        for (const evo of evolutions) {
          const shifts = Object.entries(evo.shifts)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          console.log(`  ${evo.personaId}: ${shifts}`);
          if (evo.rationale) {
            console.log(`    Rationale: ${evo.rationale.slice(0, 120)}`);
          }
        }
      }
    }
  } catch (err) {
    if (JSON_MODE) {
      console.log(JSON.stringify({ evolved: 0, error: err.message }));
    } else {
      console.log(`[evolve-traits] LLM evolution failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("[evolve-traits] Fatal error:", err.message);
  process.exit(1);
});
