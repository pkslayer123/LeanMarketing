The exploration shows that **Layer 2 is already fully implemented**. Here's what exists:

**Database**
- `supabase/migrations/20260303000001_create_audience_and_outreach.sql` — tables for `audience_definitions`, `leads`, `message_templates`, `outreach_campaigns`, `outreach_sends` with RLS policies

**API Routes**
- `app/api/audience/route.ts` — GET/POST audience definition
- `app/api/leads/route.ts` + `[id]/route.ts` — CRUD for leads
- `app/api/outreach/route.ts` — CRUD for campaigns
- `app/api/outreach/templates/route.ts` + `[id]/route.ts` — A/B template management
- `app/api/outreach/send/route.ts` — provider-neutral mock sender with rate limits, daily cap, stop-on-reply

**Library**
- `lib/outreach/index.ts` — full TypeScript types, `analyseTemplate()`, `runQualityGate2()` with all 4 checks

**Components**
- `components/Outreach/AudienceForm/` — job role, company type, inclusion/exclusion tag inputs
- `components/Outreach/LeadList/` — lead list with fit reasons and status tracking

**Page**
- `app/projects/[id]/audience/page.tsx` + `_client.tsx` — full page with AudienceForm, LeadList, TemplateEditor (A/B), CampaignSettings, QualityGate2Panel

All the listed gaps (audience definition, lead management, A/B message editor, mock sender, Quality Gate 2, rate limits/caps/stop-on-reply) are covered. No new code needs to be written.
