All the requested gaps are already fully implemented. Here's a summary of what exists:

| Gap | File | Status |
|-----|------|--------|
| `/auth/login` | `app/auth/login/page.tsx` | Complete — email/password login via Supabase Auth |
| `/auth/signup` | `app/auth/signup/page.tsx` | Complete — registration with email verification |
| Auth middleware | `middleware.ts` | Complete — protects all routes, redirects to `/auth/login` |
| Session management | `app/layout.tsx` | Complete — refreshes Supabase session on every request |
| Logout action | `lib/auth/actions.ts` | Complete — `logout()` signs out and redirects |
| AuthForm component | `components/AuthForm.tsx` | Complete — handles both login and signup modes |
| OAuth callback | `app/api/auth/callback/route.ts` | Complete — exchanges code for session |
| Server client | `lib/supabaseServer.ts` | Complete — `createServerSupabaseClient()` helper |

Nothing is missing. The feature is fully built and functional — no changes needed.
