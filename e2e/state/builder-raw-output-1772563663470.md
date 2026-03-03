After reviewing all existing files, the database schema feature is already fully implemented. Here's what's in place:

**Migrations (`supabase/migrations/`)** — 11 migrations covering everything:

| Migration | Tables Created |
|-----------|---------------|
| `000000` | `projects`, `ideas` + RLS |
| `000001` | `audience_definitions`, `leads`, `message_templates`, `outreach_campaigns`, `outreach_sends` + enums + RLS |
| `000002` | `conversations`, `conversation_messages` + enums + RLS |
| `000003` | `proofs`, `landing_pages` + RLS |
| `000004` | `offers` + RLS |
| `000005` | `review_cycles` + RLS |
| `000006` | `project_settings` + RLS |
| `000007` | Adds `status`, `last_activity_at` to projects |
| `000008` | `set_updated_at()` trigger on all tables |
| `000009` | Fills gaps: `leads.stage`, `outreach_sends.project_id`/`content`, `offers.lead_id` |
| `000010` | Proper enums (`project_status`, `offer_template`, `offer_status`, `approval_mode`), performance indexes, `messages` convenience view |

**TypeScript types (`lib/database/index.ts`)** — Full `Database` type with all 14 tables/views + all enum types.

**Query helpers (`lib/database/queries.ts`)** — Typed helpers for all major read operations.

All spec-required columns are present:
- `projects`: id, user_id (owner), name, created_at, status ✅
- `ideas`: project_id, description, audience, problem, payment_assumption, next_step ✅
- `leads`: project_id, name, email, company, fit_reason, status, stage ✅
- `outreach_sends` + `messages` view: project_id, lead_id, template_version, sent_at, content ✅
- `conversation_messages`: lead_id (via conversation), direction, content, classified_stage, created_at ✅
- `offers`: project_id, lead_id, scope, duration_days, price_cents, success_definition, status ✅
- `review_cycles` (analytics): project_id, cycle_number, messages_sent, replies, stage_advances, bottleneck ✅
- RLS policies on every table ✅

No gaps remain — the database schema feature is complete.
