import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import IdeaForm from "@/components/IdeaForm";
import type { Idea } from "@/lib/ideas";

interface IdeaPageProps {
  params: Promise<{ id: string }>;
}

export default async function IdeaPage({ params }: IdeaPageProps) {
  const { id: projectId } = await params;

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: existing } = await supabase
    .from("ideas")
    .select("*")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <div className="mx-auto max-w-xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Define Your Idea
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Capture the core of your idea before building anything. All fields are
            required to pass the quality gate.
          </p>
        </div>
        <div className="rounded-lg bg-white dark:bg-gray-800 p-6 shadow-sm">
          <IdeaForm projectId={projectId} existing={existing as Idea | null} />
        </div>
      </div>
    </div>
  );
}
