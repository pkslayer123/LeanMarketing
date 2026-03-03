#!/usr/bin/env node

/**
 * Pre-iteration Fix — Runs before each loop iteration (except first) to apply
 * learned fixes from previous failures. Permanent behavior, learning.
 *
 * Reads: findings, triage, unresolved-bugs, learned-fix-patterns.json
 * Applies: Felix lint, Felix safe codemods, learned patterns
 *
 * Usage:
 *   node scripts/e2e/pre-iteration-fix.js
 *   node scripts/e2e/pre-iteration-fix.js --dry-run
 *
 * Called by: loop.sh after iteration N, before iteration N+1
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const LEARNED_PATTERNS_PATH = path.join(ROOT, "e2e", "state", "learned-fix-patterns.json");
const UNRESOLVED_BUGS_PATH = path.join(ROOT, "e2e", "state", "unresolved-bugs.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${ts}] ${msg}`);
}

function loadLearnedPatterns() {
  if (!fs.existsSync(LEARNED_PATTERNS_PATH)) {
    return { patterns: [], version: 1 };
  }
  try {
    return JSON.parse(fs.readFileSync(LEARNED_PATTERNS_PATH, "utf-8"));
  } catch {
    return { patterns: [], version: 1 };
  }
}

function saveLearnedPatterns(data) {
  const dir = path.dirname(LEARNED_PATTERNS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(LEARNED_PATTERNS_PATH, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Apply a learned pattern: search-replace in file(s).
 * Pattern: { id, description, glob, search, replace, once }
 */
function applyPattern(pattern) {
  if (!pattern.glob || !pattern.search || pattern.replace === undefined) {
    return 0; // Recommendation-only patterns; no search-replace
  }
  const { globSync } = require("glob");
  const files = globSync(pattern.glob, { cwd: ROOT, absolute: true });
  let applied = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let content = fs.readFileSync(file, "utf-8");
    const before = content;
    const regex = new RegExp(pattern.search, pattern.flags ?? "g");
    content = content.replace(regex, pattern.replace);
    if (content !== before) {
      if (!DRY_RUN) {
        fs.writeFileSync(file, content);
      }
      applied++;
      log(`  Applied: ${path.relative(ROOT, file)} (${pattern.id})`);
    }
  }
  return applied;
}

function main() {
  log("Pre-iteration fix: applying learned fixes from previous failures.");

  let totalApplied = 0;

  // 1. Felix lint fixes (always safe)
  log("Running Felix --apply-lint...");
  if (!DRY_RUN) {
    try {
      execSync("node scripts/e2e/felix-fix.js --apply-lint", {
        cwd: ROOT,
        stdio: "pipe",
      });
    } catch (e) {
      log("Felix lint failed (non-fatal): " + (e.message ?? ""));
    }
  } else {
    log("  [dry-run] would run: node scripts/e2e/felix-fix.js --apply-lint");
  }

  // 2. Felix safe codemods (.single() → .maybeSingle())
  log("Running Felix --apply --force (safe codemods)...");
  if (!DRY_RUN) {
    try {
      execSync("node scripts/e2e/felix-fix.js --apply --force", {
        cwd: ROOT,
        stdio: "pipe",
      });
    } catch (e) {
      log("Felix apply failed (non-fatal): " + (e.message ?? ""));
    }
  } else {
    log("  [dry-run] would run: node scripts/e2e/felix-fix.js --apply --force");
  }

  // 3. Learned patterns from file
  const learned = loadLearnedPatterns();
  // Snapshot findings before applying so we can measure effectiveness later
  snapshotFindingsForEffectiveness(learned);
  if (learned.patterns.length > 0) {
    log(`Applying ${learned.patterns.length} learned pattern(s)...`);
    for (const p of learned.patterns) {
      if (p.disabled) {
        continue;
      }
      const n = applyPattern(p);
      totalApplied += n;

      // Track effectiveness metrics
      if (!p.effectiveness) {
        p.effectiveness = {
          timesApplied: 0,
          filesChanged: 0,
          lastApplied: null,
          findingsBeforeApply: 0,
          findingsAfterApply: 0,
          successRate: null,
        };
      }
      if (n > 0) {
        p.effectiveness.timesApplied++;
        p.effectiveness.filesChanged += n;
        p.effectiveness.lastApplied = new Date().toISOString();
      }
    }
  }

  // 4. Sync from resolved unresolved-bugs: add patterns we've learned
  if (fs.existsSync(UNRESOLVED_BUGS_PATH)) {
    try {
      const ub = JSON.parse(fs.readFileSync(UNRESOLVED_BUGS_PATH, "utf-8"));
      const resolved = (ub.bugs ?? []).filter((b) => b.status === "resolved");
      for (const b of resolved) {
        const existing = learned.patterns.find((p) => p.sourceBug === b.id);
        if (existing) continue;

        // Known pattern: change_type_id "process_change" → "CHG-PRC"
        if (
          b.summary?.includes("change_type") &&
          b.fix?.includes("CHG-PRC") &&
          !learned.patterns.some((p) => p.id === "change_type_id_process_change")
        ) {
          const newPattern = {
            id: "change_type_id_process_change",
            description: "Change type_id from invalid 'process_change' to valid 'CHG-PRC'",
            sourceBug: b.id,
            glob: "e2e/**/*.{ts,tsx}",
            search: 'change_type_id:\\s*"process_change"',
            replace: 'change_type_id: "CHG-PRC"',
            flags: "g",
          };
          learned.patterns.push(newPattern);
          const n = applyPattern(newPattern);
          totalApplied += n;
          log(`  Learned from ${b.id}: ${newPattern.description}`);
        }
      }
      if (learned.patterns.length > 0) {
        learned.lastUpdated = new Date().toISOString();
        if (!DRY_RUN) {
          saveLearnedPatterns(learned);
        }
      }
    } catch (e) {
      log("Could not sync from unresolved-bugs: " + (e.message ?? ""));
    }
  }

  // 5. Self-healing: analyze recent findings for stale selectors & permission changes
  log("Self-healing: checking recent findings for auto-fixable patterns...");
  const selfHealCount = selfHealFromFindings(learned);
  totalApplied += selfHealCount;

  if (learned.patterns.length > 0) {
    learned.lastUpdated = new Date().toISOString();
    if (!DRY_RUN) {
      saveLearnedPatterns(learned);
    }
  }

  if (totalApplied > 0 && !DRY_RUN) {
    try {
      const audit = require("./audit-log.js");
      audit.appendAuditLog("pre_iteration_fix_applied", process.env.E2E_AUDIT_ACTOR ?? "script", {
        type: "learned_patterns",
        description: "Applied learned fix patterns from previous failures",
        count: totalApplied,
        selfHealed: selfHealCount,
      });
    } catch {
      // best-effort
    }
  }

  // 6. Consume fix queue — convert approved MOC fixes to learned patterns
  const fixQueuePath = path.join(ROOT, "e2e", "state", "fix-queue.json");
  if (fs.existsSync(fixQueuePath)) {
    try {
      const fixQueue = JSON.parse(fs.readFileSync(fixQueuePath, "utf-8"));
      const pending = (fixQueue.items ?? []).filter((i) => i.status === "pending");
      if (pending.length > 0) {
        log(`Fix queue: ${pending.length} approved MOC(s) — converting to learned patterns...`);
        let converted = 0;
        for (const item of pending) {
          const tag = item.platformMocNumber ? ` [${item.platformMocNumber}]` : "";
          // Items with fixPatterns can be auto-applied
          if (Array.isArray(item.fixPatterns) && item.fixPatterns.length > 0) {
            for (const fp of item.fixPatterns) {
              if (!fp.glob || !fp.search || !fp.replace) {
                continue;
              }
              const patternId = `moc-fix-${item.id ?? Date.now()}-${converted}`;
              const exists = learned.patterns.some((p) => p.id === patternId);
              if (!exists) {
                learned.patterns.push({
                  id: patternId,
                  description: `From MOC${tag}: ${(item.title ?? "").slice(0, 60)}`,
                  glob: fp.glob,
                  search: fp.search,
                  replace: fp.replace,
                  flags: fp.flags ?? "g",
                  once: fp.once ?? false,
                  source: "fix-queue",
                  mocId: item.id ?? null,
                });
                converted++;
              }
            }
            item.status = "applied";
            item.appliedAt = new Date().toISOString();
          } else {
            // No auto-fixable patterns — log for manual implementation
            log(`  ${item.tier}${tag} ${(item.title ?? "").slice(0, 60)} (${item.findingCount} findings) — needs manual fix`);
          }
        }
        if (converted > 0) {
          log(`  Converted ${converted} MOC fix pattern(s) to learned patterns.`);
          if (!DRY_RUN) {
            saveLearnedPatterns(learned);
            fs.writeFileSync(fixQueuePath, JSON.stringify(fixQueue, null, 2) + "\n");
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // Safety gate: if patterns broke the build, revert all unstaged app/lib changes
  if (totalApplied > 0 && !DRY_RUN) {
    try {
      execSync("npx tsc --noEmit 2>&1", { cwd: ROOT, stdio: "pipe", timeout: 120000 });
    } catch {
      log("  WARNING: Type-check failed after patterns — reverting app/lib changes");
      try {
        execSync("git checkout -- app/ lib/ components/ e2e/", { cwd: ROOT, stdio: "pipe" });
      } catch { /* ignore */ }
    }
  }

  log(`Pre-iteration fix complete.${totalApplied > 0 ? ` Applied ${totalApplied} pattern(s) (${selfHealCount} self-healed).` : ""}`);
}

/**
 * Self-heal from recent findings: detect stale selectors and permission
 * expectation mismatches, generate fix patterns automatically.
 */
function selfHealFromFindings(learned) {
  const findingsPath = path.join(ROOT, "e2e", "state", "findings", "findings.json");
  if (!fs.existsSync(findingsPath)) {
    return 0;
  }

  let findings;
  try {
    findings = JSON.parse(fs.readFileSync(findingsPath, "utf-8"));
  } catch {
    return 0;
  }

  const allFindings = Array.isArray(findings) ? findings : (findings.findings ?? []);
  // Only process recent findings (last 24 hours)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = allFindings.filter((f) => {
    const ts = f.timestamp ? new Date(f.timestamp).getTime() : 0;
    return ts > cutoff;
  });

  if (recent.length === 0) {
    return 0;
  }

  let healed = 0;

  // Pattern 1: Stale selector findings — detect "element not found" patterns
  const selectorFailures = recent.filter(
    (f) =>
      f.description?.includes("Action") &&
      f.description?.includes("failed") &&
      (f.description?.includes("locator.click") ||
        f.description?.includes("Timeout") ||
        f.description?.includes("not found"))
  );

  for (const failure of selectorFailures) {
    // Extract the selector from the failure message
    const selectorMatch = failure.description?.match(/on "([^"]+)"/);
    if (!selectorMatch) { continue; }
    const staleSelector = selectorMatch[1];

    // Check if we already have a fix for this selector
    if (learned.patterns.some((p) => p.search === escapeRegex(staleSelector) && p.type === "self-heal")) {
      continue;
    }

    // Record the stale selector as a known issue (pattern with placeholder replacement)
    const patternId = `stale_selector_${Date.now().toString(36)}`;
    const newPattern = {
      id: patternId,
      type: "self-heal",
      description: `Stale selector detected: "${staleSelector}" on ${failure.page}`,
      detectedAt: new Date().toISOString(),
      page: failure.page,
      staleSelector,
      // Don't auto-apply — just record for manual review or future LLM-driven fix
      disabled: true,
      glob: "e2e/**/*.{ts,tsx}",
      search: escapeRegex(staleSelector),
      replace: staleSelector, // placeholder — LLM or manual review will set the real replacement
      flags: "g",
    };
    learned.patterns.push(newPattern);
    log(`  [Self-heal] Recorded stale selector: "${staleSelector}" on ${failure.page}`);
    healed++;
  }

  // Pattern 2: Permission expectation mismatches — detect "should be GRANTED but was denied"
  const permFailures = recent.filter(
    (f) =>
      f.description?.includes("[OrgPerms]") ||
      f.description?.includes("[Oracle/Permissions]") ||
      f.description?.includes("permission")
  );

  for (const failure of permFailures) {
    const keyMatch = failure.description?.match(/Permission "([^"]+)"/);
    const permKey = keyMatch?.[1] ?? failure.permissionKey;
    if (!permKey) { continue; }

    // Check if we already have a fix for this permission
    if (learned.patterns.some((p) => p.permissionKey === permKey && p.type === "self-heal")) {
      continue;
    }

    // Determine if it's a grant→deny or deny→grant mismatch
    const isGrantedButDenied = failure.description?.includes("should be GRANTED but was denied");
    const isDeniedButGranted = failure.description?.includes("should be DENIED") && failure.description?.includes("granted");

    if (isGrantedButDenied || isDeniedButGranted) {
      const patternId = `perm_mismatch_${permKey.replace(/\./g, "_")}`;
      if (learned.patterns.some((p) => p.id === patternId)) { continue; }

      const newPattern = {
        id: patternId,
        type: "self-heal",
        description: `Permission expectation mismatch: ${permKey} (${isGrantedButDenied ? "expected grant, got deny" : "expected deny, got grant"})`,
        detectedAt: new Date().toISOString(),
        permissionKey: permKey,
        mismatchType: isGrantedButDenied ? "grant_to_deny" : "deny_to_grant",
        // Don't auto-apply permission changes — too security-sensitive
        disabled: true,
        glob: "e2e/**/*.{ts,tsx}",
        search: `"${escapeRegex(permKey)}"`,
        replace: `"${permKey}"`, // placeholder
        flags: "g",
      };
      learned.patterns.push(newPattern);
      log(`  [Self-heal] Recorded permission mismatch: ${permKey} (${newPattern.mismatchType})`);
      healed++;
    }
  }

  // Pattern 3: API route changes — detect 404s on known routes
  const apiFailures = recent.filter(
    (f) =>
      f.page?.startsWith("/api/") &&
      (f.description?.includes("404") || f.description?.includes("405"))
  );

  for (const failure of apiFailures) {
    const route = failure.page;
    if (!route) { continue; }

    if (learned.patterns.some((p) => p.staleRoute === route && p.type === "self-heal")) {
      continue;
    }

    const patternId = `stale_route_${Date.now().toString(36)}`;
    const newPattern = {
      id: patternId,
      type: "self-heal",
      description: `API route returning 404/405: ${route}`,
      detectedAt: new Date().toISOString(),
      staleRoute: route,
      disabled: true,
      glob: "e2e/**/*.{ts,tsx}",
      search: escapeRegex(route),
      replace: route, // placeholder
      flags: "g",
    };
    learned.patterns.push(newPattern);
    log(`  [Self-heal] Recorded stale API route: ${route}`);
    healed++;
  }

  // Pattern 4: API 500 regressions — detect server errors on API routes
  const api500Failures = recent.filter(
    (f) =>
      (f.page?.startsWith("/api/") || f.description?.includes("/api/")) &&
      (f.description?.includes("500") || f.description?.includes("E2E_SERVER_ERROR") ||
       f.description?.includes("Internal Server Error"))
  );

  // Deduplicate by route
  const seen500Routes = new Set();
  for (const failure of api500Failures) {
    // Extract the API route from page or description
    const route = failure.page?.startsWith("/api/") ? failure.page : null;
    const routeMatch = failure.description?.match(/(\/api\/[^\s"]+)/);
    const apiRoute = route ?? routeMatch?.[1];
    if (!apiRoute) { continue; }

    // Deduplicate within this run
    if (seen500Routes.has(apiRoute)) { continue; }
    seen500Routes.add(apiRoute);

    // Check if we already have a pattern for this route
    if (learned.patterns.some((p) => p.apiRoute === apiRoute && p.type === "self-heal" && p.failureType === "500")) {
      continue;
    }

    const patternId = `api_500_${apiRoute.replace(/[^a-zA-Z0-9]/g, "_")}`;
    if (learned.patterns.some((p) => p.id === patternId)) { continue; }

    const newPattern = {
      id: patternId,
      type: "self-heal",
      failureType: "500",
      description: `API route returning 500: ${apiRoute} (${failure.persona ?? "unknown"})`,
      detectedAt: new Date().toISOString(),
      apiRoute,
      persona: failure.persona,
      // Don't auto-apply — 500s need investigation, not regex fixes
      disabled: true,
      glob: "app/api/**/*.{ts,tsx}",
      search: "",
      replace: "",
      flags: "g",
    };
    learned.patterns.push(newPattern);
    log(`  [Self-heal] Recorded API 500 regression: ${apiRoute}`);
    healed++;
  }

  // Pattern 5: Summarize finding categories for dashboard visibility
  const categoryCounts = {};
  for (const f of recent) {
    const cat = f.severity ?? "unknown";
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }
  if (Object.keys(categoryCounts).length > 0) {
    const summary = Object.entries(categoryCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    log(`  Finding categories (last 24h): ${summary}`);
  }

  if (healed === 0) {
    log("  No self-healable patterns found in recent findings.");
  }

  return healed;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Snapshot current finding count per sourceBug so we can measure
 * effectiveness after the next iteration run.
 */
function snapshotFindingsForEffectiveness(learned) {
  const findingsPath = path.join(ROOT, "e2e", "state", "findings", "findings.json");
  if (!fs.existsSync(findingsPath)) {
    return;
  }

  let findings;
  try {
    findings = JSON.parse(fs.readFileSync(findingsPath, "utf-8"));
  } catch {
    return;
  }

  const allFindings = Array.isArray(findings) ? findings : (findings.findings ?? []);
  const openFindings = allFindings.filter((f) => f.status !== "resolved");

  // Count open findings per sourceBug pattern
  for (const p of learned.patterns) {
    if (!p.effectiveness) {
      continue;
    }
    // Count findings that match this pattern's sourceBug or related pages
    let relatedCount = 0;
    for (const f of openFindings) {
      if (p.sourceBug && f.sourceBug === p.sourceBug) {
        relatedCount++;
      } else if (p.apiRoute && f.page === p.apiRoute) {
        relatedCount++;
      } else if (p.permissionKey && f.description?.includes(p.permissionKey)) {
        relatedCount++;
      }
    }
    p.effectiveness.findingsBeforeApply = relatedCount;
  }
}

/**
 * Update effectiveness metrics by comparing current findings vs snapshot.
 * Called with --update-effectiveness after a test iteration completes.
 */
function updateEffectiveness() {
  const learned = loadLearnedPatterns();
  const findingsPath = path.join(ROOT, "e2e", "state", "findings", "findings.json");
  if (!fs.existsSync(findingsPath)) {
    return;
  }

  let findings;
  try {
    findings = JSON.parse(fs.readFileSync(findingsPath, "utf-8"));
  } catch {
    return;
  }

  const allFindings = Array.isArray(findings) ? findings : (findings.findings ?? []);
  const openFindings = allFindings.filter((f) => f.status !== "resolved");

  let updated = 0;
  for (const p of learned.patterns) {
    if (!p.effectiveness || p.effectiveness.timesApplied === 0) {
      continue;
    }

    let relatedCount = 0;
    for (const f of openFindings) {
      if (p.sourceBug && f.sourceBug === p.sourceBug) {
        relatedCount++;
      } else if (p.apiRoute && f.page === p.apiRoute) {
        relatedCount++;
      } else if (p.permissionKey && f.description?.includes(p.permissionKey)) {
        relatedCount++;
      }
    }

    p.effectiveness.findingsAfterApply = relatedCount;

    // Calculate success rate: how much did findings decrease?
    const before = p.effectiveness.findingsBeforeApply ?? 0;
    if (before > 0) {
      p.effectiveness.successRate = Math.round(
        ((before - relatedCount) / before) * 100
      );
      updated++;
    }
  }

  // Auto-disable patterns with persistent zero effectiveness
  for (const p of learned.patterns) {
    if (
      p.effectiveness &&
      p.effectiveness.timesApplied >= 3 &&
      p.effectiveness.successRate !== null &&
      p.effectiveness.successRate <= 0
    ) {
      if (!p.disabled) {
        log(`  [Effectiveness] Disabling ineffective pattern: ${p.id} (success rate: ${p.effectiveness.successRate}%)`);
        p.disabled = true;
        p.disabledReason = "auto-disabled: zero effectiveness after 3+ applications";
      }
    }
  }

  if (updated > 0) {
    learned.lastUpdated = new Date().toISOString();
    saveLearnedPatterns(learned);
    log(`Updated effectiveness for ${updated} pattern(s).`);
  }
}

// Handle --update-effectiveness flag
if (args.includes("--update-effectiveness")) {
  updateEffectiveness();
} else {
  main();
}
