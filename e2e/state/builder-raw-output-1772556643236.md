All Layer 3 files are already fully implemented. Here's a summary of what exists and covers every specified gap:

**`lib/conversations/index.ts`**
- `ConversationStage` type: `not_relevant | curious | interested | ready_to_evaluate`
- `STAGE_LABELS`, `STAGE_ORDER`, `STAGE_COLORS` constants
- `suggestNextAction(stage)` — smallest next step per interest level
- `runQualityGate3(messages)` — 3 checks: classification accuracy, effort check, logging

**`app/api/conversations/route.ts`** — GET list + POST create with QG auto-run

**`app/api/conversations/[id]/route.ts`** — GET single, PATCH stage/action with QG re-run, DELETE

**`app/api/conversations/[id]/messages/route.ts`** — GET history + POST add message with auto stage-advancement (inbound classified_stage advances conversation if higher than current)

**`app/projects/[id]/conversations/page.tsx`** — Server component with auth, ownership check, fetches conversations + leads

**`components/Conversations/ConversationsDashboard.tsx`** — Full client UI:
- Stage filter buttons + conversation list with badges
- `StagePipeline` component — visual color-coded progress bar
- Next action suggestion box (indigo callout)
- Quality Gate 3 detail panel with pass/fail icons per check
- Full message thread (outbound right/blue, inbound left/gray, timestamps, classification badges)
- Add message form with direction selector + classify-reply dropdown for inbound

**`supabase/migrations/20260303000002_create_conversations.sql`** — DB schema with enums, `conversations` and `conversation_messages` tables, RLS policies

Every gap is covered. No new code needs to be written for Layer 3.
