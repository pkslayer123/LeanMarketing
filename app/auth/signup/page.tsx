import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { signup } from "@/lib/auth/actions";

export default function SignupPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-white">Create Account</h1>
        <AuthForm mode="signup" action={signup} />
        <p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
          Already have an account?{" "}
          <Link href="/auth/login" className="text-indigo-600 hover:underline dark:text-indigo-400">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
