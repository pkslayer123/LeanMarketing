All the authentication gaps are already filled. Here's what exists:

| Gap | Status | Location |
|-----|--------|----------|
| `/auth/login` page | Done | `app/auth/login/page.tsx` |
| `/auth/signup` page | Done | `app/auth/signup/page.tsx` |
| Auth middleware | Done | `middleware.ts` |
| Session handling in layout | Done | `app/layout.tsx` |
| Sign-out action | Done | `lib/auth/actions.ts` |
| OAuth callback | Done | `app/api/auth/callback/route.ts` |
| Supabase clients | Done | `lib/supabaseServer.ts`, `lib/supabaseClient.ts` |

The full auth flow is implemented:
1. Unauthenticated users hit middleware → redirected to `/auth/login`
2. Login/signup via `AuthForm` component → server actions in `lib/auth/actions.ts`
3. Email confirmation via `/api/auth/callback` route
4. Logout redirects to `/auth/login`

Nothing to build — this feature area is complete.
