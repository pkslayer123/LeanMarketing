import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { login } from "@/lib/auth/actions";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-white">Sign In</h1>
        <AuthForm mode="login" action={login} />
        <p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
          Don&apos;t have an account?{" "}
          <Link href="/auth/signup" className="text-indigo-600 hover:underline dark:text-indigo-400">
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
