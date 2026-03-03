All the code for this feature already exists and is fully implemented. Here's what's in place:

| File | Status |
|------|--------|
| `app/settings/page.tsx` | Server component — fetches projects + settings, renders per-project toggle |
| `app/api/settings/route.ts` | GET (fetch by project_id) + PATCH (upsert approval mode) |
| `lib/settings/index.ts` | `ApprovalMode` type, `ProjectSettings` interface, `requiresApproval()` logic, label map |
| `components/Settings/ApprovalModeToggle.tsx` | Client component — radio group with loading/error/saved states |
| `supabase/migrations/20260303000006_create_project_settings.sql` | `project_settings` table with RLS |
| `supabase/migrations/20260303000010_add_enums_and_indexes.sql` | `approval_mode` enum type migration |

The feature covers all the specified gaps:
- **`/settings` route** — lists all user projects, each with an approval mode toggle
- **Strict mode** — `requiresApproval()` returns `true` for all actions
- **Relaxed mode** — auto-advances low-risk; blocks on keywords like `delete`, `publish`, `deploy`, etc.
- **DB persistence** — `project_settings` table with `(project_id, user_id)` unique constraint and RLS

Nothing needs to be created.
