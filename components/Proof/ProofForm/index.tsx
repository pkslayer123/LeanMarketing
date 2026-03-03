"use client";

import { useState } from "react";
import {
  PROOF_TYPE_LABELS,
  PROOF_TYPE_DESCRIPTIONS,
  type Proof,
  type ProofInput,
  type ProofType,
  type QualityGateFeedback,
} from "@/lib/proof";

interface ProofFormProps {
  projectId: string;
  existing?: Proof | null;
}

const PROOF_TYPES: ProofType[] = ["summary", "demo", "trial"];

const INPUT_CLASS =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white";

const LABEL_CLASS = "block text-sm font-medium text-gray-700 dark:text-gray-300";

export default function ProofForm({ projectId, existing }: ProofFormProps) {
  const [proofType, setProofType] = useState<ProofType>(existing?.proof_type ?? "summary");
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
    const body: ProofInput = {
      project_id: projectId,
      proof_type: proofType,
      title: (form.elements.namedItem("title") as HTMLInputElement).value,
      outcome_description: (form.elements.namedItem("outcome_description") as HTMLTextAreaElement).value,
      proof_url: (form.elements.namedItem("proof_url") as HTMLInputElement).value || undefined,
      content: (form.elements.namedItem("content") as HTMLTextAreaElement).value || undefined,
      consumption_time_minutes: Number((form.elements.namedItem("consumption_time_minutes") as HTMLInputElement).value),
      decision_request: (form.elements.namedItem("decision_request") as HTMLInputElement).value,
    };

    const res = await fetch("/api/proof", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await res.json();

    if (!res.ok) {
      setError(json.error ?? "Failed to save proof.");
    } else {
      setGateFeedback(json.quality_gate_feedback);
      setSaved(true);
    }

    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Proof type selector */}
      <div>
        <p className={LABEL_CLASS}>Proof type <span className="text-red-500">*</span></p>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {PROOF_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setProofType(type)}
              className={`rounded-md border px-4 py-3 text-left transition-colors ${
                proofType === type
                  ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 dark:border-indigo-400"
                  : "border-gray-200 hover:border-gray-300 dark:border-gray-600 dark:hover:border-gray-500"
              }`}
            >
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                {PROOF_TYPE_LABELS[type]}
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {PROOF_TYPE_DESCRIPTIONS[type]}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Title */}
      <div>
        <label htmlFor="title" className={LABEL_CLASS}>
          Title <span className="text-red-500">*</span>
        </label>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          A short, plain-language name for this proof.
        </p>
        <input
          id="title"
          name="title"
          type="text"
          required
          defaultValue={existing?.title ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      {/* Outcome description */}
      <div>
        <label htmlFor="outcome_description" className={LABEL_CLASS}>
          What outcome does this proof show? <span className="text-red-500">*</span>
        </label>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Describe the result the prospect achieves — not the features of your product.
        </p>
        <textarea
          id="outcome_description"
          name="outcome_description"
          required
          rows={3}
          defaultValue={existing?.outcome_description ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      {/* Proof URL (optional) */}
      <div>
        <label htmlFor="proof_url" className={LABEL_CLASS}>
          Link to proof{" "}
          <span className="text-gray-400 text-xs font-normal">(optional)</span>
        </label>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          URL to a video, doc, or demo environment.
        </p>
        <input
          id="proof_url"
          name="proof_url"
          type="url"
          defaultValue={existing?.proof_url ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      {/* Written content (optional) */}
      <div>
        <label htmlFor="content" className={LABEL_CLASS}>
          Written content{" "}
          <span className="text-gray-400 text-xs font-normal">(optional)</span>
        </label>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Paste a summary or script if your proof is text-based.
        </p>
        <textarea
          id="content"
          name="content"
          rows={4}
          defaultValue={existing?.content ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      {/* Consumption time */}
      <div>
        <label htmlFor="consumption_time_minutes" className={LABEL_CLASS}>
          Estimated time to consume (minutes) <span className="text-red-500">*</span>
        </label>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Must be 10 minutes or under to pass the quality gate.
        </p>
        <input
          id="consumption_time_minutes"
          name="consumption_time_minutes"
          type="number"
          min={1}
          max={60}
          required
          defaultValue={existing?.consumption_time_minutes ?? 5}
          className={`${INPUT_CLASS} max-w-[120px]`}
        />
      </div>

      {/* Decision request */}
      <div>
        <label htmlFor="decision_request" className={LABEL_CLASS}>
          Decision request (CTA) <span className="text-red-500">*</span>
        </label>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          The single, clear ask at the end of your proof — e.g., "Are you ready to move forward?"
        </p>
        <input
          id="decision_request"
          name="decision_request"
          type="text"
          required
          defaultValue={existing?.decision_request ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {saved && (
        <p className="text-sm text-green-600 dark:text-green-400">Proof saved.</p>
      )}

      {gateFeedback && (
        <div className="rounded-md border p-4 space-y-2 dark:border-gray-600">
          <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Quality Gate 4:{" "}
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
        {loading ? "Saving..." : "Save Proof"}
      </button>
    </form>
  );
}
