All the required pieces are already fully implemented:

- **`/auth/login`** — `app/auth/login/page.tsx` exists with email/password form
- **`/auth/signup`** — `app/auth/signup/page.tsx` exists with registration form
- **Auth middleware** — `middleware.ts` protects all routes, redirects unauthenticated users to `/auth/login`
- **Session handling in layout** — `app/layout.tsx` calls `supabase.auth.getUser()` on every render to refresh the session
- **Sign-out action** — `lib/auth/actions.ts` exports `logout()` which signs out and redirects to `/auth/login`
- **Auth callback** — `app/api/auth/callback/route.ts` handles the email confirmation flow
- **`AuthForm` component** — `components/AuthForm.tsx` is a client component with loading/error state
- **Server client** — `lib/supabaseServer.ts` creates a cookie-based server Supabase client

Everything listed in the spec is already present and correctly implemented. There are no gaps to fill.
