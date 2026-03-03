import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import ProofForm from "@/components/Proof/ProofForm";
import LandingPageForm from "@/components/Proof/LandingPageForm";
import type { Proof, LandingPage } from "@/lib/proof";

interface ProofPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProofPage({ params }: ProofPageProps) {
  const { id: projectId } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const [{ data: proof }, { data: landingPage }] = await Promise.all([
    supabase
      .from("proofs")
      .select("*")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("landing_pages")
      .select("*")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <div className="mx-auto max-w-2xl space-y-8">
        {/* Header */}
        <div>
          <nav className="text-sm text-gray-500 dark:text-gray-400 mb-2">
            <a href="/projects" className="hover:underline">
              Projects
            </a>
            {" / "}
            <a href={`/projects/${projectId}`} className="hover:underline">
              Project
            </a>
            {" / "}
            <span>Proof</span>
          </nav>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Layer 4 — Proof &amp; Demonstration
          </h1>
          <p className="mt-1 text-gray-600 dark:text-gray-400">
            Show a prospect your outcome in under 10 minutes, then ask for a
            decision.
          </p>
        </div>

        {/* Quality Gate Status */}
        {proof && (
          <div
            className={`rounded-lg p-4 border ${
              proof.quality_gate_passed
                ? "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
                : "bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-base">
                {proof.quality_gate_passed ? "✓" : "⚠"}
              </span>
              <span
                className={`font-medium text-sm ${
                  proof.quality_gate_passed
                    ? "text-green-800 dark:text-green-200"
                    : "text-yellow-800 dark:text-yellow-200"
                }`}
              >
                Quality Gate 4:{" "}
                {proof.quality_gate_passed ? "Passed" : "Not yet passing"}
              </span>
            </div>
            {proof.quality_gate_feedback && (
              <ul className="mt-2 space-y-1">
                {(
                  proof.quality_gate_feedback as {
                    checks: { label: string; passed: boolean; feedback: string }[];
                  }
                ).checks?.map((check, i) => (
                  <li
                    key={i}
                    className={`text-xs flex items-start gap-1.5 ${
                      check.passed
                        ? "text-green-700 dark:text-green-300"
                        : "text-yellow-700 dark:text-yellow-300"
                    }`}
                  >
                    <span>{check.passed ? "✓" : "✗"}</span>
                    <span>{check.passed ? check.label : check.feedback}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Proof Artifact Form */}
        <div className="rounded-lg bg-white dark:bg-gray-800 p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
            Proof Artifact
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
            Choose a format: written summary, walkthrough demo, or trial access.
            Must show the outcome clearly and take under 10 minutes.
          </p>
          <ProofForm projectId={projectId} existing={proof as Proof | null} />
        </div>

        {/* Landing Page Builder */}
        <div className="rounded-lg bg-white dark:bg-gray-800 p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
            Landing Page Builder
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
            Generate a simple page to share your proof with prospects. Focus on
            their problem, the result they get, and one clear action.
          </p>
          <LandingPageForm
            projectId={projectId}
            existing={landingPage as LandingPage | null}
          />
        </div>
      </div>
    </div>
  );
}
