"use client";

import { useState } from "react";

interface AuthFormProps {
  mode: "login" | "signup";
  action: (formData: FormData) => Promise<{ error?: string; success?: string } | undefined>;
}

export default function AuthForm({ mode, action }: AuthFormProps) {
  const [message, setMessage] = useState<{ error?: string; success?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setMessage(null);
    const result = await action(formData);
    if (result) setMessage(result);
    setLoading(false);
  }

  return (
    <form action={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={6}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        />
      </div>

      {message?.error && (
        <p className="text-sm text-red-600 dark:text-red-400">{message.error}</p>
      )}
      {message?.success && (
        <p className="text-sm text-green-600 dark:text-green-400">{message.success}</p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
      >
        {loading ? "Loading..." : mode === "login" ? "Sign In" : "Sign Up"}
      </button>
    </form>
  );
}
