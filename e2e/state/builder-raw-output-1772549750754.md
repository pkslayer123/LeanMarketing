All the requested features are already fully implemented. Here's what exists:

| Gap | File | Status |
|-----|------|--------|
| `/auth/login` | `app/auth/login/page.tsx` | Exists |
| `/auth/signup` | `app/auth/signup/page.tsx` | Exists |
| Auth middleware | `middleware.ts` | Exists — protects all non-public routes |
| Session handling in layout | `app/layout.tsx` | Exists — refreshes session on every render |
| Sign-out action | `lib/auth/actions.ts` (`logout`) | Exists — redirects to `/auth/login` |
| Auth form component | `components/AuthForm.tsx` | Exists |
| Server actions | `lib/auth/actions.ts` | Exists — `login`, `signup`, `logout` |
| OAuth callback | `app/api/auth/callback/route.ts` | Exists |
| Supabase clients | `lib/supabaseClient.ts`, `lib/supabaseServer.ts` | Exist |

There is nothing to create. The entire authentication system — routes, middleware, session management, form UI, server actions, and the email confirmation callback — is already in place and follows the correct `@supabase/ssr` pattern.
