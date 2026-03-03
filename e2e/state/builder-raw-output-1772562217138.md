All the authentication features are already fully implemented. Nothing needs to be created. Here's what exists:

| File | Status |
|------|--------|
| `app/auth/login/page.tsx` | Complete — email/password login with `AuthForm` |
| `app/auth/signup/page.tsx` | Complete — registration with email verification flow |
| `app/api/auth/callback/route.ts` | Complete — OAuth/SSO callback handler |
| `lib/auth/actions.ts` | Complete — `login`, `signup`, `logout` server actions |
| `components/AuthForm.tsx` | Complete — reusable form with loading/error states |
| `middleware.ts` | Complete — protects all routes, redirects to `/auth/login` |
| `app/layout.tsx` | Complete — Supabase session refresh on every render |

All the specific gaps listed in the task are already filled:
- `/auth/login` and `/auth/signup` routes exist
- Route protection via middleware is in place
- Supabase session handling in layout is done
- Sign-out action (`logout()`) redirects to `/auth/login`

No changes needed.
