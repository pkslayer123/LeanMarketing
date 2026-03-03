All the required pieces are already fully implemented:

- **`app/auth/login/page.tsx`** — login page with email/password form
- **`app/auth/signup/page.tsx`** — signup page with email verification message
- **`app/api/auth/callback/route.ts`** — OAuth/magic link callback handler
- **`lib/auth/actions.ts`** — `login`, `signup`, and `logout` server actions
- **`components/AuthForm.tsx`** — shared client-side form with loading/error states
- **`lib/supabaseServer.ts`** — `createServerSupabaseClient` helper
- **`middleware.ts`** — route protection, redirects unauthenticated users to `/auth/login`
- **`app/layout.tsx`** — session refresh on every page load via `supabase.auth.getUser()`

All gaps listed in the feature spec are covered. No changes are needed.
