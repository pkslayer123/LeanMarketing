All auth feature gaps are already filled. Here's a summary of what exists and is functional:

| File | Status |
|------|--------|
| `app/auth/login/page.tsx` | Complete — renders `AuthForm` with `login` action |
| `app/auth/signup/page.tsx` | Complete — renders `AuthForm` with `signup` action |
| `app/api/auth/callback/route.ts` | Complete — exchanges OAuth code for session |
| `lib/auth/actions.ts` | Complete — `login`, `signup`, `logout` server actions |
| `components/AuthForm.tsx` | Complete — client form with loading/error/success states |
| `lib/supabaseServer.ts` | Complete — `createServerSupabaseClient` using `@supabase/ssr` |
| `middleware.ts` | Complete — redirects unauthenticated users to `/auth/login`, allows public auth paths |
| `app/layout.tsx` | Complete — calls `supabase.auth.getUser()` on every render to refresh session |

No code changes were needed — every gap listed in the spec was already implemented correctly. The auth system uses the standard `@supabase/ssr` pattern with `createServerClient` in both middleware and server components.
