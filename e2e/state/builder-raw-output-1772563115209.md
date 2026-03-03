All the authentication features are already fully implemented. Here's a summary of what exists:

**Already complete — no gaps to fill:**

| File | Status |
|------|--------|
| `app/auth/login/page.tsx` | Login page with branding, form, signup link |
| `app/auth/signup/page.tsx` | Signup page with email verification flow |
| `lib/auth/actions.ts` | `login`, `signup`, `logout` server actions |
| `components/AuthForm.tsx` | Reusable client form with loading/error/success states |
| `middleware.ts` | Route protection, redirects unauthenticated users to `/auth/login` |
| `app/layout.tsx` | Session refresh on every page load (Supabase SSR pattern) |
| `app/api/auth/callback/route.ts` | OAuth code exchange handler |
| `lib/supabaseServer.ts` | Server-side Supabase client with cookie handling |
| `lib/supabaseClient.ts` | Browser-side Supabase client |

Every gap listed in the feature spec has already been addressed:
- `/auth/login` and `/auth/signup` routes exist
- Route protection via `middleware.ts` redirects unauthenticated users
- Session handling in `app/layout.tsx` via `supabase.auth.getUser()`
- Sign-out via the `logout()` server action with redirect to `/auth/login`

Nothing needs to be built.
