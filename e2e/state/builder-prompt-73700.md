You are building a new feature for a Next.js application.

## Feature to Build: Layer 6 — Review and Adjustment

**codeAreas:** `app/projects/[id]/review/`, `app/api/analytics/`, `lib/analytics/`, `components/Analytics/`

| Aspect | Current | Gap |
|--------|---------|-----|
| Weekly review dashboard | None | `/projects/[id]/review` — messages sent, replies, stage advancement |
| Bottleneck identification | None | Auto-identify biggest drop-off point |
| Variable tracking | None | Track single-variable changes per cycle |
| Quality Gate 6 | None | Pass/fail: 30+ attempts, bottleneck identified, one variable, hypothesis written |
| Experiment history | None | Log of past cycles and their results |

## Already Existing (do NOT recreate)
- app/projects/[id]/review
- app/api/analytics
- lib/analytics
- components/Analytics

## Specific Gaps to Fill
- `/projects/[id]/review` — messages sent, replies, stage advancement
- Auto-identify biggest drop-off point
- Track single-variable changes per cycle
- Pass/fail: 30+ attempts, bottleneck identified, one variable, hypothesis written
- Log of past cycles and their results

## Expected Routes
- /projects/[id]/review

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
