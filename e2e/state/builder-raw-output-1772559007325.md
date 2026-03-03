All the specified gaps are already fully implemented. Here's the status:

| Gap | Status | File |
|-----|--------|------|
| `/auth/login` | **Done** | `app/auth/login/page.tsx` |
| `/auth/signup` | **Done** | `app/auth/signup/page.tsx` |
| Route protection middleware | **Done** | `middleware.ts` |
| Supabase session handling in layout | **Done** | `app/layout.tsx` |
| Sign-out action and redirect | **Done** | `lib/auth/actions.ts` (`logout()`) |
| `AuthForm` component | **Done** | `components/AuthForm.tsx` |
| Server actions (login/signup/logout) | **Done** | `lib/auth/actions.ts` |
| OAuth callback handler | **Done** | `app/api/auth/callback/route.ts` |

Every gap listed in the feature spec has already been built. No code needs to be written.
