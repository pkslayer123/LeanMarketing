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

export default function ProjectCard({ project }: { project: Project }) {
  const styles = statusStyles[project.status] ?? statusStyles.active;

  return (
    <Link
      href={`/projects/${project.id}/idea`}
      className="block bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5 hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-gray-900 dark:text-white text-lg truncate">
          {project.name}
        </h3>
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${styles.badge}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}`} />
          {project.status}
        </span>
      </div>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
        {formatRelativeTime(project.last_activity_at)}
      </p>
      <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
        Created {new Date(project.created_at).toLocaleDateString()}
      </p>
    </Link>
  );
}
