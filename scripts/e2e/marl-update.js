#!/usr/bin/env node

/**
 * MARL Update — Cooperative Multi-Agent Reinforcement Learning with shared
 * experience replay.
 *
 * Tabular Q-learning where each persona learns cooperative policies. Reward
 * includes diversity bonus (don't duplicate others' coverage). Shared
 * experience replay lets personas learn from each other.
 *
 * Reads:
 *   - e2e/state/persona-learning.json
 *   - e2e/state/findings/findings.json
 *   - e2e/state/green-history.json
 *   - e2e/state/foraging-model.json (for patch info)
 *   - e2e/state/marl-qtable.json (previous state)
 *   - e2e/state/experience-replay.json (previous buffer)
 *
 * Writes:
 *   - e2e/state/marl-qtable.json
 *   - e2e/state/experience-replay.json
 *
 * Usage:
 *   node scripts/e2e/marl-update.js              # Summary report
 *   node scripts/e2e/marl-update.js --json        # Machine-readable output
 *   node scripts/e2e/marl-update.js --export      # Write to state files
 *   node scripts/e2e/marl-update.js --persona <id> # Show Q-table for one persona
 *   node scripts/e2e/marl-update.js --dry-run     # Compute but don't save
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const PERSONA_LEARNING_PATH = path.join(ROOT, "e2e", "state", "persona-learning.json");
const FINDINGS_PATH = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const GREEN_HISTORY_PATH = path.join(ROOT, "e2e", "state", "green-history.json");
const FORAGING_PATH = path.join(ROOT, "e2e", "state", "foraging-model.json");
const QTABLE_PATH = path.join(ROOT, "e2e", "state", "marl-qtable.json");
const REPLAY_PATH = path.join(ROOT, "e2e", "state", "experience-replay.json");

const args = process.argv.slice(2);
const isJson = args.includes("--json");
const doExport = args.includes("--export");
const dryRun = args.includes("--dry-run");
const personaDrill = getArg("--persona");

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function padRight(str, len) {
  return String(str).padEnd(len);
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  learning_rate: 0.1,
  discount_factor: 0.9,
  epsilon_decay: 0.995,
  epsilon_min: 0.05,
  state_features: ["area", "test_mode", "coverage_level"],
  actions: ["explore", "boundary", "fuzz", "regression", "permission"],
};

const DEFAULT_REPLAY_CONFIG = {
  cross_persona_weight: 0.3,
  recency_bias: 0.7,
  batch_size: 32,
};

const MAX_BUFFER_SIZE = 5000;

// ---------------------------------------------------------------------------
// Area and action classification
// ---------------------------------------------------------------------------

const AREA_MAP = {
  "/mocs": "moc-workflow",
  "/moc/:id": "moc-detail",
  "/admin": "admin-config",
  "/admin/permissions": "review-permissions",
  "/admin/people": "admin-people",
  "/admin/departments": "admin-departments",
  "/admin/features": "admin-features",
  "/admin/settings": "admin-settings",
  "/admin/developer": "admin-developer",
  "/admin/errors": "admin-monitoring",
  "/admin/audit": "admin-monitoring",
  "/admin/analytics": "admin-analytics",
  "/review": "review-permissions",
  "/my-department": "department-mgmt",
  "/account": "account-settings",
};

const SEVERITY_REWARD = { security: 10, bug: 6, ux: 3, suggestion: 1 };

function classifyArea(page) {
  if (!page) {
    return "unknown";
  }
  // Normalize page: collapse IDs
  const normalized = page
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+/g, "/:id");

  // Try longest prefix match
  const sortedPrefixes = Object.keys(AREA_MAP).sort((a, b) => b.length - a.length);
  for (const prefix of sortedPrefixes) {
    if (normalized.startsWith(prefix)) {
      return AREA_MAP[prefix];
    }
  }
  return "unknown";
}

function classifyAction(finding) {
  const desc = (finding.description ?? "").toLowerCase();
  const failureType = (finding.failureType ?? "").toLowerCase();

  if (failureType.includes("permission") || desc.includes("permission") || desc.includes("bola")) {
    return "permission";
  }
  if (failureType.includes("boundary") || desc.includes("boundary") || desc.includes("overflow")) {
    return "boundary";
  }
  if (desc.includes("fuzz") || desc.includes("injection") || desc.includes("unicode")) {
    return "fuzz";
  }
  if (desc.includes("regression") || desc.includes("revert")) {
    return "regression";
  }
  return "explore";
}

function classifyCoverageLevel(area, greenHistory) {
  if (!greenHistory?.tests) {
    return "low";
  }

  // Count tests related to this area
  let totalTests = 0;
  let passingTests = 0;
  for (const [title, data] of Object.entries(greenHistory.tests)) {
    const normalizedTitle = title.toLowerCase();
    const areaWords = area.replace(/-/g, " ").toLowerCase();
    if (normalizedTitle.includes(areaWords) || normalizedTitle.includes(area)) {
      totalTests += 1;
      if ((data.consecutivePasses ?? 0) > 0) {
        passingTests += 1;
      }
    }
  }

  if (totalTests === 0) {
    return "low";
  }
  const passRate = passingTests / totalTests;
  if (passRate >= 0.8) {
    return "high";
  }
  if (passRate >= 0.4) {
    return "medium";
  }
  return "low";
}

// ---------------------------------------------------------------------------
// Experience generation from findings
// ---------------------------------------------------------------------------

function buildState(area, action, coverageLevel) {
  return `${area}|${action}|${coverageLevel}`;
}

function findingsToExperiences(findings, greenHistory, personaLearning) {
  const allFindings = Array.isArray(findings) ? findings : findings?.findings ?? [];

  // Only process recent open findings (last iteration's worth)
  const recentFindings = allFindings.filter((f) => f.status !== "resolved");

  const experiences = [];
  const personaCoverage = {}; // track what each persona covers this round

  for (const finding of recentFindings) {
    const personaName = finding.persona
      ? finding.persona.toLowerCase().replace(/\s+/g, "-")
      : null;

    if (!personaName) {
      continue;
    }

    const area = classifyArea(finding.page);
    const action = classifyAction(finding);
    const coverageLevel = classifyCoverageLevel(area, greenHistory);
    const state = buildState(area, action, coverageLevel);

    // Pick the next action (what the persona should try next)
    const actions = DEFAULT_CONFIG.actions;
    const nextActionIdx = (actions.indexOf(action) + 1) % actions.length;
    const nextAction = actions[nextActionIdx];
    const nextCoverage = coverageLevel === "low" ? "medium" : coverageLevel;
    const nextState = buildState(area, nextAction, nextCoverage);

    // Compute reward
    const baseReward = SEVERITY_REWARD[finding.severity] ?? 1;

    // Novelty bonus: first finding in this area gets a boost
    if (!personaCoverage[personaName]) {
      personaCoverage[personaName] = new Set();
    }
    const noveltyBonus = personaCoverage[personaName].has(area) ? 0 : 3;
    personaCoverage[personaName].add(area);

    // Coverage overlap penalty: if many personas cover this area, penalize
    let overlapPenalty = 0;
    if (personaLearning?.personas) {
      let coveringPersonas = 0;
      for (const [pid, pdata] of Object.entries(personaLearning.personas)) {
        if (pid === personaName) {
          continue;
        }
        const recentAreas = (pdata.recentFindings ?? [])
          .map((f) => classifyArea(f.page));
        if (recentAreas.includes(area)) {
          coveringPersonas += 1;
        }
      }
      overlapPenalty = Math.min(coveringPersonas * 0.5, 3);
    }

    const reward = baseReward + noveltyBonus - overlapPenalty;

    const tags = [];
    if (finding.severity === "security") {
      tags.push("security");
    }
    if (finding.severity) {
      tags.push(`severity-${finding.severity}`);
    }
    if (finding.failureType) {
      tags.push(finding.failureType);
    }

    experiences.push({
      persona: personaName,
      iteration: 0, // will be set by caller
      state,
      action: `${area}|${action}`,
      reward: parseFloat(reward.toFixed(2)),
      next_state: nextState,
      tags,
    });
  }

  return experiences;
}

// ---------------------------------------------------------------------------
// Q-learning update
// ---------------------------------------------------------------------------

function initPersonaQEntry() {
  return {
    q_values: {},
    total_reward: 0,
    exploration_rate: 0.3, // start exploring
    episodes: 0,
  };
}

function getQValue(qValues, state, action) {
  return qValues[state]?.[action] ?? 0;
}

function setQValue(qValues, state, action, value) {
  if (!qValues[state]) {
    qValues[state] = {};
  }
  qValues[state][action] = parseFloat(value.toFixed(4));
}

function maxQValue(qValues, state) {
  const stateActions = qValues[state];
  if (!stateActions) {
    return 0;
  }
  const values = Object.values(stateActions);
  if (values.length === 0) {
    return 0;
  }
  return Math.max(...values);
}

function updateQTable(qtable, replayBuffer, config, replayConfig) {
  const totalUpdates = qtable.meta?.total_updates ?? 0;
  let newUpdates = 0;
  let totalReward = 0;

  for (const [personaId, personaQ] of Object.entries(qtable.personas)) {
    // Sample mini-batch: 70% own experiences, 30% cross-persona
    const ownExperiences = replayBuffer.filter((e) => e.persona === personaId);
    const crossExperiences = replayBuffer.filter((e) => e.persona !== personaId);

    const ownCount = Math.min(
      Math.ceil(replayConfig.batch_size * (1 - replayConfig.cross_persona_weight)),
      ownExperiences.length
    );
    const crossCount = Math.min(
      Math.floor(replayConfig.batch_size * replayConfig.cross_persona_weight),
      crossExperiences.length
    );

    // Sample with recency bias
    const sampleWithBias = (arr, count, bias) => {
      if (arr.length <= count) {
        return [...arr];
      }
      const sampled = [];
      const weights = arr.map((_, i) => Math.pow(bias, arr.length - 1 - i));
      const totalWeight = weights.reduce((a, b) => a + b, 0);

      for (let s = 0; s < count; s++) {
        let rand = Math.random() * totalWeight;
        for (let i = 0; i < arr.length; i++) {
          rand -= weights[i];
          if (rand <= 0) {
            sampled.push(arr[i]);
            break;
          }
        }
      }
      return sampled;
    };

    const batch = [
      ...sampleWithBias(ownExperiences, ownCount, replayConfig.recency_bias),
      ...sampleWithBias(crossExperiences, crossCount, replayConfig.recency_bias),
    ];

    // Q-learning updates
    for (const exp of batch) {
      const currentQ = getQValue(personaQ.q_values, exp.state, exp.action);
      const maxNextQ = maxQValue(personaQ.q_values, exp.next_state);
      const newQ =
        currentQ +
        config.learning_rate * (exp.reward + config.discount_factor * maxNextQ - currentQ);

      setQValue(personaQ.q_values, exp.state, exp.action, newQ);
      personaQ.total_reward += exp.reward;
      totalReward += exp.reward;
      newUpdates += 1;
    }

    personaQ.episodes += 1;

    // Decay exploration
    personaQ.exploration_rate = Math.max(
      config.epsilon_min,
      personaQ.exploration_rate * config.epsilon_decay
    );
    personaQ.exploration_rate = parseFloat(personaQ.exploration_rate.toFixed(4));
  }

  return { newUpdates, totalReward: parseFloat(totalReward.toFixed(2)), totalUpdates: totalUpdates + newUpdates };
}

// ---------------------------------------------------------------------------
// Best action recommendation
// ---------------------------------------------------------------------------

function getBestAction(personaQ, state, config) {
  // Epsilon-greedy
  if (Math.random() < personaQ.exploration_rate) {
    const actions = config.actions;
    return actions[Math.floor(Math.random() * actions.length)];
  }

  const stateActions = personaQ.q_values[state];
  if (!stateActions || Object.keys(stateActions).length === 0) {
    const actions = config.actions;
    return actions[Math.floor(Math.random() * actions.length)];
  }

  let bestAction = null;
  let bestValue = -Infinity;
  for (const [action, value] of Object.entries(stateActions)) {
    if (value > bestValue) {
      bestValue = value;
      bestAction = action;
    }
  }
  return bestAction;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printSummary(qtable, replayStats) {
  const { personas, config, meta } = qtable;
  const personaIds = Object.keys(personas);

  console.log("");
  console.log("MARL Q-Table Summary");
  console.log("====================");
  console.log(
    `Personas: ${personaIds.length} | Total updates: ${meta.total_updates} | ` +
    `Avg reward: ${meta.avg_reward}`
  );
  console.log(
    `Replay buffer: ${replayStats.bufferSize} experiences | ` +
    `New this round: ${replayStats.newExperiences}`
  );
  console.log("");

  // Per-persona summary sorted by total reward
  const sorted = personaIds
    .map((id) => ({ id, ...personas[id] }))
    .sort((a, b) => b.total_reward - a.total_reward)
    .slice(0, 20);

  console.log(
    padRight("Persona", 25) +
    padRight("Reward", 10) +
    padRight("Episodes", 10) +
    padRight("Epsilon", 10) +
    padRight("States", 8) +
    padRight("Best State", 35)
  );
  console.log("-".repeat(98));

  for (const p of sorted) {
    const stateCount = Object.keys(p.q_values).length;
    // Find state with highest max Q
    let bestState = "(none)";
    let bestQ = -Infinity;
    for (const [state, actions] of Object.entries(p.q_values)) {
      const maxQ = Math.max(...Object.values(actions));
      if (maxQ > bestQ) {
        bestQ = maxQ;
        bestState = state;
      }
    }

    console.log(
      padRight(p.id, 25) +
      padRight(p.total_reward.toFixed(1), 10) +
      padRight(p.episodes, 10) +
      padRight(p.exploration_rate.toFixed(3), 10) +
      padRight(stateCount, 8) +
      padRight(bestState.slice(0, 35), 35)
    );
  }

  if (personaIds.length > 20) {
    console.log(`  ... (${personaIds.length} total personas)`);
  }
  console.log("");
}

function printPersonaDrill(qtable, personaId) {
  const personaQ = qtable.personas[personaId];

  console.log("");
  console.log(`MARL Q-Table: ${personaId}`);
  console.log("=".repeat(50));

  if (!personaQ) {
    console.log("No Q-table data for this persona.");
    return;
  }

  console.log(
    `Total reward: ${personaQ.total_reward.toFixed(1)} | ` +
    `Episodes: ${personaQ.episodes} | ` +
    `Epsilon: ${personaQ.exploration_rate.toFixed(3)}`
  );
  console.log("");

  const states = Object.entries(personaQ.q_values).sort(([, a], [, b]) => {
    const maxA = Math.max(...Object.values(a));
    const maxB = Math.max(...Object.values(b));
    return maxB - maxA;
  });

  if (states.length === 0) {
    console.log("No Q-values learned yet.");
    return;
  }

  console.log("Q-values (state -> action: value):");
  for (const [state, actions] of states) {
    console.log(`  ${state}:`);
    const sorted = Object.entries(actions).sort(([, a], [, b]) => b - a);
    for (const [action, value] of sorted) {
      const bar = value > 0 ? "+".repeat(Math.min(Math.ceil(value), 20)) : "-";
      console.log(`    ${padRight(action, 30)} ${padRight(value.toFixed(2), 8)} ${bar}`);
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const personaLearning = loadJson(PERSONA_LEARNING_PATH);
  const findings = loadJson(FINDINGS_PATH) ?? [];
  const greenHistory = loadJson(GREEN_HISTORY_PATH) ?? { tests: {} };
  const previousQTable = loadJson(QTABLE_PATH);
  const previousReplay = loadJson(REPLAY_PATH);

  // Initialize Q-table
  const config = previousQTable?.config ?? { ...DEFAULT_CONFIG };
  const personas = {};

  // Seed personas from persona-learning
  if (personaLearning?.personas) {
    for (const personaId of Object.keys(personaLearning.personas)) {
      personas[personaId] = previousQTable?.personas?.[personaId] ?? initPersonaQEntry();
    }
  }

  // Also keep any personas from previous Q-table
  if (previousQTable?.personas) {
    for (const [pid, pdata] of Object.entries(previousQTable.personas)) {
      if (!personas[pid]) {
        personas[pid] = pdata;
      }
    }
  }

  const qtable = {
    personas,
    config,
    meta: {
      total_updates: previousQTable?.meta?.total_updates ?? 0,
      avg_reward: previousQTable?.meta?.avg_reward ?? 0,
      generatedAt: new Date().toISOString(),
    },
  };

  // Initialize replay buffer
  const replayConfig = previousReplay?.config ?? { ...DEFAULT_REPLAY_CONFIG };
  let buffer = previousReplay?.buffer ?? [];

  // Step 1: Convert findings to experiences
  const newExperiences = findingsToExperiences(findings, greenHistory, personaLearning);

  // Set iteration on new experiences
  const iterationEstimate = (previousQTable?.meta?.total_updates ?? 0) > 0
    ? Math.ceil((previousQTable.meta.total_updates) / Object.keys(personas).length) + 1
    : 1;
  for (const exp of newExperiences) {
    exp.iteration = iterationEstimate;
  }

  // Step 2: Add to replay buffer (ring buffer)
  buffer = [...buffer, ...newExperiences];
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer = buffer.slice(buffer.length - MAX_BUFFER_SIZE);
  }

  // Ensure new persona entries exist for any persona with new experiences
  for (const exp of newExperiences) {
    if (!qtable.personas[exp.persona]) {
      qtable.personas[exp.persona] = initPersonaQEntry();
    }
  }

  // Step 3: Update Q-values
  const { newUpdates, totalReward, totalUpdates } = updateQTable(
    qtable,
    buffer,
    config,
    replayConfig
  );

  qtable.meta.total_updates = totalUpdates;
  const personaCount = Object.keys(qtable.personas).length;
  qtable.meta.avg_reward = personaCount > 0
    ? parseFloat(
        (Object.values(qtable.personas).reduce((s, p) => s + p.total_reward, 0) / personaCount).toFixed(2)
      )
    : 0;
  qtable.meta.generatedAt = new Date().toISOString();

  const replayState = {
    buffer,
    buffer_size: MAX_BUFFER_SIZE,
    config: replayConfig,
    meta: {
      total_experiences: buffer.length,
      generatedAt: new Date().toISOString(),
    },
  };

  const replayStats = {
    bufferSize: buffer.length,
    newExperiences: newExperiences.length,
    newUpdates,
  };

  // Output
  if (isJson) {
    console.log(JSON.stringify({ qtable, replayStats }, null, 2));
  } else if (personaDrill) {
    printPersonaDrill(qtable, personaDrill);
  } else {
    printSummary(qtable, replayStats);
  }

  // Write state files
  if (doExport && !dryRun) {
    fs.mkdirSync(path.dirname(QTABLE_PATH), { recursive: true });
    fs.writeFileSync(QTABLE_PATH, JSON.stringify(qtable, null, 2) + "\n");
    fs.writeFileSync(REPLAY_PATH, JSON.stringify(replayState, null, 2) + "\n");
    if (!isJson) {
      console.log(`Exported Q-table to ${path.relative(ROOT, QTABLE_PATH)}`);
      console.log(`Exported replay buffer to ${path.relative(ROOT, REPLAY_PATH)}`);
    }
  } else if (doExport && dryRun) {
    if (!isJson) {
      console.log("[dry-run] Would write Q-table and replay buffer. Skipped.");
    }
  }
}

main();
