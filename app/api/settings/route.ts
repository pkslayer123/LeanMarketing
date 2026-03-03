import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { ProjectSettingsInput } from "@/lib/settings";

function makeSupabase(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        },
      },
    }
  );
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project_id");
  if (!projectId) {
    return NextResponse.json({ error: "project_id is required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("project_settings")
    .select("*")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? { approval_mode: "strict" }, { status: 200 });
}

export async function PATCH(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ProjectSettingsInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { project_id, approval_mode } = body;
  if (!project_id || !approval_mode) {
    return NextResponse.json({ error: "project_id and approval_mode are required." }, { status: 400 });
  }

  if (!["strict", "relaxed"].includes(approval_mode)) {
    return NextResponse.json({ error: "approval_mode must be 'strict' or 'relaxed'." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("project_settings")
    .upsert(
      {
        project_id,
        user_id: user.id,
        approval_mode,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,user_id" }
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 200 });
}
