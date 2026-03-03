/**
 * Zero-Shot Fix Pattern Matcher
 *
 * Matches findings against learned fix patterns (local + cross-project shared)
 * for instant fixes without LLM. When a finding matches a known pattern,
 * the fix can be applied directly.
 *
 * Reads:
 *   - e2e/state/learned-fix-patterns.json (local patterns)
 *   - ~/.persona-engine/shared-patterns.json (cross-project, if exists)
 *
 * Usage:
 *   const { findMatchingPattern, applyPattern } = require("./lib/pattern-matcher");
 *   const match = findMatchingPattern(finding);
 *   if (match) { const result = applyPattern(match, filePath); }
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const LOCAL_PATTERNS_PATH = path.join(STATE_DIR, "learned-fix-patterns.json");
const SHARED_PATTERNS_PATH = path.join(os.homedir(), ".persona-engine", "shared-patterns.json");

let _localPatterns = null;
let _sharedPatterns = null;
let _patternsLoadedAt = 0;
const CACHE_TTL_MS = 300000; // Reload patterns every 5 min

function loadPatterns() {
  const now = Date.now();
  if (_localPatterns && now - _patternsLoadedAt < CACHE_TTL_MS) {
    return { local: _localPatterns, shared: _sharedPatterns };
  }

  // Load local patterns
  try {
    if (fs.existsSync(LOCAL_PATTERNS_PATH)) {
      const data = JSON.parse(fs.readFileSync(LOCAL_PATTERNS_PATH, "utf-8"));
      const raw = Array.isArray(data) ? data : (data.patterns ?? []);
      _localPatterns = Array.isArray(raw) ? raw : [];
    } else {
      _localPatterns = [];
    }
  } catch {
    _localPatterns = [];
  }

  // Load cross-project shared patterns
  try {
    if (fs.existsSync(SHARED_PATTERNS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SHARED_PATTERNS_PATH, "utf-8"));
      const rawShared = Array.isArray(data) ? data : (data.patterns ?? []);
      _sharedPatterns = Array.isArray(rawShared) ? rawShared : [];
    } else {
      _sharedPatterns = [];
    }
  } catch {
    _sharedPatterns = [];
  }

  _patternsLoadedAt = now;
  return { local: _localPatterns, shared: _sharedPatterns };
}

/**
 * Match a finding against all known patterns.
 *
 * @param {{ description: string, page?: string, severity?: string, evidence?: string }} finding
 * @returns {{ pattern: object, source: "local"|"shared", confidence: number } | null}
 */
function findMatchingPattern(finding) {
  const { local, shared } = loadPatterns();
  const text = `${finding.description ?? ""} ${finding.evidence ?? ""} ${finding.page ?? ""}`.toLowerCase();

  // Try local patterns first (higher trust)
  const localMatch = _matchAgainst(local, text, finding);
  if (localMatch) {
    return { ...localMatch, source: "local" };
  }

  // Try shared patterns
  const sharedMatch = _matchAgainst(shared, text, finding);
  if (sharedMatch) {
    return { ...sharedMatch, source: "shared" };
  }

  return null;
}

function _matchAgainst(patterns, text, finding) {
  if (!Array.isArray(patterns)) { return null; }
  for (const pattern of patterns) {
    if (pattern.disabled) { continue; }

    // Skip patterns with poor effectiveness
    if (pattern.effectiveness?.successRate !== null &&
        pattern.effectiveness?.successRate !== undefined &&
        pattern.effectiveness.successRate < 0.3 &&
        pattern.effectiveness.timesApplied > 2) {
      continue;
    }

    // Match by search pattern
    if (pattern.search) {
      try {
        const regex = new RegExp(pattern.search, "i");
        if (regex.test(text)) {
          const confidence = computeConfidence(pattern, finding);
          if (confidence >= 0.5) {
            return { pattern, confidence };
          }
        }
      } catch {
        // Invalid regex — try literal match
        if (text.includes(pattern.search.toLowerCase())) {
          return { pattern, confidence: 0.6 };
        }
      }
    }

    // Match by description keywords
    if (pattern.description) {
      const keywords = pattern.description.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const matched = keywords.filter((kw) => text.includes(kw));
      if (matched.length >= 3 && matched.length / keywords.length >= 0.5) {
        return { pattern, confidence: 0.5 + (matched.length / keywords.length) * 0.3 };
      }
    }
  }

  return null;
}

/**
 * Compute confidence for a pattern match.
 */
function computeConfidence(pattern, finding) {
  let confidence = 0.6; // Base

  // Boost: pattern has good track record
  if (pattern.effectiveness?.successRate > 0.7) {
    confidence += 0.15;
  }
  if (pattern.effectiveness?.timesApplied > 5) {
    confidence += 0.1;
  }

  // Boost: severity match
  if (finding.severity && pattern.fixType === "code") {
    confidence += 0.05;
  }

  // Boost: has autoFix enabled
  if (pattern.autoFix) {
    confidence += 0.1;
  }

  // Reduce: pattern is old and untested
  if (pattern.effectiveness?.timesApplied === 0) {
    confidence -= 0.1;
  }

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Apply a matched pattern to fix a file.
 *
 * @param {{ pattern: object, source: string }} match — From findMatchingPattern
 * @param {string} filePath — File to apply the fix to (optional, pattern may have glob)
 * @returns {{ applied: boolean, filesChanged: number, error?: string }}
 */
function applyPattern(match, filePath) {
  const { pattern } = match;

  if (!pattern.search || !pattern.replace) {
    return { applied: false, filesChanged: 0, error: "pattern has no search/replace" };
  }

  // Determine target files
  const targetGlob = filePath ?? pattern.glob;
  if (!targetGlob) {
    return { applied: false, filesChanged: 0, error: "no target file or glob" };
  }

  try {
    // Use grep to find matching files
    const grepResult = execSync(
      `grep -rl "${pattern.search.replace(/"/g, '\\"')}" ${targetGlob} 2>/dev/null || true`,
      { cwd: ROOT, stdio: "pipe", timeout: 10000 }
    ).toString().trim();

    const files = grepResult ? grepResult.split("\n").filter(Boolean) : [];

    if (files.length === 0) {
      return { applied: false, filesChanged: 0, error: "no files match pattern" };
    }

    let changed = 0;
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(ROOT, file), "utf-8");
        const regex = new RegExp(pattern.search, "g");
        const newContent = content.replace(regex, pattern.replace);

        if (newContent !== content) {
          fs.writeFileSync(path.join(ROOT, file), newContent);
          changed++;
        }
      } catch {
        // Skip files that can't be read/written
      }
    }

    // Update effectiveness tracking
    if (changed > 0) {
      _updateEffectiveness(pattern, changed);
    }

    return { applied: changed > 0, filesChanged: changed };
  } catch (err) {
    return { applied: false, filesChanged: 0, error: err.message };
  }
}

/**
 * Update pattern effectiveness after applying.
 */
function _updateEffectiveness(pattern, filesChanged) {
  try {
    if (!pattern.effectiveness) {
      pattern.effectiveness = { timesApplied: 0, filesChanged: 0, lastApplied: null, successRate: null, successes: 0, failures: 0 };
    }
    pattern.effectiveness.timesApplied = (pattern.effectiveness.timesApplied ?? 0) + 1;
    pattern.effectiveness.filesChanged = (pattern.effectiveness.filesChanged ?? 0) + filesChanged;
    pattern.effectiveness.lastApplied = new Date().toISOString();

    // Recompute successRate from tracked outcomes
    const s = pattern.effectiveness.successes ?? 0;
    const f = pattern.effectiveness.failures ?? 0;
    if (s + f > 0) {
      pattern.effectiveness.successRate = parseFloat((s / (s + f)).toFixed(3));
    }

    _savePattern(pattern);
  } catch {
    // Non-fatal
  }
}

/**
 * Record fix verification outcome for a pattern.
 * Called by moc-commit-tracker.js when a fix is verified as working or failing.
 * @param {string} patternId — Pattern ID
 * @param {boolean} success — Whether the fix actually resolved the issue
 */
function recordVerificationOutcome(patternId, success) {
  try {
    if (!fs.existsSync(LOCAL_PATTERNS_PATH)) { return; }
    const data = JSON.parse(fs.readFileSync(LOCAL_PATTERNS_PATH, "utf-8"));
    const patterns = Array.isArray(data) ? data : (data.patterns ?? []);
    const pattern = patterns.find((p) => p.id === patternId);
    if (!pattern) { return; }

    if (!pattern.effectiveness) {
      pattern.effectiveness = { timesApplied: 0, filesChanged: 0, lastApplied: null, successRate: null, successes: 0, failures: 0 };
    }

    if (success) {
      pattern.effectiveness.successes = (pattern.effectiveness.successes ?? 0) + 1;
    } else {
      pattern.effectiveness.failures = (pattern.effectiveness.failures ?? 0) + 1;
    }

    // Recompute successRate
    const s = pattern.effectiveness.successes ?? 0;
    const f = pattern.effectiveness.failures ?? 0;
    if (s + f > 0) {
      pattern.effectiveness.successRate = parseFloat((s / (s + f)).toFixed(3));
    }

    // Auto-disable patterns that consistently fail (< 0.3 success rate with 3+ outcomes)
    if (pattern.effectiveness.successRate < 0.3 && s + f >= 3) {
      pattern.disabled = true;
      pattern.disabledReason = `low success rate: ${pattern.effectiveness.successRate} (${s}/${s + f})`;
    }

    _savePattern(pattern);
  } catch {
    // Non-fatal
  }
}

/** Save a modified pattern back to local patterns file. */
function _savePattern(pattern) {
  try {
    if (!fs.existsSync(LOCAL_PATTERNS_PATH)) { return; }
    const data = JSON.parse(fs.readFileSync(LOCAL_PATTERNS_PATH, "utf-8"));
    const patterns = Array.isArray(data) ? data : (data.patterns ?? []);
    const idx = patterns.findIndex((p) => p.id === pattern.id);
    if (idx !== -1) {
      patterns[idx] = pattern;
      const tmpPath = LOCAL_PATTERNS_PATH + `.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(Array.isArray(data) ? patterns : { ...data, patterns }, null, 2) + "\n");
      fs.renameSync(tmpPath, LOCAL_PATTERNS_PATH);
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Export a successful local pattern to the shared cross-project store.
 */
function sharePattern(pattern) {
  try {
    const dir = path.dirname(SHARED_PATTERNS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let shared = [];
    if (fs.existsSync(SHARED_PATTERNS_PATH)) {
      try {
        const data = JSON.parse(fs.readFileSync(SHARED_PATTERNS_PATH, "utf-8"));
        shared = Array.isArray(data) ? data : (data.patterns ?? []);
      } catch {
        shared = [];
      }
    }

    // Dedup by ID
    if (shared.some((p) => p.id === pattern.id)) { return; }

    shared.push({
      ...pattern,
      sharedFrom: "changepilot",
      sharedAt: new Date().toISOString(),
    });

    fs.writeFileSync(SHARED_PATTERNS_PATH, JSON.stringify(shared, null, 2) + "\n");
  } catch {
    // Non-fatal
  }
}

/**
 * Get statistics about pattern matching effectiveness.
 */
function getStats() {
  const { local, shared } = loadPatterns();
  const activeLocal = local.filter((p) => !p.disabled);
  const activeShared = shared.filter((p) => !p.disabled);
  const applied = activeLocal.filter((p) => (p.effectiveness?.timesApplied ?? 0) > 0);
  const effective = applied.filter((p) =>
    p.effectiveness?.successRate === null || p.effectiveness.successRate > 0.5
  );

  return {
    localPatterns: activeLocal.length,
    sharedPatterns: activeShared.length,
    appliedPatterns: applied.length,
    effectivePatterns: effective.length,
    totalApplications: applied.reduce((sum, p) => sum + (p.effectiveness?.timesApplied ?? 0), 0),
  };
}

module.exports = {
  findMatchingPattern,
  applyPattern,
  sharePattern,
  getStats,
  loadPatterns,
  recordVerificationOutcome,
};
