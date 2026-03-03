import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabaseServer';
import ConversationsDashboard from '@/components/Conversations/ConversationsDashboard';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ConversationsPage({ params }: PageProps) {
  const { id: projectId } = await params;
  const supabase = await createServerSupabaseClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/login');

  // Verify project ownership
  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single();

  if (!project) redirect('/dashboard');

  // Fetch conversations with lead data
  const { data: conversations } = await supabase
    .from('conversations')
    .select('*, leads(id, name, email)')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });

  // Fetch leads for this project (to start new conversations)
  const { data: leads } = await supabase
    .from('leads')
    .select('id, name, email')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <nav className="text-sm text-gray-500 dark:text-gray-400 mb-2">
            <a href="/dashboard" className="hover:text-indigo-600">Dashboard</a>
            <span className="mx-2">/</span>
            <a href={`/projects/${projectId}/idea`} className="hover:text-indigo-600">
              {project.name}
            </a>
            <span className="mx-2">/</span>
            <span className="text-gray-900 dark:text-white">Conversations</span>
          </nav>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Conversation & Qualification
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Log outreach, classify replies, and track leads through qualification stages.
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 h-[calc(100vh-220px)]">
          <ConversationsDashboard
            projectId={projectId}
            initialConversations={conversations ?? []}
            leads={leads ?? []}
          />
        </div>
      </div>
    </div>
  );
}
