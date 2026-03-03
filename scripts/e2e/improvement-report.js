#!/usr/bin/env node

/**
 * Improvement Report Generator
 *
 * Aggregates persona feedback, findings, and learning data into a prioritized
 * improvement report. Maps improvements to BUILD-SPEC.md sections and identifies
 * patterns across personas.
 *
 * Bridges the gap from "this is broken" to "this should be better" by categorizing
 * feedback into actionable improvement areas with effort estimates.
 *
 * Usage:
 *   node scripts/e2e/improvement-report.js                    # Full report
 *   node scripts/e2e/improvement-report.js --quick-wins       # Quick wins only
 *   node scripts/e2e/improvement-report.js --json             # Machine-readable
 *   node scripts/e2e/improvement-report.js --spec-update      # BUILD-SPEC.md suggestions
 *   node scripts/e2e/improvement-report.js --by-role          # Group by user role
 *   node scripts/e2e/improvement-report.js --by-feature       # Group by feature area
 */

try {
  require("dotenv").config({ path: ".env.local", quiet: true });
} catch {
  // dotenv not installed
}

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FINDINGS_FILE = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const LEARNING_FILE = path.join(ROOT, "e2e", "state", "persona-learning.json");
const REPORT_DIR = path.join(ROOT, "e2e", "reports");
const BUILD_SPEC = path.join(ROOT, "docs", "BUILD-SPEC.md");

const args = process.argv.slice(2);
const isJson = args.includes("--json");
const quickWinsOnly = args.includes("--quick-wins");
const specUpdate = args.includes("--spec-update");
const byRole = args.includes("--by-role");
const byFeature = args.includes("--by-feature");

// ---------------------------------------------------------------------------
// Page → Feature area mapping
// ---------------------------------------------------------------------------

const PAGE_TO_FEATURE = {
  "/mocs/new": "Stage 0: Capture",
  "/moc/new": "Stage 0: Capture",
  "/stage-0": "Stage 0: Capture",
  "/stage-1": "Stage 1: Frame",
  "/stage-2": "Stage 2: Hotspots",
  "/stage-3": "Stage 3: Route",
  "/route": "Stage 3: Route",
  "/stage-4": "Stage 4: Decide",
  "/review": "Stage 4: Decide",
  "/decide": "Stage 4: Decide",
  "/stage-5": "Stage 5: Execute",
  "/execute": "Stage 5: Execute",
  "/stage-6": "Stage 6: Closeout",
  "/closeout": "Stage 6: Closeout",
  "/mocs": "MOC Dashboard",
  "/admin": "Admin Settings",
  "/admin/permissions": "Permissions & Access Control",
  "/review/role-inbox": "Stage 4: Decide",
  "/my-department": "Department Management",
  "/admin/agents": "Riley Review-Bot",
};

const PERSONA_ROLES = {
  "cliff-patience": "user",
  "paige-turner": "user",
  "frank-doorman": "user",
  "raj-diligence": "reviewer",
  "victor-veto": "reviewer",
  "wanda-walls": "dept_head",
  "del-e-gate": "dept_head",
  "sue-pervisor": "admin",
  "grant-powers": "super_admin",
  "oscar-outsider": "external",
  "rex-expired": "expired",
  "norma-null": "user",
  "penny-tester": "user",
  "maria-steadman": "reviewer",
  "cal-compliance": "reviewer",
  "ally-access": "user",
  "daria-dark": "user",
  "pete-perf": "user",
  "max-manual": "admin",
  "cody-trust": "admin",
};

// ---------------------------------------------------------------------------
// Severity → Improvement category heuristic
// ---------------------------------------------------------------------------

function categorizeImprovement(finding) {
  const desc = (finding.description || "").toLowerCase();
  const page = (finding.page || "").toLowerCase();

  if (desc.includes("missing") || desc.includes("need") || desc.includes("context") || desc.includes("data")) {
    return "decision_context";
  }
  if (desc.includes("slow") || desc.includes("step") || desc.includes("click") || desc.includes("workflow") || desc.includes("faster")) {
    return "workflow_efficiency";
  }
  if (desc.includes("chart") || desc.includes("sort") || desc.includes("filter") || desc.includes("display") || desc.includes("layout")) {
    return "data_presentation";
  }
  if (desc.includes("help") || desc.includes("tooltip") || desc.includes("guide") || desc.includes("template") || desc.includes("example")) {
    return "user_empowerment";
  }
  if (desc.includes("terminology") || desc.includes("label") || desc.includes("confus") || desc.includes("expect")) {
    return "real_world_alignment";
  }

  // Product findings carry dimension metadata from spec verification oracle
  if (finding.severity === "product" && finding.productDimension) {
    const dimMap = {
      completeness: "decision_context",
      usability: "real_world_alignment",
      clarity: "user_empowerment",
      efficiency: "workflow_efficiency",
      polish: "data_presentation",
    };
    return dimMap[finding.productDimension] || "decision_context";
  }

  // Default based on severity
  if (finding.severity === "ux") return "real_world_alignment";
  if (finding.severity === "suggestion") return "workflow_efficiency";
  if (finding.severity === "product") return "decision_context";
  return "decision_context";
}

function estimateEffort(finding) {
  // Product findings carry oracle-assigned effort
  if (finding.productEffort) {
    return finding.productEffort;
  }

  const desc = (finding.description || "").toLowerCase();

  // Quick wins: tooltip, label, text changes
  if (desc.includes("tooltip") || desc.includes("label") || desc.includes("text") || desc.includes("rename") || desc.includes("typo")) {
    return "quick_win";
  }
  // Strategic: new features, data pipelines, major redesigns
  if (desc.includes("dashboard") || desc.includes("new feature") || desc.includes("integration") || desc.includes("analytics") || desc.includes("automated")) {
    return "strategic";
  }
  return "medium";
}

function mapPageToFeature(page) {
  if (!page) return "Unknown";
  for (const [pattern, feature] of Object.entries(PAGE_TO_FEATURE)) {
    if (page.includes(pattern)) return feature;
  }
  return "Other";
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------

function loadFindings() {
  if (!fs.existsSync(FINDINGS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function loadLearning() {
  if (!fs.existsSync(LEARNING_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LEARNING_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function loadFeedback() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];

  try {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await supabase
      .from("user_feedback")
      .select("*")
      .in("feedback_type", ["suggestion", "confusion", "question"])
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.warn(`[improvement-report] Feedback query error: ${error.message}`);
      return [];
    }
    return data || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyzeImprovements(findings, feedback, learning) {
  const improvements = [];

  // Process findings (UX, suggestion, inconsistency, and product severity)
  for (const f of findings) {
    if (f.severity !== "ux" && f.severity !== "suggestion" && f.severity !== "inconsistency" && f.severity !== "product") {
      continue;
    }

    // Parse structured UX improvements from vision oracle: [Vision/persona/ux] [category] [effort] (element) suggestion
    const uxMatch = (f.description || "").match(
      /^\[Vision\/[^/]+\/ux\]\s*\[(\w+)\]\s*\[(\w+)\]\s*(?:\(([^)]*)\)\s*)?(.+)$/
    );

    if (uxMatch) {
      improvements.push({
        source: "vision_ux",
        persona: f.persona || "Unknown",
        role: PERSONA_ROLES[f.persona?.toLowerCase().replace(/\s+/g, "-")] || "unknown",
        page: f.page || "",
        feature: mapPageToFeature(f.page),
        category: uxMatch[1], // Pre-classified by oracle
        effort: uxMatch[2],   // Pre-estimated by oracle
        element: uxMatch[3] || "",
        description: uxMatch[4].trim(),
        timestamp: f.timestamp || "",
        failureType: f.failureType,
      });
    } else {
      improvements.push({
        source: "persona_test",
        persona: f.persona || "Unknown",
        role: PERSONA_ROLES[f.persona?.toLowerCase().replace(/\s+/g, "-")] || "unknown",
        page: f.page || "",
        feature: mapPageToFeature(f.page),
        category: categorizeImprovement(f),
        effort: estimateEffort(f),
        description: f.description || "",
        timestamp: f.timestamp || "",
      });
    }
  }

  // Process feedback from user_feedback table
  for (const fb of feedback) {
    improvements.push({
      source: "feedback_table",
      persona: fb.persona_name || "Unknown",
      role: "unknown",
      page: fb.page_url || "",
      feature: mapPageToFeature(fb.page_url),
      category: categorizeImprovement({ description: fb.message, severity: fb.feedback_type }),
      effort: estimateEffort({ description: fb.message }),
      description: fb.title ? `[${fb.title}] ${fb.message}` : fb.message || "",
      timestamp: fb.created_at || "",
      status: fb.status,
    });
  }

  return improvements;
}

function findPatterns(improvements) {
  // Group by description similarity (simple word overlap)
  const groups = {};

  for (const imp of improvements) {
    const words = imp.description.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const key = words.sort().slice(0, 5).join("|");

    if (!groups[key]) {
      groups[key] = { count: 0, personas: new Set(), features: new Set(), items: [] };
    }
    groups[key].count++;
    groups[key].personas.add(imp.persona);
    groups[key].features.add(imp.feature);
    groups[key].items.push(imp);
  }

  // Filter to patterns (2+ occurrences or 2+ personas)
  return Object.values(groups)
    .filter((g) => g.count >= 2 || g.personas.size >= 2)
    .map((g) => ({
      count: g.count,
      personas: [...g.personas],
      features: [...g.features],
      representative: g.items[0].description,
      category: g.items[0].category,
      effort: g.items[0].effort,
    }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(improvements, patterns, learning) {
  const now = new Date().toISOString().split("T")[0];

  const byCategory = {};
  const byEffort = { quick_win: [], medium: [], strategic: [] };
  const byFeatureArea = {};
  const byRoleGroup = {};

  for (const imp of improvements) {
    if (!byCategory[imp.category]) byCategory[imp.category] = [];
    byCategory[imp.category].push(imp);

    if (byEffort[imp.effort]) byEffort[imp.effort].push(imp);

    if (!byFeatureArea[imp.feature]) byFeatureArea[imp.feature] = [];
    byFeatureArea[imp.feature].push(imp);

    if (!byRoleGroup[imp.role]) byRoleGroup[imp.role] = [];
    byRoleGroup[imp.role].push(imp);
  }

  let report = `# Product Improvement Report — ${now}\n\n`;
  report += `**Total improvements identified:** ${improvements.length}\n`;
  report += `**Quick wins:** ${byEffort.quick_win.length}\n`;
  report += `**Medium effort:** ${byEffort.medium.length}\n`;
  report += `**Strategic:** ${byEffort.strategic.length}\n`;
  report += `**Patterns (multi-persona agreement):** ${patterns.length}\n\n`;

  // Category breakdown
  report += `## By Category\n\n`;
  report += `| Category | Count | Top Feature |\n`;
  report += `|----------|-------|-------------|\n`;
  for (const [cat, items] of Object.entries(byCategory)) {
    const topFeature = items.reduce((acc, i) => {
      acc[i.feature] = (acc[i.feature] || 0) + 1;
      return acc;
    }, {});
    const top = Object.entries(topFeature).sort((a, b) => b[1] - a[1])[0];
    report += `| ${cat} | ${items.length} | ${top ? top[0] : "—"} |\n`;
  }

  // Patterns (most actionable)
  if (patterns.length > 0) {
    report += `\n## Multi-Persona Patterns (Highest Priority)\n\n`;
    report += `These improvements were independently identified by multiple personas, indicating real user pain points.\n\n`;
    for (const p of patterns.slice(0, 10)) {
      report += `### ${p.representative.slice(0, 80)}\n\n`;
      report += `- **Reported by:** ${p.personas.join(", ")} (${p.count} times)\n`;
      report += `- **Feature areas:** ${p.features.join(", ")}\n`;
      report += `- **Category:** ${p.category}\n`;
      report += `- **Effort:** ${p.effort}\n\n`;
    }
  }

  // Quick wins
  if (byEffort.quick_win.length > 0 && !byFeature) {
    report += `\n## Quick Wins (< 1 day effort)\n\n`;
    for (const imp of byEffort.quick_win.slice(0, 15)) {
      report += `- **[${imp.feature}]** ${imp.description.slice(0, 100)} _(${imp.persona})_\n`;
    }
  }

  // By feature
  if (byFeature || !quickWinsOnly) {
    report += `\n## By Feature Area\n\n`;
    const sortedFeatures = Object.entries(byFeatureArea).sort((a, b) => b[1].length - a[1].length);
    for (const [feature, items] of sortedFeatures) {
      report += `### ${feature} (${items.length} improvements)\n\n`;
      const cats = {};
      for (const i of items) {
        if (!cats[i.category]) cats[i.category] = [];
        cats[i.category].push(i);
      }
      for (const [cat, catItems] of Object.entries(cats)) {
        report += `**${cat}:**\n`;
        for (const i of catItems.slice(0, 5)) {
          report += `- ${i.description.slice(0, 120)} _(${i.persona}, ${i.effort})_\n`;
        }
        report += "\n";
      }
    }
  }

  // By role
  if (byRole) {
    report += `\n## By User Role\n\n`;
    for (const [role, items] of Object.entries(byRoleGroup)) {
      report += `### ${role} (${items.length} improvements)\n\n`;
      for (const i of items.slice(0, 10)) {
        report += `- **[${i.feature}]** ${i.description.slice(0, 100)} _(${i.category}, ${i.effort})_\n`;
      }
      report += "\n";
    }
  }

  // Spec update suggestions
  if (specUpdate) {
    report += `\n## BUILD-SPEC.md Update Suggestions\n\n`;
    report += `These improvements should be added to the "Persona Insights" sections of BUILD-SPEC.md:\n\n`;
    for (const [feature, items] of Object.entries(byFeatureArea)) {
      const unique = items.slice(0, 3);
      if (unique.length > 0) {
        report += `### ${feature}\n\n`;
        for (const i of unique) {
          report += `- ${i.persona}: "${i.description.slice(0, 120)}"\n`;
        }
        report += "\n";
      }
    }
  }

  // Learning insights
  const learningData = learning.personas || {};
  const topFinders = Object.entries(learningData)
    .filter(([, v]) => v.totalFindings > 10)
    .sort((a, b) => b[1].findingRate - a[1].findingRate)
    .slice(0, 5);

  if (topFinders.length > 0) {
    report += `\n## Top Improvement Finders\n\n`;
    report += `| Persona | Finding Rate | Top Types | Focus Areas |\n`;
    report += `|---------|-------------|-----------|-------------|\n`;
    for (const [id, data] of topFinders) {
      const types = (data.topFindingTypes || []).slice(0, 2).join(", ");
      const areas = (data.focusAreas || []).slice(0, 2).join(", ");
      report += `| ${id} | ${(data.findingRate * 100).toFixed(0)}% | ${types} | ${areas} |\n`;
    }
  }

  report += `\n---\n*Generated by improvement-report.js — Maps persona feedback to actionable product improvements.*\n`;
  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const findings = loadFindings();
  const feedback = await loadFeedback();
  const learning = loadLearning();

  const improvements = analyzeImprovements(findings, feedback, learning);
  const patterns = findPatterns(improvements);

  if (quickWinsOnly) {
    const quickWins = improvements.filter((i) => i.effort === "quick_win");
    if (isJson) {
      console.log(JSON.stringify({ quickWins, count: quickWins.length }, null, 2));
    } else {
      console.log(`\nQuick Wins (${quickWins.length}):\n`);
      for (const qw of quickWins) {
        console.log(`  [${qw.feature}] ${qw.description.slice(0, 100)}`);
        console.log(`    Persona: ${qw.persona} | Category: ${qw.category}\n`);
      }
    }
    return;
  }

  if (isJson) {
    console.log(
      JSON.stringify(
        {
          total: improvements.length,
          patterns: patterns.length,
          byEffort: {
            quick_win: improvements.filter((i) => i.effort === "quick_win").length,
            medium: improvements.filter((i) => i.effort === "medium").length,
            strategic: improvements.filter((i) => i.effort === "strategic").length,
          },
          improvements: improvements.slice(0, 50),
          patterns: patterns.slice(0, 10),
        },
        null,
        2
      )
    );
    return;
  }

  // Generate and write report
  const report = generateReport(improvements, patterns, learning);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `improvement-report-${new Date().toISOString().split("T")[0]}.md`);
  fs.writeFileSync(reportPath, report);
  console.log(`\nImprovement report written to: ${reportPath}\n`);

  // Also print summary
  console.log(`Summary:`);
  console.log(`  Total improvements: ${improvements.length}`);
  console.log(`  Quick wins: ${improvements.filter((i) => i.effort === "quick_win").length}`);
  console.log(`  Medium effort: ${improvements.filter((i) => i.effort === "medium").length}`);
  console.log(`  Strategic: ${improvements.filter((i) => i.effort === "strategic").length}`);
  console.log(`  Multi-persona patterns: ${patterns.length}`);
}

main().catch(console.error);
