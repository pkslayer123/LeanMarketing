All the required pieces are already fully implemented:

- **`app/auth/login/page.tsx`** — login page with `AuthForm` + link to signup
- **`app/auth/signup/page.tsx`** — signup page with `AuthForm` + link to login
- **`app/api/auth/callback/route.ts`** — OAuth/email verification code exchange
- **`lib/auth/actions.ts`** — `login`, `signup`, `logout` server actions
- **`components/AuthForm.tsx`** — client form component with loading/error/success states
- **`middleware.ts`** — protects all routes, redirects unauthenticated users to `/auth/login`
- **`lib/supabaseServer.ts`** — `createServerSupabaseClient` utility
- **`app/layout.tsx`** — session refresh on every page load

All the gaps listed in the spec are already filled. No code needs to be written.
