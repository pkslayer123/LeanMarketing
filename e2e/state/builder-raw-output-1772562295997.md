All the authentication gaps are already filled. The codebase already has:

- **`app/auth/login/page.tsx`** — login page using `AuthForm`
- **`app/auth/signup/page.tsx`** — signup page using `AuthForm`
- **`app/api/auth/callback/route.ts`** — OAuth callback handler
- **`lib/auth/actions.ts`** — `login()`, `signup()`, `logout()` server actions
- **`middleware.ts`** — route protection, redirects unauthenticated users to `/auth/login`
- **`app/layout.tsx`** — Supabase session refresh on every load
- **`components/AuthForm.tsx`** — reusable client-side form with loading/error states

Nothing needs to be created. All requested features are implemented.
