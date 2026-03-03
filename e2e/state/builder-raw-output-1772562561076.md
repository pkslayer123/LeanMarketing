All the required pieces are already fully implemented:

| File | Status |
|------|--------|
| `app/auth/login/page.tsx` | Complete — email/password login UI |
| `app/auth/signup/page.tsx` | Complete — signup with email verification message |
| `app/api/auth/callback/route.ts` | Complete — OAuth/email confirmation callback |
| `lib/auth/actions.ts` | Complete — `login`, `signup`, `logout` server actions |
| `components/AuthForm.tsx` | Complete — client form with loading/error/success states |
| `lib/supabaseServer.ts` | Complete — `createServerSupabaseClient` utility |
| `middleware.ts` | Complete — route protection, redirect unauthenticated users |
| `app/layout.tsx` | Complete — session refresh on every page load |

Everything in the gap list is already covered:

- `/auth/login` and `/auth/signup` routes exist and render `AuthForm`
- Middleware protects all non-`/auth` routes and redirects to `/auth/login`
- `app/layout.tsx` calls `supabase.auth.getUser()` on every render (SSR session refresh)
- `logout()` server action signs out and redirects to `/auth/login`

No code needs to be written — the feature is complete.
