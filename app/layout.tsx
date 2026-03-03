import type { Metadata } from "next";
import "./globals.css";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

export const metadata: Metadata = {
  title: "LeanMarketing",
  description: "Built by Persona Engine",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Refresh session on every page load (Supabase SSR pattern)
  const supabase = await createServerSupabaseClient();
  await supabase.auth.getUser();

  return (
    <html lang="en">
      <body className="bg-gray-50 dark:bg-gray-900 min-h-screen">
        {children}
      </body>
    </html>
  );
}
