All the Layer 1 code is already fully implemented. Here's what exists:

| File | Status |
|------|--------|
| `app/projects/[id]/idea/page.tsx` | **Exists** — server component, auth-gated, fetches existing idea, renders form |
| `app/api/ideas/route.ts` | **Exists** — GET + POST with upsert and quality gate |
| `lib/ideas/index.ts` | **Exists** — `Idea` types + `runQualityGate()` with 4 checks |
| `components/IdeaForm/index.tsx` | **Exists** — client form with all 5 fields, quality gate feedback display |
| `supabase/migrations/20260303000000_*.sql` | **Exists** — `ideas` table with all columns + RLS |

The initial `Glob` returned no results for `app/projects/[id]/idea/**` because square brackets in the path pattern confused the glob matcher on Windows. Everything needed for Layer 1 is already in place — no code needs to be written.
