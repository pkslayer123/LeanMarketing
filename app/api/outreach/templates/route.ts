import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { analyseTemplate, type MessageTemplateInput } from '@/lib/outreach';

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
    .from('message_templates')
    .select('*')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .order('version', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 200 });
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: MessageTemplateInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { project_id, version, subject, body: msgBody } = body;
  if (!project_id || !version || !subject || !msgBody) {
    return NextResponse.json(
      { error: 'project_id, version, subject, and body are required' },
      { status: 400 }
    );
  }

  if (!['A', 'B'].includes(version)) {
    return NextResponse.json({ error: 'version must be A or B' }, { status: 400 });
  }

  const analysis = analyseTemplate(msgBody);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('message_templates')
    .upsert(
      {
        project_id,
        user_id: user.id,
        version,
        subject,
        body: msgBody,
        has_cta: analysis.has_cta,
        has_opt_out: analysis.has_opt_out,
        cta_count: analysis.cta_count,
        updated_at: now,
      },
      { onConflict: 'project_id,user_id,version' }
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 200 });
}
