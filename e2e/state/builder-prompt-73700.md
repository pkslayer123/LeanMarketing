You are building a new feature for a Next.js application.

## Feature to Build: Dashboard and Project Overview

**codeAreas:** `app/dashboard/`, `app/api/projects/`, `lib/projects/`, `components/Dashboard/`

| Aspect | Current | Gap |
|--------|---------|-----|
| Dashboard page | None | `/dashboard` — list all projects with status |
| Project detection | None | Detect persona-engine projects in the daemon network |
| Project cards | None | Show project name, status, last activity |
| Navigation | None | Sidebar/header nav between sections |
| Project isolation | None | Ensure projects never share data |

## Already Existing (do NOT recreate)
- app/dashboard
- app/api/projects
- lib/projects
- components/Dashboard

## Specific Gaps to Fill
- `/dashboard` — list all projects with status
- Detect persona-engine projects in the daemon network
- Show project name, status, last activity
- Sidebar/header nav between sections
- Ensure projects never share data

## Expected Routes
- /dashboard

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
