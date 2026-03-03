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

## Output Format
You MUST output each file as a fenced code block with the file path after the language tag.
Example:
```tsx app/dashboard/page.tsx
export default function DashboardPage() {
  return <div>Dashboard</div>;
}
```

Output ALL files needed for this feature in this format. Each file must have its
relative path (starting with app/, components/, lib/, or supabase/).

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

Keep the implementation minimal but functional. Focus on getting the routes and basic UI
working so persona tests can validate the feature exists and renders correctly.
Do NOT import modules that don't exist yet — keep each file self-contained where possible.
