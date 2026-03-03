"use client";

import { useState } from "react";
import type { LandingPage, LandingPageInput } from "@/lib/proof";

interface LandingPageFormProps {
  projectId: string;
  existing?: LandingPage | null;
}

export default function LandingPageForm({
  projectId,
  existing,
}: LandingPageFormProps) {
  const [form, setForm] = useState<LandingPageInput>({
    project_id: projectId,
    problem_statement: existing?.problem_statement ?? "",
    outcome_description: existing?.outcome_description ?? "",
    call_to_action: existing?.call_to_action ?? "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);

  const handleChange = (
    field: keyof Omit<LandingPageInput, "project_id">,
    value: string
  ) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/proof/landing-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to save landing page");
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const hasContent =
    form.problem_statement && form.outcome_description && form.call_to_action;

  return (
    <div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Problem Statement
          </label>
          <textarea
            rows={2}
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="What problem does your prospect face?"
            value={form.problem_statement}
            onChange={(e) => handleChange("problem_statement", e.target.value)}
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Outcome Description
          </label>
          <textarea
            rows={2}
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="What specific result will they get?"
            value={form.outcome_description}
            onChange={(e) => handleChange("outcome_description", e.target.value)}
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Call to Action
          </label>
          <input
            type="text"
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="e.g. Schedule a 15-minute call"
            value={form.call_to_action}
            onChange={(e) => handleChange("call_to_action", e.target.value)}
            required
          />
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {loading ? "Saving…" : saved ? "Saved ✓" : "Save Landing Page"}
          </button>
          {(existing || saved) && hasContent && (
            <button
              type="button"
              onClick={() => setPreview((p) => !p)}
              className="rounded-md border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {preview ? "Hide Preview" : "Preview"}
            </button>
          )}
        </div>
      </form>

      {/* Landing page preview */}
      {preview && hasContent && (
        <div className="mt-6 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="bg-gray-100 dark:bg-gray-700 px-4 py-2 flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium">
              Preview
            </span>
          </div>
          <div className="p-8 bg-white dark:bg-gray-900 text-center space-y-6">
            <div className="space-y-3">
              <p className="text-sm text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                The Problem
              </p>
              <p className="text-gray-800 dark:text-gray-200">
                {form.problem_statement}
              </p>
            </div>
            <div className="space-y-3">
              <p className="text-sm text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                The Result You Get
              </p>
              <p className="text-lg font-medium text-gray-900 dark:text-white">
                {form.outcome_description}
              </p>
            </div>
            <button
              type="button"
              className="rounded-md bg-green-600 px-8 py-3 text-sm font-medium text-white"
            >
              {form.call_to_action}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
