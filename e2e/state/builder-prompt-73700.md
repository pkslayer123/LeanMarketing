You are building a new feature for a Next.js application.

## Feature to Build: Layer 4 — Proof and Demonstration

**codeAreas:** `app/projects/[id]/proof/`, `app/api/proof/`, `lib/proof/`, `components/Proof/`

| Aspect | Current | Gap |
|--------|---------|-----|
| Proof management | None | `/projects/[id]/proof` — manage proof artifacts per project |
| Proof types | None | Support: written summary, walkthrough demo, trial |
| Landing page builder | None | Simple landing page generator following spec rules |
| Quality Gate 4 | None | Pass/fail: outcome shown, under 10min, clear decision request |

## Already Existing (do NOT recreate)
- app/projects/[id]/proof
- app/api/proof
- lib/proof
- components/Proof

## Specific Gaps to Fill
- `/projects/[id]/proof` — manage proof artifacts per project
- Support: written summary, walkthrough demo, trial
- Simple landing page generator following spec rules
- Pass/fail: outcome shown, under 10min, clear decision request

## Expected Routes
- /projects/[id]/proof

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
