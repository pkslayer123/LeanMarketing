Layer 2 is already fully implemented. All the specified gaps have been filled:

| Gap | Status | Location |
|-----|--------|----------|
| `/projects/[id]/audience` — job role, company type, inclusion/exclusion rules | **Done** | `AudienceForm` with tag inputs |
| Lead list with fit reasons, status tracking | **Done** | `components/Outreach/LeadList/` |
| A/B message editor with two parallel versions | **Done** | `_client.tsx` → `TemplateEditor` |
| Provider-neutral mock sender | **Done** | `app/api/outreach/send/route.ts` (returns `mock: true`) |
| Quality Gate 2 pass/fail | **Done** | `_client.tsx` → `QualityGate2Panel` |
| Rate limits, caps, stop-on-reply | **Done** | `CampaignSettings` + enforced in send route |

The complete stack is in place:
- **Database:** `supabase/migrations/20260303000001_create_audience_and_outreach.sql` — all 5 tables with RLS
- **API routes:** `/api/audience`, `/api/leads`, `/api/leads/[id]`, `/api/outreach`, `/api/outreach/[id]`, `/api/outreach/send`, `/api/outreach/templates`, `/api/outreach/templates/[id]`
- **Page:** `app/projects/[id]/audience/page.tsx` — server component loading all data
- **Components:** `AudienceForm`, `LeadList`, `TemplateEditor`, `CampaignSettings`, `QualityGate2Panel`
- **Types & logic:** `lib/outreach/index.ts` — types, `analyseTemplate()`, `runQualityGate2()`

Nothing to build — Layer 2 is complete.
