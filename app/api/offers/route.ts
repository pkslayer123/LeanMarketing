import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { runQualityGate, type OfferInput } from "@/lib/offers";

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

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: OfferInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { project_id, template, scope, duration_days, price_cents, success_definition } = body;
  if (!project_id || !template || !scope || !success_definition) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }
  if (!["trial", "early_access", "pilot"].includes(template)) {
    return NextResponse.json({ error: "Invalid template." }, { status: 400 });
  }

  const quality_gate_feedback = runQualityGate({
    template,
    scope,
    duration_days,
    price_cents,
    success_definition,
  });

  const { data, error } = await supabase
    .from("offers")
    .insert({
      project_id,
      user_id: user.id,
      template,
      scope,
      duration_days,
      price_cents,
      success_definition,
      status: "draft",
      quality_gate_passed: quality_gate_feedback.overall_passed,
      quality_gate_feedback,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project_id");
  if (!projectId) {
    return NextResponse.json({ error: "project_id is required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("offers")
    .select("*")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 200 });
}
