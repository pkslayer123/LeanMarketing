import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { runQualityGate2, type AudienceInput } from '@/lib/outreach';

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
    .from('audience_definitions')
    .select('*')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 200 });
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: AudienceInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { project_id, job_roles, company_types, inclusion_rules, exclusion_rules } = body;
  if (!project_id) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

  const [leadsRes, templatesRes] = await Promise.all([
    supabase.from('leads').select('*').eq('project_id', project_id).eq('user_id', user.id),
    supabase.from('message_templates').select('*').eq('project_id', project_id).eq('user_id', user.id),
  ]);

  const tempAudience = {
    id: '', project_id, user_id: user.id,
    job_roles: job_roles ?? [],
    company_types: company_types ?? [],
    inclusion_rules: inclusion_rules ?? [],
    exclusion_rules: exclusion_rules ?? [],
    quality_gate_passed: null,
    quality_gate_feedback: null,
    created_at: '', updated_at: '',
  };

  const quality_gate_feedback = runQualityGate2({
    audience: tempAudience,
    leads: leadsRes.data ?? [],
    templates: templatesRes.data ?? [],
  });

  const { data, error } = await supabase
    .from('audience_definitions')
    .upsert(
      {
        project_id,
        user_id: user.id,
        job_roles: job_roles ?? [],
        company_types: company_types ?? [],
        inclusion_rules: inclusion_rules ?? [],
        exclusion_rules: exclusion_rules ?? [],
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
