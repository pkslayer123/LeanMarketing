All the Layer 1 code areas are already fully implemented. Here's what exists:

| File | Status |
|------|--------|
| `app/projects/[id]/idea/page.tsx` | Complete — server component with auth, loads existing idea |
| `app/api/ideas/route.ts` | Complete — POST (upsert) and GET handlers |
| `lib/ideas/index.ts` | Complete — `Idea`/`IdeaInput` types + `runQualityGate()` |
| `components/IdeaForm/index.tsx` | Complete — all 5 fields + quality gate feedback UI |
| `supabase/migrations/20260303000000_create_projects_and_ideas.sql` | Complete — `ideas` table with RLS |

The gaps listed in the spec are already filled:
- **Form fields:** description, audience, problem, payment assumption, next step — all present
- **Quality Gate:** checks clarity (5–30 words), specificity (8+ words), audience (3+ words), next step (5+ words)
- **Supabase table:** `ideas` linked to projects via `project_id` with RLS

Nothing needs to be created.
