You are building a new feature for a Next.js application.

## Feature to Build: Layer 2 — Audience and Outreach

**codeAreas:** `app/projects/[id]/audience/`, `app/api/leads/`, `app/api/outreach/`, `lib/outreach/`, `components/Outreach/`

| Aspect | Current | Gap |
|--------|---------|-----|
| Audience definition | None | `/projects/[id]/audience` — job role, company type, inclusion/exclusion rules |
| Lead management | None | Lead list with fit reasons, status tracking |
| Message templates | None | A/B message editor with two parallel versions |
| Mock sender | None | Provider-neutral mock sender for end-to-end testing (Milestone 1) |
| Quality Gate 2 | None | Pass/fail: audience defined, lead fit documented, single CTA, opt-out enabled |
| Sending controls | None | Rate limits, caps, stop-on-reply |

## Already Existing (do NOT recreate)
- app/projects/[id]/audience
- app/api/leads
- app/api/outreach
- lib/outreach
- components/Outreach

## Specific Gaps to Fill
- `/projects/[id]/audience` — job role, company type, inclusion/exclusion rules
- Lead list with fit reasons, status tracking
- A/B message editor with two parallel versions
- Provider-neutral mock sender for end-to-end testing (Milestone 1)
- Pass/fail: audience defined, lead fit documented, single CTA, opt-out enabled
- Rate limits, caps, stop-on-reply

## Expected Routes
- /projects/[id]/audience

## Tech Stack & Patterns
- Next.js App Router with TypeScript
- Tailwind CSS for styling
- Supabase for database and auth (use `@supabase/ssr` createBrowserClient/createServerClient)
- React Server Components by default; add "use client" only when needed (hooks, interactivity)
- API routes use Next.js route handlers (app/api/.../route.ts with GET/POST exports)

## Project Structure
- app/ — Next.js App Router pages (page.tsx) and API routes (route.ts)
- components/ — Shared UI components
- lib/ — Utilities, services, hooks
- supabase/migrations/ — Database migrations (numbered sequentially)

Focus on creating the MISSING code areas listed above. Create minimal but functional
implementations. Do NOT import modules that don't exist yet — keep each file self-contained.
