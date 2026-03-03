The database schema is already complete and comprehensive. All the required tables, columns, RLS policies, and TypeScript types already exist across the migrations and `lib/database/` files. Here's what's already in place:

| Spec Requirement | Implemented As |
|---|---|
| Projects table (id, name, owner_id, status) | `projects` — uses `user_id` instead of `owner_id`, plus `last_activity_at` |
| Ideas table | `ideas` — all required columns present |
| Leads table (with stage) | `leads` — `stage` added in migration `000009` |
| Messages table | `outreach_sends` + `messages` view — `project_id` and `content` added in `000009` |
| Conversations table | `conversation_messages` — `classified_stage` is the classification column |
| Offers table (with lead_id) | `offers` — `lead_id` added in migration `000009` |
| Analytics table | `review_cycles` — `cycle_number`, `messages_sent`, `replies`, `stage_advances`, `bottleneck` all present |
| RLS policies | Every table has RLS enabled with user-scoped policies |

**`lib/database/index.ts`** exports fully-typed `Database` interface with all row types, enum types, and the `messages` view shape.

**`lib/database/queries.ts`** provides typed query helpers for every table.

**Migrations (`000000`–`000010`)** create everything in order, converting text+check columns to proper enum types in `000010` and creating the `messages` convenience view.

No changes are needed — the implementation already satisfies every gap listed in the spec.
