All the requested authentication gaps are already implemented. Here's what exists:

| Gap | File | Status |
|-----|------|--------|
| `/auth/login` | `app/auth/login/page.tsx` | Done |
| `/auth/signup` | `app/auth/signup/page.tsx` | Done |
| Auth middleware | `middleware.ts` | Done |
| Session handling in layout | `app/layout.tsx` | Done |
| Sign-out action | `lib/auth/actions.ts` (logout) | Done |
| Server actions | `lib/auth/actions.ts` | Done |
| AuthForm component | `components/AuthForm.tsx` | Done |
| OAuth callback | `app/api/auth/callback/route.ts` | Done |
| Supabase clients | `lib/supabaseClient.ts`, `lib/supabaseServer.ts` | Done |

No code needs to be written — the feature is fully implemented.
