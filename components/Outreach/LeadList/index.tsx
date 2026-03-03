"use client";

import { useState } from "react";
import type { Lead, LeadInput, LeadStatus } from "@/lib/outreach";

interface LeadListProps {
  projectId: string;
  initialLeads: Lead[];
  onLeadsChanged?: (leads: Lead[]) => void;
}

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  replied: "Replied",
  opted_out: "Opted Out",
  converted: "Converted",
};

const STATUS_COLORS: Record<LeadStatus, string> = {
  new: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  contacted: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  replied: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  opted_out: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  converted: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
};

const INPUT_CLASS =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white";

export default function LeadList({ projectId, initialLeads, onLeadsChanged }: LeadListProps) {
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addLoading, setAddLoading] = useState(false);

  async function handleAddLead(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAddLoading(true);
    setAddError(null);

    const form = e.currentTarget;
    const body: LeadInput = {
      project_id: projectId,
      name: (form.elements.namedItem("name") as HTMLInputElement).value,
      email: (form.elements.namedItem("email") as HTMLInputElement).value,
      company: (form.elements.namedItem("company") as HTMLInputElement).value || undefined,
      job_role: (form.elements.namedItem("job_role") as HTMLInputElement).value || undefined,
      fit_reason: (form.elements.namedItem("fit_reason") as HTMLTextAreaElement).value,
    };

    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await res.json();
    if (!res.ok) {
      setAddError(json.error ?? "Failed to add lead.");
    } else {
      const updated = [json as Lead, ...leads];
      setLeads(updated);
      onLeadsChanged?.(updated);
      setShowAdd(false);
      form.reset();
    }
    setAddLoading(false);
  }

  async function updateStatus(leadId: string, status: LeadStatus) {
    const res = await fetch(`/api/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      const json = await res.json();
      const updated = leads.map((l) => (l.id === leadId ? (json as Lead) : l));
      setLeads(updated);
      onLeadsChanged?.(updated);
    }
  }

  async function deleteLead(leadId: string) {
    const res = await fetch(`/api/leads/${leadId}`, { method: "DELETE" });
    if (res.ok) {
      const updated = leads.filter((l) => l.id !== leadId);
      setLeads(updated);
      onLeadsChanged?.(updated);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Leads ({leads.length})
        </h3>
        <button
          type="button"
          onClick={() => setShowAdd(!showAdd)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
        >
          {showAdd ? "Cancel" : "+ Add Lead"}
        </button>
      </div>

      {showAdd && (
        <form
          onSubmit={handleAddLead}
          className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Name <span className="text-red-500">*</span>
              </label>
              <input name="name" required type="text" className={INPUT_CLASS} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Email <span className="text-red-500">*</span>
              </label>
              <input name="email" required type="email" className={INPUT_CLASS} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Company
              </label>
              <input name="company" type="text" className={INPUT_CLASS} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Job Role
              </label>
              <input name="job_role" type="text" className={INPUT_CLASS} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              Fit reason <span className="text-red-500">*</span>
            </label>
            <textarea name="fit_reason" required rows={2} className={INPUT_CLASS} />
          </div>
          {addError && (
            <p className="text-xs text-red-600 dark:text-red-400">{addError}</p>
          )}
          <button
            type="submit"
            disabled={addLoading}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {addLoading ? "Adding..." : "Add Lead"}
          </button>
        </form>
      )}

      {leads.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No leads yet. Add your first lead above.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {leads.map((lead) => (
            <li key={lead.id} className="py-3 space-y-1">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    {lead.name}
                  </span>
                  {lead.job_role && (
                    <span className="ml-1.5 text-xs text-gray-500 dark:text-gray-400">
                      · {lead.job_role}
                    </span>
                  )}
                  {lead.company && (
                    <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                      @ {lead.company}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={lead.status}
                    onChange={(e) => updateStatus(lead.id, e.target.value as LeadStatus)}
                    className={`rounded-full px-2 py-0.5 text-xs font-medium border-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-500 ${STATUS_COLORS[lead.status]}`}
                  >
                    {Object.entries(STATUS_LABELS).map(([val, label]) => (
                      <option key={val} value={val}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => deleteLead(lead.id)}
                    className="text-xs text-red-500 hover:text-red-700"
                    aria-label="Delete lead"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                <span className="font-medium">Fit:</span> {lead.fit_reason}
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500">{lead.email}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
