#!/usr/bin/env node

/**
 * Spec Change Guard — Maps code changes to build spec sections.
 *
 * Prevents automated changes from accidentally overwriting partner/SME features
 * by checking whether affected feature areas have protected SME decisions.
 *
 * Usage:
 *   node scripts/e2e/spec-change-guard.js                    # Staged changes
 *   node scripts/e2e/spec-change-guard.js --commit HEAD~1    # Specific commit
 *   node scripts/e2e/spec-change-guard.js --range main..HEAD # Commit range
 *   node scripts/e2e/spec-change-guard.js --json             # Machine-readable
 *   node scripts/e2e/spec-change-guard.js --ci               # CI mode (fail on SME conflicts)
 *   node scripts/e2e/spec-change-guard.js --report           # Generate spec impact report
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const BUILD_SPEC = path.join(ROOT, "docs", "BUILD-SPEC.md");
const MANIFEST = path.join(ROOT, "e2e", "state", "manifest.json");
const REPORT_DIR = path.join(ROOT, "e2e", "state");

// ---------------------------------------------------------------------------
// File → Feature area mapping
// ---------------------------------------------------------------------------

/** Maps file path patterns to feature areas in BUILD-SPEC.md */
const FILE_TO_FEATURE = {
  // Stage-specific
  "app/moc/[id]/stage-0": "Stage 0: Capture",
  "app/moc/new": "Stage 0: Capture",
  "app/moc/[id]/stage-1": "Stage 1: Frame",
  "app/moc/[id]/stage-2": "Stage 2: Hotspots",
  "app/moc/[id]/stage-3": "Stage 3: Route",
  "app/moc/[id]/stage-4": "Stage 4: Decide",
  "app/moc/[id]/stage-5": "Stage 5: Execute",
  "app/moc/[id]/stage-6": "Stage 6: Closeout",
  "app/mocs/[id]/route": "Stage 3: Route",
  "app/mocs/[id]/review": "Stage 4: Decide",
  "app/mocs/[id]/decide": "Stage 4: Decide",
  "app/mocs/[id]/execute": "Stage 5: Execute",
  "app/mocs/[id]/closeout": "Stage 6: Closeout",

  // API routes by domain
  "app/api/mocs/[id]/review": "Stage 4: Decide",
  "app/api/mocs/[id]/reviewer-inputs": "Stage 4: Decide",
  "app/api/mocs/[id]/department-decisions": "Stage 4: Decide",
  "app/api/mocs/[id]/decision-inputs": "Stage 4: Decide",
  "app/api/mocs/[id]/hotspots": "Stage 2: Hotspots",
  "app/api/mocs/[id]/review-plan": "Stage 3: Route",
  "app/api/mocs/[id]/review-requests": "Stage 3: Route",
  "app/api/mocs/[id]/tasks": "Stage 5: Execute",
  "app/api/mocs/[id]/risks": "Stage 2: Hotspots",

  // Cross-cutting
  "lib/permissions/": "Permissions & Access Control",
  "app/api/permissions/": "Permissions & Access Control",
  "app/admin/permissions": "Permissions & Access Control",
  "lib/notifications/": "Notifications",
  "app/api/notifications": "Notifications",
  "lib/llm/": "AI/Smart Features",
  "lib/ai/": "AI/Smart Features",
  "app/api/llm/": "AI/Smart Features",
  "lib/agents/": "Riley Review-Bot",
  "app/api/agents/": "Riley Review-Bot",

  // General
  "app/mocs/": "MOC Dashboard",
  "app/admin/": "Admin Settings",
  "app/review/": "Stage 4: Decide",
  "lib/workflow/": "Workflow Engine",
  "components/": "UI Components",
  "supabase/migrations/": "Database Schema",
};

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}
const isJson = args.includes("--json");
const isCi = args.includes("--ci");
const isReport = args.includes("--report");
const withIntent = args.includes("--with-intent");

// ---------------------------------------------------------------------------
// Get changed files from git
// ---------------------------------------------------------------------------

function getChangedFiles() {
  const commit = getArg("--commit");
  const range = getArg("--range");

  let cmd;
  if (range) {
    cmd = `git diff --name-only ${range}`;
  } else if (commit) {
    cmd = `git diff --name-only ${commit}~1 ${commit}`;
  } else {
    // Staged + unstaged changes
    cmd = "git diff --name-only HEAD";
  }

  try {
    const output = execSync(cmd, { cwd: ROOT, encoding: "utf-8" });
    return output
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    // Fallback: staged changes only
    try {
      const output = execSync("git diff --cached --name-only", {
        cwd: ROOT,
        encoding: "utf-8",
      });
      return output
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Map files to feature areas
// ---------------------------------------------------------------------------

function mapFileToFeatures(filepath) {
  const features = new Set();
  const normalized = filepath.replace(/\\/g, "/");

  for (const [pattern, feature] of Object.entries(FILE_TO_FEATURE)) {
    if (normalized.includes(pattern.replace("[id]", ""))) {
      features.add(feature);
    }
  }

  // Also check manifest for more specific mappings
  if (fs.existsSync(MANIFEST)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
      for (const [featureKey, config] of Object.entries(manifest.features || {})) {
        const codeAreas = config.codeAreas || [];
        for (const area of codeAreas) {
          if (normalized.includes(area.replace("[id]", ""))) {
            features.add(featureKey);
          }
        }
      }
    } catch {
      // manifest parse error — skip
    }
  }

  if (features.size === 0) {
    features.add("Other");
  }

  return [...features];
}

// ---------------------------------------------------------------------------
// Parse BUILD-SPEC.md for protected sections
// ---------------------------------------------------------------------------

function getProtectedSections() {
  if (!fs.existsSync(BUILD_SPEC)) {
    return {};
  }

  const content = fs.readFileSync(BUILD_SPEC, "utf-8");
  const sections = {};
  let currentSection = null;
  let inProtected = false;
  const protectedItems = [];

  for (const line of content.split("\n")) {
    // Track current section
    const sectionMatch = line.match(/^###\s+(.+)/);
    if (sectionMatch) {
      if (currentSection && protectedItems.length > 0) {
        sections[currentSection] = [...protectedItems];
        protectedItems.length = 0;
      }
      currentSection = sectionMatch[1].replace(/^(Stage \d+:.*?|Cross-Cutting:.*?|Enterprise:.*?)(\s*\(.*\))?$/, "$1").trim();
      inProtected = false;
    }

    // Track protected sections
    if (line.includes("Protected SME Decisions")) {
      inProtected = true;
      continue;
    }

    if (inProtected && line.startsWith("- ") && !line.includes("None recorded yet")) {
      protectedItems.push(line.replace(/^-\s*/, "").trim());
    }

    // End of protected section
    if (inProtected && (line.startsWith("###") || line.startsWith("---"))) {
      inProtected = false;
    }
  }

  // Don't forget the last section
  if (currentSection && protectedItems.length > 0) {
    sections[currentSection] = [...protectedItems];
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Parse SME Intent entries from BUILD-SPEC.md
// ---------------------------------------------------------------------------

function getSmeIntentEntries() {
  if (!fs.existsSync(BUILD_SPEC)) {
    return {};
  }

  const content = fs.readFileSync(BUILD_SPEC, "utf-8");
  const entries = {};
  let currentSection = null;

  for (const line of content.split("\n")) {
    const sectionMatch = line.match(/^###\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
    }

    // Look for table rows with SME Intent content (not just "---")
    if (currentSection && line.startsWith("|") && !line.includes("-----")) {
      const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
      // Table format: Aspect | Spec Requirement | SME Intent | Current State | Gap
      if (cols.length >= 3 && cols[2] && cols[2] !== "SME Intent" && cols[2] !== "—") {
        if (!entries[currentSection]) entries[currentSection] = [];
        entries[currentSection].push({
          aspect: cols[0],
          smeIntent: cols[2],
        });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const changedFiles = getChangedFiles();

  if (changedFiles.length === 0) {
    if (!isJson) console.log("[spec-guard] No changed files detected.");
    if (isJson) console.log(JSON.stringify({ files: 0, features: [], warnings: [] }));
    process.exit(0);
  }

  // Map files to features
  const featureMap = {};
  for (const file of changedFiles) {
    const features = mapFileToFeatures(file);
    for (const feature of features) {
      if (!featureMap[feature]) featureMap[feature] = [];
      featureMap[feature].push(file);
    }
  }

  // Check for protected sections
  const protectedSections = getProtectedSections();
  const smeIntentEntries = getSmeIntentEntries();

  const warnings = [];
  const impacts = [];

  for (const [feature, files] of Object.entries(featureMap)) {
    const impact = {
      feature,
      files,
      hasProtection: false,
      protectedDecisions: [],
      hasSmeIntent: false,
      smeIntentCount: 0,
    };

    // Check if this feature has protected SME decisions
    for (const [section, decisions] of Object.entries(protectedSections)) {
      if (section.includes(feature) || feature.includes(section.split(":")[0])) {
        impact.hasProtection = true;
        impact.protectedDecisions = decisions;
        warnings.push({
          level: "error",
          feature,
          message: `PROTECTED: ${feature} has ${decisions.length} SME-protected decision(s). Manual review required.`,
          decisions,
          files,
        });
      }
    }

    // Check for SME intent entries
    for (const [section, entries] of Object.entries(smeIntentEntries)) {
      if (section.includes(feature) || feature.includes(section.split(":")[0])) {
        impact.hasSmeIntent = true;
        impact.smeIntentCount = entries.length;
        if (!impact.hasProtection) {
          warnings.push({
            level: "warn",
            feature,
            message: `CAUTION: ${feature} has ${entries.length} SME intent entries. Verify alignment.`,
            files,
          });
        }
      }
    }

    impacts.push(impact);
  }

  // Intent analysis: classify whether protected-area changes are safe or risky
  if (withIntent && warnings.some((w) => w.level === "error")) {
    let analyzeIntent;
    try {
      analyzeIntent = require("./change-intent").analyzeIntent;
    } catch {
      if (!isJson) {
        console.log("  [intent] change-intent.js not available — skipping intent analysis");
      }
    }

    if (analyzeIntent) {
      for (const w of warnings) {
        if (w.level !== "error") {
          continue;
        }
        try {
          const intentResult = await analyzeIntent({
            codeAreas: (w.files || []).join(","),
            error: w.decisions ? w.decisions.join("; ") : w.message,
          });
          w.intentAnalysis = {
            intent: intentResult?.intent ?? "unknown",
            confidence: intentResult?.confidence ?? 0,
            summary: intentResult?.summary ?? "",
          };
          // Downgrade from "error" to "warn" if intent says safe (refactor/rename)
          if (intentResult?.intent === "intentional" && intentResult.confidence >= 0.7) {
            w.level = "info";
            w.message = w.message.replace("PROTECTED:", "SAFE CHANGE:");
          }
        } catch {
          w.intentAnalysis = { intent: "error", confidence: 0, summary: "Intent analysis failed" };
        }
      }
    }
  }

  // Output
  if (isJson) {
    console.log(
      JSON.stringify(
        {
          files: changedFiles.length,
          features: Object.keys(featureMap),
          impacts,
          warnings,
          hasProtectedConflicts: warnings.some((w) => w.level === "error"),
        },
        null,
        2
      )
    );
  } else {
    console.log(`\n[spec-guard] Analyzing ${changedFiles.length} changed files...\n`);

    console.log("Feature areas affected:");
    for (const [feature, files] of Object.entries(featureMap)) {
      console.log(`  ${feature}: ${files.length} file(s)`);
    }

    if (warnings.length > 0) {
      console.log(`\n${"=".repeat(60)}`);
      console.log("SPEC CHANGE WARNINGS");
      console.log("=".repeat(60));
      for (const w of warnings) {
        const icon = w.level === "error" ? "!!" : w.level === "info" ? "OK" : "--";
        console.log(`\n  [${icon}] ${w.message}`);
        if (w.decisions) {
          for (const d of w.decisions) {
            console.log(`       Protected: ${d}`);
          }
        }
        if (w.intentAnalysis) {
          console.log(`       Intent: ${w.intentAnalysis.intent} (${(w.intentAnalysis.confidence * 100).toFixed(0)}%) — ${w.intentAnalysis.summary || "no summary"}`);
        }
        console.log(`       Files: ${w.files.join(", ")}`);
      }
      console.log(`\n${"=".repeat(60)}\n`);
    } else {
      console.log("\n  No SME-protected areas affected. Changes look safe.\n");
    }
  }

  // Generate report if requested
  if (isReport) {
    const report = generateReport(changedFiles, featureMap, impacts, warnings);
    const reportPath = path.join(REPORT_DIR, "spec-impact-report.md");
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(reportPath, report);
    if (!isJson) console.log(`Report written to: ${reportPath}`);
  }

  // CI mode: exit 1 on protected conflicts
  if (isCi && warnings.some((w) => w.level === "error")) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(files, featureMap, impacts, warnings) {
  const now = new Date().toISOString().split("T")[0];

  let report = `# Spec Impact Report — ${now}\n\n`;
  report += `**Files changed:** ${files.length}\n`;
  report += `**Feature areas affected:** ${Object.keys(featureMap).length}\n`;
  report += `**Warnings:** ${warnings.length} (${warnings.filter((w) => w.level === "error").length} protected conflicts)\n\n`;

  report += `## Feature Impact Summary\n\n`;
  report += `| Feature | Files | SME Protected | SME Intent |\n`;
  report += `|---------|-------|---------------|------------|\n`;

  for (const impact of impacts) {
    const prot = impact.hasProtection ? `YES (${impact.protectedDecisions.length})` : "No";
    const intent = impact.hasSmeIntent ? `${impact.smeIntentCount} entries` : "None";
    report += `| ${impact.feature} | ${impact.files.length} | ${prot} | ${intent} |\n`;
  }

  if (warnings.length > 0) {
    report += `\n## Warnings\n\n`;
    for (const w of warnings) {
      report += `### ${w.level === "error" ? "PROTECTED CONFLICT" : "Caution"}: ${w.feature}\n\n`;
      report += `${w.message}\n\n`;
      if (w.decisions) {
        report += `Protected decisions:\n`;
        for (const d of w.decisions) {
          report += `- ${d}\n`;
        }
        report += "\n";
      }
      report += `Affected files:\n`;
      for (const f of w.files) {
        report += `- \`${f}\`\n`;
      }
      report += "\n";
    }
  }

  report += `\n## Changed Files by Feature\n\n`;
  for (const [feature, fFiles] of Object.entries(featureMap)) {
    report += `### ${feature}\n\n`;
    for (const f of fFiles) {
      report += `- \`${f}\`\n`;
    }
    report += "\n";
  }

  report += `\n---\n*Generated by spec-change-guard.js*\n`;
  return report;
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[spec-guard] Fatal:", err);
    process.exit(1);
  });
}

// Export for use by other scripts (e.g., findings-to-mocs.js)
module.exports = { mapFileToFeatures, getProtectedSections, FILE_TO_FEATURE };
