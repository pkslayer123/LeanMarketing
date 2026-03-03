All the required pieces are already fully implemented:

| Gap | Status |
|-----|--------|
| `/auth/login` | `app/auth/login/page.tsx` — complete |
| `/auth/signup` | `app/auth/signup/page.tsx` — complete |
| Auth middleware | `middleware.ts` — protects routes, redirects unauthenticated users |
| Session management in layout | `app/layout.tsx` — calls `supabase.auth.getUser()` on every load |
| Sign-out action | `lib/auth/actions.ts` — `logout()` signs out and redirects to `/auth/login` |
| Auth callback | `app/api/auth/callback/route.ts` — exchanges code for session |
| `createServerSupabaseClient` | `lib/supabaseServer.ts` — complete |
| `AuthForm` component | `components/AuthForm.tsx` — complete with loading/error states |

Nothing is missing. The entire authentication feature is already in place and correctly wired together. No changes needed.
