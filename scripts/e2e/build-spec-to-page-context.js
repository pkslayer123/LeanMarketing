#!/usr/bin/env node

/**
 * build-spec-to-page-context.js
 *
 * Auto-populates e2e/state/page-spec-context.json from docs/BUILD-SPEC.md.
 * Extracts codeAreas → page routes, Spec Requirements → mustHave/shouldHave,
 * and section context → purpose/userGoal.
 *
 * Usage:
 *   node scripts/e2e/build-spec-to-page-context.js           # Update page-spec-context.json
 *   node scripts/e2e/build-spec-to-page-context.js --dry-run  # Preview without writing
 *   node scripts/e2e/build-spec-to-page-context.js --diff     # Show changes vs current
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const BUILD_SPEC = path.join(ROOT, "docs", "BUILD-SPEC.md");
const PAGE_SPEC_FILE = path.join(ROOT, "e2e", "state", "page-spec-context.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SHOW_DIFF = args.includes("--diff");

// ---------------------------------------------------------------------------
// Parse BUILD-SPEC.md sections
// ---------------------------------------------------------------------------

function parseBuildSpec() {
  if (!fs.existsSync(BUILD_SPEC)) {
    console.error("BUILD-SPEC.md not found at", BUILD_SPEC);
    process.exit(1);
  }

  const content = fs.readFileSync(BUILD_SPEC, "utf-8");
  const lines = content.split("\n");
  const sections = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New section header: ### Section Name
    const headerMatch = line.match(/^###\s+(.+)/);
    if (headerMatch) {
      if (current) {
        sections.push(current);
      }
      current = {
        name: headerMatch[1].trim(),
        codeAreas: [],
        aspects: [],
        personaInsights: [],
        protectedDecisions: [],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    // codeAreas line: **codeAreas:** `path1`, `path2`, ...
    const codeAreasMatch = line.match(/^\*\*codeAreas:\*\*\s*(.+)/);
    if (codeAreasMatch) {
      const areas = codeAreasMatch[1].match(/`([^`]+)`/g) || [];
      current.codeAreas = areas.map((a) => a.replace(/`/g, "").trim());
      continue;
    }

    // Table row: | Aspect | Spec Requirement | SME Intent | Current State | Gap |
    const tableMatch = line.match(
      /^\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]*)\|/
    );
    if (tableMatch) {
      const aspect = tableMatch[1].trim();
      const specReq = tableMatch[2].trim();
      const currentState = tableMatch[4].trim();
      const gap = tableMatch[5].trim();
      // Skip header rows and separator rows
      if (
        aspect === "Aspect" ||
        aspect.startsWith("---") ||
        aspect.startsWith("===")
      ) {
        continue;
      }
      current.aspects.push({ aspect, specReq, currentState, gap });
    }

    // Persona insights: - PersonaName: "observation"
    if (line.match(/^- .+:.*"[^"]*"/)) {
      current.personaInsights.push(line.replace(/^- /, "").trim());
    }

    // Protected decisions: bullet points after "Protected SME Decisions"
    if (line.match(/Protected SME Decisions/i)) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].match(/^- /)) {
          current.protectedDecisions.push(lines[j].replace(/^- /, "").trim());
        } else if (lines[j].trim() === "" || lines[j].match(/^#/)) {
          break;
        }
      }
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Extract page routes from codeAreas
// ---------------------------------------------------------------------------

/** Map codeArea paths to user-facing page routes */
function codeAreaToPageRoutes(codeAreas) {
  const routes = new Set();

  for (const area of codeAreas) {
    // app/moc/new/ → /moc/new (creation page)
    // app/mocs/[id]/route/ → /mocs/[id]/route
    // app/admin/permissions/ → /admin/permissions
    // app/login/ → /login
    const appMatch = area.match(/^app\/(.+?)(?:\/page\.tsx)?$/);
    if (appMatch) {
      let route = "/" + appMatch[1].replace(/\/$/, "");
      // Skip bare page.tsx (landing page handled separately as "/")
      if (route === "/page.tsx" || route === "/page") {
        continue;
      }
      // Normalize: app/moc/[id]/page.tsx → skip (it's a layout, not a specific route)
      if (route.match(/\/\[id\]$/)) {
        continue;
      }
      // Skip API routes and non-page directories (lib/, e2e/, scripts/, .github/)
      if (route.startsWith("/api/") || route.match(/^\/(?:lib|e2e|scripts|\.)/)) {
        continue;
      }
      routes.add(route);
    }
  }

  return [...routes];
}

// ---------------------------------------------------------------------------
// Derive page spec context from section data
// ---------------------------------------------------------------------------

/** Convert BUILD-SPEC section into page-spec-context entry */
function sectionToPageContext(section, route) {
  // Derive purpose from section name + aspects
  const purpose = derivePurpose(section, route);
  const userGoal = deriveUserGoal(section, route);

  // Extract mustHave from spec requirements with "Implemented" current state
  const mustHave = [];
  const shouldHave = [];

  for (const asp of section.aspects) {
    const label = asp.aspect;
    if (!label || label.length < 3) {
      continue;
    }

    // Items with gaps or "None" current state → shouldHave
    if (
      asp.gap &&
      asp.gap !== "None" &&
      asp.gap !== "—" &&
      asp.gap !== "--"
    ) {
      shouldHave.push(label);
    } else if (
      asp.currentState.toLowerCase().includes("implement") ||
      asp.currentState.toLowerCase().includes("working") ||
      asp.currentState.toLowerCase().includes("complete")
    ) {
      mustHave.push(label);
    } else {
      shouldHave.push(label);
    }
  }

  return {
    purpose,
    userGoal,
    mustHave: mustHave.slice(0, 8), // Cap at 8 for oracle prompt length
    shouldHave: shouldHave.slice(0, 6),
    specSection: section.name,
  };
}

function derivePurpose(section, route) {
  const name = section.name;

  // Stage-specific purposes
  if (name.includes("Stage 0")) {
    return "Create a new MOC with title, description, change type, and optional AI suggestions";
  }
  if (name.includes("Stage 1")) {
    return "Capture detailed change assessment including scope, framing, and risk factors";
  }
  if (name.includes("Stage 2")) {
    return "Identify risk hotspots and affected areas for the change";
  }
  if (name.includes("Stage 3")) {
    return "Route MOC to relevant departments for review and configure review plan";
  }
  if (name.includes("Stage 4")) {
    return "Collect department reviews, make decisions, and finalize conditions";
  }
  if (name.includes("Stage 5")) {
    return "Track implementation tasks and verify change completion";
  }
  if (name.includes("Stage 6")) {
    return "Final closeout with effectiveness review and lessons learned";
  }

  // Admin pages
  if (route.includes("/admin/permissions")) {
    return "Configure role-based permissions for the organization";
  }
  if (route.includes("/admin/departments")) {
    return "Manage organization departments and their review configurations";
  }
  if (route.includes("/admin/people")) {
    return "Manage organization members — invite, edit roles, remove";
  }
  if (route.includes("/admin/features")) {
    return "Toggle feature flags for the organization";
  }

  // Generic from section name
  return `${name} — manage and configure this feature area`;
}

function deriveUserGoal(section, route) {
  const name = section.name;

  if (name.includes("Stage 0")) {
    return "Submit a change request quickly with enough context for reviewers";
  }
  if (name.includes("Stage 1")) {
    return "Provide enough context for reviewers to assess the change";
  }
  if (name.includes("Stage 2")) {
    return "Accurately identify which parts of the system are affected";
  }
  if (name.includes("Stage 3")) {
    return "Send MOC to the right reviewers based on change type";
  }
  if (name.includes("Stage 4")) {
    return "See all department reviews and finalize the decision";
  }
  if (name.includes("Stage 5")) {
    return "Ensure all implementation steps are done before closing";
  }
  if (name.includes("Stage 6")) {
    return "Review the entire MOC lifecycle and document lessons learned";
  }
  if (route.includes("/admin")) {
    return "Configure and manage this feature efficiently";
  }
  if (route.includes("/review")) {
    return "Quickly see and act on items waiting for review";
  }

  return "Accomplish the task efficiently without confusion";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const sections = parseBuildSpec();
  console.log(`Parsed ${sections.length} sections from BUILD-SPEC.md`);

  // Load existing page-spec-context (preserve hand-written entries)
  let existing = {};
  if (fs.existsSync(PAGE_SPEC_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(PAGE_SPEC_FILE, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const generated = {};
  let newCount = 0;
  let updatedCount = 0;

  for (const section of sections) {
    if (section.codeAreas.length === 0) {
      continue;
    }

    const routes = codeAreaToPageRoutes(section.codeAreas);
    for (const route of routes) {
      const entry = sectionToPageContext(section, route);

      // Only generate if we have meaningful content
      if (entry.mustHave.length === 0 && entry.shouldHave.length === 0) {
        continue;
      }

      if (existing[route]) {
        updatedCount++;
        // Merge: keep hand-written fields, add BUILD-SPEC derived fields
        generated[route] = {
          ...entry,
          // Preserve hand-written overrides
          purpose: existing[route].purpose || entry.purpose,
          userGoal: existing[route].userGoal || entry.userGoal,
          // Merge mustHave/shouldHave (dedup)
          mustHave: [
            ...new Set([...existing[route].mustHave, ...entry.mustHave]),
          ].slice(0, 8),
          shouldHave: [
            ...new Set([
              ...(existing[route].shouldHave || []),
              ...entry.shouldHave,
            ]),
          ].slice(0, 6),
          specSection: entry.specSection,
        };
      } else {
        newCount++;
        generated[route] = entry;
      }
    }
  }

  // Combine: existing (preserved) + generated (new/updated)
  const result = { ...existing };
  for (const [route, entry] of Object.entries(generated)) {
    result[route] = entry;
  }

  // Sort by route for readability
  const sorted = {};
  for (const key of Object.keys(result).sort()) {
    sorted[key] = result[key];
  }

  console.log(
    `Result: ${Object.keys(sorted).length} pages (${newCount} new, ${updatedCount} updated from BUILD-SPEC)`
  );

  if (SHOW_DIFF) {
    const existingKeys = new Set(Object.keys(existing));
    const newKeys = Object.keys(sorted).filter((k) => !existingKeys.has(k));
    if (newKeys.length > 0) {
      console.log("\nNew pages:");
      for (const k of newKeys) {
        console.log(`  + ${k}: ${sorted[k].purpose.slice(0, 60)}`);
      }
    }
  }

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would write to", PAGE_SPEC_FILE);
    if (args.includes("--json")) {
      console.log(JSON.stringify(sorted, null, 2));
    }
    return;
  }

  fs.writeFileSync(PAGE_SPEC_FILE, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`Wrote ${PAGE_SPEC_FILE}`);
}

// Support require() for orchestrator integration
if (require.main === module) {
  main();
} else {
  module.exports = { parseBuildSpec, codeAreaToPageRoutes, sectionToPageContext };
}
