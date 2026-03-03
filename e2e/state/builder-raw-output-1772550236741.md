All the requested authentication features are already fully implemented. Here's what exists:

| Gap | File | Status |
|-----|------|--------|
| `/auth/login` | `app/auth/login/page.tsx` | Complete |
| `/auth/signup` | `app/auth/signup/page.tsx` | Complete |
| Route protection middleware | `middleware.ts` | Complete |
| Session handling in layout | `app/layout.tsx` | Complete |
| Sign-out action | `lib/auth/actions.ts` → `logout()` | Complete |
| Auth form component | `components/AuthForm.tsx` | Complete |
| Server actions (login/signup) | `lib/auth/actions.ts` | Complete |
| OAuth callback | `app/api/auth/callback/route.ts` | Complete |
| Supabase clients (SSR) | `lib/supabaseClient.ts`, `lib/supabaseServer.ts` | Complete |

Nothing needs to be created — all gaps listed in the spec are already filled with correct implementations using `@supabase/ssr`, server actions, and the Next.js App Router pattern.
