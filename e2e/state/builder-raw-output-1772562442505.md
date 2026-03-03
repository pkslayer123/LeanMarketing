All the authentication gaps are already implemented. Here's what exists:

| Gap | Status | File |
|-----|--------|------|
| `/auth/login` | Done | `app/auth/login/page.tsx` |
| `/auth/signup` | Done | `app/auth/signup/page.tsx` |
| Auth middleware | Done | `middleware.ts` |
| Session handling in layout | Done | `app/layout.tsx` |
| Sign-out action | Done | `lib/auth/actions.ts` → `logout()` |
| Supabase clients | Done | `lib/supabaseClient.ts`, `lib/supabaseServer.ts` |
| OAuth callback | Done | `app/api/auth/callback/route.ts` |

The full authentication system is already in place — login/signup pages with `AuthForm`, server actions for login/signup/logout, middleware protecting all non-auth routes, session refresh in the root layout, and a Supabase SSR setup with proper cookie handling.

There is nothing to build here.
