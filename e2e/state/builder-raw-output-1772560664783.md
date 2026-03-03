All the required files already exist and are fully implemented:

| File | Status |
|------|--------|
| `app/auth/login/page.tsx` | Complete — email/password login form |
| `app/auth/signup/page.tsx` | Complete — signup with email verification message |
| `app/api/auth/callback/route.ts` | Complete — OAuth code exchange handler |
| `lib/auth/actions.ts` | Complete — `login`, `signup`, `logout` server actions |
| `components/AuthForm.tsx` | Complete — client form with loading/error/success states |
| `lib/supabaseServer.ts` | Complete — `createServerSupabaseClient` using `@supabase/ssr` |
| `middleware.ts` | Complete — protects all routes, redirects unauthenticated users to `/auth/login` |
| `app/layout.tsx` | Complete — refreshes Supabase session on every page load |

Nothing is missing. The full auth system is already in place:

- `/auth/login` and `/auth/signup` routes exist with proper UI
- Middleware protects all non-auth routes and redirects to login
- Server actions handle sign-in, sign-up, and sign-out via `@supabase/ssr`
- The auth callback route handles email verification/OAuth flows
- The root layout refreshes the session on every render (the standard Supabase SSR pattern)
