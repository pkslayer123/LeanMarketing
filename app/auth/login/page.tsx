import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { login } from "@/lib/auth/actions";

interface LoginPageProps {
  searchParams: Promise<{ error?: string; message?: string }>;
}

const FEATURES = [
  {
    title: "6-Layer Validation Funnel",
    description:
      "Guide every campaign from idea through proof — so nothing ships without evidence.",
  },
  {
    title: "AI Persona Testing",
    description:
      "Simulate real audience reactions before you spend a dollar on distribution.",
  },
  {
    title: "Convergence Tracking",
    description:
      "Know exactly where your marketing stands and what needs to move next.",
  },
];

const ERROR_MESSAGES: Record<string, string> = {
  auth_callback_failed: "Authentication failed. Please try signing in again.",
  session_expired: "Your session has expired. Please sign in again.",
  unauthorized: "You must be signed in to access that page.",
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const errorKey = params.error;
  const successMessage = params.message;
  const callbackError = errorKey ? (ERROR_MESSAGES[errorKey] ?? "An unexpected error occurred.") : null;

  return (
    <main className="flex min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Left panel — feature highlights (desktop only) */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between bg-indigo-600 px-12 py-16">
        <div>
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-md bg-white/20 flex items-center justify-center">
              <svg
                className="h-5 w-5 text-white"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
                />
              </svg>
            </div>
            <span className="text-lg font-bold text-white">LeanMarketing</span>
          </div>
          <p className="mt-3 text-sm text-indigo-200">
            AI-assisted marketing governance for lean startups
          </p>
        </div>

        <div className="space-y-8">
          <h2 className="text-3xl font-bold text-white leading-snug">
            Stop guessing. Start validating your marketing.
          </h2>
          <ul className="space-y-6">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-3">
                <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20">
                  <svg
                    className="h-3 w-3 text-white"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{f.title}</p>
                  <p className="mt-0.5 text-sm text-indigo-200">{f.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-indigo-300">
          &copy; {new Date().getFullYear()} LeanMarketing. Built for founders who move fast.
        </p>
      </div>

      {/* Right panel — login form */}
      <div className="flex flex-1 flex-col justify-center px-6 py-12 lg:px-16">
        {/* Mobile logo */}
        <div className="mb-8 flex flex-col items-center lg:hidden">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-md bg-indigo-600 flex items-center justify-center">
              <svg
                className="h-5 w-5 text-white"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
                />
              </svg>
            </div>
            <span className="text-xl font-bold text-gray-900 dark:text-white">
              LeanMarketing
            </span>
          </div>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            AI-assisted marketing governance
          </p>
        </div>

        <div className="mx-auto w-full max-w-sm">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
              Sign in to your account
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Welcome back — let&apos;s pick up where you left off.
            </p>
          </div>

          {/* URL-param error (e.g. from auth callback) */}
          {callbackError && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-950">
              <p className="text-sm text-red-700 dark:text-red-400">{callbackError}</p>
            </div>
          )}

          {/* Success message (e.g. after email verified) */}
          {successMessage && (
            <div className="mt-4 rounded-md border border-green-200 bg-green-50 px-4 py-3 dark:border-green-800 dark:bg-green-950">
              <p className="text-sm text-green-700 dark:text-green-400">{successMessage}</p>
            </div>
          )}

          <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <AuthForm mode="login" action={login} />

            <div className="mt-4 text-right">
              <Link
                href="/auth/forgot-password"
                className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Forgot your password?
              </Link>
            </div>
          </div>

          <p className="mt-6 text-center text-sm text-gray-600 dark:text-gray-400">
            Don&apos;t have an account?{" "}
            <Link
              href="/auth/signup"
              className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Sign up for free
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
