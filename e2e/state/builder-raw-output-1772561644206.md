After exploring the codebase, Layer 6 is already fully implemented. Nothing needs to be built.

Here's what exists:

| File | Status |
|------|--------|
| `app/projects/[id]/review/page.tsx` | Client component — fetches analytics, renders ReviewDashboard |
| `app/api/analytics/route.ts` | GET (funnel metrics + bottleneck) and POST (save review cycle) |
| `lib/analytics/index.ts` | `identifyBottleneck()`, `runQualityGate6()`, all types |
| `components/Analytics/ReviewDashboard/index.tsx` | Funnel chart, bottleneck alert, cycle log form, quality gate badge |
| `supabase/migrations/20260303000005_create_analytics.sql` | `review_cycles` table with RLS |
| `lib/database/index.ts` | `ReviewCycleRow` type and `Database` interface |
| `lib/database/queries.ts` | `getReviewCyclesForProject()`, `getLatestReviewCycle()` |

All specific gaps from the feature spec are covered:
- **Messages sent / replies / stage advancement** — computed in the API route from leads + conversations
- **Auto-identify bottleneck** — `identifyBottleneck()` finds the largest funnel drop-off
- **Variable tracking per cycle** — `variable_changed` field on `review_cycles`
- **Quality Gate 6** — 4 checks: 30+ attempts, bottleneck identified, variable 3-20 words, hypothesis 8-60 words
- **Experiment history** — cycle cards rendered from `review_cycles` ordered by `cycle_number`

No changes needed.
