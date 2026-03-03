/**
 * Persona Nuance — Shared logic for configurable thresholds, severity weighting,
 * and graduated scores across the persona system.
 *
 * Used by: test-frequency, select-tests-by-learning, persona-fleet-health,
 * triage-findings, persona-learner.
 */

// Severity weights: bug/security matter more than ux/suggestion
const SEVERITY_WEIGHTS = {
  security: 3,
  bug: 2,
  ux: 1,
  suggestion: 0.5,
  info: 0.25,
};

function getSeverityWeight(severity) {
  return SEVERITY_WEIGHTS[severity] ?? 0.5;
}

/**
 * Compute weighted finding count (severity-weighted).
 */
function weightedFindingCount(findings) {
  if (!Array.isArray(findings)) return 0;
  return findings.reduce((sum, f) => sum + getSeverityWeight(f.severity ?? "suggestion"), 0);
}

/**
 * Assign tier with configurable thresholds. Optionally factor in finding rate
 * (high finding rate = stay hot longer even after passing).
 *
 * @param {number} consecutivePasses
 * @param {string} lastResult - "passed" | "failed"
 * @param {object} opts - { warmAt, coolAt, coldAt, findingRate }
 */
function assignTier(consecutivePasses, lastResult, opts = {}) {
  const warmAt = opts.warmAt ?? parseInt(process.env.E2E_TEST_FREQ_WARM ?? "3", 10);
  const coolAt = opts.coolAt ?? parseInt(process.env.E2E_TEST_FREQ_COOL ?? "5", 10);
  const coldAt = opts.coldAt ?? parseInt(process.env.E2E_TEST_FREQ_COLD ?? "5", 10);
  const findingRate = opts.findingRate ?? 0;

  if (lastResult === "failed" || consecutivePasses < 1) {
    return "hot";
  }
  // High finding rate: stay warm one tier hotter (finding-rate influence)
  const findingBoost = findingRate >= 0.3 ? 1 : 0;
  const effectivePasses = consecutivePasses + findingBoost;

  if (effectivePasses < warmAt) {
    return "warm";
  }
  if (effectivePasses < Math.max(coolAt, warmAt)) {
    return "cool";
  }
  return "cold";
}

/**
 * Select test titles to run for a given iteration based on tier and cadence.
 */
function selectTitlesForIteration(state, iteration, opts = {}) {
  const warmEvery = opts.warmEvery ?? 2;
  const coolEvery = opts.coolEvery ?? 3;
  const coldEvery = opts.coldEvery ?? 5;
  // Windows cmd limit ~32K — cap grep pattern to avoid "Argument list too long".
  // Each title averages ~38 chars + 1 separator; 20K safe limit ≈ ~500 titles.
  const maxPatternChars = opts.maxPatternChars ?? 20000;

  if (iteration <= 1) return [];

  const candidates = [];
  for (const [title, meta] of Object.entries(state.tests ?? {})) {
    const tier = meta.tier ?? "hot";
    const run =
      tier === "hot" ||
      (tier === "warm" && iteration % warmEvery === 0) ||
      (tier === "cool" && iteration % coolEvery === 0) ||
      (tier === "cold" && iteration % coldEvery === 0);
    if (run) {
      candidates.push({ title, tier, failCount: meta.failCount ?? 0 });
    }
  }

  // If pattern would be too long, prioritize: hot first (by failCount desc), then warm, etc.
  const tierOrder = { hot: 0, warm: 1, cool: 2, cold: 3 };
  candidates.sort((a, b) => (tierOrder[a.tier] ?? 4) - (tierOrder[b.tier] ?? 4) || b.failCount - a.failCount);

  const titles = [];
  let charCount = 0;
  for (const c of candidates) {
    charCount += c.title.length + 1;
    if (charCount > maxPatternChars) {
      break;
    }
    titles.push(c.title);
  }
  return titles;
}

/**
 * Expansion score (0-1): graduated instead of binary. Higher = more likely to expand.
 */
function getExpansionScore(entry, allPersonas, opts = {}) {
  const minRuns = opts.minRuns ?? 5;
  const maxRate = opts.maxRate ?? 0.1;
  const trendWeight = opts.trendWeight ?? 0.2;

  if (!entry || (entry.totalRuns ?? 0) < 2) return 1;
  const rate = entry.findingRate ?? 1;
  const runs = entry.totalRuns ?? 0;

  // Base: low rate + enough runs = high score
  const baseScore = rate < maxRate && runs >= minRuns ? 1 - rate : Math.max(0, 0.5 - rate);
  // Trend: if we have recentFindingRates, compare recent vs older (simplified: use findingRate trend)
  const trend = 0; // Would need history; placeholder
  return Math.min(1, Math.max(0, baseScore + trend * trendWeight));
}

/**
 * Is persona an expansion candidate? (graduated: score >= threshold, minRuns met)
 */
function isExpansionCandidate(entry, allPersonas, opts = {}) {
  const threshold = opts.expansionThreshold ?? 0.5;
  const minRuns = opts.minRuns ?? 5;
  if (!entry || (entry.totalRuns ?? 0) < minRuns) return false;
  return getExpansionScore(entry, allPersonas, opts) >= threshold;
}

/**
 * Improving personas: use trend (rate vs avg) and severity-weighted rate.
 */
function getImprovingPersonas(entries, avgRate, opts = {}) {
  const minRuns = opts.minRuns ?? 5;
  const rateFactor = opts.rateFactor ?? 0.5;
  const useSeverityWeight = opts.useSeverityWeight ?? false;

  return entries
    .filter(([, e]) => (e.totalRuns ?? 0) >= minRuns)
    .filter(([, e]) => {
      const rate = e.findingRate ?? 0;
      const effectiveRate = useSeverityWeight && e.recentFindings
        ? weightedFindingCount(e.recentFindings) / Math.max(1, (e.recentFindings?.length ?? 1))
        : rate;
      return effectiveRate < avgRate * rateFactor;
    })
    .map(([id]) => id);
}

/**
 * Compute focus areas with severity weighting and optional time decay.
 */
function computeFocusAreasWithSeverity(findings, opts = {}) {
  const maxAreas = opts.maxAreas ?? 5;
  const decayHalfLife = opts.decayHalfLife ?? 0; // 0 = no decay

  const pageScores = {};
  const now = Date.now();
  for (const f of findings) {
    const area = (f.page ?? "").split("/").slice(0, 3).join("/");
    if (!area) continue;
    const weight = getSeverityWeight(f.severity ?? "suggestion");
    const ageMs = f.timestamp ? now - new Date(f.timestamp).getTime() : 0;
    const decay = decayHalfLife > 0 ? Math.pow(0.5, ageMs / (decayHalfLife * 24 * 60 * 60 * 1000)) : 1;
    pageScores[area] = (pageScores[area] ?? 0) + weight * decay;
  }
  return Object.entries(pageScores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, maxAreas)
    .map(([area]) => area);
}

/**
 * Detect patterns with severity weighting and impact score.
 */
function detectPatternsWithImpact(findings, opts = {}) {
  const severityWeight = opts.severityWeight ?? true;
  const impactWeight = opts.impactWeight ?? true;

  const patterns = [];

  const p405 = findings.filter((f) => f.description?.includes("got 405 instead of 403"));
  if (p405.length > 0) {
    const impact = impactWeight ? p405.length * getSeverityWeight("security") : p405.length;
    patterns.push({
      priority: 1,
      name: "405 vs 403 on denied access",
      count: p405.length,
      impactScore: impact,
      severity: "security",
      fix: "Add permission checks BEFORE method validation. Return 403, not 405.",
      affected: [...new Set(p405.map((f) => f.page))].slice(0, 5),
    });
  }

  const p500 = findings.filter((f) => f.description?.includes("got 500"));
  if (p500.length > 0) {
    const impact = impactWeight ? p500.length * getSeverityWeight("bug") : p500.length;
    patterns.push({
      priority: 2,
      name: "Server 500 errors",
      count: p500.length,
      impactScore: impact,
      severity: "bug",
      fix: "Change .single() to .maybeSingle(). Add null checks.",
      affected: [...new Set(p500.map((f) => f.page))].slice(0, 5),
    });
  }

  const pPerm = findings.filter((f) => f.permissionKey);
  if (pPerm.length > 0) {
    const impact = impactWeight ? pPerm.length * getSeverityWeight("security") : pPerm.length;
    patterns.push({
      priority: 3,
      name: "Permission check mismatches",
      count: pPerm.length,
      impactScore: impact,
      severity: "security",
      fix: "Verify /api/permissions/check query param handling. Check migration 172 seeds.",
      affected: [...new Set(pPerm.map((f) => f.permissionKey))].slice(0, 5),
    });
  }

  const pDenied = findings.filter(
    (f) => f.description?.includes("denied access") && f.description?.includes("Status: 200")
  );
  if (pDenied.length > 0) {
    const impact = impactWeight ? pDenied.length * getSeverityWeight("security") : pDenied.length;
    patterns.push({
      priority: 4,
      name: "Access control soft failures (200 instead of redirect)",
      count: pDenied.length,
      impactScore: impact,
      severity: "security",
      fix: "Pages should redirect or 403 for unauthorized. Verify server-side permission checks.",
      affected: [...new Set(pDenied.map((f) => f.page))].slice(0, 5),
    });
  }

  const pUx = findings.filter((f) => f.severity === "ux");
  if (pUx.length > 0) {
    const impact = impactWeight ? pUx.length * getSeverityWeight("ux") : pUx.length;
    patterns.push({
      priority: 5,
      name: "UX/Accessibility",
      count: pUx.length,
      impactScore: impact,
      severity: "ux",
      fix: "Focus traps, keyboard nav, responsive layout. Check /mocs at 375px.",
      affected: [...new Set(pUx.map((f) => f.page))].slice(0, 5),
    });
  }

  const byPage = {};
  for (const f of findings) {
    const p = f.page?.split("?")[0] ?? "unknown";
    const w = severityWeight ? getSeverityWeight(f.severity ?? "suggestion") : 1;
    byPage[p] = (byPage[p] ?? 0) + w;
  }
  const hotPages = Object.entries(byPage)
    .filter(([, c]) => c >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (hotPages.length > 0) {
    const totalImpact = hotPages.reduce((s, [, c]) => s + c, 0);
    patterns.push({
      priority: 6,
      name: "High-finding pages (likely single root cause)",
      count: hotPages.reduce((s, [, c]) => s + c, 0),
      impactScore: totalImpact,
      severity: "bug",
      fix: "Investigate root cause on these pages. One fix may resolve many findings.",
      affected: hotPages.map(([p, c]) => `${p} (${c.toFixed(1)})`),
    });
  }

  // Sort by impact score descending, then priority
  return patterns.sort((a, b) => (b.impactScore ?? b.count) - (a.impactScore ?? a.count) || a.priority - b.priority);
}

/**
 * Coverage strength: how many personas cover a page, weighted by finding rate.
 */
function computeCoverageStrength(hotPages, entries, opts = {}) {
  const result = {};
  for (const page of hotPages) {
    const prefix = page.split("/").slice(0, 3).join("/");
    let strength = 0;
    let coveringPersonas = 0;
    for (const [, e] of entries) {
      const areas = e.focusAreas ?? [];
      const covers = areas.some((a) => page.startsWith(a) || a.includes(prefix));
      if (covers) {
        coveringPersonas++;
        strength += (e.findingRate ?? 0) + 0.1; // Avoid zero
      }
    }
    result[page] = { strength, coveringPersonas, hasCoverage: coveringPersonas > 0 };
  }
  return result;
}

module.exports = {
  SEVERITY_WEIGHTS,
  getSeverityWeight,
  weightedFindingCount,
  assignTier,
  selectTitlesForIteration,
  getExpansionScore,
  isExpansionCandidate,
  getImprovingPersonas,
  computeFocusAreasWithSeverity,
  detectPatternsWithImpact,
  computeCoverageStrength,
};
