'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Conversation,
  ConversationMessage,
  ConversationStage,
  MessageDirection,
  STAGE_LABELS,
  STAGE_ORDER,
  STAGE_COLORS,
} from '@/lib/conversations';

interface Lead {
  id: string;
  name?: string | null;
  email?: string | null;
}

interface ConversationWithLead extends Conversation {
  leads?: Lead | null;
}

interface Props {
  projectId: string;
  initialConversations: ConversationWithLead[];
  leads: Lead[];
}

const STAGE_PIPELINE_COLORS: Record<ConversationStage, string> = {
  not_relevant: 'bg-gray-400',
  curious: 'bg-yellow-400',
  interested: 'bg-blue-500',
  ready_to_evaluate: 'bg-green-500',
};

function leadLabel(lead?: Lead | null): string {
  if (!lead) return 'Unknown Lead';
  return lead.name || lead.email || lead.id.slice(0, 8);
}

function StagePipeline({ stage }: { stage: ConversationStage }) {
  const currentIdx = STAGE_ORDER.indexOf(stage);
  return (
    <div className="flex items-center gap-1 my-3">
      {STAGE_ORDER.map((s, i) => (
        <div key={s} className="flex items-center gap-1 flex-1">
          <div
            className={`h-2 flex-1 rounded-full transition-colors ${
              i <= currentIdx ? STAGE_PIPELINE_COLORS[s] : 'bg-gray-200 dark:bg-gray-700'
            }`}
          />
          {i < STAGE_ORDER.length - 1 && (
            <div className={`w-2 h-2 rounded-full ${i < currentIdx ? STAGE_PIPELINE_COLORS[STAGE_ORDER[i + 1]] : 'bg-gray-200 dark:bg-gray-700'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

function QualityGateBadge({ passed }: { passed: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
        passed
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
      }`}
    >
      {passed ? '✓ Gate 3 Passed' : '✗ Gate 3 Open'}
    </span>
  );
}

export default function ConversationsDashboard({ projectId, initialConversations, leads }: Props) {
  const [conversations, setConversations] = useState<ConversationWithLead[]>(initialConversations);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConversations[0]?.id ?? null
  );
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [stageFilter, setStageFilter] = useState<ConversationStage | 'all'>('all');
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Add message form state
  const [direction, setDirection] = useState<MessageDirection>('outbound');
  const [content, setContent] = useState('');
  const [classifiedStage, setClassifiedStage] = useState<ConversationStage | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // New conversation form state
  const [newLeadId, setNewLeadId] = useState('');
  const [creatingConv, setCreatingConv] = useState(false);

  const selectedConv = conversations.find((c) => c.id === selectedId) ?? null;

  const fetchMessages = useCallback(async (convId: string) => {
    setLoadingMessages(true);
    try {
      const res = await fetch(`/api/conversations/${convId}/messages`);
      if (res.ok) setMessages(await res.json());
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) fetchMessages(selectedId);
  }, [selectedId, fetchMessages]);

  const filteredConversations = stageFilter === 'all'
    ? conversations
    : conversations.filter((c) => c.stage === stageFilter);

  async function handleAddMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !content.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/conversations/${selectedId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          content,
          classified_stage: direction === 'inbound' && classifiedStage ? classifiedStage : null,
        }),
      });
      if (!res.ok) {
        const { error: e } = await res.json();
        setError(e ?? 'Failed to add message');
        return;
      }
      const newMsg: ConversationMessage = await res.json();
      setMessages((prev) => [...prev, newMsg]);
      setContent('');
      setClassifiedStage('');

      // Refresh conversation to get updated stage/quality gate
      const convRes = await fetch(`/api/conversations?project_id=${projectId}`);
      if (convRes.ok) {
        const updated: ConversationWithLead[] = await convRes.json();
        setConversations(updated);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreateConversation(e: React.FormEvent) {
    e.preventDefault();
    if (!newLeadId) return;
    setCreatingConv(true);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, lead_id: newLeadId }),
      });
      if (res.ok) {
        const convRes = await fetch(`/api/conversations?project_id=${projectId}`);
        if (convRes.ok) {
          const updated: ConversationWithLead[] = await convRes.json();
          setConversations(updated);
          const newConv = updated.find((c) => c.lead_id === newLeadId);
          if (newConv) setSelectedId(newConv.id);
        }
        setNewLeadId('');
      }
    } finally {
      setCreatingConv(false);
    }
  }

  const leadsWithoutConversation = leads.filter(
    (l) => !conversations.some((c) => c.lead_id === l.id)
  );

  return (
    <div className="flex h-full gap-4">
      {/* Left panel: conversation list */}
      <div className="w-72 shrink-0 flex flex-col gap-3">
        <div className="flex flex-wrap gap-1">
          {(['all', ...STAGE_ORDER] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStageFilter(s)}
              className={`text-xs px-2 py-1 rounded-full font-medium border transition-colors ${
                stageFilter === s
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-indigo-400'
              }`}
            >
              {s === 'all' ? 'All' : STAGE_LABELS[s]}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto space-y-2">
          {filteredConversations.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">No conversations yet.</p>
          )}
          {filteredConversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => setSelectedId(conv.id)}
              className={`w-full text-left rounded-lg border p-3 transition-colors ${
                conv.id === selectedId
                  ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-indigo-300'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {leadLabel(conv.leads)}
                </span>
                <QualityGateBadge passed={conv.quality_gate_passed} />
              </div>
              <span
                className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${STAGE_COLORS[conv.stage]}`}
              >
                {STAGE_LABELS[conv.stage]}
              </span>
              {conv.next_action && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
                  {conv.next_action}
                </p>
              )}
            </button>
          ))}
        </div>

        {leadsWithoutConversation.length > 0 && (
          <form onSubmit={handleCreateConversation} className="border-t pt-3 dark:border-gray-700">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              Start conversation
            </label>
            <select
              value={newLeadId}
              onChange={(e) => setNewLeadId(e.target.value)}
              className="w-full text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-2 py-1.5 mb-2 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">Select lead…</option>
              {leadsWithoutConversation.map((l) => (
                <option key={l.id} value={l.id}>{leadLabel(l)}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!newLeadId || creatingConv}
              className="w-full text-sm bg-indigo-600 text-white rounded-md py-1.5 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {creatingConv ? 'Creating…' : 'Start'}
            </button>
          </form>
        )}
      </div>

      {/* Right panel: selected conversation */}
      {selectedConv ? (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Header */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 mb-3">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                  {leadLabel(selectedConv.leads)}
                </h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STAGE_COLORS[selectedConv.stage]}`}>
                    {STAGE_LABELS[selectedConv.stage]}
                  </span>
                  <QualityGateBadge passed={selectedConv.quality_gate_passed} />
                </div>
              </div>
            </div>
            <StagePipeline stage={selectedConv.stage} />
            <div className="flex flex-wrap gap-2 mt-1">
              {STAGE_ORDER.map((s, i) => (
                <span key={s} className={`text-xs ${i === STAGE_ORDER.indexOf(selectedConv.stage) ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-400 dark:text-gray-500'}`}>
                  {STAGE_LABELS[s]}
                </span>
              ))}
            </div>
          </div>

          {/* Next action suggestion */}
          {selectedConv.next_action && (
            <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-lg px-4 py-3 mb-3">
              <p className="text-xs font-medium text-indigo-700 dark:text-indigo-300 uppercase tracking-wide mb-0.5">
                Suggested Next Action
              </p>
              <p className="text-sm text-indigo-900 dark:text-indigo-100">{selectedConv.next_action}</p>
            </div>
          )}

          {/* Quality gate detail */}
          {selectedConv.quality_gate_feedback && (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3 mb-3">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                Quality Gate 3
              </p>
              <div className="space-y-1.5">
                {selectedConv.quality_gate_feedback.checks.map((check) => (
                  <div key={check.label} className="flex items-start gap-2">
                    <span className={`mt-0.5 text-xs font-bold ${check.passed ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                      {check.passed ? '✓' : '✗'}
                    </span>
                    <div>
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                        {check.label}
                      </span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{check.feedback}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Message log */}
          <div className="flex-1 overflow-y-auto space-y-3 mb-3">
            {loadingMessages ? (
              <p className="text-sm text-gray-400">Loading messages…</p>
            ) : messages.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-gray-500">No messages yet. Log your first outreach below.</p>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-sm rounded-lg px-4 py-2.5 text-sm ${
                      msg.direction === 'outbound'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white'
                    }`}
                  >
                    <p>{msg.content}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-xs ${msg.direction === 'outbound' ? 'text-indigo-200' : 'text-gray-400'}`}>
                        {new Date(msg.created_at).toLocaleString()}
                      </span>
                      {msg.classified_stage && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${STAGE_COLORS[msg.classified_stage]}`}>
                          {STAGE_LABELS[msg.classified_stage]}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Add message form */}
          <form
            onSubmit={handleAddMessage}
            className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3"
          >
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Direction
                </label>
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as MessageDirection)}
                  className="w-full text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="outbound">Outbound (sent by me)</option>
                  <option value="inbound">Inbound (reply received)</option>
                </select>
              </div>
              {direction === 'inbound' && (
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Classify reply
                  </label>
                  <select
                    value={classifiedStage}
                    onChange={(e) => setClassifiedStage(e.target.value as ConversationStage | '')}
                    className="w-full text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="">— Select stage —</option>
                    {STAGE_ORDER.map((s) => (
                      <option key={s} value={s}>{STAGE_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Message
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={3}
                placeholder={direction === 'outbound' ? 'What did you send?' : 'What did they say?'}
                className="w-full text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
              />
            </div>
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting || !content.trim()}
              className="w-full text-sm bg-indigo-600 text-white rounded-md py-2 hover:bg-indigo-700 disabled:opacity-50 transition-colors font-medium"
            >
              {submitting ? 'Logging…' : 'Log Message'}
            </button>
          </form>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
          Select a conversation or start one from a lead.
        </div>
      )}
    </div>
  );
}
