"use client";

import { useState } from "react";
import type {
  MessageTemplate,
  MessageTemplateInput,
  OutreachCampaign,
  CampaignInput,
  QualityGate2Feedback,
  QualityGate2Input,
  AudienceDefinition,
  Lead,
} from "@/lib/outreach";
import { runQualityGate2 } from "@/lib/outreach";

// ─── Shared styles ────────────────────────────────────────────────────────────

const INPUT_CLASS =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white";
const LABEL_CLASS = "block text-sm font-medium text-gray-700 dark:text-gray-300";

// ─── A/B Template Editor ──────────────────────────────────────────────────────

interface TemplateEditorProps {
  projectId: string;
  initialTemplates: MessageTemplate[];
}

export function TemplateEditor({ projectId, initialTemplates }: TemplateEditorProps) {
  const byVersion = (v: "A" | "B") =>
    initialTemplates.find((t) => t.version === v) ?? null;

  const [templateA, setTemplateA] = useState<MessageTemplate | null>(byVersion("A"));
  const [templateB, setTemplateB] = useState<MessageTemplate | null>(byVersion("B"));
  const [saving, setSaving] = useState<"A" | "B" | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  async function saveTemplate(version: "A" | "B", subject: string, body: string) {
    setSaving(version);
    setErrors((p) => ({ ...p, [version]: "" }));
    setSaved((p) => ({ ...p, [version]: false }));

    const existing = version === "A" ? templateA : templateB;
    const url = existing ? `/api/outreach/templates/${existing.id}` : "/api/outreach/templates";
    const method = existing ? "PATCH" : "POST";
    const payload: Partial<MessageTemplateInput> & { project_id?: string } = existing
      ? { subject, body }
      : { project_id: projectId, version, subject, body };

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) {
      setErrors((p) => ({ ...p, [version]: json.error ?? "Failed to save template." }));
    } else {
      const updated = json as MessageTemplate;
      if (version === "A") setTemplateA(updated);
      else setTemplateB(updated);
      setSaved((p) => ({ ...p, [version]: true }));
    }
    setSaving(null);
  }

  return (
    <div className="space-y-6">
      {(["A", "B"] as const).map((version) => {
        const tpl = version === "A" ? templateA : templateB;
        return (
          <TemplateVersionForm
            key={version}
            version={version}
            template={tpl}
            saving={saving === version}
            error={errors[version] ?? ""}
            savedOk={saved[version] ?? false}
            onSave={(subject, body) => saveTemplate(version, subject, body)}
          />
        );
      })}
    </div>
  );
}

interface TemplateVersionFormProps {
  version: "A" | "B";
  template: MessageTemplate | null;
  saving: boolean;
  error: string;
  savedOk: boolean;
  onSave: (subject: string, body: string) => void;
}

function TemplateVersionForm({
  version,
  template,
  saving,
  error,
  savedOk,
  onSave,
}: TemplateVersionFormProps) {
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave(subject, body);
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Version {version}
        </h4>
        <div className="flex gap-2 text-xs">
          {template && (
            <>
              <Badge ok={template.has_cta} label={template.has_cta ? "CTA ✓" : "No CTA"} />
              <Badge ok={template.has_opt_out} label={template.has_opt_out ? "Opt-out ✓" : "No opt-out"} />
              {template.cta_count !== 1 && (
                <Badge ok={false} label={`${template.cta_count} CTAs (need 1)`} />
              )}
            </>
          )}
        </div>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className={LABEL_CLASS}>Subject</label>
          <input
            type="text"
            required
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className={INPUT_CLASS}
            placeholder="Your subject line…"
          />
        </div>
        <div>
          <label className={LABEL_CLASS}>
            Body
            <span className="ml-1 text-xs font-normal text-gray-400">
              (include one CTA link and an opt-out phrase)
            </span>
          </label>
          <textarea
            required
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className={INPUT_CLASS}
            placeholder="Hi {{name}}, …&#10;&#10;To unsubscribe reply STOP."
          />
        </div>
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        {savedOk && <p className="text-xs text-green-600 dark:text-green-400">Saved.</p>}
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : `Save Version ${version}`}
        </button>
      </form>
    </div>
  );
}

// ─── Campaign Settings ────────────────────────────────────────────────────────

interface CampaignSettingsProps {
  projectId: string;
  initialCampaign: OutreachCampaign | null;
}

export function CampaignSettings({ projectId, initialCampaign }: CampaignSettingsProps) {
  const [campaign, setCampaign] = useState<OutreachCampaign | null>(initialCampaign);
  const [name, setName] = useState(initialCampaign?.name ?? "");
  const [rateLimit, setRateLimit] = useState(initialCampaign?.rate_limit_per_day ?? 20);
  const [dailyCap, setDailyCap] = useState(initialCampaign?.daily_cap ?? 50);
  const [stopOnReply, setStopOnReply] = useState(initialCampaign?.stop_on_reply ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedOk, setSavedOk] = useState(false);

  const STATUS_COLORS: Record<OutreachCampaign["status"], string> = {
    draft: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
    active: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
    paused: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
    stopped: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSavedOk(false);

    const url = campaign ? `/api/outreach/${campaign.id}` : "/api/outreach";
    const method = campaign ? "PATCH" : "POST";
    const payload: Partial<CampaignInput> & { project_id?: string } = campaign
      ? { name, rate_limit_per_day: rateLimit, daily_cap: dailyCap, stop_on_reply: stopOnReply }
      : { project_id: projectId, name, rate_limit_per_day: rateLimit, daily_cap: dailyCap, stop_on_reply: stopOnReply };

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? "Failed to save campaign.");
    } else {
      setCampaign(json as OutreachCampaign);
      setSavedOk(true);
    }
    setSaving(false);
  }

  async function updateStatus(status: OutreachCampaign["status"]) {
    if (!campaign) return;
    const res = await fetch(`/api/outreach/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      const json = await res.json();
      setCampaign(json as OutreachCampaign);
    }
  }

  return (
    <div className="space-y-4">
      {campaign && (
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[campaign.status]}`}
          >
            {campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1)}
          </span>
          <div className="flex gap-2">
            {campaign.status !== "active" && (
              <button
                onClick={() => updateStatus("active")}
                className="rounded-md bg-green-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-500"
              >
                Activate
              </button>
            )}
            {campaign.status === "active" && (
              <button
                onClick={() => updateStatus("paused")}
                className="rounded-md bg-yellow-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-yellow-500"
              >
                Pause
              </button>
            )}
            {campaign.status !== "stopped" && (
              <button
                onClick={() => updateStatus("stopped")}
                className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500"
              >
                Stop
              </button>
            )}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={LABEL_CLASS}>Campaign name</label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT_CLASS}
            placeholder="e.g. Q2 SaaS outreach"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={LABEL_CLASS}>
              Rate limit
              <span className="ml-1 text-xs font-normal text-gray-400">(emails/day)</span>
            </label>
            <input
              type="number"
              min={1}
              max={500}
              value={rateLimit}
              onChange={(e) => setRateLimit(Number(e.target.value))}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>
              Daily cap
              <span className="ml-1 text-xs font-normal text-gray-400">(max sends/day)</span>
            </label>
            <input
              type="number"
              min={1}
              max={1000}
              value={dailyCap}
              onChange={(e) => setDailyCap(Number(e.target.value))}
              className={INPUT_CLASS}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={stopOnReply}
            onChange={(e) => setStopOnReply(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            Stop sending to lead when they reply
          </span>
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {savedOk && <p className="text-sm text-green-600 dark:text-green-400">Campaign saved.</p>}

        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : campaign ? "Update Campaign" : "Create Campaign"}
        </button>
      </form>
    </div>
  );
}

// ─── Quality Gate 2 Panel ─────────────────────────────────────────────────────

interface QualityGate2PanelProps {
  audience: AudienceDefinition | null;
  leads: Lead[];
  templates: MessageTemplate[];
}

export function QualityGate2Panel({ audience, leads, templates }: QualityGate2PanelProps) {
  const input: QualityGate2Input = {
    audience: audience ?? { job_roles: [], company_types: [], inclusion_rules: [], exclusion_rules: [] },
    leads,
    templates,
  };
  const result: QualityGate2Feedback = runQualityGate2(input);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex rounded-full px-3 py-1 text-sm font-semibold ${
            result.overall_passed
              ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
              : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
          }`}
        >
          {result.overall_passed ? "Passed" : "Not yet passed"}
        </span>
      </div>
      <ul className="space-y-2">
        {Object.values(result.checks).map((check) => (
          <li key={check.label} className="flex items-start gap-2">
            <span
              className={`mt-0.5 flex-shrink-0 text-sm font-bold ${
                check.passed ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"
              }`}
            >
              {check.passed ? "✓" : "✗"}
            </span>
            <div>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                {check.label}
              </span>
              <p className="text-xs text-gray-500 dark:text-gray-400">{check.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Small helper ─────────────────────────────────────────────────────────────

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-medium ${
        ok
          ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
          : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
      }`}
    >
      {label}
    </span>
  );
}
