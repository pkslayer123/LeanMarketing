export interface Project {
  id: string;
  user_id: string;
  name: string;
  status: 'active' | 'paused' | 'converged';
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'No activity yet';
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 2) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
