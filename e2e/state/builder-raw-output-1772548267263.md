```ts lib/auth/supabase.ts
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
```

```ts lib/auth/server.ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createServerSupabaseClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // setAll called from Server Component — safe to ignore
          }
        },
      },
    }
  )
}
```

```tsx components/AuthForm.tsx
'use client'

import { useState, FormEvent } from 'react'

interface AuthFormProps {
  mode: 'login' | 'signup'
  onSubmit: (email: string, password: string) => Promise<{ error?: string }>
}

export default function AuthForm({ mode, onSubmit }: AuthFormProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    setLoading(true)

    const result = await onSubmit(email, password)

    if (result.error) {
      setError(result.error)
    } else if (mode === 'signup') {
      setMessage('Check your email to confirm your account.')
    }

    setLoading(false)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="••••••••"
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {message && (
        <p className="text-sm text-green-600 bg-green-50 border border-green-200 rounded-md px-3 py-2">
          {message}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
      </button>
    </form>
  )
}
```

```tsx app/auth/login/page.tsx
'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import AuthForm from '@/components/AuthForm'
import { createClient } from '@/lib/auth/supabase'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()

  async function handleLogin(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { error: error.message }
    router.push('/')
    router.refresh()
    return {}
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Sign in</h1>
          <p className="text-sm text-gray-500 mb-6">
            Welcome back — enter your credentials to continue.
          </p>

          <AuthForm mode="login" onSubmit={handleLogin} />

          <p className="mt-4 text-sm text-center text-gray-500">
            Don&apos;t have an account?{' '}
            <Link href="/auth/signup" className="text-blue-600 hover:underline font-medium">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
```

```tsx app/auth/signup/page.tsx
'use client'

import Link from 'next/link'
import AuthForm from '@/components/AuthForm'
import { createClient } from '@/lib/auth/supabase'

export default function SignupPage() {
  const supabase = createClient()

  async function handleSignup(email: string, password: string) {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) return { error: error.message }
    return {}
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Create account</h1>
          <p className="text-sm text-gray-500 mb-6">
            Sign up to get started. We&apos;ll send a confirmation email.
          </p>

          <AuthForm mode="signup" onSubmit={handleSignup} />

          <p className="mt-4 text-sm text-center text-gray-500">
            Already have an account?{' '}
            <Link href="/auth/login" className="text-blue-600 hover:underline font-medium">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
```

```ts app/auth/callback/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: (cookiesToSet) => {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          },
        },
      }
    )

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  return NextResponse.redirect(`${origin}/auth/login?error=confirmation_failed`)
}
```

```ts app/api/auth/signout/route.ts
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/auth/server'

export async function POST() {
  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/auth/login', process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'))
}
```

```ts middleware.ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const PUBLIC_PATHS = ['/auth/login', '/auth/signup', '/auth/callback']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow public paths through without auth check
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const loginUrl = new URL('/auth/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/auth/callback).*)',
  ],
}
```

---

All 8 files are ready. Here's a summary of what was created:

| File | Purpose |
|------|---------|
| `lib/auth/supabase.ts` | Browser Supabase client (for Client Components) |
| `lib/auth/server.ts` | Server Supabase client (for Server Components / API routes) |
| `components/AuthForm.tsx` | Reusable email/password form with error/success states |
| `app/auth/login/page.tsx` | `/auth/login` — signs in and redirects to `/` |
| `app/auth/signup/page.tsx` | `/auth/signup` — registers and prompts email confirmation |
| `app/auth/callback/route.ts` | Handles Supabase email confirmation redirect |
| `app/api/auth/signout/route.ts` | POST endpoint to sign out and redirect |
| `middleware.ts` | Protects all routes except `/auth/*`, redirects unauthenticated users |

**Logout usage** — add a form anywhere in the app pointing to the signout route:
```tsx
<form action="/api/auth/signout" method="POST">
  <button type="submit">Sign out</button>
</form>
```
