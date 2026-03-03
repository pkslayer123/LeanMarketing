import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { signup } from "@/lib/auth/actions";

const FUNNEL_LAYERS = [
  { label: "Layer 1", name: "Idea Definition", color: "bg-indigo-500" },
  { label: "Layer 2", name: "Audience & Outreach", color: "bg-indigo-400" },
  { label: "Layer 3", name: "Conversations", color: "bg-indigo-300" },
  { label: "Layer 4", name: "Proof & Demonstration", color: "bg-violet-400" },
  { label: "Layer 5", name: "Paid Conversion", color: "bg-violet-500" },
  { label: "Layer 6", name: "Review & Adjustment", color: "bg-violet-600" },
];

const BENEFITS = [
  "Validate marketing ideas before spending budget",
  "AI persona tests that simulate real audience reactions",
  "Convergence tracking across all 6 funnel layers",
  "Automated fix suggestions when campaigns underperform",
];

export default function SignupPage() {
  return (
    <main className="flex min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Left panel — funnel visualization (desktop only) */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between bg-gray-900 dark:bg-gray-950 px-12 py-16">
        <div>
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
            <span className="text-lg font-bold text-white">LeanMarketing</span>
          </div>
          <p className="mt-3 text-sm text-gray-400">
            Your marketing funnel — validated at every layer
          </p>
        </div>

        {/* Funnel visualization */}
        <div className="space-y-4">
          <h2 className="text-2xl font-bold text-white">
            The 6-Layer Validation Funnel
          </h2>
          <div className="space-y-1.5">
            {FUNNEL_LAYERS.map((layer, i) => (
              <div
                key={layer.label}
                className="flex items-center gap-3 rounded-md px-3 py-2 bg-white/5"
                style={{ marginLeft: `${i * 8}px`, marginRight: `${i * 8}px` }}
              >
                <div className={`h-2 w-2 rounded-full ${layer.color}`} />
                <span className="text-xs font-medium text-gray-400">
                  {layer.label}
                </span>
                <span className="text-sm text-white">{layer.name}</span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-gray-400">
            Each layer gates the next. Campaigns only advance when they pass AI
            persona tests — keeping your budget focused on what works.
          </p>
        </div>

        {/* Benefit list */}
        <ul className="space-y-3">
          {BENEFITS.map((b) => (
            <li key={b} className="flex items-start gap-2 text-sm text-gray-300">
              <svg
                className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                  clipRule="evenodd"
                />
              </svg>
              {b}
            </li>
          ))}
        </ul>
      </div>

      {/* Right panel — signup form */}
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
              Create your account
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Free to start. No credit card required.
            </p>
          </div>

          <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <AuthForm mode="signup" action={signup} />

            <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
              Password must be at least 6 characters.
            </p>
          </div>

          {/* Email verification notice */}
          <div className="mt-4 rounded-md border border-indigo-100 bg-indigo-50 px-4 py-3 dark:border-indigo-900 dark:bg-indigo-950">
            <div className="flex gap-2">
              <svg
                className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"
                />
              </svg>
              <p className="text-xs text-indigo-700 dark:text-indigo-300">
                After signing up, check your inbox for a confirmation email to
                activate your account.
              </p>
            </div>
          </div>

          <p className="mt-6 text-center text-sm text-gray-600 dark:text-gray-400">
            Already have an account?{" "}
            <Link
              href="/auth/login"
              className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Sign in
            </Link>
          </p>

          <p className="mt-4 text-center text-xs text-gray-400 dark:text-gray-500">
            By creating an account, you agree to our{" "}
            <Link href="/terms" className="underline hover:text-gray-600 dark:hover:text-gray-300">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline hover:text-gray-600 dark:hover:text-gray-300">
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </div>
    </main>
  );
}
