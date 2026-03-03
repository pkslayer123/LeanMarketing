"use client";

import { useState } from "react";
import {
  TEMPLATE_DEFAULTS,
  TEMPLATE_LABELS,
  formatPrice,
  type Offer,
  type OfferTemplate,
  type QualityGateFeedback,
} from "@/lib/offers";

interface OfferFormProps {
  projectId: string;
  onCreated: (offer: Offer) => void;
}

const INPUT_CLASS =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white";

const LABEL_CLASS = "block text-sm font-medium text-gray-700 dark:text-gray-300";

const TEMPLATES: OfferTemplate[] = ["trial", "early_access", "pilot"];

export default function OfferForm({ projectId, onCreated }: OfferFormProps) {
  const [template, setTemplate] = useState<OfferTemplate>("trial");
  const defaults = TEMPLATE_DEFAULTS[template];

  const [scope, setScope] = useState(defaults.scope);
  const [durationDays, setDurationDays] = useState(defaults.duration_days);
  const [priceCents, setPriceCents] = useState(defaults.price_cents);
  const [successDefinition, setSuccessDefinition] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<QualityGateFeedback | null>(null);

  function applyTemplate(t: OfferTemplate) {
    setTemplate(t);
    const d = TEMPLATE_DEFAULTS[t];
    setScope(d.scope);
    setDurationDays(d.duration_days);
    setPriceCents(d.price_cents);
    setFeedback(null);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setFeedback(null);

    const res = await fetch("/api/offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        template,
        scope,
        duration_days: durationDays,
        price_cents: priceCents,
        success_definition: successDefinition,
      }),
    });

    const json = await res.json();

    if (!res.ok) {
      setError(json.error ?? "Failed to create offer.");
    } else {
      setFeedback(json.quality_gate_feedback);
      onCreated(json as Offer);
      setSuccessDefinition("");
    }

    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Template selector */}
      <div>
        <span className={LABEL_CLASS}>Offer template</span>
        <div className="mt-2 flex gap-2 flex-wrap">
          {TEMPLATES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => applyTemplate(t)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium border transition-colors ${
                template === t
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "border-gray-300 text-gray-700 hover:border-indigo-400 dark:border-gray-600 dark:text-gray-300"
              }`}
            >
              {TEMPLATE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {/* Scope */}
      <div>
        <label htmlFor="scope" className={LABEL_CLASS}>
          Scope <span className="text-red-500">*</span>
        </label>
        <textarea
          id="scope"
          name="scope"
          required
          rows={3}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className={INPUT_CLASS}
          placeholder="Describe what's included in this offer..."
        />
      </div>

      {/* Duration + Price */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="duration_days" className={LABEL_CLASS}>
            Duration (days) <span className="text-red-500">*</span>
          </label>
          <input
            id="duration_days"
            name="duration_days"
            type="number"
            required
            min={1}
            max={365}
            value={durationDays}
            onChange={(e) => setDurationDays(Number(e.target.value))}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="price_cents" className={LABEL_CLASS}>
            Price (USD) <span className="text-red-500">*</span>
          </label>
          <input
            id="price_cents"
            name="price_cents"
            type="number"
            required
            min={0}
            step={1}
            value={(priceCents / 100).toFixed(2)}
            onChange={(e) => setPriceCents(Math.round(parseFloat(e.target.value || "0") * 100))}
            className={INPUT_CLASS}
            placeholder="0.00"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {formatPrice(priceCents)}
          </p>
        </div>
      </div>

      {/* Success definition */}
      <div>
        <label htmlFor="success_definition" className={LABEL_CLASS}>
          Measurable success definition <span className="text-red-500">*</span>
        </label>
        <textarea
          id="success_definition"
          name="success_definition"
          required
          rows={3}
          value={successDefinition}
          onChange={(e) => setSuccessDefinition(e.target.value)}
          className={INPUT_CLASS}
          placeholder="e.g. Customer achieves 3 closed deals or 20% increase in qualified pipeline within 30 days."
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Include a specific metric so success is measurable.
        </p>
      </div>

      {/* Quality gate feedback */}
      {feedback && (
        <div
          className={`rounded-md p-4 text-sm ${
            feedback.overall_passed
              ? "bg-green-50 dark:bg-green-900/20"
              : "bg-yellow-50 dark:bg-yellow-900/20"
          }`}
        >
          <p
            className={`font-semibold mb-2 ${
              feedback.overall_passed
                ? "text-green-700 dark:text-green-400"
                : "text-yellow-700 dark:text-yellow-400"
            }`}
          >
            Quality Gate {feedback.overall_passed ? "Passed" : "Not Passed"}
          </p>
          <ul className="space-y-1">
            {feedback.checks.map((c) => (
              <li key={c.label} className="flex items-start gap-2">
                <span
                  className={
                    c.passed ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                  }
                >
                  {c.passed ? "✓" : "✗"}
                </span>
                <span className="text-gray-700 dark:text-gray-300">
                  <span className="font-medium">{c.label}:</span> {c.feedback}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
      >
        {loading ? "Creating offer..." : "Create Offer"}
      </button>
    </form>
  );
}
