All the requested auth features are already fully implemented. Here's what exists:

| Gap | Status | File |
|-----|--------|------|
| `/auth/login` | **Done** | `app/auth/login/page.tsx` |
| `/auth/signup` | **Done** | `app/auth/signup/page.tsx` |
| Route protection | **Done** | `middleware.ts` |
| Session handling in layout | **Done** | `app/layout.tsx` |
| Logout action | **Done** | `lib/auth/actions.ts` (`logout()`) |
| Auth callback | **Done** | `app/api/auth/callback/route.ts` |
| AuthForm component | **Done** | `components/AuthForm.tsx` |

Everything is wired up correctly using `@supabase/ssr` patterns — server actions for login/signup/logout, middleware redirecting unauthenticated users to `/auth/login`, session refresh in the root layout, and an OAuth callback handler. No gaps remain to fill.
