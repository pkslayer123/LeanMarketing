/**
 * Theme-to-Spec Pipeline Connector
 *
 * Connects finding theme consolidation output to the spec decomposer
 * for autonomous improvement loops. When a theme accumulates enough
 * findings, it can be decomposed into implementation MOCs automatically.
 *
 * Flow: themes → filter actionable → check if spec section exists →
 *       generate spec gap → feed to spec decomposer → create MOCs
 *
 * Reads: finding-themes.json, BUILD-SPEC.md
 * Writes: theme-spec-gaps.json (spec gaps derived from themes)
 *
 * Usage:
 *   const { findSpecGaps, generateImprovementMocs } = require("./lib/theme-spec-connector");
 *   const gaps = findSpecGaps();
 *   if (gaps.length > 0) { await generateImprovementMocs(gaps); }
 */

const fs = require("fs");
const path = require("path");
const { pagePathToSourceFiles, toRelativePaths } = require("./page-to-source");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const THEMES_PATH = path.join(STATE_DIR, "finding-themes.json");
const GAPS_PATH = path.join(STATE_DIR, "theme-spec-gaps.json");
const BUILD_SPEC_PATH = path.join(ROOT, "docs", "BUILD-SPEC.md");

// Themes that map to spec sections
const THEME_TO_SPEC_SECTION = {
  "dark-mode": "Dark Mode & Theming",
  "loading-states": "Loading States & Skeleton UIs",
  "null-safety": "Null Safety & Error Boundaries",
  "permission-access": "Permissions & Access Control",
  "error-handling": "Error Handling",
  "form-validation": "Form Validation",
  "accessibility": "Accessibility (WCAG)",
  "layout-responsive": "Responsive Design",
  "navigation-routing": "Navigation & Routing",
  "data-display": "Data Display & Formatting",
  "api-integration": "API Integration",
  "workflow-stages": "MOC Workflow Stages",
  "search-filter": "Search & Filtering",
  "notification-feedback": "Notifications & Feedback",
  "session-auth": "Authentication & Sessions",
};

// Minimum findings in a theme before it warrants a spec gap
const MIN_FINDINGS_FOR_GAP = 3;

/**
 * Load the current BUILD-SPEC.md and extract section headings.
 */
function loadSpecSections() {
  try {
    const content = fs.readFileSync(BUILD_SPEC_PATH, "utf-8");
    const sections = new Set();
    for (const match of content.matchAll(/^##\s+(.+)$/gm)) {
      sections.add(match[1].trim());
    }
    for (const match of content.matchAll(/^###\s+(.+)$/gm)) {
      sections.add(match[1].trim());
    }
    return sections;
  } catch {
    return new Set();
  }
}

/**
 * Load finding themes.
 */
function loadThemes() {
  try {
    if (fs.existsSync(THEMES_PATH)) {
      return JSON.parse(fs.readFileSync(THEMES_PATH, "utf-8"));
    }
  } catch {}
  return null;
}

/**
 * Find spec gaps — themes with enough findings that don't have
 * corresponding BUILD-SPEC.md coverage.
 *
 * @returns {Array<{ themeId: string, title: string, findingCount: number, severity: string, specSection: string|null, isGap: boolean, suggestedSpec: string }>}
 */
function findSpecGaps() {
  const themes = loadThemes();
  if (!themes?.themes) { return []; }

  const specSections = loadSpecSections();
  const gaps = [];

  for (const theme of themes.themes) {
    const findingCount = theme.findingCount ?? theme.findings?.length ?? 0;
    if (findingCount < MIN_FINDINGS_FOR_GAP) { continue; }

    const specSection = THEME_TO_SPEC_SECTION[theme.id ?? theme.themeId] ?? null;

    // Check if this theme's spec section exists in BUILD-SPEC.md
    let isGap = true;
    if (specSection) {
      for (const section of specSections) {
        if (section.toLowerCase().includes(specSection.toLowerCase()) ||
            specSection.toLowerCase().includes(section.toLowerCase())) {
          isGap = false;
          break;
        }
      }
    }

    // Also consider it a gap if the section exists but findings indicate it's incomplete
    const severity = theme.severity ?? theme.dominantSeverity ?? "ux";
    if (severity === "security" || severity === "bug") {
      isGap = true; // Security/bug themes always need attention
    }

    if (isGap || severity === "security") {
      gaps.push({
        themeId: theme.id ?? theme.themeId,
        title: theme.title ?? theme.name ?? theme.id,
        findingCount,
        severity,
        specSection,
        isGap,
        suggestedSpec: generateSpecEntry(theme),
        rootCause: theme.rootCause ?? theme.suggested_fix ?? "",
        examplePages: (theme.pages ?? theme.affectedPages ?? []).slice(0, 5),
      });
    }
  }

  // Sort by severity weight × finding count
  const severityWeight = { security: 5, bug: 3, product: 2, ux: 1.5, suggestion: 1 };
  gaps.sort((a, b) => {
    const wa = (severityWeight[a.severity] ?? 1) * a.findingCount;
    const wb = (severityWeight[b.severity] ?? 1) * b.findingCount;
    return wb - wa;
  });

  // Save gaps
  try {
    const result = { gaps, computedAt: new Date().toISOString(), totalGaps: gaps.length };
    const tmpPath = GAPS_PATH + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2) + "\n");
    fs.renameSync(tmpPath, GAPS_PATH);
  } catch {}

  return gaps;
}

/**
 * Generate a suggested BUILD-SPEC entry for a theme.
 */
function generateSpecEntry(theme) {
  const title = theme.title ?? theme.name ?? theme.id;
  const severity = theme.severity ?? "ux";
  const pages = (theme.pages ?? theme.affectedPages ?? []).slice(0, 3).join(", ");
  const rootCause = theme.rootCause ?? theme.suggested_fix ?? "needs investigation";

  return `### ${title}

**Status:** Gap identified from E2E persona findings
**Severity:** ${severity}
**Finding count:** ${theme.findingCount ?? "unknown"}
**Affected pages:** ${pages || "various"}
**Root cause:** ${rootCause}
**Action:** TODO — implement fix and add to spec
`;
}

/**
 * Generate MOC entries from spec gaps.
 * These can be fed into the MOC queue for the fix pipeline.
 *
 * @param {Array} gaps — Output from findSpecGaps()
 * @returns {Array<{ title: string, description: string, tier: string, severity: string, themeId: string }>}
 */
function generateMocEntries(gaps) {
  const mocs = [];

  for (const gap of gaps) {
    const tier = gap.severity === "security" ? "needs_approval"
      : gap.severity === "bug" ? "auto_approve"
      : "auto_fix";

    // Resolve source files from example pages for moc-auto-fix.js
    const affectedPages = gap.examplePages || [];
    const sourceFilesSet = new Set();
    for (const page of affectedPages) {
      for (const sf of toRelativePaths(pagePathToSourceFiles(page))) {
        sourceFilesSet.add(sf);
      }
    }

    // Skip MOCs with no source files — fix-engine can't act on them
    if (sourceFilesSet.size === 0) { continue; }

    const localId = `moc-theme-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    mocs.push({
      id: localId,
      title: `Fix: ${gap.title} (${gap.findingCount} findings)`,
      description: [
        `Theme: ${gap.themeId}`,
        `Severity: ${gap.severity}`,
        `Finding count: ${gap.findingCount}`,
        `Root cause: ${gap.rootCause}`,
        `Example pages: ${affectedPages.join(", ")}`,
        gap.suggestedSpec ? `\nSuggested spec entry:\n${gap.suggestedSpec}` : "",
      ].filter(Boolean).join("\n"),
      tier,
      severity: gap.severity,
      themeId: gap.themeId,
      source: "theme-spec-connector",
      pageArea: affectedPages[0] || null,
      affectedPages,
      sourceFiles: [...sourceFilesSet].slice(0, 10),
    });
  }

  return mocs;
}

// CLI mode
if (require.main === module) {
  const gaps = findSpecGaps();
  console.log(`Found ${gaps.length} spec gaps from themes:\n`);
  for (const gap of gaps) {
    console.log(`  [${gap.severity}] ${gap.title} — ${gap.findingCount} findings (${gap.isGap ? "GAP" : "incomplete"})`);
  }

  if (gaps.length > 0) {
    const mocs = generateMocEntries(gaps);
    console.log(`\nGenerated ${mocs.length} MOC entries:`);
    for (const moc of mocs) {
      console.log(`  [${moc.tier}] ${moc.title}`);
    }
  }
}

module.exports = {
  findSpecGaps,
  generateMocEntries,
  generateSpecEntry,
  loadSpecSections,
  THEME_TO_SPEC_SECTION,
  MIN_FINDINGS_FOR_GAP,
};
