"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import ReviewDashboard from "@/components/Analytics/ReviewDashboard";
import type { AnalyticsReport, ReviewCycle } from "@/lib/analytics";

export default function ReviewPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [cycles, setCycles] = useState<ReviewCycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      const res = await fetch(`/api/analytics?project_id=${projectId}`);
      if (res.ok) {
        const data = await res.json();
        setReport(data.report);
        setCycles(data.cycles);
      } else {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "Failed to load analytics.");
      }
      setLoading(false);
    }
    fetchData();
  }, [projectId]);

  function handleCycleCreated(cycle: ReviewCycle) {
    setCycles((prev) => [cycle, ...prev]);
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <div className="mx-auto max-w-2xl space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Review & Adjustment
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Analyse your outreach funnel, identify bottlenecks, and log what you
            will change next cycle.
          </p>
        </div>

        {loading && (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading analytics…</p>
        )}

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {!loading && !error && report && (
          <ReviewDashboard
            projectId={projectId}
            report={report}
            cycles={cycles}
            onCycleCreated={handleCycleCreated}
          />
        )}
      </div>
    </div>
  );
}
