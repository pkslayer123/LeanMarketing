You are building a new feature for a Next.js application.

## Feature to Build: Layer 5 — Paid Conversion

**codeAreas:** `app/projects/[id]/conversion/`, `app/api/offers/`, `lib/offers/`, `components/Offers/`

| Aspect | Current | Gap |
|--------|---------|-----|
| Offer builder | None | `/projects/[id]/conversion` — scope, time, price, success definition |
| Offer templates | None | Trial, early access, pilot agreement templates |
| Quality Gate 5 | None | Pass/fail: scope, duration, price, measurable success |
| Offer tracking | None | Track sent offers, acceptance, conversion |

## Already Existing (do NOT recreate)
- app/projects/[id]/conversion
- app/api/offers
- lib/offers
- components/Offers

## Specific Gaps to Fill
- `/projects/[id]/conversion` — scope, time, price, success definition
- Trial, early access, pilot agreement templates
- Pass/fail: scope, duration, price, measurable success
- Track sent offers, acceptance, conversion

## Expected Routes
- /projects/[id]/conversion

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
