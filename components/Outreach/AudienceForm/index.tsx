"use client";

import { useState } from "react";
import type { AudienceDefinition, AudienceInput } from "@/lib/outreach";

interface AudienceFormProps {
  projectId: string;
  existing?: AudienceDefinition | null;
  onSaved?: (audience: AudienceDefinition) => void;
}

const INPUT_CLASS =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white";

const LABEL_CLASS = "block text-sm font-medium text-gray-700 dark:text-gray-300";

function TagInput({
  label,
  hint,
  name,
  defaultValues,
}: {
  label: string;
  hint: string;
  name: string;
  defaultValues: string[];
}) {
  const [tags, setTags] = useState<string[]>(defaultValues);
  const [input, setInput] = useState("");

  function addTag() {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setInput("");
  }

  function removeTag(tag: string) {
    setTags(tags.filter((t) => t !== tag));
  }

  return (
    <div>
      <label className={LABEL_CLASS}>{label}</label>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{hint}</p>
      {/* Hidden inputs so the form serialises the array */}
      {tags.map((t, i) => (
        <input key={i} type="hidden" name={name} value={t} />
      ))}
      <div className="mt-1 flex flex-wrap gap-1">
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
          >
            {t}
            <button
              type="button"
              onClick={() => removeTag(t)}
              className="ml-0.5 hover:text-indigo-600"
              aria-label={`Remove ${t}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-1 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag();
            }
          }}
          placeholder="Type and press Enter"
          className={INPUT_CLASS}
        />
        <button
          type="button"
          onClick={addTag}
          className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Add
        </button>
      </div>
    </div>
  );
}

export default function AudienceForm({ projectId, existing, onSaved }: AudienceFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);

    const form = e.currentTarget;
    const fd = new FormData(form);

    const body: AudienceInput = {
      project_id: projectId,
      job_roles: fd.getAll("job_roles") as string[],
      company_types: fd.getAll("company_types") as string[],
      inclusion_rules: fd.getAll("inclusion_rules") as string[],
      exclusion_rules: fd.getAll("exclusion_rules") as string[],
    };

    const res = await fetch("/api/audience", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? "Failed to save audience.");
    } else {
      setSaved(true);
      onSaved?.(json as AudienceDefinition);
    }
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <TagInput
        label="Job roles"
        hint="Target job titles (e.g. Head of Marketing, CTO)"
        name="job_roles"
        defaultValues={existing?.job_roles ?? []}
      />
      <TagInput
        label="Company types"
        hint="Types of company to target (e.g. SaaS startup, agency)"
        name="company_types"
        defaultValues={existing?.company_types ?? []}
      />
      <TagInput
        label="Inclusion rules"
        hint="Must-have criteria (e.g. 10+ employees, series A+)"
        name="inclusion_rules"
        defaultValues={existing?.inclusion_rules ?? []}
      />
      <TagInput
        label="Exclusion rules"
        hint="Disqualifying criteria (e.g. competitor, enterprise only)"
        name="exclusion_rules"
        defaultValues={existing?.exclusion_rules ?? []}
      />

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {saved && (
        <p className="text-sm text-green-600 dark:text-green-400">Audience saved.</p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
      >
        {loading ? "Saving..." : "Save Audience"}
      </button>
    </form>
  );
}
