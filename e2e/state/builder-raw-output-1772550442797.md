All the specified gaps are already fully implemented. Here's what exists:

| Gap | Status |
|-----|--------|
| `/auth/login` | `app/auth/login/page.tsx` — complete with AuthForm |
| `/auth/signup` | `app/auth/signup/page.tsx` — complete with AuthForm |
| Route protection middleware | `middleware.ts` — redirects unauthenticated users to `/auth/login` |
| Supabase session handling in layout | `app/layout.tsx` — calls `supabase.auth.getUser()` on every load |
| Sign-out action + redirect | `lib/auth/actions.ts` — `logout()` signs out and redirects to `/auth/login` |

Supporting files are also in place: `lib/supabaseServer.ts`, `lib/supabaseClient.ts`, `components/AuthForm.tsx`, and `app/api/auth/callback/route.ts`.

No code needs to be written — the feature is complete.
