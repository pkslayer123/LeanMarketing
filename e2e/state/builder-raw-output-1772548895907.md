All the requested authentication features are already fully implemented. Here's what exists:

| Gap | Status | File |
|-----|--------|------|
| `/auth/login` page | **Done** | `app/auth/login/page.tsx` |
| `/auth/signup` page | **Done** | `app/auth/signup/page.tsx` |
| Auth middleware | **Done** | `middleware.ts` |
| Session handling in layout | **Done** | `app/layout.tsx` |
| Sign-out action | **Done** | `lib/auth/actions.ts` — `logout()` |
| Auth server actions | **Done** | `lib/auth/actions.ts` — `login()`, `signup()` |
| OAuth callback | **Done** | `app/api/auth/callback/route.ts` |
| Shared AuthForm component | **Done** | `components/AuthForm.tsx` |

Nothing needs to be created. The full auth flow is in place using Supabase SSR with cookie-based sessions, server actions, and middleware-based route protection.
