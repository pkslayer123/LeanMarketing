import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { redirect } from "next/navigation";
import Sidebar from "@/components/Dashboard/Sidebar";
import ApprovalModeToggle from "@/components/Settings/ApprovalModeToggle";
import type { ApprovalMode } from "@/lib/settings";
import { APPROVAL_MODE_DESCRIPTIONS } from "@/lib/settings";

export const metadata = { title: "Settings — LeanMarketing" };

export default async function SettingsPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const [{ data: projects }, { data: allSettings }] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("project_settings")
      .select("project_id, approval_mode")
      .eq("user_id", user.id),
  ]);

  const settingsMap = new Map(
    (allSettings ?? []).map((s) => [s.project_id, s.approval_mode as ApprovalMode])
  );

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-gray-900">
      <Sidebar />

      <main className="flex-1 p-8">
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Configure approval mode and governance settings for each project.
            </p>
          </div>

          {/* Approval Mode Section */}
          <section className="mb-10">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
              Approval Mode
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Controls when the AI must pause and wait for your review before advancing a lead or
              taking an action through the validation funnel.
            </p>

            {/* Mode reference cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
              {(["strict", "relaxed"] as ApprovalMode[]).map((mode) => (
                <div
                  key={mode}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
                >
                  <p className="text-sm font-semibold text-gray-900 dark:text-white capitalize mb-1">
                    {mode}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                    {APPROVAL_MODE_DESCRIPTIONS[mode]}
                  </p>
                </div>
              ))}
            </div>

            {/* Per-project toggles */}
            {projects && projects.length > 0 ? (
              <div className="space-y-6">
                {projects.map((project) => (
                  <div
                    key={project.id}
                    className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm"
                  >
                    <div className="mb-5">
                      <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                        {project.name}
                      </h3>
                      <p className="text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">
                        {project.id}
                      </p>
                    </div>

                    <ApprovalModeToggle
                      projectId={project.id}
                      initialMode={settingsMap.get(project.id) ?? "strict"}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-10 shadow-sm text-center">
                <p className="text-sm font-medium text-gray-900 dark:text-white mb-1">
                  No projects yet
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Create a project from the Dashboard to configure its approval settings.
                </p>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
