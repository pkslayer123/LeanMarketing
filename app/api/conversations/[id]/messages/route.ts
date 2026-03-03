import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import {
  MessageInput,
  ConversationStage,
  STAGE_ORDER,
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

  const { data: conversation } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data, error } = await supabase
    .from('conversation_messages')
    .select('*')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data ?? []);
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, stage')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: MessageInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { direction, content, classified_stage } = body;

  if (!direction || !content?.trim()) {
    return NextResponse.json(
      { error: 'direction and content are required' },
      { status: 400 }
    );
  }

  const { data: message, error: msgError } = await supabase
    .from('conversation_messages')
    .insert({
      conversation_id: id,
      user_id: user.id,
      direction,
      content: content.trim(),
      classified_stage: classified_stage ?? null,
    })
    .select()
    .single();

  if (msgError) return NextResponse.json({ error: msgError.message }, { status: 500 });

  const { data: allMessages } = await supabase
    .from('conversation_messages')
    .select('direction, classified_stage')
    .eq('conversation_id', id);

  const quality_gate_feedback = runQualityGate3(allMessages ?? []);

  // Advance stage if inbound message has a higher classification
  let newStage: ConversationStage = conversation.stage;
  if (direction === 'inbound' && classified_stage) {
    const currentIdx = STAGE_ORDER.indexOf(conversation.stage);
    const newIdx = STAGE_ORDER.indexOf(classified_stage);
    if (newIdx > currentIdx) newStage = classified_stage;
  }

  await supabase
    .from('conversations')
    .update({
      stage: newStage,
      next_action: suggestNextAction(newStage),
      quality_gate_passed: quality_gate_feedback.overall_passed,
      quality_gate_feedback,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', user.id);

  return NextResponse.json(message, { status: 201 });
}
