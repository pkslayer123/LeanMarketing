All the authentication gaps listed in the spec are already implemented. Here's the status:

| Gap | File | Status |
|-----|------|--------|
| `/auth/login` page | `app/auth/login/page.tsx` | Done |
| `/auth/signup` page | `app/auth/signup/page.tsx` | Done |
| Auth middleware | `middleware.ts` | Done |
| Session handling in layout | `app/layout.tsx` | Done |
| Logout action | `lib/auth/actions.ts` | Done |
| AuthForm component | `components/AuthForm.tsx` | Done |
| Supabase server client | `lib/supabaseServer.ts` | Done |
| OAuth callback route | `app/api/auth/callback/route.ts` | Done |

All pieces are in place:
- Login/signup pages use `AuthForm` with server actions
- Middleware redirects unauthenticated users to `/auth/login` (excluding `/auth/*` and static assets)
- `app/layout.tsx` refreshes the session on every page load via `supabase.auth.getUser()`
- `logout()` in `lib/auth/actions.ts` signs out and redirects to `/auth/login`

No code needs to be written — the feature is fully implemented.
