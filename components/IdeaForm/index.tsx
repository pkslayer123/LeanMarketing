"use client";

import { useState } from "react";
import type { Idea, IdeaInput, QualityGateFeedback } from "@/lib/ideas";

interface IdeaFormProps {
  projectId: string;
  existing?: Idea | null;
}

const INPUT_CLASS =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white";

const LABEL_CLASS = "block text-sm font-medium text-gray-700 dark:text-gray-300";

export default function IdeaForm({ projectId, existing }: IdeaFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [gateFeedback, setGateFeedback] = useState<QualityGateFeedback | null>(
    existing?.quality_gate_feedback ?? null
  );

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);

    const form = e.currentTarget;
    const body: IdeaInput = {
      project_id: projectId,
      description: (form.elements.namedItem("description") as HTMLTextAreaElement).value,
      audience: (form.elements.namedItem("audience") as HTMLInputElement).value,
      problem: (form.elements.namedItem("problem") as HTMLTextAreaElement).value,
      payment_assumption: (form.elements.namedItem("payment_assumption") as HTMLTextAreaElement).value,
      next_step: (form.elements.namedItem("next_step") as HTMLInputElement).value,
    };

    const res = await fetch("/api/ideas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await res.json();

    if (!res.ok) {
      setError(json.error ?? "Failed to save idea.");
    } else {
      setGateFeedback(json.quality_gate_feedback);
      setSaved(true);
    }

    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label htmlFor="description" className={LABEL_CLASS}>
          One-sentence description <span className="text-red-500">*</span>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Summarise your idea in a single sentence.
        </p>
        <textarea
          id="description"
          name="description"
          required
          rows={2}
          defaultValue={existing?.description ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label htmlFor="audience" className={LABEL_CLASS}>
          Target audience <span className="text-red-500">*</span>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Who specifically will use or buy this?
        </p>
        <input
          id="audience"
          name="audience"
          type="text"
          required
          defaultValue={existing?.audience ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label htmlFor="problem" className={LABEL_CLASS}>
          Problem being solved <span className="text-red-500">*</span>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          What pain or friction does your idea remove?
        </p>
        <textarea
          id="problem"
          name="problem"
          required
          rows={3}
          defaultValue={existing?.problem ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label htmlFor="payment_assumption" className={LABEL_CLASS}>
          Payment assumption <span className="text-red-500">*</span>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          What must be true for someone to pay for this?
        </p>
        <textarea
          id="payment_assumption"
          name="payment_assumption"
          required
          rows={3}
          defaultValue={existing?.payment_assumption ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label htmlFor="next_step" className={LABEL_CLASS}>
          Smallest next step <span className="text-red-500">*</span>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          What is the single smallest action after getting a reply?
        </p>
        <input
          id="next_step"
          name="next_step"
          type="text"
          required
          defaultValue={existing?.next_step ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {saved && (
        <p className="text-sm text-green-600 dark:text-green-400">Idea saved.</p>
      )}

      {gateFeedback && (
        <div className="rounded-md border p-4 space-y-2 dark:border-gray-600">
          <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Quality Gate:{" "}
            {gateFeedback.overall_passed ? (
              <span className="text-green-600 dark:text-green-400">Passed</span>
            ) : (
              <span className="text-red-600 dark:text-red-400">Needs work</span>
            )}
          </p>
          <ul className="space-y-1">
            {gateFeedback.checks.map((check) => (
              <li key={check.label} className="flex items-start gap-2 text-sm">
                <span className={check.passed ? "text-green-500" : "text-red-500"}>
                  {check.passed ? "✓" : "✗"}
                </span>
                <span className="text-gray-600 dark:text-gray-400">
                  <span className="font-medium">{check.label}:</span> {check.feedback}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
      >
        {loading ? "Saving..." : "Save Idea"}
      </button>
    </form>
  );
}
