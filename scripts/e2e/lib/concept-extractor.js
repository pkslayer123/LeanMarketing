#!/usr/bin/env node
/**
 * Concept Extractor — Abstracts code-level fix patterns into transferable concepts.
 *
 * Instead of "add null check to line 42 of app/mocs/page.tsx", extracts:
 * "null-safety: API response fields should be null-checked before property access"
 *
 * These abstract concepts transfer across ANY project, unlike code-level patterns.
 *
 * Input: learned-fix-patterns.json (code-level patterns)
 * Output: concept-patterns.json (abstract concepts)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const LEARNED_PATTERNS = path.join(STATE_DIR, "learned-fix-patterns.json");
const CONCEPT_FILE = path.join(STATE_DIR, "concept-patterns.json");

// Concept taxonomy — maps code patterns to transferable concepts
const CONCEPT_RULES = [
  {
    concept: "null-safety",
    category: "defensive-coding",
    patterns: [/null.?check/i, /optional.?chain/i, /\?\./i, /undefined/i, /maybeSingle/i, /emptyToNull/i, /\?\?/],
    description: "API response fields and object properties should be null-checked before access",
    transferable: true,
  },
  {
    concept: "bola-protection",
    category: "security",
    patterns: [/organization_id/i, /org.?filter/i, /access.?control/i, /bola/i, /data.?isolation/i, /rls/i],
    description: "Resource access must verify ownership via organization/user scoping",
    transferable: true,
  },
  {
    concept: "dark-mode-parity",
    category: "ui",
    patterns: [/dark:/i, /dark.?mode/i, /dark:bg-/i, /dark:text-/i],
    description: "Every light-mode style must have a corresponding dark: variant",
    transferable: true,
  },
  {
    concept: "loading-state",
    category: "ux",
    patterns: [/loading/i, /skeleton/i, /spinner/i, /Suspense/i, /isLoading/i],
    description: "Async operations should show loading indicators before data arrives",
    transferable: true,
  },
  {
    concept: "error-boundary",
    category: "resilience",
    patterns: [/try.?catch/i, /error.?boundary/i, /error.?handler/i, /fallback/i, /non.?fatal/i],
    description: "Operations that can fail should be wrapped with error handling and user-facing fallbacks",
    transferable: true,
  },
  {
    concept: "input-validation",
    category: "security",
    patterns: [/validat/i, /sanitiz/i, /escape/i, /xss/i, /injection/i, /input/i],
    description: "User input must be validated and sanitized at system boundaries",
    transferable: true,
  },
  {
    concept: "permission-enforcement",
    category: "security",
    patterns: [/permission/i, /hasMinRole/i, /requireAuth/i, /unauthorized/i, /forbidden/i, /role.?check/i],
    description: "Every endpoint and UI element must enforce appropriate permission checks",
    transferable: true,
  },
  {
    concept: "responsive-layout",
    category: "ui",
    patterns: [/responsive/i, /mobile/i, /sm:|md:|lg:/i, /breakpoint/i, /grid.?cols/i],
    description: "Layouts must adapt to different screen sizes with appropriate breakpoints",
    transferable: true,
  },
  {
    concept: "api-error-handling",
    category: "resilience",
    patterns: [/api.*error/i, /fetch.*fail/i, /status.*[45]\d\d/i, /http.*error/i, /generic.?message/i],
    description: "API errors should be logged server-side with details but return generic messages to clients",
    transferable: true,
  },
  {
    concept: "state-freshness",
    category: "data-integrity",
    patterns: [/stale/i, /refetch/i, /invalidat/i, /cache.*bust/i, /fresh/i],
    description: "Critical decisions must use freshly-fetched data, not cached state",
    transferable: true,
  },
  {
    concept: "accessibility",
    category: "ui",
    patterns: [/aria-/i, /a11y/i, /screen.?reader/i, /wcag/i, /tab.?index/i, /alt.?text/i, /focus/i],
    description: "Interactive elements must be accessible via keyboard, screen reader, and WCAG guidelines",
    transferable: true,
  },
  {
    concept: "form-validation",
    category: "ux",
    patterns: [/form.*valid/i, /required.*field/i, /error.*message/i, /submit.*check/i],
    description: "Forms should validate inputs before submission with clear error messages",
    transferable: true,
  },
];

function extractConcepts() {
  // Load code-level patterns
  let codePatterns = [];
  try {
    if (fs.existsSync(LEARNED_PATTERNS)) {
      const data = JSON.parse(fs.readFileSync(LEARNED_PATTERNS, "utf-8"));
      codePatterns = data.patterns || data || [];
      if (!Array.isArray(codePatterns)) {
        codePatterns = Object.values(codePatterns);
      }
    }
  } catch { /* empty */ }

  // Also load findings for broader concept detection
  let findings = [];
  try {
    const findingsPath = path.join(STATE_DIR, "findings", "findings.json");
    if (fs.existsSync(findingsPath)) {
      const data = JSON.parse(fs.readFileSync(findingsPath, "utf-8"));
      findings = Array.isArray(data) ? data : (data.findings || []);
    }
  } catch { /* empty */ }

  // Also load check-patterns.json for cross-persona patterns
  let checkPatterns = [];
  try {
    const cpPath = path.join(STATE_DIR, "check-patterns.json");
    if (fs.existsSync(cpPath)) {
      const data = JSON.parse(fs.readFileSync(cpPath, "utf-8"));
      checkPatterns = data.patterns || [];
    }
  } catch { /* empty */ }

  // Combine all text sources for concept matching
  const allText = [
    ...codePatterns.map(p => `${p.description || ""} ${p.pattern || ""} ${p.fix || ""} ${p.name || ""}`),
    ...findings.map(f => `${f.description || ""} ${f.root_cause || ""} ${f.page || ""}`),
    ...checkPatterns.map(p => `${p.keyword || ""} ${p.description || ""}`),
  ];

  // Match concepts
  const concepts = {};
  for (const rule of CONCEPT_RULES) {
    let totalMatches = 0;
    const matchedSources = [];

    for (const text of allText) {
      for (const pattern of rule.patterns) {
        if (pattern.test(text)) {
          totalMatches++;
          matchedSources.push(text.slice(0, 100));
          break; // One match per text is enough
        }
      }
    }

    const confidence = Math.min(1.0, totalMatches / 10); // Saturates at 10 matches

    concepts[rule.concept] = {
      concept: rule.concept,
      category: rule.category,
      description: rule.description,
      transferable: rule.transferable,
      evidence: totalMatches,
      confidence: Math.round(confidence * 100) / 100,
      status: confidence >= 0.7 ? "confirmed" : confidence >= 0.3 ? "emerging" : "weak",
      exampleSources: matchedSources.slice(0, 3),
      lastUpdated: new Date().toISOString(),
    };
  }

  return concepts;
}

function main() {
  const concepts = extractConcepts();

  const confirmed = Object.values(concepts).filter(c => c.status === "confirmed").length;
  const emerging = Object.values(concepts).filter(c => c.status === "emerging").length;

  const output = {
    version: 1,
    lastUpdated: new Date().toISOString(),
    stats: {
      totalConcepts: Object.keys(concepts).length,
      confirmed,
      emerging,
      weak: Object.keys(concepts).length - confirmed - emerging,
    },
    concepts,
  };

  fs.writeFileSync(CONCEPT_FILE, JSON.stringify(output, null, 2) + "\n");

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\n--- Concept Patterns ---`);
    console.log(`Confirmed: ${confirmed} | Emerging: ${emerging} | Weak: ${Object.keys(concepts).length - confirmed - emerging}`);
    console.log("");
    for (const [id, c] of Object.entries(concepts).sort((a, b) => b[1].confidence - a[1].confidence)) {
      const badge = c.status === "confirmed" ? "+" : c.status === "emerging" ? "~" : "-";
      console.log(`  ${badge} ${id} (${c.category}): confidence=${c.confidence} evidence=${c.evidence} — ${c.description.slice(0, 80)}`);
    }
    console.log("");
  }
}

if (require.main === module) { main(); }
module.exports = { extractConcepts, CONCEPT_RULES };
