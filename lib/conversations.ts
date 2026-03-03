/**
 * lib/conversations.ts
 *
 * Input types and pure helper functions for the conversation qualification layer.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConversationStage = 'not_relevant' | 'curious' | 'interested' | 'ready_to_evaluate';

export interface ConversationInput {
  project_id: string;
  lead_id: string;
  stage?: ConversationStage;
}

export interface MessageInput {
  direction: 'outbound' | 'inbound';
  content: string;
  classified_stage?: ConversationStage;
}

// ─── Stage ordering ───────────────────────────────────────────────────────────

export const STAGE_ORDER: ConversationStage[] = [
  'not_relevant',
  'curious',
  'interested',
  'ready_to_evaluate',
];

// ─── Next-action suggestions ──────────────────────────────────────────────────

export function suggestNextAction(stage: ConversationStage): string {
  switch (stage) {
    case 'not_relevant':
      return 'No action needed — lead is not relevant.';
    case 'curious':
      return 'Send a follow-up message to build interest.';
    case 'interested':
      return 'Schedule a discovery call or share proof material.';
    case 'ready_to_evaluate':
      return 'Send a formal offer or pilot proposal.';
  }
}

// ─── Quality gate types ───────────────────────────────────────────────────────

export interface QualityGateCheck {
  label: string;
  passed: boolean;
  feedback: string;
}

export interface QualityGateFeedback {
  overall_passed: boolean;
  checks: QualityGateCheck[];
}

// ─── Quality gate 3 (Conversation qualification) ─────────────────────────────

interface MessageRecord {
  direction: string;
  classified_stage: string | null;
}

export function runQualityGate3(messages: MessageRecord[]): QualityGateFeedback {
  const inbound = messages.filter((m) => m.direction === 'inbound');
  const classified = inbound.filter((m) => m.classified_stage !== null);
  const advancedStages: ConversationStage[] = ['interested', 'ready_to_evaluate'];
  const hasAdvanced = classified.some(
    (m) => m.classified_stage && advancedStages.includes(m.classified_stage as ConversationStage),
  );

  const checks: QualityGateCheck[] = [
    {
      label: 'Has inbound reply',
      passed: inbound.length > 0,
      feedback:
        inbound.length > 0
          ? `${inbound.length} inbound message(s) received.`
          : 'No inbound messages yet — follow up to elicit a reply.',
    },
    {
      label: 'Replies classified',
      passed: classified.length > 0,
      feedback:
        classified.length > 0
          ? `${classified.length} message(s) have been classified.`
          : 'Classify at least one inbound message to track stage.',
    },
    {
      label: 'Lead shows interest',
      passed: hasAdvanced,
      feedback: hasAdvanced
        ? 'Lead has shown interest or readiness to evaluate.'
        : 'No messages classified as interested or ready_to_evaluate yet.',
    },
  ];

  return {
    overall_passed: checks.every((c) => c.passed),
    checks,
  };
}
