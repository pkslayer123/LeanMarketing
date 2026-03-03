import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  identifyBottleneck,
  runQualityGate6,
  type AnalyticsReport,
  type ReviewCycleInput,
} from "@/lib/analytics";

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

  // Aggregate lead funnel
  const { data: leads, error: leadsError } = await supabase
    .from("leads")
    .select("id, status")
    .eq("project_id", projectId)
    .eq("user_id", user.id);

  if (leadsError) {
    return NextResponse.json({ error: leadsError.message }, { status: 500 });
  }

  // Aggregate conversations for stage advancement
  const { data: conversations, error: convsError } = await supabase
    .from("conversations")
    .select("id, stage")
    .eq("project_id", projectId)
    .eq("user_id", user.id);

  if (convsError) {
    return NextResponse.json({ error: convsError.message }, { status: 500 });
  }

  // Compute funnel counts
  const totalLeads = leads?.length ?? 0;
  const messagesSent = leads?.filter((l) =>
    ["contacted", "replied", "opted_out", "converted"].includes(l.status)
  ).length ?? 0;
  const replies = leads?.filter((l) =>
    ["replied", "converted"].includes(l.status)
  ).length ?? 0;
  const stageAdvances = conversations?.filter((c) =>
    ["interested", "ready_to_evaluate"].includes(c.stage)
  ).length ?? 0;
  const converted = leads?.filter((l) => l.status === "converted").length ?? 0;

  const funnel = [
    { label: "Total Leads", count: totalLeads },
    { label: "Contacted", count: messagesSent },
    { label: "Replied", count: replies },
    { label: "Stage Advanced", count: stageAdvances },
    { label: "Converted", count: converted },
  ];

  const { label: bottleneck, drop_count, drop_pct } = identifyBottleneck(funnel);

  const report: AnalyticsReport = {
    project_id: projectId,
    messages_sent: messagesSent,
    replies,
    stage_advances: stageAdvances,
    converted,
    funnel,
    bottleneck,
    bottleneck_drop_count: drop_count,
    bottleneck_drop_pct: drop_pct,
  };

  // Fetch existing review cycles
  const { data: cycles, error: cyclesError } = await supabase
    .from("review_cycles")
    .select("*")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .order("cycle_number", { ascending: false });

  if (cyclesError) {
    return NextResponse.json({ error: cyclesError.message }, { status: 500 });
  }

  return NextResponse.json({ report, cycles: cycles ?? [] }, { status: 200 });
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

  let body: ReviewCycleInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { project_id, variable_changed, hypothesis } = body;
  if (!project_id || !variable_changed || !hypothesis) {
    return NextResponse.json(
      { error: "project_id, variable_changed, and hypothesis are required." },
      { status: 400 }
    );
  }

  // Re-compute current metrics for snapshot
  const { data: leads } = await supabase
    .from("leads")
    .select("id, status")
    .eq("project_id", project_id)
    .eq("user_id", user.id);

  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, stage")
    .eq("project_id", project_id)
    .eq("user_id", user.id);

  const totalLeads = leads?.length ?? 0;
  const messagesSent = leads?.filter((l) =>
    ["contacted", "replied", "opted_out", "converted"].includes(l.status)
  ).length ?? 0;
  const replies = leads?.filter((l) =>
    ["replied", "converted"].includes(l.status)
  ).length ?? 0;
  const stageAdvances = conversations?.filter((c) =>
    ["interested", "ready_to_evaluate"].includes(c.stage)
  ).length ?? 0;
  const converted = leads?.filter((l) => l.status === "converted").length ?? 0;

  const funnel = [
    { label: "Total Leads", count: totalLeads },
    { label: "Contacted", count: messagesSent },
    { label: "Replied", count: replies },
    { label: "Stage Advanced", count: stageAdvances },
    { label: "Converted", count: converted },
  ];
  const { label: bottleneck } = identifyBottleneck(funnel);

  // Determine next cycle number
  const { data: existingCycles } = await supabase
    .from("review_cycles")
    .select("cycle_number")
    .eq("project_id", project_id)
    .eq("user_id", user.id)
    .order("cycle_number", { ascending: false })
    .limit(1);

  const nextCycleNumber = existingCycles && existingCycles.length > 0
    ? existingCycles[0].cycle_number + 1
    : 1;

  const quality_gate_feedback = runQualityGate6({
    messages_sent: messagesSent,
    bottleneck,
    variable_changed,
    hypothesis,
  });

  const { data, error } = await supabase
    .from("review_cycles")
    .insert({
      project_id,
      user_id: user.id,
      cycle_number: nextCycleNumber,
      messages_sent: messagesSent,
      replies,
      stage_advances: stageAdvances,
      bottleneck,
      variable_changed,
      hypothesis,
      quality_gate_passed: quality_gate_feedback.overall_passed,
      quality_gate_feedback,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 200 });
}
