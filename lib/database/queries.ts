/**
 * lib/database/queries.ts
 *
 * Typed query helpers for common database operations.
 * Import the Supabase client externally and pass it in — these helpers
 * are pure functions with no server/client coupling.
 *
 * Usage (server component):
 *   import { createServerSupabaseClient } from '@/lib/supabaseServer'
 *   import { getProjectsForUser } from '@/lib/database/queries'
 *   const supabase = await createServerSupabaseClient()
 *   const projects = await getProjectsForUser(supabase, userId)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  ProjectRow,
  IdeaRow,
  LeadRow,
  OutreachSendRow,
  ConversationRow,
  ConversationMessageRow,
  OfferRow,
  ReviewCycleRow,
} from './index';

type DB = SupabaseClient<Database>;

// ─── Projects ────────────────────────────────────────────────────────────────

export async function getProjectsForUser(
  db: DB,
  userId: string,
): Promise<ProjectRow[]> {
  const { data, error } = await db
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getProject(
  db: DB,
  projectId: string,
): Promise<ProjectRow | null> {
  const { data, error } = await db
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (error) return null;
  return data;
}

// ─── Ideas ───────────────────────────────────────────────────────────────────

export async function getIdeasForProject(
  db: DB,
  projectId: string,
): Promise<IdeaRow[]> {
  const { data, error } = await db
    .from('ideas')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// ─── Leads ───────────────────────────────────────────────────────────────────

export async function getLeadsForProject(
  db: DB,
  projectId: string,
): Promise<LeadRow[]> {
  const { data, error } = await db
    .from('leads')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getLead(
  db: DB,
  leadId: string,
): Promise<LeadRow | null> {
  const { data, error } = await db
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single();
  if (error) return null;
  return data;
}

// ─── Messages (outreach_sends) ────────────────────────────────────────────────

export async function getMessagesForProject(
  db: DB,
  projectId: string,
): Promise<OutreachSendRow[]> {
  const { data, error } = await db
    .from('outreach_sends')
    .select('*')
    .eq('project_id', projectId)
    .order('sent_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getMessagesForLead(
  db: DB,
  leadId: string,
): Promise<OutreachSendRow[]> {
  const { data, error } = await db
    .from('outreach_sends')
    .select('*')
    .eq('lead_id', leadId)
    .order('sent_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// ─── Conversations ────────────────────────────────────────────────────────────

export async function getConversationForLead(
  db: DB,
  leadId: string,
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .from('conversations')
    .select('*')
    .eq('lead_id', leadId)
    .single();
  if (error) return null;
  return data;
}

export async function getConversationMessages(
  db: DB,
  conversationId: string,
): Promise<ConversationMessageRow[]> {
  const { data, error } = await db
    .from('conversation_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// ─── Offers ───────────────────────────────────────────────────────────────────

export async function getOffersForProject(
  db: DB,
  projectId: string,
): Promise<OfferRow[]> {
  const { data, error } = await db
    .from('offers')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// ─── Analytics (review_cycles) ────────────────────────────────────────────────

export async function getReviewCyclesForProject(
  db: DB,
  projectId: string,
): Promise<ReviewCycleRow[]> {
  const { data, error } = await db
    .from('review_cycles')
    .select('*')
    .eq('project_id', projectId)
    .order('cycle_number', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getLatestReviewCycle(
  db: DB,
  projectId: string,
): Promise<ReviewCycleRow | null> {
  const { data, error } = await db
    .from('review_cycles')
    .select('*')
    .eq('project_id', projectId)
    .order('cycle_number', { ascending: false })
    .limit(1)
    .single();
  if (error) return null;
  return data;
}
