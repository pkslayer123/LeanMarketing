import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabaseServer';
import Sidebar from '@/components/Dashboard/Sidebar';
import ProjectCard from '@/components/Dashboard/ProjectCard';
import NetworkSyncButton from '@/components/Dashboard/NetworkSyncButton';
import type { Project } from '@/lib/projects';

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/auth/login');

  const { data: projects } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', user.id)
    .order('last_activity_at', { ascending: false, nullsFirst: false });

  const localProjects = (projects ?? []).filter(
    (p: Project & { is_network_project?: boolean }) => !p.is_network_project
  );
  const networkProjects = (projects ?? []).filter(
    (p: Project & { is_network_project?: boolean }) => p.is_network_project
  );

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-gray-900">
      <Sidebar />
      <main className="flex-1 p-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Projects</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                All persona-engine projects in your daemon network
              </p>
            </div>
            <NetworkSyncButton />
          </div>

          {/* Network Projects */}
          {networkProjects.length > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900">
                  <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                </span>
                Daemon Network
                <span className="text-xs font-normal text-gray-400">
                  ({networkProjects.length} project{networkProjects.length !== 1 ? 's' : ''})
                </span>
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {(networkProjects as Project[]).map((project) => (
                  <ProjectCard key={project.id} project={project} isNetworkProject />
                ))}
              </div>
            </div>
          )}

          {/* Local Projects */}
          {localProjects.length > 0 && (
            <div className="mb-8">
              {networkProjects.length > 0 && (
                <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-3">
                  Local Projects
                </h2>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {(localProjects as Project[]).map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            </div>
          )}

          {/* Empty state — show when no projects at all, with sync suggestion */}
          {(!projects || projects.length === 0) && (
            <div className="text-center py-16 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="mx-auto w-12 h-12 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-indigo-600 dark:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <p className="text-gray-900 dark:text-gray-100 text-lg font-medium">
                No projects detected yet
              </p>
              <p className="text-gray-500 dark:text-gray-400 text-sm mt-1 max-w-md mx-auto">
                Click &quot;Sync Network&quot; to detect persona-engine projects in your daemon network,
                or wait for the daemon to create them automatically.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
