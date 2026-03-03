You are building a new feature for a Next.js application.

## Feature to Build: Approval Mode Toggle

**codeAreas:** `app/settings/`, `app/api/settings/`, `lib/settings/`, `components/Settings/`

| Aspect | Current | Gap |
|--------|---------|-----|
| Settings page | None | `/settings` — approval mode toggle |
| Strict mode | None | All classifications and next actions require approval |
| Relaxed mode | None | Low-risk auto-advance, high-risk requires approval |
| Mode persistence | None | Store mode in database per project |

## Already Existing (do NOT recreate)
- app/settings
- app/api/settings
- lib/settings
- components/Settings

## Specific Gaps to Fill
- `/settings` — approval mode toggle
- All classifications and next actions require approval
- Low-risk auto-advance, high-risk requires approval
- Store mode in database per project

## Expected Routes
- /settings

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
