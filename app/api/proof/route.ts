import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { runQualityGate, type ProofInput } from '@/lib/proof';

function makeSupabase(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
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
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('project_id');
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

  const { data, error } = await supabase
    .from('proofs')
    .select('*')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 200 });
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: ProofInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { project_id, proof_type, title, outcome_description, consumption_time_minutes, decision_request } = body;
  if (!project_id || !proof_type || !title || !outcome_description || !consumption_time_minutes || !decision_request) {
    return NextResponse.json(
      { error: 'project_id, proof_type, title, outcome_description, consumption_time_minutes, and decision_request are required' },
      { status: 400 }
    );
  }

  const quality_gate_feedback = runQualityGate({
    proof_type,
    title,
    outcome_description,
    proof_url: body.proof_url,
    content: body.content,
    consumption_time_minutes,
    decision_request,
  });

  const { data, error } = await supabase
    .from('proofs')
    .upsert(
      {
        project_id,
        user_id: user.id,
        proof_type,
        title,
        outcome_description,
        proof_url: body.proof_url ?? null,
        content: body.content ?? null,
        consumption_time_minutes,
        decision_request,
        quality_gate_passed: quality_gate_feedback.overall_passed,
        quality_gate_feedback,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,user_id' }
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 200 });
}
