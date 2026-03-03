import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

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

interface MockSendInput {
  campaign_id: string;
  lead_id: string;
  template_version: 'A' | 'B';
}

/**
 * POST /api/outreach/send
 *
 * Provider-neutral mock sender for Milestone 1 / end-to-end testing.
 * Records the send in outreach_sends without calling any real email provider.
 * Respects the campaign's daily_cap by counting sends in the last 24 h.
 * Marks the lead as 'contacted' and returns the send record.
 */
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = makeSupabase(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: MockSendInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { campaign_id, lead_id, template_version } = body;
  if (!campaign_id || !lead_id || !template_version) {
    return NextResponse.json(
      { error: 'campaign_id, lead_id, and template_version are required' },
      { status: 400 }
    );
  }

  if (!['A', 'B'].includes(template_version)) {
    return NextResponse.json({ error: 'template_version must be A or B' }, { status: 400 });
  }

  // Verify the campaign belongs to this user
  const { data: campaign, error: campaignErr } = await supabase
    .from('outreach_campaigns')
    .select('id, daily_cap, stop_on_reply, status')
    .eq('id', campaign_id)
    .eq('user_id', user.id)
    .single();

  if (campaignErr || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  if (campaign.status === 'stopped') {
    return NextResponse.json({ error: 'Campaign is stopped' }, { status: 409 });
  }

  // Check daily cap
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('outreach_sends')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaign_id)
    .gte('created_at', since);

  if ((count ?? 0) >= campaign.daily_cap) {
    return NextResponse.json(
      { error: 'Daily cap reached', daily_cap: campaign.daily_cap },
      { status: 429 }
    );
  }

  // If stop_on_reply, check if any lead has replied
  if (campaign.stop_on_reply) {
    const { data: replied } = await supabase
      .from('outreach_sends')
      .select('id')
      .eq('campaign_id', campaign_id)
      .eq('status', 'replied')
      .limit(1);

    if (replied && replied.length > 0) {
      return NextResponse.json(
        { error: 'Campaign stopped due to reply' },
        { status: 409 }
      );
    }
  }

  // Record the mock send
  const sentAt = new Date().toISOString();
  const { data: send, error: sendErr } = await supabase
    .from('outreach_sends')
    .insert({
      campaign_id,
      lead_id,
      template_version,
      status: 'sent',
      sent_at: sentAt,
    })
    .select()
    .single();

  if (sendErr) return NextResponse.json({ error: sendErr.message }, { status: 500 });

  // Update lead status to 'contacted'
  await supabase
    .from('leads')
    .update({ status: 'contacted', updated_at: sentAt })
    .eq('id', lead_id)
    .eq('user_id', user.id);

  return NextResponse.json({ send, mock: true }, { status: 201 });
}
