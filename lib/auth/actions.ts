"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabaseServer";

export async function login(formData: FormData) {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: error.message };
  }

  redirect("/");
}

export async function signup(formData: FormData) {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signUp({ email, password });

  if (error) {
    return { error: error.message };
  }

  return { success: "Check your email to confirm your account." };
}

export async function logout() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/auth/login");
}
