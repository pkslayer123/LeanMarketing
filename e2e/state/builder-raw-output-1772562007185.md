All the requested authentication features are already fully implemented. Here's what exists:

| Gap | Status | File |
|-----|--------|------|
| `/auth/login` | **Done** | `app/auth/login/page.tsx` |
| `/auth/signup` | **Done** | `app/auth/signup/page.tsx` |
| Auth middleware | **Done** | `middleware.ts` |
| Session handling in layout | **Done** | `app/layout.tsx` |
| Logout action | **Done** | `lib/auth/actions.ts` → `logout()` |
| OAuth callback | **Done** | `app/api/auth/callback/route.ts` |
| Supabase clients | **Done** | `lib/supabaseClient.ts`, `lib/supabaseServer.ts` |

Nothing needs to be built. The entire auth system is in place:
- Login/signup pages use `AuthForm` with server actions
- Middleware redirects unauthenticated users to `/auth/login`, allowing only `/auth/*` paths through
- The root layout refreshes the session on every request via `supabase.auth.getUser()`
- The `logout()` server action signs out and redirects to `/auth/login`
