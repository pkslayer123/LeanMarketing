"use client";

import { useState } from "react";
import type { ApprovalMode } from "@/lib/settings";
import { APPROVAL_MODE_LABELS } from "@/lib/settings";

interface ApprovalModeToggleProps {
  projectId: string;
  initialMode: ApprovalMode;
}

export default function ApprovalModeToggle({ projectId, initialMode }: ApprovalModeToggleProps) {
  const [mode, setMode] = useState<ApprovalMode>(initialMode);
  const [savedMode, setSavedMode] = useState<ApprovalMode>(initialMode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleChange(newMode: ApprovalMode) {
    setMode(newMode);
    setLoading(true);
    setError(null);
    setSaved(false);

    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, approval_mode: newMode }),
    });

    const json = await res.json();

    if (!res.ok) {
      setError(json.error ?? "Failed to save setting.");
      setMode(savedMode);
    } else {
      setSavedMode(newMode);
      setSaved(true);
    }

    setLoading(false);
  }

  return (
    <div className="space-y-3">
      {(["strict", "relaxed"] as ApprovalMode[]).map((option) => (
        <label
          key={option}
          className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors ${
            mode === option
              ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30 dark:border-indigo-400"
              : "border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600"
          } ${loading ? "opacity-60 pointer-events-none" : ""}`}
        >
          <input
            type="radio"
            name={`approval_mode_${projectId}`}
            value={option}
            checked={mode === option}
            disabled={loading}
            onChange={() => handleChange(option)}
            className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
          />
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-white capitalize">{option}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{APPROVAL_MODE_LABELS[option]}</p>
          </div>
        </label>
      ))}

      {loading && (
        <p className="text-xs text-gray-500 dark:text-gray-400">Saving...</p>
      )}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      {saved && !loading && (
        <p className="text-xs text-green-600 dark:text-green-400">Settings saved.</p>
      )}
    </div>
  );
}
