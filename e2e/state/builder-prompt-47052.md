You are building a new feature for a Next.js application based on a BUILD-SPEC.

## Feature to Build: Authentication and User Management

**codeAreas:** `app/auth/`, `app/api/auth/`, `lib/auth/`, `components/AuthForm.tsx`

| Aspect | Current | Gap |
|--------|---------|-----|
| Login page | None | `/auth/login` — email/password login via Supabase Auth |
| Signup page | None | `/auth/signup` — registration with email verification |
| Auth middleware | None | Protect routes, redirect unauthenticated users |
| Session management | None | Supabase session handling in layout |
| Logout | None | Sign-out action and redirect |

## Expected Routes
- /auth/login
- /auth/signup

## Instructions
1. Create the necessary page routes under app/ (page.tsx files)
2. Create any needed API routes under app/api/ (route.ts files)
3. Create shared components under components/
4. If the feature needs database tables, create a Supabase migration file
5. Use the project's existing patterns: Tailwind CSS for styling, Supabase for DB, handleGET/handlePOST for API routes
6. After creating files, run `npx tsc --noEmit` to verify no type errors

## Project Structure
- app/ — Next.js App Router pages and API routes
- components/ — Shared UI components
- lib/ — Utilities, services, hooks
- supabase/migrations/ — Database migrations (numbered sequentially)

Keep the implementation minimal but functional. Focus on getting the route and basic UI working so persona tests can validate it.
