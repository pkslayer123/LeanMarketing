import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { login } from "@/lib/auth/actions";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-6 dark:bg-gray-900">
      <div className="mb-8 text-center">
        <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
          LeanMarketing
        </h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          AI-assisted marketing governance for lean startups
        </p>
      </div>
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-md dark:border-gray-700 dark:bg-gray-800">
        <h1 className="mb-6 text-xl font-semibold text-gray-900 dark:text-white">Sign in to your account</h1>
        <AuthForm mode="login" action={login} />
        <p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
          Don&apos;t have an account?{" "}
          <Link href="/auth/signup" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
