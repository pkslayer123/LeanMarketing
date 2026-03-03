#!/usr/bin/env node
// Queue DB abstraction — dual Supabase/JSON storage for MOC pipeline tracking
// Tries Supabase first, falls back to local JSON file

const fs = require("fs");
const path = require("path");

const TABLE = "moc_pipeline_tracking";
const QUEUE_PATH = path.join(process.cwd(), "e2e", "state", "moc-queue.json");

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { return null; }
  try {
    const { createClient } = require("@supabase/supabase-js");
    return createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } catch { return null; }
}

function isSupabaseAvailable() {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ---- Field mapping ----

function toDbRow(entry) {
  return {
    pipeline_id: entry.id,
    moc_id: entry.platformMocId || null,
    moc_number: entry.platformMocNumber || null,
    title: entry.title,
    description: entry.description || null,
    tier: entry.tier || "auto_fix",
    category: entry.category || null,
    pipeline_status: entry.status || "pending_approval",
    source: entry.source || null,
    persona: entry.persona || null,
    change_type: entry.changeType || null,
    change_type_label: entry.changeTypeLabel || null,
    risk_level: entry.riskLevel || null,
    review_depth: entry.reviewDepth || null,
    routed_departments: entry.routedDepartments || [],
    requires_management: entry.requiresManagement || false,
    metadata: {
      findings: entry.findings || [],
      affectedFiles: entry.affectedFiles || [],
    },
    submitted_at: entry.submittedAt || null,
    approved_at: entry.approvedAt || null,
    implemented_at: entry.implementedAt || null,
    implementation_notes: entry.implementationNotes || null,
    management_approvers: entry.managementApprovers || [],
    triage_note: entry.triageNote || null,
    commit_sha: entry.commit_sha || null,
    commit_refs: entry.commit_refs || [],
    verified: entry.verified || false,
    rejected_at: entry.rejectedAt || null,
    rejected_by: entry.rejectedBy || null,
    rejection_notes: entry.rejectionNotes || null,
    closed_at: entry.closedAt || null,
    spec_conflict: entry.specConflict || false,
    spec_conflict_section: entry.specConflictSection || null,
  };
}

function fromDbRow(row) {
  const meta = row.metadata || {};
  return {
    id: row.pipeline_id,
    platformMocId: row.moc_id || undefined,
    platformMocNumber: row.moc_number || undefined,
    title: row.title,
    description: row.description || undefined,
    tier: row.tier,
    category: row.category || undefined,
    status: row.pipeline_status,
    source: row.source || undefined,
    persona: row.persona || undefined,
    changeType: row.change_type || undefined,
    changeTypeLabel: row.change_type_label || undefined,
    riskLevel: row.risk_level || undefined,
    reviewDepth: row.review_depth || undefined,
    routedDepartments: row.routed_departments || [],
    requiresManagement: row.requires_management || false,
    findings: meta.findings || [],
    affectedFiles: meta.affectedFiles || [],
    submittedAt: row.submitted_at || undefined,
    approvedAt: row.approved_at || undefined,
    implementedAt: row.implemented_at || undefined,
    implementationNotes: row.implementation_notes || undefined,
    managementApprovers: row.management_approvers || [],
    triageNote: row.triage_note || undefined,
    commit_sha: row.commit_sha || undefined,
    commit_refs: row.commit_refs || [],
    verified: row.verified || false,
    rejectedAt: row.rejected_at || undefined,
    rejectedBy: row.rejected_by || undefined,
    rejectionNotes: row.rejection_notes || undefined,
    closedAt: row.closed_at || undefined,
    specConflict: row.spec_conflict || false,
    specConflictSection: row.spec_conflict_section || undefined,
  };
}

// ---- File I/O (fallback) ----

function loadQueueFromFile() {
  if (!fs.existsSync(QUEUE_PATH)) { return { version: 2, mocs: [] }; }
  try {
    const raw = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
    return { version: raw.version ?? 2, mocs: Array.isArray(raw.mocs) ? raw.mocs : [] };
  } catch { return { version: 2, mocs: [] }; }
}

function saveQueueToFile(queue) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n", "utf-8");
}

// ---- Core operations ----

async function loadAll() {
  const sb = getServiceClient();
  if (sb) {
    const { data, error } = await sb.from(TABLE).select("*").order("submitted_at", { ascending: false, nullsFirst: false });
    if (!error && data) { return data.map(fromDbRow); }
    console.warn("[queue-db] Supabase query failed, falling back to file:", error?.message);
  }
  return loadQueueFromFile().mocs;
}

async function loadEntry(id) {
  const sb = getServiceClient();
  if (sb) {
    const { data } = await sb.from(TABLE).select("*").or(`pipeline_id.eq.${id},moc_id.eq.${id}`).maybeSingle();
    if (data) { return fromDbRow(data); }
  }
  const queue = loadQueueFromFile();
  return queue.mocs.find(m => m.id === id || m.platformMocId === id) || null;
}

async function createEntry(entry) {
  const sb = getServiceClient();
  const row = toDbRow(entry);
  if (sb) {
    const { error } = await sb.from(TABLE).upsert(row, { onConflict: "pipeline_id" });
    if (error) { console.warn("[queue-db] Create failed:", error.message); }
  }
  // Also write to file for backward compatibility
  const queue = loadQueueFromFile();
  const idx = queue.mocs.findIndex(m => m.id === entry.id);
  if (idx >= 0) { queue.mocs[idx] = entry; } else { queue.mocs.push(entry); }
  saveQueueToFile(queue);
}

async function updateEntry(id, fields) {
  const sb = getServiceClient();
  if (sb) {
    const dbFields = {};
    if (fields.status !== undefined) { dbFields.pipeline_status = fields.status; }
    if (fields.approvedAt !== undefined) { dbFields.approved_at = fields.approvedAt; }
    if (fields.implementedAt !== undefined) { dbFields.implemented_at = fields.implementedAt; }
    if (fields.implementationNotes !== undefined) { dbFields.implementation_notes = fields.implementationNotes; }
    if (fields.rejectedAt !== undefined) { dbFields.rejected_at = fields.rejectedAt; }
    if (fields.rejectedBy !== undefined) { dbFields.rejected_by = fields.rejectedBy; }
    if (fields.rejectionNotes !== undefined) { dbFields.rejection_notes = fields.rejectionNotes; }
    if (fields.closedAt !== undefined) { dbFields.closed_at = fields.closedAt; }
    if (fields.managementApprovers !== undefined) { dbFields.management_approvers = fields.managementApprovers; }
    if (fields.commit_sha !== undefined) { dbFields.commit_sha = fields.commit_sha; }
    if (fields.commit_refs !== undefined) { dbFields.commit_refs = fields.commit_refs; }
    if (fields.verified !== undefined) { dbFields.verified = fields.verified; }
    if (fields.staleDays !== undefined) { dbFields.stale_days = fields.staleDays; }
    if (Object.keys(dbFields).length > 0) {
      const { error } = await sb.from(TABLE).update(dbFields).eq("pipeline_id", id);
      if (error) { console.warn("[queue-db] Update failed:", error.message); }
    }
  }
  // Also update file
  const queue = loadQueueFromFile();
  const moc = queue.mocs.find(m => m.id === id);
  if (moc) { Object.assign(moc, fields); saveQueueToFile(queue); }
}

async function deleteEntry(id) {
  const sb = getServiceClient();
  if (sb) {
    await sb.from(TABLE).delete().eq("pipeline_id", id);
  }
  const queue = loadQueueFromFile();
  queue.mocs = queue.mocs.filter(m => m.id !== id);
  saveQueueToFile(queue);
}

// ---- Query helpers ----

async function queryByStatus(...statuses) {
  const all = await loadAll();
  return all.filter(m => statuses.includes(m.status));
}

async function queryPending() {
  return queryByStatus("pending_approval", "awaiting_approval");
}

function computeStaleDays(moc) {
  if (moc.status !== "pending_approval" && moc.status !== "awaiting_approval") { return 0; }
  const submitted = moc.submittedAt ? new Date(moc.submittedAt).getTime() : 0;
  if (!submitted) { return 0; }
  return Math.floor((Date.now() - submitted) / (1000 * 60 * 60 * 24));
}

async function querySummary() {
  const all = await loadAll();
  const summary = { total: all.length, byStatus: {}, byTier: {}, pendingApproval: 0, staleCount: 0 };
  for (const m of all) {
    summary.byStatus[m.status] = (summary.byStatus[m.status] || 0) + 1;
    summary.byTier[m.tier] = (summary.byTier[m.tier] || 0) + 1;
    if (m.status === "pending_approval" || m.status === "awaiting_approval") {
      summary.pendingApproval++;
      if (computeStaleDays(m) > 2) { summary.staleCount++; }
    }
  }
  return summary;
}

// ---- Backward compat ----

async function loadQueue() {
  const mocs = await loadAll();
  return { version: 2, mocs };
}

async function saveQueue(queue) {
  const sb = getServiceClient();
  if (sb) {
    for (const entry of queue.mocs) {
      const row = toDbRow(entry);
      await sb.from(TABLE).upsert(row, { onConflict: "pipeline_id" }).then(({ error }) => {
        if (error) { console.warn("[queue-db] Upsert failed for", entry.id, error.message); }
      });
    }
  }
  saveQueueToFile(queue);
}

module.exports = {
  TABLE,
  getServiceClient,
  isSupabaseAvailable,
  toDbRow,
  fromDbRow,
  loadQueueFromFile,
  saveQueueToFile,
  loadAll,
  loadEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  queryByStatus,
  queryPending,
  querySummary,
  computeStaleDays,
  loadQueue,
  saveQueue,
};
