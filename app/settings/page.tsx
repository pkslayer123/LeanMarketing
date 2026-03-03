import { createServerSupabaseClient } from "@/lib/supabaseServer";
import { redirect } from "next/navigation";
import ApprovalModeToggle from "@/components/Settings/ApprovalModeToggle";
import type { ApprovalMode } from "@/lib/settings";

export default async function SettingsPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
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
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Settings</h1>
        <p className="text-gray-500 dark:text-gray-400 mb-8">
          Configure approval mode for each project.
        </p>

        {projects && projects.length > 0 ? (
          <div className="space-y-6">
            {projects.map((project) => (
              <div
                key={project.id}
                className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6"
              >
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                  {project.name}
                </h2>
                <p className="text-xs font-mono text-gray-400 dark:text-gray-500 mb-5">
                  {project.id}
                </p>

                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  Approval Mode
                </h3>
                <ApprovalModeToggle
                  projectId={project.id}
                  initialMode={settingsMap.get(project.id) ?? "strict"}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-8 text-center">
            <p className="text-gray-500 dark:text-gray-400">
              No projects found. Create a project to configure its settings.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
