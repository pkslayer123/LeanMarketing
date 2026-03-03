#!/usr/bin/env node

/**
 * Record fix effectiveness -- tracks finding resolution across iterations.
 *
 * Now reads actual findings.json and compares per-finding status across iterations:
 * - New findings (appeared this iteration)
 * - Resolved findings (present before, absent or marked resolved now)
 * - Regressed findings (marked resolved before, reappeared)
 * - Persistent findings (still open across iterations)
 *
 * Usage:
 *   node scripts/e2e/record-fix-effectiveness.js --iteration N --findings-count X [--analysis-file path]
 *
 * Called by: loop.sh after each iteration
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FILE = path.join(ROOT, "e2e", "state", "fix-effectiveness.json");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
};

const iteration = parseInt(getArg("--iteration") ?? "0", 10);
const findingsCount = parseInt(getArg("--findings-count") ?? "0", 10);
const analysisFile = getArg("--analysis-file") ?? null;

function load() {
  if (!fs.existsSync(FILE)) {
    return { entries: [], perFinding: [], findingSnapshots: {}, lastUpdated: null };
  }
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return {
      entries: data.entries ?? [],
      perFinding: data.perFinding ?? [],
      findingSnapshots: data.findingSnapshots ?? {},
      lastUpdated: data.lastUpdated ?? null,
    };
  } catch {
    return { entries: [], perFinding: [], findingSnapshots: {}, lastUpdated: null };
  }
}

function save(data) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function findingKey(f) {
  if (f.id) {
    return `id::${f.id}`;
  }
  // Normalize: strip dynamic UUIDs, trim whitespace, lowercase for fuzzy match
  const page = (f.page ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>").trim();
  const desc = (f.description ?? "").slice(0, 120).toLowerCase().replace(/\s+/g, " ").trim();
  return `${page}::${f.severity}::${desc}`;
}

function loadFindings() {
  if (!fs.existsSync(FINDINGS_FILE)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
    return Array.isArray(data) ? data : (data.findings ?? []);
  } catch {
    return [];
  }
}

function main() {
  if (iteration < 1) {
    console.error("Usage: node scripts/e2e/record-fix-effectiveness.js --iteration N --findings-count X [--analysis-file path]");
    process.exit(1);
  }

  const data = load();
  const currentFindings = loadFindings();

  // Build current finding snapshot: key -> { status, severity, persona, page }
  const currentSnapshot = {};
  for (const f of currentFindings) {
    const key = findingKey(f);
    currentSnapshot[key] = {
      status: f.status ?? "open",
      severity: f.severity,
      persona: f.persona,
      page: f.page,
      occurrences: f.occurrences ?? 1,
      description: (f.description ?? "").slice(0, 150),
    };
  }

  // Compare with previous snapshot to compute per-finding changes
  const prevSnapshotKey = `iter-${iteration - 1}`;
  const prevSnapshot = data.findingSnapshots[prevSnapshotKey] ?? {};

  const prevKeys = new Set(Object.keys(prevSnapshot));
  const currKeys = new Set(Object.keys(currentSnapshot));

  let newCount = 0;
  let resolvedCount = 0;
  let regressedCount = 0;
  let persistentCount = 0;
  let noiseCount = 0;

  // Findings in current that weren't in previous = new
  for (const key of currKeys) {
    const curr = currentSnapshot[key];
    if (curr.status === "noise") {
      noiseCount++;
      continue;
    }
    if (!prevKeys.has(key)) {
      newCount++;
    } else {
      // Was in previous too
      const prev = prevSnapshot[key];
      if (prev.status === "resolved" && curr.status === "open") {
        regressedCount++;
      } else {
        persistentCount++;
      }
    }
  }

  // Findings in previous that aren't in current = resolved (verified fixes)
  const verifiedFixes = [];
  for (const key of prevKeys) {
    const prev = prevSnapshot[key];
    if (prev.status === "noise") {
      continue;
    }
    if (!currKeys.has(key) && prev.status === "open") {
      resolvedCount++;
      verifiedFixes.push({
        findingKey: key,
        page: prev.page,
        severity: prev.severity,
        persona: prev.persona,
        verifiedAt: new Date().toISOString(),
        iteration,
      });
    }
  }

  const openCount = currentFindings.filter((f) => f.status === "open" || !f.status).length;
  const totalCount = currentFindings.length;

  // Product quality breakdown
  const productFindings = currentFindings.filter((f) => f.severity === "product");
  const productOpen = productFindings.filter((f) => f.status === "open" || !f.status).length;
  const productGrades = {};
  for (const f of productFindings) {
    const grade = f.productGrade ?? "?";
    productGrades[grade] = (productGrades[grade] ?? 0) + 1;
  }
  const productPages = new Set(productFindings.map((f) => (f.page ?? "").replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "")).filter(Boolean)).size;

  // Update previous entry with findings-after
  const prevEntry = data.entries.find((e) => e.findingsAfter == null);
  if (prevEntry) {
    prevEntry.findingsAfter = findingsCount;
    prevEntry.resolved = prevEntry.findingsBefore > findingsCount;
    prevEntry.perFindingDelta = {
      new: newCount,
      resolved: resolvedCount,
      regressed: regressedCount,
      persistent: persistentCount,
      noise: noiseCount,
    };
  }

  // Create new entry for this iteration
  data.entries.push({
    id: `fix-${Date.now()}`,
    iteration,
    findingsBefore: findingsCount,
    findingsAfter: null,
    analysisFile: analysisFile ?? null,
    timestamp: new Date().toISOString(),
    resolved: null,
    breakdown: {
      total: totalCount,
      open: openCount,
      noise: noiseCount,
      new: newCount,
      resolved: resolvedCount,
      regressed: regressedCount,
      persistent: persistentCount,
    },
    productQuality: {
      total: productFindings.length,
      open: productOpen,
      pagesGraded: productPages,
      grades: productGrades,
    },
  });

  // Accumulate verified fixes (capped at 200 for bounded growth)
  if (!data.verifiedFixes) {
    data.verifiedFixes = [];
  }
  data.verifiedFixes.push(...verifiedFixes);
  if (data.verifiedFixes.length > 200) {
    data.verifiedFixes = data.verifiedFixes.slice(-200);
  }

  // Save current snapshot for next iteration comparison
  const currSnapshotKey = `iter-${iteration}`;
  data.findingSnapshots[currSnapshotKey] = currentSnapshot;

  // Keep only last 5 snapshots to prevent unbounded growth
  const snapshotKeys = Object.keys(data.findingSnapshots).sort();
  while (snapshotKeys.length > 5) {
    const oldest = snapshotKeys.shift();
    delete data.findingSnapshots[oldest];
  }

  // Keep only last 30 entries
  if (data.entries.length > 30) {
    data.entries = data.entries.slice(-30);
  }

  save(data);

  console.log(`Fix effectiveness (iter ${iteration}): ${totalCount} total, ${openCount} open, ${noiseCount} noise, +${newCount} new, -${resolvedCount} resolved, ${regressedCount} regressed, ${persistentCount} persistent`);
  if (productFindings.length > 0) {
    const gradeStr = Object.entries(productGrades).map(([g, n]) => `${g}:${n}`).join(" ");
    console.log(`  Product quality: ${productFindings.length} findings, ${productOpen} open, ${productPages} pages graded [${gradeStr}]`);
  }

  try {
    const audit = require("./audit-log.js");
    audit.appendAuditLog("fix_effectiveness_recorded", process.env.E2E_AUDIT_ACTOR ?? "script", {
      iteration,
      findingsCount,
      breakdown: { total: totalCount, open: openCount, noise: noiseCount, new: newCount, resolved: resolvedCount, regressed: regressedCount },
    });
  } catch {
    // Audit is best-effort
  }
}

main();
