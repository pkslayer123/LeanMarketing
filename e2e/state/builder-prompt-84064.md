You are building a new feature for a Next.js application.

## Feature to Build: Authentication and User Management

**codeAreas:** `app/auth/`, `app/api/auth/`, `lib/auth/`, `components/AuthForm.tsx`

| Aspect | Current | Gap |
|--------|---------|-----|
| Login page | None | `/auth/login` — email/password login via Supabase Auth |
| Signup page | None | `/auth/signup` — registration with email verification |
| Auth middleware | None | Protect routes, redirect unauthenticated users |
| Session management | None | Supabase session handling in layout |
| Logout | None | Sign-out action and redirect |

## Already Existing (do NOT recreate)
- app/auth
- app/api/auth
- lib/auth
- components/AuthForm.tsx

## Specific Gaps to Fill
- `/auth/login` — email/password login via Supabase Auth
- `/auth/signup` — registration with email verification
- Protect routes, redirect unauthenticated users
- Supabase session handling in layout
- Sign-out action and redirect

## Expected Routes
- /auth/login
- /auth/signup

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
