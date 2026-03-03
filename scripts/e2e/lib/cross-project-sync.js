#!/usr/bin/env node

/**
 * Cross-Project Sync — Universal knowledge sharing between daemons.
 *
 * Each daemon accumulates knowledge (fix patterns, convergence configs,
 * model budget insights, persona strategies). Universal knowledge —
 * patterns that work across ANY project, not just one — gets synced
 * to a shared directory (~/.persona-engine/) and optionally to
 * ChangePilot's API for network-wide distribution.
 *
 * What gets shared:
 *   - Fix patterns that succeed in 2+ projects
 *   - Model budget efficiency data (which models work for what)
 *   - Convergence configurations (optimal claw intervals, worker counts)
 *   - Oracle prompt improvements
 *   - Circuit breaker thresholds that prevent false positives
 *
 * What NEVER gets shared:
 *   - BUILD-SPEC content (project-specific)
 *   - Route maps (project-specific)
 *   - Source code or file paths
 *   - Credentials or env vars
 *   - Persona definitions (derived from project-specific spec)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

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

// Shared state directory — cross-project intelligence lives here
const SHARED_DIR = path.join(os.homedir(), ".persona-engine");
const SHARED_PATTERNS_PATH = path.join(SHARED_DIR, "shared-patterns.json");
const MODEL_BUDGETS_PATH = path.join(SHARED_DIR, "model-budgets.json");
const CROSS_INSIGHTS_PATH = path.join(SHARED_DIR, "cross-insights.json");
const CONVERGENCE_CONFIGS_PATH = path.join(SHARED_DIR, "convergence-configs.json");

function ensureSharedDir() {
  fs.mkdirSync(SHARED_DIR, { recursive: true });
}

function loadJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch { /* corrupt file */ }
  return fallback;
}

function saveJSON(filePath, data) {
  ensureSharedDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Get the current project's name from config.
 */
function getProjectName() {
  const configPath = path.join(ROOT, "persona-engine.json");
  if (fs.existsSync(configPath)) {
    try { return JSON.parse(fs.readFileSync(configPath, "utf-8")).name; } catch { /* ignore */ }
  }
  return path.basename(ROOT);
}

// -------------------------------------------------------------------------
// Fix Patterns — patterns that auto-fix.js has proven effective
// -------------------------------------------------------------------------

/**
 * Record a successful fix pattern from this project.
 * After the same pattern succeeds in 2+ projects, it becomes "universal".
 */
function recordFixPattern(pattern) {
  const patterns = loadJSON(SHARED_PATTERNS_PATH, { patterns: [], projects: {} });
  const projectName = getProjectName();

  // Check if this pattern already exists
  const existing = patterns.patterns.find((p) =>
    p.errorPattern === pattern.errorPattern && p.fixStrategy === pattern.fixStrategy
  );

  if (existing) {
    // Add this project to the pattern's success list
    if (!existing.projects.includes(projectName)) {
      existing.projects.push(projectName);
    }
    existing.successCount = (existing.successCount || 0) + 1;
    existing.lastSuccess = new Date().toISOString();

    // Promote to universal if 2+ projects confirmed
    if (existing.projects.length >= 2 && !existing.universal) {
      existing.universal = true;
      existing.promotedAt = new Date().toISOString();
    }
  } else {
    patterns.patterns.push({
      errorPattern: pattern.errorPattern,
      fixStrategy: pattern.fixStrategy,
      description: pattern.description || "",
      projects: [projectName],
      successCount: 1,
      firstSeen: new Date().toISOString(),
      lastSuccess: new Date().toISOString(),
      universal: false,
    });
  }

  // Track per-project stats
  if (!patterns.projects[projectName]) {
    patterns.projects[projectName] = { patternsContributed: 0, patternsConsumed: 0, lastSync: null };
  }
  patterns.projects[projectName].patternsContributed++;
  patterns.projects[projectName].lastSync = new Date().toISOString();

  saveJSON(SHARED_PATTERNS_PATH, patterns);
}

/**
 * Get universal fix patterns that other projects have proven.
 * Returns only patterns confirmed in 2+ projects (universal: true).
 */
function getUniversalPatterns() {
  const patterns = loadJSON(SHARED_PATTERNS_PATH, { patterns: [] });
  const projectName = getProjectName();

  // Track that this project consumed patterns
  if (patterns.projects && patterns.projects[projectName]) {
    patterns.projects[projectName].patternsConsumed++;
  }

  return patterns.patterns.filter((p) => p.universal);
}

// -------------------------------------------------------------------------
// Model Budgets — which models are cost-effective for what tasks
// -------------------------------------------------------------------------

/**
 * Record model usage outcome.
 */
function recordModelUsage(entry) {
  const budgets = loadJSON(MODEL_BUDGETS_PATH, { usage: [], projects: {} });
  const projectName = getProjectName();

  budgets.usage.push({
    model: entry.model,
    task: entry.task, // "oracle", "fix", "build", "classify"
    tokens: entry.tokens || 0,
    cost: entry.cost || 0,
    success: Boolean(entry.success),
    project: projectName,
    timestamp: new Date().toISOString(),
  });

  // Keep last 1000 entries
  if (budgets.usage.length > 1000) {
    budgets.usage = budgets.usage.slice(-1000);
  }

  // Update per-project totals
  if (!budgets.projects[projectName]) {
    budgets.projects[projectName] = { totalTokens: 0, totalCost: 0, taskCount: 0 };
  }
  budgets.projects[projectName].totalTokens += entry.tokens || 0;
  budgets.projects[projectName].totalCost += entry.cost || 0;
  budgets.projects[projectName].taskCount++;

  saveJSON(MODEL_BUDGETS_PATH, budgets);
}

/**
 * Get model efficiency rankings for a given task type.
 */
function getModelEfficiency(task) {
  const budgets = loadJSON(MODEL_BUDGETS_PATH, { usage: [] });

  const taskEntries = budgets.usage.filter((u) => u.task === task);
  if (taskEntries.length === 0) { return []; }

  // Group by model
  const modelStats = {};
  for (const entry of taskEntries) {
    if (!modelStats[entry.model]) {
      modelStats[entry.model] = { total: 0, success: 0, avgTokens: 0, totalTokens: 0 };
    }
    modelStats[entry.model].total++;
    if (entry.success) { modelStats[entry.model].success++; }
    modelStats[entry.model].totalTokens += entry.tokens || 0;
  }

  // Calculate efficiency scores
  return Object.entries(modelStats)
    .map(([model, stats]) => ({
      model,
      successRate: stats.total > 0 ? stats.success / stats.total : 0,
      avgTokens: stats.total > 0 ? Math.round(stats.totalTokens / stats.total) : 0,
      sampleSize: stats.total,
    }))
    .sort((a, b) => b.successRate - a.successRate);
}

// -------------------------------------------------------------------------
// Cross-Project Insights — patterns detected across the network
// -------------------------------------------------------------------------

/**
 * Record a cross-project insight (convergence config, strategy, etc.).
 */
function recordInsight(insight) {
  const insights = loadJSON(CROSS_INSIGHTS_PATH, { insights: [] });
  const projectName = getProjectName();

  insights.insights.push({
    type: insight.type, // "convergence_config", "claw_interval", "worker_count", "oracle_prompt"
    key: insight.key,
    value: insight.value,
    context: insight.context || "",
    project: projectName,
    timestamp: new Date().toISOString(),
  });

  // Keep last 500 insights
  if (insights.insights.length > 500) {
    insights.insights = insights.insights.slice(-500);
  }

  saveJSON(CROSS_INSIGHTS_PATH, insights);
}

/**
 * Get insights for a given type, aggregated across projects.
 */
function getInsights(type) {
  const insights = loadJSON(CROSS_INSIGHTS_PATH, { insights: [] });
  return insights.insights.filter((i) => i.type === type);
}

/**
 * Get the most common value for a given insight key.
 */
function getConsensusValue(type, key) {
  const matching = getInsights(type).filter((i) => i.key === key);
  if (matching.length === 0) { return null; }

  // Count occurrences of each value
  const counts = {};
  for (const i of matching) {
    const v = JSON.stringify(i.value);
    counts[v] = (counts[v] || 0) + 1;
  }

  // Return the most common
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  try { return JSON.parse(sorted[0][0]); } catch { return sorted[0][0]; }
}

// -------------------------------------------------------------------------
// Network Sync — push/pull to ChangePilot API (optional)
// -------------------------------------------------------------------------

/**
 * Push local universal patterns to ChangePilot for network-wide distribution.
 */
async function pushToNetwork() {
  const cpUrl = process.env.CHANGEPILOT_API_URL || "https://moc-ai.vercel.app";
  const serviceKey = process.env.CHANGEPILOT_SERVICE_KEY;

  if (!serviceKey) { return { pushed: 0 }; }

  const patterns = getUniversalPatterns();
  const budgets = loadJSON(MODEL_BUDGETS_PATH, { projects: {} });
  const insights = loadJSON(CROSS_INSIGHTS_PATH, { insights: [] });

  try {
    const res = await fetch(`${cpUrl}/api/daemon-network/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        projectName: getProjectName(),
        universalPatterns: patterns.slice(-50), // Last 50
        modelBudgets: budgets.projects,
        insights: insights.insights.slice(-100), // Last 100
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return { pushed: patterns.length, received: data.newPatterns || 0 };
    }
  } catch { /* network unavailable — solo mode */ }

  return { pushed: 0 };
}

/**
 * Pull new universal patterns from the network.
 */
async function pullFromNetwork() {
  const cpUrl = process.env.CHANGEPILOT_API_URL || "https://moc-ai.vercel.app";
  const serviceKey = process.env.CHANGEPILOT_SERVICE_KEY;

  if (!serviceKey) { return { received: 0 }; }

  try {
    const res = await fetch(`${cpUrl}/api/daemon-network/patterns`, {
      headers: { "Authorization": `Bearer ${serviceKey}` },
    });

    if (res.ok) {
      const data = await res.json();
      const patterns = loadJSON(SHARED_PATTERNS_PATH, { patterns: [], projects: {} });

      // Merge new patterns
      let added = 0;
      for (const incoming of (data.patterns || [])) {
        const exists = patterns.patterns.find((p) =>
          p.errorPattern === incoming.errorPattern && p.fixStrategy === incoming.fixStrategy
        );
        if (!exists) {
          patterns.patterns.push({ ...incoming, universal: true, source: "network" });
          added++;
        }
      }

      if (added > 0) {
        saveJSON(SHARED_PATTERNS_PATH, patterns);
      }

      return { received: added };
    }
  } catch { /* network unavailable */ }

  return { received: 0 };
}

/**
 * Full sync: push local knowledge, pull network knowledge.
 */
async function sync() {
  const pushResult = await pushToNetwork();
  const pullResult = await pullFromNetwork();
  return { ...pushResult, ...pullResult };
}

module.exports = {
  // Fix patterns
  recordFixPattern,
  getUniversalPatterns,
  // Model budgets
  recordModelUsage,
  getModelEfficiency,
  // Insights
  recordInsight,
  getInsights,
  getConsensusValue,
  // Network
  pushToNetwork,
  pullFromNetwork,
  sync,
  // Utils
  getProjectName,
  SHARED_DIR,
};
