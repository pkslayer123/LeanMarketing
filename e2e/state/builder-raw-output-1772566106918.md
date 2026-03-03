All gaps are already filled. Here's a summary of what exists:

| Gap | Status | File |
|-----|--------|------|
| `/auth/login` — email/password login | **Done** | `app/auth/login/page.tsx` |
| `/auth/signup` — registration with email verification | **Done** | `app/auth/signup/page.tsx` |
| Auth middleware — route protection | **Done** | `middleware.ts` |
| Supabase session handling in layout | **Done** | `app/layout.tsx` |
| Sign-out action and redirect | **Done** | `lib/auth/actions.ts` (`logout()`) |
| OAuth callback handler | **Done** | `app/api/auth/callback/route.ts` |
| Shared form component | **Done** | `components/AuthForm.tsx` |

The implementation uses the correct `@supabase/ssr` pattern with `createServerClient`/`createBrowserClient`, server actions for login/signup/logout, and middleware that protects all routes except `/auth/login` and `/auth/signup`. No code needs to be written.
