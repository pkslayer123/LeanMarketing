#!/usr/bin/env node

/**
 * Curiosity Engine — ICM-lite forward model for persona test exploration.
 *
 * Statistical forward model that tracks (page, action_type) outcome distributions.
 * Prediction error = surprise = intrinsic curiosity reward.
 *
 * For each (page, action_type) pair the model maintains:
 *   - outcome_distribution: observed frequencies of status/severity outcomes
 *   - timing_stats: mean, std, observation count
 *   - curiosity_bonus: higher for more surprising areas, decays over time
 *
 * Surprise is computed as -log(P(outcome)) from the forward model.
 * High surprise observations feed into Thompson Sampling as intrinsic reward.
 *
 * Noisy TV filter: known noise patterns (hydration, network drops, timing jitter)
 * are excluded to avoid wasting curiosity budget on uninformative signals.
 *
 * Usage:
 *   node scripts/e2e/curiosity-engine.js                # Human-readable summary
 *   node scripts/e2e/curiosity-engine.js --json          # Machine-readable JSON
 *   node scripts/e2e/curiosity-engine.js --export        # Write model to state file
 *   node scripts/e2e/curiosity-engine.js --top 20        # Top N curious areas
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FINDINGS_PATH = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const LEARNING_PATH = path.join(ROOT, "e2e", "state", "persona-learning.json");
const GREEN_HISTORY_PATH = path.join(ROOT, "e2e", "state", "green-history.json");
const LOOP_PERF_PATH = path.join(ROOT, "e2e", "state", "loop-performance.jsonl");
const MODEL_PATH = path.join(ROOT, "e2e", "state", "curiosity-model.json");

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const EXPORT = args.includes("--export");
const topNIdx = args.indexOf("--top");
const TOP_N = topNIdx >= 0 ? parseInt(args[topNIdx + 1] ?? "15", 10) : 15;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    return fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Noisy TV filter — skip observations that produce false curiosity
// ---------------------------------------------------------------------------

const NOISY_TV_PATTERNS = [
  /hydration/i,
  /react\s*#?419/i,
  /failed\s+to\s+fetch/i,
  /network\s*(drop|timeout|error)/i,
  /signal\s+is\s+aborted/i,
  /auth\s+session\s+missing/i,
  /timing[_ ]?jitter/i,
  /long\s+task/i,
  /NEXT_REDIRECT/i,
  /refresh_token_not_found/i,
];

function isNoisyTv(description) {
  if (!description) {
    return false;
  }
  return NOISY_TV_PATTERNS.some((pattern) => pattern.test(description));
}

// ---------------------------------------------------------------------------
// KL divergence between two discrete distributions
// ---------------------------------------------------------------------------

function klDivergence(p, q) {
  let kl = 0;
  const allKeys = new Set([...Object.keys(p), ...Object.keys(q)]);
  for (const key of allKeys) {
    const pv = p[key] || 0.001;
    const qv = q[key] || 0.001;
    if (pv > 0) {
      kl += pv * Math.log(pv / qv);
    }
  }
  return kl;
}

// ---------------------------------------------------------------------------
// Severity → outcome mapping
// ---------------------------------------------------------------------------

function severityToOutcome(severity) {
  const map = {
    critical: "500",
    bug: "400",
    security: "403",
    ux: "200",
    suggestion: "200",
    info: "200",
  };
  return map[severity] || "200";
}

function actionTypeFromFinding(finding) {
  const desc = (finding.description || "").toLowerCase();
  const failType = (finding.failureType || "").toLowerCase();

  if (failType.includes("vision")) {
    return "visual_check";
  }
  if (failType.includes("permission") || failType.includes("bola")) {
    return "permission_check";
  }
  if (failType.includes("oracle") || desc.includes("[oracle")) {
    return "oracle_validation";
  }
  if (desc.includes("submit") || desc.includes("review")) {
    return "submit_review";
  }
  if (desc.includes("navigate") || desc.includes("access") || desc.includes("load")) {
    return "page_access";
  }
  return "general_test";
}

// ---------------------------------------------------------------------------
// Forward model operations
// ---------------------------------------------------------------------------

function initializeModel() {
  return {
    forward_model: {},
    surprise_log: [],
    config: {
      surprise_threshold: 2.0,
      curiosity_reward_weight: 3.0,
      model_update_rate: 0.1,
      min_observations: 5,
      noisy_tv_filter: ["timing_jitter", "hydration_warnings", "network_timeout"],
    },
    meta: {
      total_observations: 0,
      total_surprises: 0,
      avg_surprise: 0,
      generatedAt: new Date().toISOString(),
    },
  };
}

function getModelKey(page, actionType) {
  return `${page}|${actionType}`;
}

function ensureEntry(forwardModel, key) {
  if (!forwardModel[key]) {
    forwardModel[key] = {
      outcome_distribution: {},
      timing_stats: { mean: 0, std: 0, n: 0 },
      observation_count: 0,
      last_surprise: { iteration: 0, surprise_score: 0 },
      curiosity_bonus: 0.5,
    };
  }
  return forwardModel[key];
}

function computeSurprise(entry, outcome) {
  const dist = entry.outcome_distribution;
  const total = Object.values(dist).reduce((s, v) => s + v, 0);

  // If no prior observations, maximum surprise
  if (total === 0 || entry.observation_count < 1) {
    return 4.0;
  }

  // Normalize distribution to get probabilities
  const prob = (dist[outcome] || 0) / total;

  // -log(P(outcome)), clamped to avoid infinity
  const clampedProb = Math.max(prob, 0.001);
  return -Math.log(clampedProb);
}

function updateDistribution(entry, outcome, alpha) {
  const dist = entry.outcome_distribution;

  // Exponential moving average update
  for (const key of Object.keys(dist)) {
    dist[key] = (1 - alpha) * dist[key];
  }
  dist[outcome] = ((1 - alpha) * (dist[outcome] || 0)) + alpha;

  // Re-normalize
  const total = Object.values(dist).reduce((s, v) => s + v, 0);
  if (total > 0) {
    for (const key of Object.keys(dist)) {
      dist[key] = dist[key] / total;
    }
  }

  entry.observation_count += 1;
}

function decayCuriosityBonuses(forwardModel, currentIteration) {
  for (const entry of Object.values(forwardModel)) {
    const itersSinceLastSurprise = currentIteration - (entry.last_surprise?.iteration ?? 0);
    // Decay curiosity bonus by 10% per iteration with no new surprises
    if (itersSinceLastSurprise > 0) {
      entry.curiosity_bonus *= Math.pow(0.9, itersSinceLastSurprise);
      // Floor at a small exploration baseline
      entry.curiosity_bonus = Math.max(entry.curiosity_bonus, 0.05);
    }
  }
}

// ---------------------------------------------------------------------------
// Estimate current iteration from loop-performance
// ---------------------------------------------------------------------------

function getCurrentIteration(loopPerf) {
  if (!loopPerf || loopPerf.length === 0) {
    return 1;
  }
  const last = loopPerf[loopPerf.length - 1];
  return (last.iter ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const findings = loadJson(FINDINGS_PATH) ?? [];
  const learning = loadJson(LEARNING_PATH) ?? { personas: {} };
  const greenHistory = loadJson(GREEN_HISTORY_PATH) ?? { tests: {} };
  const loopPerf = loadJsonl(LOOP_PERF_PATH);
  const existingModel = loadJson(MODEL_PATH);

  const model = existingModel ?? initializeModel();
  const forwardModel = model.forward_model;
  const config = model.config;
  const alpha = config.model_update_rate;
  const threshold = config.surprise_threshold;
  const currentIter = getCurrentIteration(loopPerf);

  // Track stats for this run
  let newObservations = 0;
  let newSurprises = 0;
  let surpriseSum = 0;

  // Decay existing curiosity bonuses
  decayCuriosityBonuses(forwardModel, currentIter);

  // Process each finding as an observation
  for (const finding of findings) {
    const page = finding.page || "/unknown";
    const description = finding.description || "";

    // Noisy TV filter — skip noise to avoid false curiosity
    if (isNoisyTv(description)) {
      continue;
    }

    const actionType = actionTypeFromFinding(finding);
    const outcome = severityToOutcome(finding.severity);
    const key = getModelKey(page, actionType);
    const entry = ensureEntry(forwardModel, key);

    // Compute surprise before updating model
    const surprise = computeSurprise(entry, outcome);
    surpriseSum += surprise;
    newObservations++;

    // If surprise exceeds threshold, log it
    if (surprise > threshold) {
      newSurprises++;

      // Boost curiosity bonus for this area
      entry.curiosity_bonus = Math.min(
        (entry.curiosity_bonus || 0) + surprise * config.curiosity_reward_weight * 0.1,
        5.0
      );
      entry.last_surprise = {
        iteration: currentIter,
        surprise_score: Math.round(surprise * 100) / 100,
      };

      // Add to surprise log (keep last 200 entries)
      model.surprise_log.push({
        page,
        action: actionType,
        persona: finding.persona || "unknown",
        expected_outcome: getMostLikelyOutcome(entry.outcome_distribution),
        actual_outcome: outcome,
        surprise_score: Math.round(surprise * 100) / 100,
        iteration: currentIter,
        timestamp: finding.timestamp || new Date().toISOString(),
      });
    }

    // Update forward model with this observation
    updateDistribution(entry, outcome, alpha);
  }

  // Trim surprise log to last 200
  if (model.surprise_log.length > 200) {
    model.surprise_log = model.surprise_log.slice(-200);
  }

  // Update meta
  model.meta = {
    total_observations: (model.meta.total_observations || 0) + newObservations,
    total_surprises: (model.meta.total_surprises || 0) + newSurprises,
    avg_surprise: newObservations > 0 ? Math.round((surpriseSum / newObservations) * 100) / 100 : model.meta.avg_surprise || 0,
    generatedAt: new Date().toISOString(),
  };

  // Enrich curiosity from spec gaps (pages with spec gaps get curiosity boost)
  try {
    const gapsPath = path.join(ROOT, "e2e", "state", "theme-spec-gaps.json");
    if (fs.existsSync(gapsPath)) {
      const gaps = JSON.parse(fs.readFileSync(gapsPath, "utf-8"));
      const specGapPages = new Set();
      for (const gap of gaps.gaps || gaps.unmappedThemes || []) {
        if (gap.examplePages) {
          for (const p of gap.examplePages) {
            specGapPages.add(p);
          }
        }
        if (gap.affectedPages) {
          for (const p of gap.affectedPages) {
            specGapPages.add(p);
          }
        }
      }
      // Apply curiosity bonus to forward model entries matching spec-gap pages
      let specGapBoosted = 0;
      for (const [nodeId, node] of Object.entries(forwardModel)) {
        const nodePage = nodeId.split("|")[0] || nodeId;
        if (specGapPages.has(nodePage) || specGapPages.has(node.page)) {
          node.curiosity_bonus = (node.curiosity_bonus || 0) + 0.15;
          specGapBoosted++;
        }
      }
      if (specGapPages.size > 0) {
        console.log(
          `[Curiosity] Applied spec-gap boost to ${specGapBoosted} model entries from ${specGapPages.size} gap pages`
        );
      }
    }
  } catch {
    // Non-fatal — theme-spec-gaps.json may not exist yet
  }

  // Enrich curiosity from production telemetry (high-error production pages get curiosity boost)
  try {
    const telPath = path.join(ROOT, "e2e", "state", "production-telemetry.json");
    if (fs.existsSync(telPath)) {
      const telemetry = JSON.parse(fs.readFileSync(telPath, "utf-8"));
      const pages = telemetry.pages ?? {};
      let prodBoosted = 0;
      for (const [page, info] of Object.entries(pages)) {
        if (!info || typeof info.riskScore !== "number" || info.riskScore < 0.3) {
          continue;
        }
        for (const [key, entry] of Object.entries(forwardModel)) {
          const nodePage = key.split("|")[0] ?? "";
          if (nodePage === page || page.endsWith(nodePage)) {
            entry.curiosity_bonus = (entry.curiosity_bonus ?? 0) + info.riskScore * 0.5;
            prodBoosted++;
          }
        }
        // Seed entries for high-risk production pages not yet in forward model
        const visitKey = `${page}|page_access`;
        if (!forwardModel[visitKey] && info.riskScore >= 0.5) {
          forwardModel[visitKey] = {
            observation_count: 0,
            outcome_distribution: {},
            curiosity_bonus: info.riskScore * 1.5,
            last_surprise: null,
          };
          prodBoosted++;
        }
      }
      if (prodBoosted > 0) {
        console.log(`[Curiosity] Applied production-risk boost to ${prodBoosted} entries`);
      }
    }
  } catch {
    // Non-fatal
  }

  // Enrich curiosity from coverage-gaps.json (untested pages/features get curiosity boost)
  try {
    const covGapsPath = path.join(ROOT, "e2e", "state", "coverage-gaps.json");
    if (fs.existsSync(covGapsPath)) {
      const covGaps = JSON.parse(fs.readFileSync(covGapsPath, "utf-8"));
      const untestedPages = new Set(covGaps.pages?.untested || []);
      let covGapBoosted = 0;
      for (const [key, entry] of Object.entries(forwardModel)) {
        const page = key.split("|")[0] || "";
        // Normalize: /admin/departments matches the coverage gap
        if (untestedPages.has(page)) {
          entry.curiosity_bonus = (entry.curiosity_bonus || 0) + 1.5;
          covGapBoosted++;
        }
      }
      // Also seed entries for untested pages not yet in forward model
      for (const page of untestedPages) {
        const key = `${page}|visit`;
        if (!forwardModel[key]) {
          forwardModel[key] = {
            observation_count: 0,
            outcome_distribution: {},
            curiosity_bonus: 2.0,
            last_surprise: null,
          };
          covGapBoosted++;
        }
      }
      if (covGapBoosted > 0) {
        console.log(
          `[Curiosity] Applied coverage-gap boost to ${covGapBoosted} entries from ${untestedPages.size} untested pages`
        );
      }
    }
  } catch {
    // Non-fatal — coverage-gaps.json may not exist yet
  }

  // Build ranked list of most curious areas
  const rankedAreas = Object.entries(forwardModel)
    .map(([key, entry]) => {
      const [page, action] = key.split("|");
      return {
        key,
        page,
        action,
        curiosity_bonus: Math.round((entry.curiosity_bonus || 0) * 1000) / 1000,
        observation_count: entry.observation_count,
        last_surprise_score: entry.last_surprise?.surprise_score ?? 0,
        last_surprise_iter: entry.last_surprise?.iteration ?? 0,
        top_outcome: getMostLikelyOutcome(entry.outcome_distribution),
        outcome_entropy: computeEntropy(entry.outcome_distribution),
      };
    })
    .sort((a, b) => b.curiosity_bonus - a.curiosity_bonus);

  const topAreas = rankedAreas.slice(0, TOP_N);

  // Export
  if (EXPORT) {
    fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
    fs.writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2) + "\n");
    console.log(`Curiosity model written to: ${MODEL_PATH}`);
  }

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          topCuriousAreas: topAreas,
          recentSurprises: model.surprise_log.slice(-10),
          meta: model.meta,
          config: model.config,
          modelSize: Object.keys(forwardModel).length,
        },
        null,
        2
      )
    );
    return;
  }

  // Human-readable output
  console.log("\n--- Curiosity Engine (ICM-lite Forward Model) ---");
  console.log(
    `Model entries: ${Object.keys(forwardModel).length} | ` +
      `New observations: ${newObservations} | ` +
      `New surprises: ${newSurprises} | ` +
      `Avg surprise: ${model.meta.avg_surprise}`
  );
  console.log(
    `Total observations: ${model.meta.total_observations} | ` +
      `Total surprises: ${model.meta.total_surprises} | ` +
      `Iteration: ${currentIter}\n`
  );

  console.log("Rank  Page                          Action              Curiosity  Obs  LastSurp  Entropy  TopOutcome");
  console.log("\u2500".repeat(110));

  for (let i = 0; i < topAreas.length; i++) {
    const a = topAreas[i];
    const rank = String(i + 1).padStart(4);
    const page = a.page.padEnd(30).slice(0, 30);
    const action = a.action.padEnd(20).slice(0, 20);
    const curiosity = a.curiosity_bonus.toFixed(3).padStart(9);
    const obs = String(a.observation_count).padStart(4);
    const lastS = a.last_surprise_score.toFixed(2).padStart(8);
    const entropy = a.outcome_entropy.toFixed(2).padStart(8);
    const topOut = a.top_outcome.padStart(10);
    console.log(`${rank}  ${page}${action}${curiosity}${obs}${lastS}${entropy}${topOut}`);
  }

  if (rankedAreas.length > TOP_N) {
    console.log(`\n... and ${rankedAreas.length - TOP_N} more areas (use --top N to see more)`);
  }

  // Recent surprises summary
  const recentSurprises = model.surprise_log.slice(-5);
  if (recentSurprises.length > 0) {
    console.log("\nRecent surprises:");
    for (const s of recentSurprises) {
      console.log(
        `  [${s.surprise_score.toFixed(2)}] ${s.page} | ${s.action} | ` +
          `persona=${s.persona} | expected=${s.expected_outcome} actual=${s.actual_outcome}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function getMostLikelyOutcome(dist) {
  if (!dist || Object.keys(dist).length === 0) {
    return "none";
  }
  let maxKey = "none";
  let maxVal = -1;
  for (const [key, val] of Object.entries(dist)) {
    if (val > maxVal) {
      maxVal = val;
      maxKey = key;
    }
  }
  return maxKey;
}

function computeEntropy(dist) {
  if (!dist || Object.keys(dist).length === 0) {
    return 0;
  }
  const total = Object.values(dist).reduce((s, v) => s + v, 0);
  if (total === 0) {
    return 0;
  }
  let entropy = 0;
  for (const val of Object.values(dist)) {
    const p = val / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }
  return Math.round(entropy * 100) / 100;
}

main();
