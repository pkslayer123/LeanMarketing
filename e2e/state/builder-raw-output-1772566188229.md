All the required files already exist and are fully implemented:

- **`/auth/login`** — `app/auth/login/page.tsx` renders `AuthForm` with the `login` server action
- **`/auth/signup`** — `app/auth/signup/page.tsx` renders `AuthForm` with the `signup` server action  
- **Auth middleware** — `middleware.ts` protects all routes, redirects unauthenticated users to `/auth/login`
- **Session management** — `app/layout.tsx` calls `supabase.auth.getUser()` on every render to refresh the session
- **Logout** — `lib/auth/actions.ts` exports `logout()` which signs out and redirects to `/auth/login`
- **Auth actions** — `lib/auth/actions.ts` has `login`, `signup`, and `logout` server actions using `createServerSupabaseClient`
- **AuthForm component** — `components/AuthForm.tsx` is a client component with loading/error/success state
- **OAuth callback** — `app/api/auth/callback/route.ts` handles the email verification code exchange

The feature is already fully scaffolded. No gaps to fill.
