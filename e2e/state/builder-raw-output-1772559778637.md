The Layer 1 — Idea Definition feature is **already fully implemented**. Here's what exists:

| Gap | Status | File |
|-----|--------|------|
| `/projects/[id]/idea` page with form fields | Done | `app/projects/[id]/idea/page.tsx` |
| Payment assumption field | Done | `components/IdeaForm/index.tsx` |
| Next step field | Done | `components/IdeaForm/index.tsx` |
| Quality Gate 1 (clarity, specificity, audience, next step) | Done | `lib/ideas.ts` → `runQualityGate()` |
| Supabase `ideas` table linked to projects | Done | `supabase/migrations/20260303000000_create_projects_and_ideas.sql` |

**What's in place:**
- Server page component with auth check and existing-idea fetch
- `IdeaForm` client component with 5 fields, real-time quality gate display, and upsert on save
- `POST /api/ideas` — validates fields, runs quality gate, upserts record
- `GET /api/ideas?project_id=` — returns ideas with RLS enforcement
- 5-check quality gate: description clarity, audience specificity, problem specificity, payment assumption, next step actionability
- RLS policies on both `projects` and `ideas` tables

Nothing needs to be built for this feature. If tests are failing against it, share the test output and I can help diagnose the specific gaps.
