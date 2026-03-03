All the listed gaps are already fully implemented. Here's a summary of what exists:

| Gap | Status | File |
|-----|--------|------|
| `/auth/login` | Done | `app/auth/login/page.tsx` |
| `/auth/signup` | Done | `app/auth/signup/page.tsx` |
| Auth middleware | Done | `middleware.ts` |
| Session handling in layout | Done | `app/layout.tsx` |
| Sign-out action | Done | `lib/auth/actions.ts` — `logout()` |
| OAuth callback | Done | `app/api/auth/callback/route.ts` |

The implementation is complete and correct:
- Uses `@supabase/ssr` with `createServerClient`/`createBrowserClient` as required
- Middleware protects all routes, allows `/auth/*` as public paths
- `AuthForm.tsx` is a client component with loading/error/success state
- Server actions handle login, signup, and logout with proper redirects
- Layout refreshes the session on every page load via `supabase.auth.getUser()`

No changes needed — the feature is already built.
