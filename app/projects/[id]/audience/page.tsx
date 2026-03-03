import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import AudienceForm from "@/components/Outreach/AudienceForm";
import LeadList from "@/components/Outreach/LeadList";
import { TemplateEditor, CampaignSettings, QualityGate2Panel } from "./_client";
import type { AudienceDefinition, Lead, MessageTemplate, OutreachCampaign } from "@/lib/outreach";

interface AudiencePageProps {
  params: Promise<{ id: string }>;
}

export default async function AudiencePage({ params }: AudiencePageProps) {
  const { id: projectId } = await params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const [
    { data: audience },
    { data: leads },
    { data: templates },
    { data: campaigns },
  ] = await Promise.all([
    supabase
      .from("audience_definitions")
      .select("*")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("leads")
      .select("*")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("message_templates")
      .select("*")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .order("version"),
    supabase
      .from("outreach_campaigns")
      .select("*")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const initialCampaign = campaigns?.[0] ?? null;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <div className="mx-auto max-w-2xl space-y-10">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Audience &amp; Outreach
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Define who you&apos;re reaching, craft your messages, and configure
            sending controls.
          </p>
        </div>

        {/* Section 1 — Audience Definition */}
        <Section title="Audience Definition" description="Specify the job roles and company types you want to target, along with inclusion and exclusion rules.">
          <AudienceForm
            projectId={projectId}
            existing={audience as AudienceDefinition | null}
          />
        </Section>

        {/* Section 2 — Leads */}
        <Section title="Leads" description="Track individual prospects. Every lead needs a documented fit reason.">
          <LeadList
            projectId={projectId}
            initialLeads={(leads ?? []) as Lead[]}
          />
        </Section>

        {/* Section 3 — Message Templates (A/B) */}
        <Section title="Message Templates" description="Write two parallel message versions (A and B). Each must have exactly one call-to-action and an opt-out phrase.">
          <TemplateEditor
            projectId={projectId}
            initialTemplates={(templates ?? []) as MessageTemplate[]}
          />
        </Section>

        {/* Section 4 — Campaign / Sending Controls */}
        <Section title="Sending Controls" description="Set rate limits, daily caps, and stop-on-reply behaviour for your outreach campaign.">
          <CampaignSettings
            projectId={projectId}
            initialCampaign={initialCampaign as OutreachCampaign | null}
          />
        </Section>

        {/* Section 5 — Quality Gate 2 */}
        <Section title="Quality Gate 2" description="All four checks must pass before your outreach is considered ready.">
          <QualityGate2Panel
            audience={audience as AudienceDefinition | null}
            leads={(leads ?? []) as Lead[]}
            templates={(templates ?? []) as MessageTemplate[]}
          />
        </Section>

      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
        <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{description}</p>
      </div>
      <div className="rounded-lg bg-white dark:bg-gray-800 p-6 shadow-sm">{children}</div>
    </div>
  );
}
