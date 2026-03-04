'use client';

import Link from 'next/link';
import type { Project } from '@/lib/projects';
import { formatRelativeTime } from '@/lib/projects';

const statusStyles: Record<Project['status'], { badge: string; dot: string }> = {
  active: {
    badge: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    dot: 'bg-green-500',
  },
  paused: {
    badge: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    dot: 'bg-yellow-500',
  },
  converged: {
    badge: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    dot: 'bg-blue-500',
  },
};

const phaseColors: Record<string, string> = {
  BUILD: 'text-orange-600 dark:text-orange-400',
  STABILIZE: 'text-yellow-600 dark:text-yellow-400',
  POLISH: 'text-blue-600 dark:text-blue-400',
  CONVERGED: 'text-green-600 dark:text-green-400',
};

interface ProjectCardProps {
  project: Project;
  isNetworkProject?: boolean;
}

export default function ProjectCard({ project, isNetworkProject }: ProjectCardProps) {
  const styles = statusStyles[project.status] ?? statusStyles.active;
  const showDaemonInfo = isNetworkProject || project.is_network_project;
  const convergencePercent = Math.round((project.daemon_convergence_score ?? 0) * 100);

  return (
    <Link
      href={`/projects/${project.id}/idea`}
      className="block bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5 hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-gray-900 dark:text-white text-lg truncate">
          {project.daemon_project_name || project.name}
        </h3>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {showDaemonInfo && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
              daemon
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${styles.badge}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}`} />
            {project.status}
          </span>
        </div>
      </div>

      {/* Daemon network details */}
      {showDaemonInfo && (
        <div className="mt-3 space-y-2">
          {/* Convergence progress bar */}
          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-gray-500 dark:text-gray-400">Convergence</span>
              <span className="font-medium text-gray-700 dark:text-gray-300">
                {convergencePercent}%
              </span>
            </div>
            <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all"
                style={{ width: `${convergencePercent}%` }}
              />
            </div>
          </div>

          {/* Build phase + cycle count */}
          <div className="flex items-center justify-between text-xs">
            {project.daemon_build_phase && (
              <span className={`font-medium ${phaseColors[project.daemon_build_phase] ?? 'text-gray-500'}`}>
                {project.daemon_build_phase}
              </span>
            )}
            {(project.daemon_claw_cycle ?? 0) > 0 && (
              <span className="text-gray-400 dark:text-gray-500">
                cycle {project.daemon_claw_cycle}
              </span>
            )}
          </div>

          {/* MOC count */}
          {(project.daemon_moc_count ?? 0) > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {project.daemon_moc_count} open MOC{project.daemon_moc_count !== 1 ? 's' : ''}
            </p>
          )}
        </div>
      )}

      {/* Timestamps */}
      <div className="mt-3 flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {showDaemonInfo && project.last_synced_at
            ? `Synced ${formatRelativeTime(project.last_synced_at)}`
            : formatRelativeTime(project.last_activity_at)}
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-500">
          Created {new Date(project.created_at).toLocaleDateString()}
        </p>
      </div>
    </Link>
  );
}
