import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import {
  ConversationStage,
  runQualityGate3,
  suggestNextAction,
} from '@/lib/conversations';

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

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('conversations')
    .select('*, leads(id, name, email), conversation_messages(*)')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  return NextResponse.json(data);
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { stage?: ConversationStage; next_action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.stage) {
    updates.stage = body.stage;
    updates.next_action = suggestNextAction(body.stage);
  }
  if (body.next_action !== undefined) {
    updates.next_action = body.next_action;
  }

  const { data: messages } = await supabase
    .from('conversation_messages')
    .select('direction, classified_stage')
    .eq('conversation_id', id);

  const quality_gate_feedback = runQualityGate3(messages ?? []);
  updates.quality_gate_passed = quality_gate_feedback.overall_passed;
  updates.quality_gate_feedback = quality_gate_feedback;

  const { data, error } = await supabase
    .from('conversations')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
