Everything is already fully implemented. Here's what exists and is complete:

| File | Status |
|------|--------|
| `app/auth/login/page.tsx` | Complete — login UI using `AuthForm` + `login` action |
| `app/auth/signup/page.tsx` | Complete — signup UI using `AuthForm` + `signup` action |
| `app/api/auth/callback/route.ts` | Complete — exchanges OAuth code for session |
| `lib/auth/actions.ts` | Complete — `login`, `signup`, `logout` server actions |
| `components/AuthForm.tsx` | Complete — client component with loading/error/success state |
| `lib/supabaseServer.ts` | Complete — `createServerSupabaseClient` using `@supabase/ssr` |
| `lib/supabaseClient.ts` | Complete — `createClient` browser client |
| `middleware.ts` | Complete — protects all routes, redirects unauthenticated users to `/auth/login` |
| `app/layout.tsx` | Complete — refreshes session on every page load |

All five gaps listed in the spec are already covered:

- `/auth/login` and `/auth/signup` routes exist and render correctly
- Route protection is handled by `middleware.ts` using `supabase.auth.getUser()`
- Session handling is in `app/layout.tsx` (calls `getUser()` on every render)
- Sign-out is implemented as the `logout()` server action in `lib/auth/actions.ts`

No code needs to be written. The feature is complete.
