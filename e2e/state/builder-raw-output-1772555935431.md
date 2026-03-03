The Layer 1 — Idea Definition feature is **already fully implemented**. The exploration found all the required pieces are in place:

| Component | File | Status |
|---|---|---|
| Idea page | `app/projects/[id]/idea/page.tsx` | Exists |
| API route (GET/POST) | `app/api/ideas/route.ts` | Exists |
| Types + Quality Gate | `lib/ideas/index.ts` | Exists |
| Form component | `components/IdeaForm/index.tsx` | Exists |
| DB migration | `supabase/migrations/20260303000000_create_projects_and_ideas.sql` | Exists |

The implementation includes all the specific gaps listed in the spec:
- One-sentence description, audience, and problem fields
- Payment assumption field
- Next step field
- Quality gate checking clarity, specificity, audience, and next step
- Supabase `ideas` table with RLS linked to projects

Nothing needs to be built. If the E2E tests are failing for this feature, the issue is likely in the runtime environment (auth, DB schema not applied, env vars) rather than missing code.
