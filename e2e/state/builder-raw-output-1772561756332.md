All the listed gaps are already implemented. Here's what exists:

| Gap | Status | File |
|-----|--------|------|
| `/auth/login` | Done | `app/auth/login/page.tsx` |
| `/auth/signup` | Done | `app/auth/signup/page.tsx` |
| Auth middleware | Done | `middleware.ts` |
| Session handling in layout | Done | `app/layout.tsx` |
| Sign-out action | Done | `lib/auth/actions.ts` → `logout()` |
| OAuth callback | Done | `app/api/auth/callback/route.ts` |

The full authentication system is already in place:

- **Login/Signup pages** use `AuthForm` component with server actions
- **Middleware** protects all routes, redirecting unauthenticated users to `/auth/login`
- **Layout** calls `getUser()` on every render to keep the session fresh
- **Actions** (`login`, `signup`, `logout`) handle Supabase auth and redirects
- **Supabase clients** (`lib/supabaseClient.ts`, `lib/supabaseServer.ts`) are configured with `@supabase/ssr`

No code needs to be written — everything is already implemented.
