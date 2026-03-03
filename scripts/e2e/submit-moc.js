#!/usr/bin/env node

/**
 * submit-moc.js -- Create real MOCs in the ChangePilot org via Supabase.
 *
 * Creates actual database entries visible in the platform. Uses the
 * Supabase service role for direct DB access (bypasses auth/RLS).
 *
 * Two tiers:
 * - CRITICAL (security, migration, spec_conflict): Created at Stage 0
 *   as drafts. Flagged "MANAGEMENT REVIEW REQUIRED" in description.
 *   Darren/Steve can see and advance them.
 * - STANDARD (everything else): Created at Stage 0 as drafts with
 *   auto-approval note. The cp-meta persona tests handle full lifecycle.
 *
 * Usage:
 *   node scripts/e2e/submit-moc.js --submit <json>        # Submit a new MOC
 *   node scripts/e2e/submit-moc.js --check-approved        # Get approved MOCs
 *   node scripts/e2e/submit-moc.js --list                  # List all MOCs
 *   node scripts/e2e/submit-moc.js --complete <moc-id>     # Mark as implemented
 *   node scripts/e2e/submit-moc.js --analyst-prompt        # Generate prompt section
 */

try {
  require("dotenv").config({ path: ".env.local", quiet: true });
} catch {
  // dotenv not installed
}

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_FILE = path.join(ROOT, "e2e", "state", "changepilot-org.json");
const MOC_QUEUE_FILE = path.join(ROOT, "e2e", "state", "moc-queue.json");

const args = process.argv.slice(2);

// ---------------------------------------------------------------------------
// Supabase service client (direct DB access, bypasses auth/RLS)
// ---------------------------------------------------------------------------

let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return null; // Fall back to local-only mode
  }

  try {
    const { createClient } = require("@supabase/supabase-js");
    _supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return _supabase;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local MOC Queue (metadata tracker — maps findings to real platform MOC IDs)
// ---------------------------------------------------------------------------

function loadQueue() {
  if (!fs.existsSync(MOC_QUEUE_FILE)) {
    return { version: 2, mocs: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(MOC_QUEUE_FILE, "utf-8"));
  } catch {
    return { version: 2, mocs: [] };
  }
}

function saveQueue(queue) {
  const dir = path.dirname(MOC_QUEUE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(MOC_QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n");
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Change type mapping (persona finding types -> MOC change types)
// ---------------------------------------------------------------------------

const CHANGE_TYPE_MAP = {
  bug_fix: { label: "Bug Fix", risk_level: "medium", review_depth: "Standard" },
  feature: { label: "Feature Release", risk_level: "medium", review_depth: "Standard" },
  infrastructure: { label: "Infrastructure Change", risk_level: "high", review_depth: "Deep" },
  security: { label: "Security Patch", risk_level: "critical", review_depth: "Deep" },
  ui_ux: { label: "UI/UX Redesign", risk_level: "low", review_depth: "Light" },
  migration: { label: "Database Migration", risk_level: "critical", review_depth: "Deep" },
  dependency: { label: "Dependency Update", risk_level: "medium", review_depth: "Standard" },
  api_change: { label: "API Change", risk_level: "high", review_depth: "Deep" },
};

// Department routing based on change type
// Product included only for user-facing changes needing product owner sign-off.
// Technical changes (infra, migration, dependency, security, bug, API) route to
// technical departments only — reduces product owner queue overload.
const ROUTING_MAP = {
  bug_fix: ["Engineering", "QA & Testing"],
  feature: ["Engineering", "Product", "Design"],
  infrastructure: ["DevOps", "Engineering"],
  security: ["Security", "Engineering"],
  ui_ux: ["Design", "Product", "Engineering"],
  migration: ["DevOps", "Engineering", "Security"],
  dependency: ["DevOps", "Security"],
  api_change: ["Engineering", "Security", "QA & Testing"],
};

// ---------------------------------------------------------------------------
// Generate MOC number (matches the platform format)
// ---------------------------------------------------------------------------

function generateMocNumber() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `MOC-CP-${ts}-${rand}`;
}

/**
 * Generate the next sequential MOC number by querying the database.
 * The DB trigger is broken (LPAD overflow at 9999+), so we compute
 * the number client-side and supply it explicitly on insert.
 */
let _mocNumberOffset = 0; // Tracks how many numbers we've generated this process
async function generatePlatformMocNumber(supabase) {
  const year = new Date().getFullYear();
  const prefix = `MOC-${year}-`;

  const { data } = await supabase
    .from("mocs")
    .select("moc_number")
    .like("moc_number", `${prefix}%`)
    .order("moc_number", { ascending: false })
    .limit(1);

  const maxStr = data?.[0]?.moc_number ?? `${prefix}0`;
  const currentMax = parseInt(maxStr.replace(prefix, ""), 10) || 0;
  _mocNumberOffset++;
  const next = currentMax + _mocNumberOffset;
  return `${prefix}${String(next).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Create real platform MOC via Supabase service role
// ---------------------------------------------------------------------------

async function createPlatformMoc(config, input, changeInfo, isCritical) {
  const supabase = getSupabase();
  if (!supabase) {
    return null; // No Supabase credentials — will fall back to local-only
  }

  const orgId = config.orgId;
  const engDeptId = config.departments?.Engineering;

  // Find a REAL HUMAN user in the ChangePilot org to be the initiator.
  // Must exclude: (1) test accounts (is_test_account), (2) E2E pool accounts (email pattern).
  // The /mocs page filters out MOCs initiated by is_test_account users, making MOCs invisible.
  // Uses role column (not deprecated is_developer flag) per CLAUDE.md mandate.
  let initiatorId = null;
  const { data: devProfile } = await supabase
    .from("user_profiles")
    .select("id, email")
    .eq("organization_id", orgId)
    .eq("role", "developer")
    .not("is_test_account", "is", true)
    .not("email", "like", "e2e-%")
    .not("email", "like", "cp-dev-e2e%")
    .limit(1)
    .maybeSingle();

  if (devProfile) {
    initiatorId = devProfile.id;
  } else {
    // Fall back: find any real human admin+ user in the ChangePilot org
    const { data: adminProfile } = await supabase
      .from("user_profiles")
      .select("id, email")
      .eq("organization_id", orgId)
      .in("role", ["admin", "super_admin", "developer"])
      .not("is_test_account", "is", true)
      .not("email", "like", "e2e-%")
      .not("email", "like", "cp-dev-e2e%")
      .limit(1)
      .maybeSingle();
    if (adminProfile) {
      initiatorId = adminProfile.id;
    } else {
      // Last resort: any non-test, non-pool user in the org
      const { data: anyProfile } = await supabase
        .from("user_profiles")
        .select("id, email")
        .eq("organization_id", orgId)
        .not("is_test_account", "is", true)
        .not("email", "like", "e2e-%")
        .limit(1)
        .maybeSingle();
      if (anyProfile) {
        initiatorId = anyProfile.id;
      }
    }
  }

  if (!initiatorId) {
    // Do NOT fall back to pool developers — they are in Test Co org, not ChangePilot.
    // Using a wrong-org initiator causes MOCs to appear in the wrong organization.
    console.error("[submit-moc] No developer or user found in ChangePilot org. Cannot create platform MOC.");
    console.error("[submit-moc] Ensure Steve or another developer exists in CP org (id: " + orgId + ")");
    return null;
  }

  // Generate the next MOC number from DB (trigger is broken at 9999+)
  let platformMocNumber;
  try {
    platformMocNumber = await generatePlatformMocNumber(supabase);
  } catch (e) {
    console.error(`[submit-moc] Failed to generate MOC number: ${e.message}`);
    return null;
  }

  const mocNumber = generateMocNumber();
  const managementTag = isCritical
    ? "\n\n--- MANAGEMENT REVIEW REQUIRED ---\nThis change was flagged as critical by the persona testing system. " +
      "Review required from: " + (config.managementApprovers ?? []).map((a) => a.name).join(", ")
    : "";

  const sourceTag = input.persona
    ? `\n\nIdentified by persona: ${input.persona}`
    : "\n\nIdentified by automated testing system";

  // Map our change types to valid DB change_type values
  // Valid: process, equipment, organizational, technology, regulatory, other
  const dbChangeType = {
    bug_fix: "technology",
    feature: "technology",
    infrastructure: "technology",
    security: "technology",
    ui_ux: "process",
    migration: "technology",
    dependency: "technology",
    api_change: "technology",
  }[input.changeType] ?? "process";

  const { data: moc, error } = await supabase
    .from("mocs")
    .insert({
      title: input.title?.slice(0, 200) ?? "Untitled MOC",
      description: (input.description ?? "") + managementTag + sourceTag,
      organization_id: orgId,
      initiated_by: initiatorId,
      stage: 0,
      status: "draft",
      change_type: dbChangeType,
      reason_for_change: input.description?.slice(0, 500) ?? "Identified by persona testing",
      risk_level: changeInfo.risk_level ?? "medium",
      moc_number: platformMocNumber, // Explicit — bypass broken DB trigger
    })
    .select("id, moc_number, title, stage, status")
    .single();

  if (error) {
    // Retry once on duplicate key — race condition with concurrent inserts
    if (error.code === "23505" && error.message?.includes("moc_number")) {
      console.warn(`[submit-moc] moc_number collision (${platformMocNumber}), retrying...`);
      try {
        const retryNumber = await generatePlatformMocNumber(supabase);
        const { data: retryMoc, error: retryErr } = await supabase
          .from("mocs")
          .insert({
            title: input.title?.slice(0, 200) ?? "Untitled MOC",
            description: (input.description ?? "") + managementTag + sourceTag,
            organization_id: orgId,
            initiated_by: initiatorId,
            stage: 0,
            status: "draft",
            change_type: dbChangeType,
            reason_for_change: input.description?.slice(0, 500) ?? "Identified by persona testing",
            risk_level: changeInfo.risk_level ?? "medium",
            moc_number: retryNumber,
          })
          .select("id, moc_number, title, stage, status")
          .single();
        if (retryErr) {
          console.error(`[submit-moc] DB retry failed: ${retryErr.message}`);
          return null;
        }
        return retryMoc;
      } catch (retryE) {
        console.error(`[submit-moc] DB retry error: ${retryE.message}`);
        return null;
      }
    }
    console.error(`[submit-moc] DB error creating MOC: ${error.message}`);
    return null;
  }

  return moc;
}

// ---------------------------------------------------------------------------
// Submit MOC (creates in platform + tracks locally)
// ---------------------------------------------------------------------------

async function submitMoc(inputJson) {
  let input;
  try {
    input = typeof inputJson === "string" ? JSON.parse(inputJson) : inputJson;
  } catch (e) {
    console.error("[submit-moc] Invalid JSON:", e.message);
    if (require.main === module) process.exit(1);
    return null;
  }

  const config = loadConfig();
  if (!config) {
    console.error("[submit-moc] ChangePilot org not set up. Run: node scripts/e2e/setup-changepilot-org.js");
    if (require.main === module) process.exit(1);
    return null;
  }

  const queue = loadQueue();
  const changeInfo = CHANGE_TYPE_MAP[input.changeType] ?? CHANGE_TYPE_MAP.bug_fix;
  const routeDepts = ROUTING_MAP[input.changeType] ?? ["Engineering"];
  const isCritical = input.category === "critical";

  // Create real platform MOC
  const platformMoc = await createPlatformMoc(config, input, changeInfo, isCritical);
  const platformMocId = platformMoc?.id ?? null;
  const platformMocNumber = platformMoc?.moc_number ?? null;

  const tier = input.tier ?? (isCritical ? "needs_approval" : "auto_approve");

  // Extract pageGroup for dedup tracking
  function extractPageGroupFromDesc(desc) {
    const match = (desc ?? "").match(/\*\*Page area:\*\*\s*(.+)/);
    if (match) {
      return match[1].trim().split("/").slice(0, 3).join("/");
    }
    return input.pageGroup ?? "unknown";
  }

  const pageGroup = extractPageGroupFromDesc(input.description);

  // Build local tracking entry
  const localId = `moc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const mocEntry = {
    id: localId,
    platformMocId,        // Real MOC ID in Supabase (null if creation failed)
    platformMocNumber,    // Real MOC number visible in platform
    title: input.title,
    description: input.description,
    pageGroup,            // Stored explicitly for dedup
    tier,                 // auto_fix | auto_approve | needs_approval
    category: isCritical ? "critical" : "standard",
    status: "approved", // All MOCs start approved — tier field drives stage-4 gate in cp-meta
    source: input.source ?? "persona",
    persona: input.persona ?? null,
    changeType: input.changeType ?? "bug_fix",
    changeTypeLabel: changeInfo.label,
    riskLevel: changeInfo.risk_level,
    reviewDepth: changeInfo.review_depth,
    routedDepartments: routeDepts,
    requiresManagement: isCritical,
    findings: input.findings ?? [],
    findingIds: input.findingIds ?? input.findings ?? [],
    affectedFiles: input.affectedFiles ?? [],
    sourceFiles: input.sourceFiles ?? [],
    pageArea: input.pageArea ?? pageGroup ?? null,
    affectedPages: input.affectedPages ?? [],
    submittedAt: new Date().toISOString(),
    iteration: input.iteration ?? null,
    approvedAt: new Date().toISOString(), // All MOCs start approved
    implementedAt: null,
    implementationNotes: null,
    managementApprovers: isCritical ? (config.managementApprovers ?? []) : [],
  };

  // Last-resort dedup gate
  const DEDUP_STOP_WORDS = new Set(["the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or", "not", "no", "with",
    "auto", "fix", "vision", "bug", "page", "area", "moc", "spec", "implementation", "should", "does", "can", "has", "are",
    "this", "that", "from", "was", "were", "been", "have", "will", "but", "all", "its", "our", "when"]);

  function normalizeTitle(text) {
    return (text ?? "")
      .replace(/^\[.*?\]\s*/g, "")
      .replace(/\*\*[^*]+\*\*\s*/g, "")
      .replace(/[^a-zA-Z\s]/g, " ")       // Strip numbers — "2 findings" and "3 findings" should match
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !DEDUP_STOP_WORDS.has(w))
      .slice(0, 8)
      .sort()
      .join("_");
  }

  const newSig = `${mocEntry.changeType}::${pageGroup}::${normalizeTitle(mocEntry.title)}`;
  const existingMatch = queue.mocs.find((m) => {
    if (m.status === "pending_approval" || m.status === "awaiting_approval") { return false; }
    if (m.status === "archived") { return false; }
    const mPg = m.pageGroup ?? extractPageGroupFromDesc(m.description);
    const mSig = `${m.changeType}::${mPg}::${normalizeTitle(m.title)}`;
    return mSig === newSig;
  });

  if (existingMatch) {
    console.log(`[submit-moc] DEDUP: Skipping "${mocEntry.title}" — matches existing MOC ${existingMatch.id} (${existingMatch.status})`);
    return existingMatch;
  }

  queue.mocs.push(mocEntry);
  saveQueue(queue);

  const platformMsg = platformMocId
    ? `Created in platform: ${platformMocNumber} (${platformMocId})`
    : "Local tracking only (no Supabase credentials)";

  const statusMsg = isCritical
    ? `CRITICAL -- management gate at stage 4 (${mocEntry.managementApprovers.map((a) => a.name).join(", ")})`
    : `STANDARD -- ready for implementation`;

  console.log(`[submit-moc] ${platformMsg}`);
  console.log(`  Title: ${mocEntry.title}`);
  console.log(`  Type: ${mocEntry.changeTypeLabel} (${mocEntry.riskLevel})`);
  console.log(`  Routed to: ${routeDepts.join(", ")}`);
  console.log(`  Status: ${statusMsg}`);

  return mocEntry;
}

// ---------------------------------------------------------------------------
// Check approved MOCs
// ---------------------------------------------------------------------------

function checkApproved() {
  const queue = loadQueue();
  const approved = queue.mocs.filter((m) => m.status === "approved" && !m.implementedAt);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ count: approved.length, mocs: approved }, null, 2));
  } else {
    console.log(`[submit-moc] ${approved.length} approved MOCs ready for implementation:`);
    for (const moc of approved) {
      const platformTag = moc.platformMocNumber ? ` [${moc.platformMocNumber}]` : "";
      console.log(`  [${moc.id}]${platformTag} ${moc.title} (${moc.changeTypeLabel})`);
      if (moc.affectedFiles.length > 0) {
        console.log(`    Files: ${moc.affectedFiles.join(", ")}`);
      }
    }
  }

  return approved;
}

// ---------------------------------------------------------------------------
// List all pending
// ---------------------------------------------------------------------------

function listAll() {
  const queue = loadQueue();
  const stats = {
    pending_approval: 0,
    approved: 0,
    rejected: 0,
    implemented: 0,
    in_platform: 0,
  };

  for (const moc of queue.mocs) {
    stats[moc.status] = (stats[moc.status] ?? 0) + 1;
    if (moc.platformMocId) stats.in_platform++;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ stats, mocs: queue.mocs.slice(-50) }, null, 2));
  } else {
    console.log(`[submit-moc] MOC Queue Summary:`);
    console.log(`  Pending review: ${stats.pending_approval}`);
    console.log(`  Approved: ${stats.approved}`);
    console.log(`  Rejected: ${stats.rejected}`);
    console.log(`  Implemented: ${stats.implemented}`);
    console.log(`  In platform: ${stats.in_platform}`);
    console.log();

    const pending = queue.mocs.filter((m) => m.status === "pending_approval");
    if (pending.length > 0) {
      console.log("  Awaiting management approval:");
      for (const moc of pending) {
        const approvers = moc.managementApprovers.map((a) => a.name).join(", ");
        const platformTag = moc.platformMocNumber ? ` [${moc.platformMocNumber}]` : "";
        console.log(`    [${moc.id}]${platformTag} ${moc.title} -- needs: ${approvers}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Commit tracking — search git history for evidence of code changes
// ---------------------------------------------------------------------------

/**
 * Search recent git history for commits related to this MOC.
 *
 * Two search strategies (both run, results merged):
 *   1. MOC number in commit message (e.g. "MOC-2026-4567" in the subject/body)
 *   2. File path match — extracts page path from description and checks git log
 *
 * @param {string} description - MOC description text
 * @param {object} [opts] - Optional search hints
 * @param {string} [opts.mocNumber] - MOC number (e.g. "MOC-2026-4567") for message search
 * @returns {string[]} Array of commit SHAs (newest first)
 */
function findMatchingCommits(description, opts = {}) {
  try {
    const allShas = [];

    // Strategy 1: Search commit messages for the MOC number
    const mocNumber = opts.mocNumber;
    if (mocNumber) {
      try {
        const output = execSync(
          `git log --oneline --since="14 days ago" --grep="${mocNumber}"`,
          { encoding: "utf-8", timeout: 5000, cwd: ROOT }
        ).trim();
        if (output) {
          for (const line of output.split("\n")) {
            const sha = line.split(" ")[0];
            if (sha && !allShas.includes(sha)) {
              allShas.push(sha);
            }
          }
        }
      } catch {
        // grep search failed — continue with file path strategy
      }
    }

    // Strategy 2: Search by file path from description
    const desc = description || "";
    const pageMatch = desc.match(/\*\*Page area:\*\*\s*([^\n*]+)/i);
    const pagePath = pageMatch?.[1]?.trim();

    if (pagePath) {
      const patterns = [];
      const cleanPath = pagePath.replace(/^\/+/, ""); // strip leading slash

      if (cleanPath.startsWith("api/")) {
        patterns.push(`app/${cleanPath}/`);
        patterns.push("lib/");
      } else if (
        ["pricing", "about", "contact", "terms", "privacy"].some((p) =>
          cleanPath.startsWith(p)
        )
      ) {
        patterns.push(`app/(marketing)/${cleanPath}/`);
        patterns.push(`**/${cleanPath}*`);
      } else {
        patterns.push(`app/${cleanPath}/`);
      }

      for (const pattern of patterns) {
        try {
          const output = execSync(
            `git log --oneline --since="14 days ago" -- "${pattern}"`,
            { encoding: "utf-8", timeout: 5000, cwd: ROOT }
          ).trim();
          if (output) {
            for (const line of output.split("\n")) {
              const sha = line.split(" ")[0];
              if (sha && !allShas.includes(sha)) {
                allShas.push(sha);
              }
            }
          }
        } catch {
          // git command failed for this pattern — continue with others
        }
      }
    }

    return allShas;
  } catch {
    // git not available or other error — return empty
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mark as implemented (updates both local queue and platform MOC)
// ---------------------------------------------------------------------------

async function completeMoc(mocId, opts = {}) {
  const queue = loadQueue();
  const moc = queue.mocs.find((m) => m.id === mocId || m.platformMocId === mocId);

  if (!moc) {
    console.error(`[submit-moc] MOC not found: ${mocId}`);
    if (require.main === module) { process.exit(1); }
    return null;
  }

  // Search git history for matching commits before marking as implemented
  const commits = findMatchingCommits(moc.description);
  if (commits.length > 0) {
    moc.status = "implemented";
    moc.commit_sha = commits[0];
    moc.commit_refs = commits;
    moc.verified = true;
    console.log(`[submit-moc] Commit evidence: ${commits.length} matching commit(s), latest: ${commits[0]}`);
  } else {
    moc.status = "auto_closed_unverified";
    moc.verified = false;
    moc.autoClosedReason = "No matching commits found -- workflow complete but fix not verified";
    console.log("[submit-moc] No commit evidence found -- marking as auto_closed_unverified");
  }

  moc.implementedAt = new Date().toISOString();
  const cliNotes = args.includes("--notes") ? args[args.indexOf("--notes") + 1] : null;
  moc.implementationNotes = opts.notes || cliNotes || "Implemented by loop iteration";

  // Update platform MOC status if we have the real ID
  if (moc.platformMocId) {
    const supabase = getSupabase();
    if (supabase) {
      await supabase
        .from("mocs")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", moc.platformMocId);
    }
  }

  saveQueue(queue);
  const platformTag = moc.platformMocNumber ? ` [${moc.platformMocNumber}]` : "";
  const verifiedTag = moc.verified ? " [verified]" : " [unverified]";
  console.log(`[submit-moc] Marked as ${moc.status}: ${mocId}${platformTag}${verifiedTag}`);
  return moc;
}

// ---------------------------------------------------------------------------
// Approve/reject critical MOC
// ---------------------------------------------------------------------------

function approveMoc(mocId) {
  const queue = loadQueue();
  const moc = queue.mocs.find((m) => m.id === mocId || m.platformMocId === mocId);

  if (!moc) {
    console.error(`[submit-moc] MOC not found: ${mocId}`);
    if (require.main === module) process.exit(1);
    return;
  }

  const approverName = args[args.indexOf("--approver") + 1] || "Management";
  moc.status = "approved";
  moc.approvedAt = new Date().toISOString();

  saveQueue(queue);
  console.log(`[submit-moc] APPROVED by ${approverName}: ${moc.title}`);
}

function rejectMoc(mocId) {
  const queue = loadQueue();
  const moc = queue.mocs.find((m) => m.id === mocId || m.platformMocId === mocId);

  if (!moc) {
    console.error(`[submit-moc] MOC not found: ${mocId}`);
    if (require.main === module) process.exit(1);
    return;
  }

  const reason = args[args.indexOf("--reason") + 1] || "Rejected by management";
  moc.status = "rejected";
  moc.rejectedAt = new Date().toISOString();
  moc.implementationNotes = reason;

  saveQueue(queue);
  console.log(`[submit-moc] REJECTED: ${moc.title} -- ${reason}`);
}

// ---------------------------------------------------------------------------
// Generate analyst prompt section for approved MOCs
// ---------------------------------------------------------------------------

function generateAnalystPrompt() {
  const approved = checkApproved();

  if (approved.length === 0) {
    return "";
  }

  const lines = [
    "APPROVED MOCs TO IMPLEMENT (reviewed and approved through ChangePilot MOC process):",
    "",
  ];

  for (const moc of approved) {
    const platformTag = moc.platformMocNumber ? ` [${moc.platformMocNumber}]` : "";
    lines.push(`- [${moc.id}]${platformTag} ${moc.title} (${moc.changeTypeLabel}, ${moc.riskLevel})`);
    lines.push(`  ${(moc.description ?? "").slice(0, 200)}`);
    if (moc.affectedFiles.length > 0) {
      lines.push(`  Files: ${moc.affectedFiles.join(", ")}`);
    }
    lines.push(`  After implementing, run: node scripts/e2e/submit-moc.js --complete ${moc.id}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main (only when run directly, not when required by other scripts)
// ---------------------------------------------------------------------------

const isDirectRun = require.main === module;

async function main() {
  if (args.includes("--submit")) {
    const jsonIdx = args.indexOf("--submit");
    const jsonStr = args[jsonIdx + 1];
    if (!jsonStr) {
      console.error("Usage: --submit <json>");
      process.exit(1);
    }
    await submitMoc(jsonStr);
  } else if (args.includes("--check-approved")) {
    checkApproved();
  } else if (args.includes("--list")) {
    listAll();
  } else if (args.includes("--complete")) {
    const id = args[args.indexOf("--complete") + 1];
    await completeMoc(id);
  } else if (args.includes("--approve")) {
    const id = args[args.indexOf("--approve") + 1];
    approveMoc(id);
  } else if (args.includes("--reject")) {
    const id = args[args.indexOf("--reject") + 1];
    rejectMoc(id);
  } else if (args.includes("--analyst-prompt")) {
    const prompt = generateAnalystPrompt();
    if (prompt) {
      console.log(prompt);
    }
  } else {
    console.log("submit-moc.js -- Create real MOCs in ChangePilot org");
    console.log("");
    console.log("Commands:");
    console.log("  --submit <json>           Submit a new MOC (creates in platform DB)");
    console.log("  --check-approved          List approved MOCs ready to implement");
    console.log("  --list                    List all MOCs with stats");
    console.log("  --complete <id>           Mark MOC as implemented");
    console.log("  --approve <id>            Management approve a critical MOC");
    console.log("  --reject <id>             Management reject a critical MOC");
    console.log("  --analyst-prompt          Generate analyst prompt for approved MOCs");
    console.log("");
    console.log("Add --json for machine-readable output");
  }
}

if (isDirectRun) {
  main().catch((err) => {
    console.error("[submit-moc] Fatal:", err.message);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Sync MOC status to platform database (for needs_human escalation, etc.)
// ---------------------------------------------------------------------------

/**
 * Update a platform MOC's status in the database.
 * Used when moc-auto-fix.js escalates to needs_human — the MOC should
 * appear in "Awaiting Your Decision" on the /mocs page.
 *
 * @param {string} platformMocId - The real Supabase MOC ID
 * @param {object} updates - Fields to update (status, stage, etc.)
 * @returns {boolean} true if updated, false if failed
 */
async function syncMocStatus(platformMocId, updates) {
  if (!platformMocId) {
    return false;
  }
  const supabase = getSupabase();
  if (!supabase) {
    return false;
  }
  const { error } = await supabase
    .from("mocs")
    .update(updates)
    .eq("id", platformMocId);
  if (error) {
    console.error(`[submit-moc] syncMocStatus failed for ${platformMocId}: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Ensure a local queue MOC has a platform MOC in the database.
 * Creates one if platformMocId is missing. Returns the platformMocId.
 */
async function ensurePlatformMoc(queueMoc) {
  if (queueMoc.platformMocId) {
    return queueMoc.platformMocId;
  }
  const config = loadConfig();
  if (!config) {
    return null;
  }
  const changeInfo = CHANGE_TYPE_MAP[queueMoc.changeType] ?? CHANGE_TYPE_MAP.bug_fix;
  const isCritical = queueMoc.tier === "needs_approval";
  const platformMoc = await createPlatformMoc(config, {
    title: queueMoc.title,
    description: queueMoc.description,
    changeType: queueMoc.changeType ?? "bug_fix",
    persona: queueMoc.persona,
    tier: queueMoc.tier,
  }, changeInfo, isCritical);
  if (platformMoc) {
    queueMoc.platformMocId = platformMoc.id;
    queueMoc.platformMocNumber = platformMoc.moc_number;
    return platformMoc.id;
  }
  return null;
}

/**
 * Send a notification to the developer when a MOC needs human attention.
 */
async function notifyNeedsHuman(platformMocId, mocTitle, reason) {
  const supabase = getSupabase();
  if (!supabase || !platformMocId) {
    return;
  }
  // Steve's user ID and org
  const STEVE_USER_ID = "d66e81bb-f290-49f7-9953-58c2cc3f0325";
  const CP_ORG_ID = "aafe9a8b-eb63-46ca-85b9-1a3d3f3a3d1c";
  try {
    await supabase.from("user_notifications").insert({
      user_id: STEVE_USER_ID,
      type: "pipeline",
      notification_type: "moc_status_change",
      title: "MOC needs your attention",
      message: `${(mocTitle ?? "").slice(0, 100)}. ${reason ?? ""}`,
      action_url: `/mocs/${platformMocId}`,
      action_label: "Review MOC",
      related_moc_id: platformMocId,
      organization_id: CP_ORG_ID,
      priority: "high",
      metadata: { source: "daemon-pipeline", reason: reason ?? "needs_human" },
    });
  } catch (e) {
    console.error(`[submit-moc] notifyNeedsHuman failed: ${e.message}`);
  }
}

// Export for use by other scripts
if (typeof module !== "undefined") {
  module.exports = { submitMoc, checkApproved, completeMoc, findMatchingCommits, generateAnalystPrompt, loadQueue, saveQueue, CHANGE_TYPE_MAP, ROUTING_MAP, syncMocStatus, ensurePlatformMoc, notifyNeedsHuman };
}
