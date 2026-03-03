/**
 * pipeline-metrics.js — Pipeline accuracy tracking for E2E classification stages.
 *
 * Records classification decisions (triage, tier assignment, fix verification)
 * with metadata so accuracy can be computed per stage over time.
 *
 * State: e2e/state/pipeline-accuracy.json
 * Max 1000 entries per stage (FIFO eviction).
 *
 * Exports:
 *   recordDecision(stage, input, output, metadata)
 *   getStageAccuracy(stage)
 *   getOverview()
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_FILE = path.join(ROOT, "e2e", "state", "pipeline-accuracy.json");

const MAX_ENTRIES_PER_STAGE = 1000;

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { stages: {}, updatedAt: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { stages: {}, updatedAt: null };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Record a classification decision
// ---------------------------------------------------------------------------

/**
 * Record a pipeline classification decision for accuracy tracking.
 *
 * @param {string} stage - Pipeline stage (e.g., "triage", "tier_assignment", "fix_verification", "oracle")
 * @param {object} input - Input data summary (e.g., { findingId, description })
 * @param {object} output - Classification output (e.g., { tier: "auto_fix", reason: "..." })
 * @param {object} [metadata] - Optional metadata (e.g., { correct: true, correctedTo: "noise" })
 */
function recordDecision(stage, input, output, metadata = {}) {
  const state = loadState();

  if (!state.stages[stage]) {
    state.stages[stage] = { entries: [], stats: { total: 0, correct: 0, incorrect: 0, unknown: 0 } };
  }

  const stageData = state.stages[stage];
  const entry = {
    ts: new Date().toISOString(),
    input,
    output,
    ...metadata,
  };

  stageData.entries.push(entry);

  // Update stats if correctness is known
  stageData.stats.total++;
  if (metadata.correct === true) {
    stageData.stats.correct++;
  } else if (metadata.correct === false) {
    stageData.stats.incorrect++;
  } else {
    stageData.stats.unknown++;
  }

  // FIFO eviction
  if (stageData.entries.length > MAX_ENTRIES_PER_STAGE) {
    const removed = stageData.entries.splice(0, stageData.entries.length - MAX_ENTRIES_PER_STAGE);
    // Adjust stats for removed entries
    for (const r of removed) {
      stageData.stats.total--;
      if (r.correct === true) { stageData.stats.correct--; }
      else if (r.correct === false) { stageData.stats.incorrect--; }
      else { stageData.stats.unknown--; }
    }
  }

  saveState(state);
  return entry;
}

// ---------------------------------------------------------------------------
// Query accuracy for a stage
// ---------------------------------------------------------------------------

/**
 * Get accuracy metrics for a pipeline stage.
 *
 * @param {string} stage - Pipeline stage name
 * @returns {{ total: number, correct: number, incorrect: number, unknown: number, accuracy: number|null }}
 */
function getStageAccuracy(stage) {
  const state = loadState();
  const stageData = state.stages[stage];
  if (!stageData) {
    return { total: 0, correct: 0, incorrect: 0, unknown: 0, accuracy: null };
  }

  const { total, correct, incorrect, unknown } = stageData.stats;
  const evaluated = correct + incorrect;
  const accuracy = evaluated > 0 ? correct / evaluated : null;

  return { total, correct, incorrect, unknown, accuracy };
}

// ---------------------------------------------------------------------------
// Overview across all stages
// ---------------------------------------------------------------------------

/**
 * Get accuracy overview for all tracked pipeline stages.
 *
 * @returns {{ stages: Record<string, { total, correct, incorrect, unknown, accuracy }>, updatedAt: string|null }}
 */
function getOverview() {
  const state = loadState();
  const overview = {};

  for (const [stage] of Object.entries(state.stages)) {
    overview[stage] = getStageAccuracy(stage);
  }

  return { stages: overview, updatedAt: state.updatedAt };
}

module.exports = {
  recordDecision,
  getStageAccuracy,
  getOverview,
  STATE_FILE,
};
