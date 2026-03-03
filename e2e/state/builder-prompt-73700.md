You are building a new feature for a Next.js application.

## Feature to Build: Layer 1 — Idea Definition

**codeAreas:** `app/projects/[id]/idea/`, `app/api/ideas/`, `lib/ideas/`, `components/IdeaForm/`

| Aspect | Current | Gap |
|--------|---------|-----|
| Idea form | None | `/projects/[id]/idea` — capture one-sentence description, audience, problem |
| Payment assumption | None | Field: what must be true for someone to pay |
| Next step definition | None | Field: smallest next step after reply |
| Quality Gate 1 | None | Pass/fail check: clarity, specificity, audience, next step |
| Idea storage | None | Supabase table for ideas linked to projects |

## Already Existing (do NOT recreate)
- app/projects/[id]/idea
- app/api/ideas
- lib/ideas
- components/IdeaForm

## Specific Gaps to Fill
- `/projects/[id]/idea` — capture one-sentence description, audience, problem
- Field: what must be true for someone to pay
- Field: smallest next step after reply
- Pass/fail check: clarity, specificity, audience, next step
- Supabase table for ideas linked to projects

## Expected Routes
- /projects/[id]/idea

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
