All the requested authentication features are already fully implemented. Here's what exists:

| Gap | File | Status |
|-----|------|--------|
| `/auth/login` | `app/auth/login/page.tsx` | Done |
| `/auth/signup` | `app/auth/signup/page.tsx` | Done |
| Auth middleware | `middleware.ts` | Done |
| Session handling in layout | `app/layout.tsx` | Done |
| Sign-out action | `lib/auth/actions.ts` (logout) | Done |
| Auth callback | `app/api/auth/callback/route.ts` | Done |

The implementation is complete and correctly uses:
- `@supabase/ssr` with `createBrowserClient`/`createServerClient`
- Server Actions for login, signup, and logout
- Middleware protecting all non-`/auth/*` routes with redirect to `/auth/login`
- Session refresh on every page load via `layout.tsx`

No code needs to be written. The feature is already in place.
