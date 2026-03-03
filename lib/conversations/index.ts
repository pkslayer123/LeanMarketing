export type ConversationStage =
  | 'not_relevant'
  | 'curious'
  | 'interested'
  | 'ready_to_evaluate';

export type MessageDirection = 'outbound' | 'inbound';

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  user_id: string;
  direction: MessageDirection;
  content: string;
  classified_stage: ConversationStage | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  project_id: string;
  lead_id: string;
  user_id: string;
  stage: ConversationStage;
  next_action: string | null;
  quality_gate_passed: boolean;
  quality_gate_feedback: QualityGate3Feedback | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationInput {
  project_id: string;
  lead_id: string;
  stage?: ConversationStage;
}

export interface MessageInput {
  direction: MessageDirection;
  content: string;
  classified_stage?: ConversationStage | null;
}

export interface QualityGate3Check {
  label: string;
  passed: boolean;
  feedback: string;
}

export interface QualityGate3Feedback {
  checks: QualityGate3Check[];
  overall_passed: boolean;
}

export const STAGE_LABELS: Record<ConversationStage, string> = {
  not_relevant: 'Not Relevant',
  curious: 'Curious',
  interested: 'Interested',
  ready_to_evaluate: 'Ready to Evaluate',
};

export const STAGE_ORDER: ConversationStage[] = [
  'not_relevant',
  'curious',
  'interested',
  'ready_to_evaluate',
];

export const STAGE_COLORS: Record<ConversationStage, string> = {
  not_relevant:
    'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  curious:
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  interested:
    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  ready_to_evaluate:
    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
};

export function suggestNextAction(stage: ConversationStage): string {
  const suggestions: Record<ConversationStage, string> = {
    not_relevant: 'Archive this lead — no further action needed.',
    curious: 'Send a short case study or social proof to build interest.',
    interested: 'Schedule a 15-minute discovery call.',
    ready_to_evaluate: 'Send a demo link or proposal immediately.',
  };
  return suggestions[stage];
}

export function runQualityGate3(
  messages: Pick<ConversationMessage, 'direction' | 'classified_stage'>[],
): QualityGate3Feedback {
  const checks: QualityGate3Check[] = [];

  // Check 1: Classification accuracy — all inbound messages should be classified
  const inbound = messages.filter((m) => m.direction === 'inbound');
  const classifiedCount = inbound.filter((m) => m.classified_stage != null).length;
  const classificationPassed =
    inbound.length === 0 || classifiedCount === inbound.length;
  checks.push({
    label: 'Classification Accuracy',
    passed: classificationPassed,
    feedback: classificationPassed
      ? 'All inbound replies have been classified.'
      : `${inbound.length - classifiedCount} inbound message(s) lack a classification.`,
  });

  // Check 2: Effort check — at least one outbound message logged
  const hasOutbound = messages.some((m) => m.direction === 'outbound');
  checks.push({
    label: 'Effort Check',
    passed: hasOutbound,
    feedback: hasOutbound
      ? 'At least one outbound message recorded.'
      : 'Log at least one outbound message to show outreach effort.',
  });

  // Check 3: Logging — conversation history must exist
  const hasMessages = messages.length > 0;
  checks.push({
    label: 'Conversation Logging',
    passed: hasMessages,
    feedback: hasMessages
      ? 'Conversation history is being tracked.'
      : 'No messages logged yet. Add your first outreach message.',
  });

  return {
    checks,
    overall_passed: checks.every((c) => c.passed),
  };
}
