#!/usr/bin/env node
/**
 * Pattern Generalizer — Post-iteration script that extracts reusable
 * check patterns from findings for cross-persona verification.
 *
 * Usage:
 *   node scripts/e2e/pattern-generalizer.js [--export] [--dry-run]
 *
 * Wired into orchestrator Phase 3.5.
 */

const fs = require("fs");
const path = require("path");

const FINDINGS_FILE = path.resolve(__dirname, "../../e2e/state/findings/findings.json");
const PATTERNS_FILE = path.resolve(__dirname, "../../e2e/state/check-patterns.json");

const isDryRun = process.argv.includes("--dry-run");

function main() {
  console.log("[pattern-generalizer] Starting pattern extraction...");

  // Load findings
  let findings = [];
  try {
    if (fs.existsSync(FINDINGS_FILE)) {
      findings = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn(`[pattern-generalizer] Could not load findings: ${err.message}`);
    return;
  }

  if (!Array.isArray(findings) || findings.length === 0) {
    console.log("[pattern-generalizer] No findings to process.");
    return;
  }

  // Load existing patterns
  let existingData = { version: 1, updatedAt: new Date().toISOString(), patterns: [] };
  try {
    if (fs.existsSync(PATTERNS_FILE)) {
      existingData = JSON.parse(fs.readFileSync(PATTERNS_FILE, "utf-8"));
    }
  } catch {
    // Start fresh
  }

  // Use the TypeScript module via require (compiled by ts-node or tsc)
  // Fallback to inline extraction if module not available
  let newPatterns = [];
  try {
    const { extractPatterns } = require("../../e2e/lib/pattern-generalizer");
    newPatterns = extractPatterns(findings, existingData);
  } catch {
    // Fallback: simple inline extraction
    newPatterns = extractPatternsInline(findings, existingData);
  }

  if (newPatterns.length === 0) {
    console.log(`[pattern-generalizer] No new patterns extracted (${existingData.patterns.length} existing).`);
    return;
  }

  // Merge new patterns
  const merged = {
    version: 1,
    updatedAt: new Date().toISOString(),
    patterns: [...existingData.patterns, ...newPatterns],
  };

  // Stats
  const byStatus = {};
  for (const p of merged.patterns) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  }

  console.log(`[pattern-generalizer] ${newPatterns.length} new patterns extracted.`);
  console.log(`[pattern-generalizer] Total: ${merged.patterns.length} patterns (${JSON.stringify(byStatus)})`);

  if (isDryRun) {
    console.log("[pattern-generalizer] Dry run — not saving.");
    for (const p of newPatterns) {
      console.log(`  NEW: [${p.category}] ${p.description.slice(0, 100)}`);
    }
    return;
  }

  // Save
  try {
    fs.writeFileSync(PATTERNS_FILE, JSON.stringify(merged, null, 2));
    console.log(`[pattern-generalizer] Saved to ${PATTERNS_FILE}`);
  } catch (err) {
    console.error(`[pattern-generalizer] Failed to save: ${err.message}`);
  }
}

/**
 * Inline fallback extraction (pure JS, no TS dependency).
 * Simplified version of the TypeScript extractPatterns function.
 */
function extractPatternsInline(findings, existing) {
  const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "this", "that", "it", "its", "page", "found", "test", "check", "persona",
    "not", "but", "and", "or", "if", "so", "no", "just",
  ]);

  function extractKw(text) {
    return text.toLowerCase().replace(/[[\](){}'"`,.:;!?]/g, " ")
      .split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  function overlap(a, b) {
    if (!a.length || !b.length) { return 0; }
    const setA = new Set(a);
    let shared = 0;
    for (const w of b) { if (setA.has(w)) { shared++; } }
    const union = new Set([...a, ...b]).size;
    return union > 0 ? shared / union : 0;
  }

  const actionable = findings.filter(f =>
    f.status !== "noise" && f.status !== "resolved" && f.status !== "wont_fix" && f.severity !== "question"
  );

  const clusters = new Map();
  for (const f of actionable) {
    const kw = extractKw((f.description || "").slice(0, 200));
    const key = kw.sort().slice(0, 6).join("|");
    if (key.length < 3) { continue; }
    const c = clusters.get(key) || [];
    c.push(f);
    clusters.set(key, c);
  }

  const results = [];
  const now = new Date().toISOString();

  for (const [, clusterFindings] of clusters) {
    const personas = new Set(clusterFindings.map(f => f.persona));
    if (personas.size < 2) { continue; }

    const clusterKw = extractKw(clusterFindings.map(f => (f.description || "").slice(0, 200)).join(" "));
    const isDup = existing.patterns.some(p => overlap(clusterKw, extractKw(p.description)) > 0.7);
    if (isDup) { continue; }

    const rep = clusterFindings.reduce((best, f) => (f.description || "").length > (best.description || "").length ? f : best);
    const pages = [...new Set(clusterFindings.map(f => f.page))];

    results.push({
      id: `pat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      description: (rep.description || "").slice(0, 200),
      category: "ux",
      verificationInstruction: `Check for similar issues. Keywords: ${clusterKw.slice(0, 8).join(", ")}`,
      sourceFindings: clusterFindings.map(f => (f.description || "").slice(0, 100)),
      affectedPages: pages.slice(0, 20),
      confirmedBy: [...personas],
      negatedBy: [],
      status: personas.size >= 4 ? "widespread" : personas.size >= 2 ? "confirmed" : "candidate",
      createdAt: now,
      lastCheckedAt: now,
      verificationCount: 0,
    });
  }

  return results;
}

main();
