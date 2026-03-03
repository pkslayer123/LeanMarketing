"use client";

import { useState } from "react";
import type { AnalyticsReport, ReviewCycle, QualityGate6Feedback } from "@/lib/analytics";

interface ReviewDashboardProps {
  projectId: string;
  report: AnalyticsReport;
  cycles: ReviewCycle[];
  onCycleCreated: (cycle: ReviewCycle) => void;
}

const INPUT_CLASS =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white";

const LABEL_CLASS = "block text-sm font-medium text-gray-700 dark:text-gray-300";

function QualityGateBadge({ feedback }: { feedback: QualityGate6Feedback }) {
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-2">
      <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">
        Quality Gate 6:{" "}
        {feedback.overall_passed ? (
          <span className="text-green-600 dark:text-green-400">Passed</span>
        ) : (
          <span className="text-red-600 dark:text-red-400">Needs work</span>
        )}
      </p>
      <ul className="space-y-1">
        {feedback.checks.map((check) => (
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
  );
}

function FunnelChart({ funnel }: { funnel: AnalyticsReport["funnel"] }) {
  const max = Math.max(...funnel.map((s) => s.count), 1);
  return (
    <div className="space-y-2">
      {funnel.map((stage, i) => {
        const pct = Math.round((stage.count / max) * 100);
        const dropPct =
          i > 0 && funnel[i - 1].count > 0
            ? Math.round(((funnel[i - 1].count - stage.count) / funnel[i - 1].count) * 100)
            : null;
        return (
          <div key={stage.label}>
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-0.5">
              <span>{stage.label}</span>
              <span className="flex gap-2">
                {dropPct !== null && dropPct > 0 && (
                  <span className="text-red-500">−{dropPct}%</span>
                )}
                <span className="font-medium text-gray-700 dark:text-gray-300">{stage.count}</span>
              </span>
            </div>
            <div className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-2 bg-indigo-500 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CycleCard({ cycle }: { cycle: ReviewCycle }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Cycle {cycle.cycle_number}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            cycle.quality_gate_passed
              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
              : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300"
          }`}
        >
          QG6 {cycle.quality_gate_passed ? "Passed" : "Not Passed"}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          { label: "Sent", value: cycle.messages_sent },
          { label: "Replied", value: cycle.replies },
          { label: "Advanced", value: cycle.stage_advances },
        ].map((s) => (
          <div key={s.label} className="rounded bg-gray-50 dark:bg-gray-700/50 py-1">
            <p className="text-lg font-bold text-gray-900 dark:text-white">{s.value}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{s.label}</p>
          </div>
        ))}
      </div>
      {cycle.bottleneck && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          <span className="font-medium">Bottleneck:</span> {cycle.bottleneck}
        </p>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        <span className="font-medium">Variable:</span> {cycle.variable_changed}
      </p>
      <p className="text-xs text-gray-600 dark:text-gray-300 italic">"{cycle.hypothesis}"</p>
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {new Date(cycle.created_at).toLocaleDateString()}
      </p>
    </div>
  );
}

export default function ReviewDashboard({
  projectId,
  report,
  cycles,
  onCycleCreated,
}: ReviewDashboardProps) {
  const [variable, setVariable] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateFeedback, setGateFeedback] = useState<QualityGate6Feedback | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setGateFeedback(null);

    const res = await fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        variable_changed: variable,
        hypothesis,
      }),
    });

    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? "Failed to save review cycle.");
    } else {
      setGateFeedback(json.quality_gate_feedback);
      onCycleCreated(json);
      setVariable("");
      setHypothesis("");
    }
    setLoading(false);
  }

  const replyRate =
    report.messages_sent > 0
      ? Math.round((report.replies / report.messages_sent) * 100)
      : null;

  return (
    <div className="space-y-8">
      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Messages Sent", value: report.messages_sent },
          { label: "Replies", value: report.replies },
          {
            label: "Reply Rate",
            value: replyRate !== null ? `${replyRate}%` : "—",
          },
          { label: "Stage Advances", value: report.stage_advances },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-4 text-center"
          >
            <p className="text-2xl font-bold text-gray-900 dark:text-white">{stat.value}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Funnel */}
      <div className="rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
          Outreach Funnel
        </h2>
        <FunnelChart funnel={report.funnel} />
      </div>

      {/* Bottleneck */}
      {report.bottleneck && report.bottleneck !== "Not enough data" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 p-4">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            Biggest Drop-off
          </p>
          <p className="text-sm text-amber-700 dark:text-amber-400 mt-0.5">
            {report.bottleneck} — {report.bottleneck_drop_count} lost (
            {report.bottleneck_drop_pct}% drop)
          </p>
        </div>
      )}

      {/* Log Review Cycle */}
      <div className="rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
          Log Review Cycle {cycles.length + 1}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="variable" className={LABEL_CLASS}>
              Single variable to change <span className="text-red-500">*</span>
            </label>
            <input
              id="variable"
              name="variable"
              type="text"
              required
              value={variable}
              onChange={(e) => setVariable(e.target.value)}
              placeholder="e.g. Subject line tone — question vs. statement"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label htmlFor="hypothesis" className={LABEL_CLASS}>
              Hypothesis (one sentence) <span className="text-red-500">*</span>
            </label>
            <textarea
              id="hypothesis"
              name="hypothesis"
              required
              rows={2}
              value={hypothesis}
              onChange={(e) => setHypothesis(e.target.value)}
              placeholder="e.g. Changing the subject line to a question will increase reply rate by 10%."
              className={INPUT_CLASS}
            />
          </div>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          {gateFeedback && <QualityGateBadge feedback={gateFeedback} />}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            {loading ? "Saving..." : "Save Review Cycle"}
          </button>
        </form>
      </div>

      {/* Cycle History */}
      {cycles.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Experiment History
          </h2>
          <div className="space-y-3">
            {cycles.map((cycle) => (
              <CycleCard key={cycle.id} cycle={cycle} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
