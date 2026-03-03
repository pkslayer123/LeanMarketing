Layer 6 is already fully implemented. Every file exists and is complete:

| File | Status |
|------|--------|
| `app/projects/[id]/review/page.tsx` | Complete — client component, fetches analytics, passes data to dashboard |
| `app/api/analytics/route.ts` | Complete — GET aggregates funnel from `leads`/`conversations`, POST creates review cycles with Quality Gate 6 |
| `lib/analytics/index.ts` | Complete — `identifyBottleneck()`, `runQualityGate6()`, all types |
| `components/Analytics/ReviewDashboard/index.tsx` | Complete — summary stats, funnel chart with drop-off %, bottleneck highlight, cycle form, experiment history |
| `supabase/migrations/20260303000005_create_analytics.sql` | Complete — `review_cycles` table with RLS |

All five specific gaps are covered:
- **Messages sent / replies / stage advancement** — computed from `leads` and `conversations` tables in the GET handler
- **Auto-identify bottleneck** — `identifyBottleneck()` finds the largest absolute drop between funnel stages
- **Single-variable tracking** — `variable_changed` field, validated to 3–20 words
- **Quality Gate 6** — 4 checks: 30+ attempts, bottleneck identified, one variable, hypothesis sentence
- **Experiment history** — `CycleCard` renders past cycles in reverse order

Nothing needs to be built.
