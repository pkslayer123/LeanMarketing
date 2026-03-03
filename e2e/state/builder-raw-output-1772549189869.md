All the gaps are already implemented. Here's a summary of what exists and covers each gap:

| Gap | File | Status |
|-----|------|--------|
| `/auth/login` | `app/auth/login/page.tsx` | Complete — email/password login via `AuthForm` + server action |
| `/auth/signup` | `app/auth/signup/page.tsx` | Complete — registration with email verification message |
| Auth middleware | `middleware.ts` | Complete — protects all routes, redirects unauthenticated users to `/auth/login` |
| Session handling in layout | `app/layout.tsx` | Complete — calls `supabase.auth.getUser()` on every page load to refresh session |
| Sign-out action | `lib/auth/actions.ts:34` | Complete — `logout()` signs out and redirects to `/auth/login` |
| Auth form component | `components/AuthForm.tsx` | Complete — client component with loading/error/success states |
| Server Supabase client | `lib/supabaseServer.ts` | Complete — `createServerClient` with cookie handling |
| Auth callback route | `app/api/auth/callback/route.ts` | Complete — exchanges code for session after email verification |

The authentication and user management feature is fully implemented with no gaps remaining.
