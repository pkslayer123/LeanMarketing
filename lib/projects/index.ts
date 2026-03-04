export type ProjectStatus = 'active' | 'paused' | 'converged';

export interface Project {
  id: string;
  user_id: string;
  name: string;
  status: ProjectStatus;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
  // Daemon network fields
  daemon_project_name?: string | null;
  daemon_node_id?: string | null;
  is_network_project?: boolean;
  daemon_status?: string | null;
  daemon_convergence_score?: number | null;
  daemon_build_phase?: string | null;
  daemon_claw_cycle?: number | null;
  daemon_moc_count?: number | null;
  last_synced_at?: string | null;
}

export interface CreateProjectInput {
  name: string;
}

export interface UpdateProjectInput {
  name?: string;
  status?: ProjectStatus;
  last_activity_at?: string | null;
}

export const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'converged'];

export function isValidStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && PROJECT_STATUSES.includes(value as ProjectStatus);
}

export function validateProjectName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Project name is required';
  if (name.trim().length < 2) return 'Project name must be at least 2 characters';
  if (name.trim().length > 100) return 'Project name must be 100 characters or fewer';
  return null;
}

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'No activity yet';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return 'Just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 2) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function getStatusLabel(status: ProjectStatus): string {
  const labels: Record<ProjectStatus, string> = {
    active: 'Active',
    paused: 'Paused',
    converged: 'Converged',
  };
  return labels[status] ?? status;
}

export function getStatusBadgeClasses(status: ProjectStatus): string {
  const classes: Record<ProjectStatus, string> = {
    active: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    paused: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    converged: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  };
  return classes[status] ?? classes.active;
}

export function getStatusDotClass(status: ProjectStatus): string {
  const dots: Record<ProjectStatus, string> = {
    active: 'bg-green-500',
    paused: 'bg-yellow-500',
    converged: 'bg-blue-500',
  };
  return dots[status] ?? dots.active;
}

// --- Client-side API helpers ---

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch('/api/projects', { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? 'Failed to fetch projects');
  }
  return res.json();
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const nameError = validateProjectName(input.name);
  if (nameError) throw new Error(nameError);

  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.name.trim() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? 'Failed to create project');
  return body as Project;
}

export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
  if (input.name !== undefined) {
    const nameError = validateProjectName(input.name);
    if (nameError) throw new Error(nameError);
  }
  if (input.status !== undefined && !isValidStatus(input.status)) {
    throw new Error('Invalid project status');
  }

  const res = await fetch(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? 'Failed to update project');
  return body as Project;
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? 'Failed to delete project');
  }
}
