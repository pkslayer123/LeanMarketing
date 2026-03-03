You are building a new feature for a Next.js application.

## Feature to Build: Layer 3 — Conversation and Qualification

**codeAreas:** `app/projects/[id]/conversations/`, `app/api/conversations/`, `lib/conversations/`, `components/Conversations/`

| Aspect | Current | Gap |
|--------|---------|-----|
| Reply classification | None | Classify: not relevant, curious, interested, ready to evaluate |
| Stage pipeline | None | Visual stage progression for leads |
| Conversation log | None | Full exchange history per lead |
| Next action suggestions | None | Auto-suggest smallest next step based on interest level |
| Quality Gate 3 | None | Pass/fail: classification accuracy, effort check, logging |

## Already Existing (do NOT recreate)
- app/projects/[id]/conversations
- app/api/conversations
- lib/conversations
- components/Conversations

## Specific Gaps to Fill
- Classify: not relevant, curious, interested, ready to evaluate
- Visual stage progression for leads
- Full exchange history per lead
- Auto-suggest smallest next step based on interest level
- Pass/fail: classification accuracy, effort check, logging

## Expected Routes
- Determine appropriate routes from the feature description

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
