All the required pieces are already in place and fully implemented:

| Gap | Status |
|-----|--------|
| `/auth/login` | `app/auth/login/page.tsx` — complete |
| `/auth/signup` | `app/auth/signup/page.tsx` — complete |
| Auth middleware | `middleware.ts` — protects all routes, redirects to `/auth/login` |
| Session management | `app/layout.tsx` calls `supabase.auth.getUser()` on every page load |
| Sign-out action | `lib/auth/actions.ts` exports `logout()` which signs out and redirects |
| `AuthForm` component | `components/AuthForm.tsx` — client component with loading/error states |
| Server Supabase client | `lib/supabaseServer.ts` — `createServerSupabaseClient()` using `@supabase/ssr` |
| Auth callback | `app/api/auth/callback/route.ts` — handles email confirmation flow |

Everything is already built and correct. No files need to be created or modified.
