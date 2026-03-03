#!/usr/bin/env node

/**
 * Memory Consolidation — Three-tier cognitive memory system for the persona testing framework.
 *
 * Inspired by cognitive neuroscience, this implements a "sleep consolidation" process:
 *   Sensory memory (raw observations, cleared each iteration)
 *   -> Working memory (detected patterns, rolling 5-iteration window)
 *   -> Long-term memory (consolidated systemic knowledge, persistent)
 *
 * Each tier has different retention rules:
 *   - Sensory: ephemeral, replaced every run
 *   - Working: capacity-limited (50 patterns), decays per iteration, evicts lowest scores
 *   - Long-term: persistent, confidence-weighted, only grows via consolidation
 *
 * Usage:
 *   node scripts/e2e/memory-consolidation.js                          # Full consolidation cycle
 *   node scripts/e2e/memory-consolidation.js --export                 # Write state files
 *   node scripts/e2e/memory-consolidation.js --json                   # Machine-readable output
 *   node scripts/e2e/memory-consolidation.js --iteration 49           # Override iteration number
 *   node scripts/e2e/memory-consolidation.js --dry-run                # Preview without writing
 *   node scripts/e2e/memory-consolidation.js --status                 # Show current memory state
 *
 * Called by: run-loop-hooks.js after-iteration, orchestrator.js post-iteration phase
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

// --- File paths ---
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const GREEN_HISTORY_FILE = path.join(ROOT, "e2e", "state", "green-history.json");
const PERSONA_LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const HOTSPOT_MAP_FILE = path.join(ROOT, "e2e", "state", "hotspot-map.json");

const SENSORY_FILE = path.join(ROOT, "e2e", "state", "memory-sensory.json");
const WORKING_FILE = path.join(ROOT, "e2e", "state", "memory-working.json");
const LONGTERM_FILE = path.join(ROOT, "e2e", "state", "memory-longterm.json");

// --- Constants ---
const WORKING_MEMORY_CAPACITY = 50;
const CONSOLIDATION_THRESHOLD = 0.7;
const CONSOLIDATION_MIN_OCCURRENCES = 3;
const DECAY_RATE_DEFAULT = 0.15;
const DECAY_FLOOR = 0.05;
const ROLLING_WINDOW = 5;
const CONFIDENCE_BOOST = 0.05;
const CONFIDENCE_MAX = 0.99;

// --- CLI args ---
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const dryRun = args.includes("--dry-run");
const exportMode = args.includes("--export");
const statusMode = args.includes("--status");

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const iterationOverride = getArg("--iteration");

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

function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function log(msg) {
  if (!jsonMode) {
    console.log(`[memory] ${msg}`);
  }
}

/**
 * Normalize a page URL into a wildcard pattern.
 * Example: a MOC detail page becomes a wildcard pattern like /moc/STAR/stage-3
 */
function toPagePattern(page) {
  if (!page) {
    return "unknown";
  }
  // Replace UUID-like segments and numeric IDs with *
  return page
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/*")
    .replace(/\/\d{4,}/g, "/*")
    .replace(/\/[a-zA-Z0-9_-]{20,}/g, "/*");
}

/**
 * Map finding severity to a normalized severity level.
 */
function normalizeSeverity(severity) {
  const s = (severity ?? "").toLowerCase();
  if (s === "critical" || s === "security") {
    return "critical";
  }
  if (s === "high" || s === "bug") {
    return "high";
  }
  if (s === "medium" || s === "ux") {
    return "medium";
  }
  if (s === "low" || s === "suggestion" || s === "improvement") {
    return "low";
  }
  return "medium";
}

/**
 * Map finding to an outcome category.
 */
function toOutcomeCategory(finding) {
  const desc = (finding.description ?? "").toLowerCase();
  const ft = (finding.failureType ?? "").toLowerCase();

  if (ft === "real_bug" || /500|crash|exception/i.test(desc)) {
    return "error";
  }
  if (ft === "permission_changed" || /403|permission|denied|unauthorized/i.test(desc)) {
    return "permission";
  }
  if (ft === "stale_selector" || /locator|selector|element.*not.*found/i.test(desc)) {
    return "selector";
  }
  if (ft === "vision_defect" || /\[vision/i.test(desc)) {
    return "visual";
  }
  if (ft === "transient" || /network|timeout|hydration/i.test(desc)) {
    return "transient";
  }
  if (ft === "ui_refactor" || /layout|heading|text.*changed/i.test(desc)) {
    return "ui_change";
  }
  return "other";
}

/**
 * Generate a deterministic pattern ID from category and page pattern.
 */
function generatePatternId(category, pagePattern, severity) {
  const hash = `${category}:${pagePattern}:${severity}`;
  // Simple numeric hash
  let h = 0;
  for (let i = 0; i < hash.length; i++) {
    h = ((h << 5) - h + hash.charCodeAt(i)) | 0;
  }
  return `wp-${Math.abs(h).toString(36).slice(0, 6).padStart(6, "0")}`;
}

/**
 * Generate a long-term knowledge ID from source pattern IDs.
 */
function generateLongtermId(sourcePatterns) {
  const combined = sourcePatterns.sort().join("+");
  let h = 0;
  for (let i = 0; i < combined.length; i++) {
    h = ((h << 5) - h + combined.charCodeAt(i)) | 0;
  }
  return `lt-${Math.abs(h).toString(36).slice(0, 6).padStart(6, "0")}`;
}

/**
 * Compute significance score for a cluster.
 * Higher for: more personas, higher severity, more observations.
 */
function computeSignificance(cluster) {
  const severityWeight = {
    critical: 1.0,
    high: 0.8,
    medium: 0.5,
    low: 0.3,
  };
  const sw = severityWeight[cluster.severity] ?? 0.5;
  const personaCount = cluster.personas.size;
  const personaFactor = Math.min(personaCount / 3, 1.0); // Normalize: 3+ personas = max
  const countFactor = Math.min(cluster.observations.length / 5, 1.0);

  return (sw * 0.4) + (personaFactor * 0.35) + (countFactor * 0.25);
}

// ---------------------------------------------------------------------------
// Infer current iteration number
// ---------------------------------------------------------------------------

function inferIteration() {
  if (iterationOverride) {
    return parseInt(iterationOverride, 10);
  }

  // Try reading from previous sensory memory
  const prev = loadJson(SENSORY_FILE);
  if (prev && typeof prev.iteration === "number") {
    return prev.iteration + 1;
  }

  // Try reading from loop performance log
  const perfFile = path.join(ROOT, "e2e", "state", "loop-performance.jsonl");
  if (fs.existsSync(perfFile)) {
    try {
      const lines = fs.readFileSync(perfFile, "utf-8").trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]);
        if (typeof last.iter === "number") {
          return last.iter;
        }
      }
    } catch {
      // Fall through
    }
  }

  return 1;
}

// ---------------------------------------------------------------------------
// Phase 1: Ingest — sensory memory from raw findings
// ---------------------------------------------------------------------------

function ingestSensoryMemory(iteration) {
  const findings = loadJson(FINDINGS_FILE);
  if (!Array.isArray(findings)) {
    return { iteration, observations: [], count: 0 };
  }

  // Take unresolved findings, plus recently resolved ones (from this run)
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - 2 * 60 * 60 * 1000); // Last 2 hours

  const observations = [];
  for (const f of findings) {
    const isRecent = f.timestamp && new Date(f.timestamp) > recentCutoff;
    const isUnresolved = f.status !== "resolved";

    if (!isRecent && !isUnresolved) {
      continue;
    }

    const severity = normalizeSeverity(f.severity);
    const outcome = toOutcomeCategory(f);
    const persona = (f.persona ?? "unknown").toLowerCase().replace(/\s+/g, "-");

    observations.push({
      persona,
      page: f.page ?? "unknown",
      outcome,
      type: f.failureType ?? "finding",
      severity,
      description: (f.description ?? "").slice(0, 300),
      timestamp: f.timestamp ?? now.toISOString(),
    });
  }

  // Also ingest from green history — failures are observations too
  const greenHistory = loadJson(GREEN_HISTORY_FILE);
  if (greenHistory && greenHistory.tests) {
    for (const [testTitle, entry] of Object.entries(greenHistory.tests)) {
      if (entry.consecutivePasses === 0 && entry.lastFailed) {
        const failedRecently = new Date(entry.lastFailed) > recentCutoff;
        if (failedRecently) {
          // Extract persona name from test title if possible
          const personaMatch = testTitle.match(/^([A-Za-z][\w -]+?)\s*>/);
          const persona = personaMatch
            ? personaMatch[1].toLowerCase().replace(/\s+/g, "-")
            : "unknown";

          observations.push({
            persona,
            page: "test:" + testTitle.slice(0, 100),
            outcome: "test_failure",
            type: "test_regression",
            severity: "medium",
            description: `Test failed: ${testTitle.slice(0, 200)}`,
            timestamp: entry.lastFailed,
          });
        }
      }
    }
  }

  // Ingest from persona learning — high finding rate personas signal problem areas
  const personaLearning = loadJson(PERSONA_LEARNING_FILE);
  if (personaLearning && personaLearning.personas) {
    for (const [personaId, stats] of Object.entries(personaLearning.personas)) {
      if (stats.findingRate > 0.3 && Array.isArray(stats.recentFindings)) {
        for (const rf of stats.recentFindings.slice(0, 5)) {
          const alreadyIngested = observations.some(
            (o) => o.persona === personaId && o.description.includes(rf.description?.slice(0, 50) ?? "")
          );
          if (!alreadyIngested) {
            observations.push({
              persona: personaId,
              page: rf.page ?? "unknown",
              outcome: toOutcomeCategory({ description: rf.description, failureType: "" }),
              type: "persona_finding",
              severity: normalizeSeverity(rf.severity),
              description: (rf.description ?? "").slice(0, 300),
              timestamp: rf.timestamp ?? now.toISOString(),
            });
          }
        }
      }
    }
  }

  // Ingest from hotspot map — hot areas are observations of systemic issues
  const hotspotMap = loadJson(HOTSPOT_MAP_FILE);
  if (hotspotMap && hotspotMap.hotspots) {
    for (const [area, data] of Object.entries(hotspotMap.hotspots)) {
      if (data.score && data.score >= 0.7) {
        observations.push({
          persona: "system",
          page: area,
          outcome: "hotspot",
          type: "hotspot",
          severity: data.score >= 0.9 ? "high" : "medium",
          description: `Hotspot: ${area} (score ${data.score})`,
          timestamp: now.toISOString(),
        });
      }
    }
  }

  return {
    iteration,
    observations,
    count: observations.length,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Pattern detection — cluster observations into working memory candidates
// ---------------------------------------------------------------------------

function detectPatterns(sensory) {
  const clusters = new Map(); // key = "pagePattern:outcome:severity"

  for (const obs of sensory.observations) {
    const pagePattern = toPagePattern(obs.page);
    const key = `${pagePattern}:${obs.outcome}:${obs.severity}`;

    if (!clusters.has(key)) {
      clusters.set(key, {
        pagePattern,
        outcome: obs.outcome,
        severity: obs.severity,
        observations: [],
        personas: new Set(),
        pages: new Set(),
      });
    }

    const cluster = clusters.get(key);
    cluster.observations.push(obs);
    cluster.personas.add(obs.persona);
    cluster.pages.add(pagePattern);
  }

  // Only promote clusters with 2+ observations to patterns
  const patterns = [];
  for (const [, cluster] of clusters) {
    if (cluster.observations.length < 2) {
      continue;
    }

    const significance = computeSignificance(cluster);
    const id = generatePatternId(cluster.outcome, cluster.pagePattern, cluster.severity);

    // Build a human-readable description from the cluster
    const sampleDescs = cluster.observations
      .slice(0, 3)
      .map((o) => o.description.slice(0, 80));
    const description = cluster.observations.length <= 3
      ? sampleDescs.join("; ")
      : `${sampleDescs[0]} (and ${cluster.observations.length - 1} similar)`;

    // Determine category from outcome
    const categoryMap = {
      error: "reliability",
      permission: "permission",
      selector: "ui_stability",
      visual: "visual",
      transient: "infrastructure",
      ui_change: "ui_stability",
      test_failure: "test_quality",
      hotspot: "systemic",
      other: "general",
    };

    patterns.push({
      id,
      description,
      category: categoryMap[cluster.outcome] ?? "general",
      occurrences: cluster.observations.length,
      personas_involved: [...cluster.personas],
      pages_involved: [...cluster.pages],
      significance,
      severity: cluster.severity,
    });
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Phase 3: Working memory update — merge new patterns, apply decay, enforce capacity
// ---------------------------------------------------------------------------

function updateWorkingMemory(newPatterns, currentIteration) {
  const existing = loadJson(WORKING_FILE) ?? {
    patterns: [],
    capacity: WORKING_MEMORY_CAPACITY,
    lastUpdated: new Date().toISOString(),
  };

  const patternMap = new Map();
  for (const p of existing.patterns) {
    patternMap.set(p.id, p);
  }

  // Merge new patterns
  for (const np of newPatterns) {
    if (patternMap.has(np.id)) {
      // Update existing pattern
      const ep = patternMap.get(np.id);
      ep.occurrences += np.occurrences;
      ep.last_seen_iteration = currentIteration;
      ep.consolidation_score = np.significance * Math.log(ep.occurrences + 1);

      // Merge persona and page lists (deduplicate)
      const personaSet = new Set([...ep.personas_involved, ...np.personas_involved]);
      ep.personas_involved = [...personaSet];
      const pageSet = new Set([...ep.pages_involved, ...np.pages_involved]);
      ep.pages_involved = [...pageSet];
    } else {
      // New pattern
      patternMap.set(np.id, {
        id: np.id,
        description: np.description,
        category: np.category,
        first_seen_iteration: currentIteration,
        last_seen_iteration: currentIteration,
        occurrences: np.occurrences,
        personas_involved: np.personas_involved,
        pages_involved: np.pages_involved,
        consolidation_score: np.significance * Math.log(np.occurrences + 1),
        decay_rate: DECAY_RATE_DEFAULT,
      });
    }
  }

  // Apply decay to patterns not seen this iteration
  for (const [id, p] of patternMap) {
    if (p.last_seen_iteration < currentIteration) {
      p.consolidation_score -= p.decay_rate;
    }
  }

  // Remove patterns below decay floor
  const decayed = [];
  for (const [id, p] of patternMap) {
    if (p.consolidation_score < DECAY_FLOOR) {
      decayed.push(id);
    }
  }
  for (const id of decayed) {
    patternMap.delete(id);
  }

  // Enforce capacity — evict lowest-scoring patterns
  let patterns = [...patternMap.values()];
  if (patterns.length > WORKING_MEMORY_CAPACITY) {
    patterns.sort((a, b) => b.consolidation_score - a.consolidation_score);
    patterns = patterns.slice(0, WORKING_MEMORY_CAPACITY);
  }

  // Prune patterns outside rolling window
  patterns = patterns.filter(
    (p) => currentIteration - p.last_seen_iteration <= ROLLING_WINDOW
  );

  return {
    patterns,
    capacity: WORKING_MEMORY_CAPACITY,
    decayed: decayed.length,
    lastUpdated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Phase 4: Consolidation — promote strong working patterns to long-term memory
// ---------------------------------------------------------------------------

function consolidateToLongterm(workingMemory, currentIteration) {
  const existing = loadJson(LONGTERM_FILE) ?? {
    knowledge: [],
    meta: {
      total_knowledge: 0,
      unresolved: 0,
      avg_confidence: 0,
      generatedAt: new Date().toISOString(),
    },
  };

  const knowledgeMap = new Map();
  for (const k of existing.knowledge) {
    knowledgeMap.set(k.id, k);
  }

  // Identify patterns ready for consolidation
  const toConsolidate = workingMemory.patterns.filter((p) => {
    // Score threshold
    if (p.consolidation_score >= CONSOLIDATION_THRESHOLD) {
      return true;
    }
    // Occurrence threshold
    if (p.occurrences >= CONSOLIDATION_MIN_OCCURRENCES) {
      return true;
    }
    // High severity + multiple personas
    if (
      (p.category === "permission" || p.category === "reliability") &&
      p.personas_involved.length >= 2
    ) {
      return true;
    }
    return false;
  });

  // Group related consolidation candidates by category + affected area
  const groups = new Map();
  for (const p of toConsolidate) {
    const areaKey = p.pages_involved.sort().join(",");
    const groupKey = `${p.category}:${areaKey}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(p);
  }

  let promoted = 0;
  let boosted = 0;

  for (const [, groupPatterns] of groups) {
    const sourceIds = groupPatterns.map((p) => p.id);
    const ltId = generateLongtermId(sourceIds);

    const totalOccurrences = groupPatterns.reduce((sum, p) => sum + p.occurrences, 0);
    const allPersonas = [...new Set(groupPatterns.flatMap((p) => p.personas_involved))];
    const allPages = [...new Set(groupPatterns.flatMap((p) => p.pages_involved))];
    const maxScore = Math.max(...groupPatterns.map((p) => p.consolidation_score));

    // Compute initial confidence from consolidation scores
    const confidence = Math.min(
      0.5 + (maxScore * 0.3) + (allPersonas.length * 0.05),
      CONFIDENCE_MAX
    );

    // Build a systemic description
    const category = groupPatterns[0].category;
    const descriptions = groupPatterns.map((p) => p.description);
    const systemicDescription = descriptions.length === 1
      ? descriptions[0]
      : `${category} issues across ${allPages.join(", ")}: ${descriptions[0].slice(0, 120)}`;

    if (knowledgeMap.has(ltId)) {
      // Boost existing knowledge
      const entry = knowledgeMap.get(ltId);
      entry.confidence = Math.min(entry.confidence + CONFIDENCE_BOOST, CONFIDENCE_MAX);
      entry.last_confirmed_iteration = currentIteration;
      entry.total_occurrences += totalOccurrences;

      // Merge affected areas
      const areaSet = new Set([...entry.affected_areas, ...allPages]);
      entry.affected_areas = [...areaSet];
      boosted++;
    } else {
      // Create new long-term knowledge
      const earliest = Math.min(...groupPatterns.map((p) => p.first_seen_iteration));
      knowledgeMap.set(ltId, {
        id: ltId,
        description: systemicDescription,
        confidence,
        category: category === "reliability" ? "systemic" : category,
        source_patterns: sourceIds,
        first_seen_iteration: earliest,
        last_confirmed_iteration: currentIteration,
        total_occurrences: totalOccurrences,
        affected_areas: allPages,
        resolved: false,
        resolution_note: null,
      });
      promoted++;
    }
  }

  // Recalculate meta
  const knowledge = [...knowledgeMap.values()];
  const unresolved = knowledge.filter((k) => !k.resolved).length;
  const avgConfidence = knowledge.length > 0
    ? knowledge.reduce((sum, k) => sum + k.confidence, 0) / knowledge.length
    : 0;

  return {
    knowledge,
    meta: {
      total_knowledge: knowledge.length,
      unresolved,
      avg_confidence: parseFloat(avgConfidence.toFixed(3)),
      generatedAt: new Date().toISOString(),
    },
    promoted,
    boosted,
  };
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function showStatus() {
  const sensory = loadJson(SENSORY_FILE);
  const working = loadJson(WORKING_FILE);
  const longterm = loadJson(LONGTERM_FILE);

  if (jsonMode) {
    console.log(JSON.stringify({
      sensory: sensory ? { iteration: sensory.iteration, count: sensory.count } : null,
      working: working ? { patterns: working.patterns.length, capacity: working.capacity } : null,
      longterm: longterm ? longterm.meta : null,
    }));
    return;
  }

  console.log("\n[memory] Three-tier memory status");
  console.log("  ===================================");

  if (sensory) {
    console.log(`  Sensory:   ${sensory.count} observations (iteration ${sensory.iteration})`);
  } else {
    console.log("  Sensory:   (empty — no prior run)");
  }

  if (working) {
    const topPatterns = working.patterns
      .sort((a, b) => b.consolidation_score - a.consolidation_score)
      .slice(0, 5);
    console.log(`  Working:   ${working.patterns.length}/${working.capacity} patterns`);
    if (topPatterns.length > 0) {
      console.log("  Top patterns:");
      for (const p of topPatterns) {
        console.log(`    [${p.consolidation_score.toFixed(2)}] ${p.description.slice(0, 80)}`);
      }
    }
  } else {
    console.log("  Working:   (empty — no patterns yet)");
  }

  if (longterm && longterm.meta) {
    console.log(`  Long-term: ${longterm.meta.total_knowledge} entries (${longterm.meta.unresolved} unresolved, avg confidence ${longterm.meta.avg_confidence})`);
    if (longterm.knowledge) {
      const top = longterm.knowledge
        .filter((k) => !k.resolved)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5);
      if (top.length > 0) {
        console.log("  Top knowledge:");
        for (const k of top) {
          console.log(`    [${k.confidence.toFixed(2)}] ${k.description.slice(0, 80)}`);
        }
      }
    }
  } else {
    console.log("  Long-term: (empty — no consolidated knowledge)");
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (statusMode) {
    showStatus();
    return;
  }

  const currentIteration = inferIteration();
  log(`Starting consolidation cycle (iteration ${currentIteration})`);

  // Phase 1: Ingest sensory observations
  log("Phase 1: Ingesting sensory observations...");
  const sensory = ingestSensoryMemory(currentIteration);
  log(`  ${sensory.count} observations collected`);

  // Phase 2: Detect patterns from observations
  log("Phase 2: Detecting patterns...");
  const newPatterns = detectPatterns(sensory);
  log(`  ${newPatterns.length} patterns detected from clusters`);

  // Phase 3: Update working memory (merge, decay, capacity enforcement)
  log("Phase 3: Updating working memory...");
  const workingResult = updateWorkingMemory(newPatterns, currentIteration);
  log(`  ${workingResult.patterns.length} active patterns (${workingResult.decayed} decayed)`);

  // Phase 4: Consolidate to long-term memory
  log("Phase 4: Consolidating to long-term memory...");
  const longtermResult = consolidateToLongterm(workingResult, currentIteration);
  log(`  ${longtermResult.promoted} new, ${longtermResult.boosted} boosted (${longtermResult.meta.total_knowledge} total)`);

  // Build summary
  const summary = {
    iteration: currentIteration,
    sensory: { count: sensory.count },
    working: {
      active: workingResult.patterns.length,
      capacity: WORKING_MEMORY_CAPACITY,
      decayed: workingResult.decayed,
      newPatterns: newPatterns.length,
    },
    longterm: {
      total: longtermResult.meta.total_knowledge,
      unresolved: longtermResult.meta.unresolved,
      avgConfidence: longtermResult.meta.avg_confidence,
      promoted: longtermResult.promoted,
      boosted: longtermResult.boosted,
    },
    timestamp: new Date().toISOString(),
  };

  // Write state files unless --dry-run
  if (!dryRun || exportMode) {
    writeJson(SENSORY_FILE, sensory);
    writeJson(WORKING_FILE, {
      patterns: workingResult.patterns,
      capacity: workingResult.capacity,
      lastUpdated: workingResult.lastUpdated,
    });
    writeJson(LONGTERM_FILE, {
      knowledge: longtermResult.knowledge,
      meta: longtermResult.meta,
    });
    log("State files written.");
  } else {
    log("Dry run — no files written.");
  }

  // Output
  if (jsonMode) {
    console.log(JSON.stringify(summary));
  } else {
    console.log("");
    console.log("[memory] Consolidation complete");
    console.log(`  Sensory:   ${sensory.count} observations`);
    console.log(`  Working:   ${workingResult.patterns.length}/${WORKING_MEMORY_CAPACITY} patterns (${newPatterns.length} new, ${workingResult.decayed} decayed)`);
    console.log(`  Long-term: ${longtermResult.meta.total_knowledge} entries (${longtermResult.promoted} promoted, ${longtermResult.boosted} boosted)`);
    console.log(`  Unresolved knowledge: ${longtermResult.meta.unresolved} (avg confidence ${longtermResult.meta.avg_confidence})`);
    console.log("");
  }
}

main();
