import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServer } from '@/lib/supabase/server';

const Body = z.object({
  workspace_id: z.string().uuid(),
  lead_ids: z.array(z.string().uuid()).max(5000),
  /** The campaign being filled (its own recipients don't count). */
  campaign_id: z.string().uuid().optional(),
});

/** Same rule as the engine: a lead another campaign messaged within this time is taken. */
const RECENT_OUTREACH_MS = 30 * 86400_000;
const CHUNK = 150;

/**
 * Which of these leads are already taken by another campaign — queued in an active one, or messaged in the last
 * 30 days — whoever created it. Members can't see each other's campaigns, so this check runs with the service
 * role; it only answers for the leads asked about and only says "taken", nothing about the other campaign.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { workspace_id, lead_ids, campaign_id } = parsed.data;

  const supabase = await createSupabaseServer();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub as string | undefined;
  if (!userId) return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
  const { data: me } = await supabase.from('workspace_members').select('active').eq('workspace_id', workspace_id).eq('user_id', userId).maybeSingle();
  if (!me?.active) return NextResponse.json({ error: 'You are not an active member of this workspace' }, { status: 403 });

  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'Server is missing SUPABASE_SERVICE_ROLE_KEY' }, { status: 500 });

  const since = Date.now() - RECENT_OUTREACH_MS;
  const busy = new Set<string>();
  const chunks: string[][] = [];
  for (let i = 0; i < lead_ids.length; i += CHUNK) chunks.push(lead_ids.slice(i, i + CHUNK));
  for (let i = 0; i < chunks.length; i += 5) {
    const results = await Promise.all(
      chunks.slice(i, i + 5).map((ids) =>
        admin
          .from('campaign_recipients')
          .select('lead_id, campaign_id, status, steps_sent, last_sent_at, campaigns!inner(status)')
          .eq('workspace_id', workspace_id)
          .in('lead_id', ids),
      ),
    );
    for (const { data, error } of results) {
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      for (const r of (data ?? []) as unknown as Array<{ lead_id: string; campaign_id: string; status: string; steps_sent: number; last_sent_at: string | null; campaigns: { status: string } }>) {
        if (r.campaign_id === campaign_id) continue;
        const queued = ['running', 'paused', 'scheduled'].includes(r.campaigns.status) && ['pending', 'waiting', 'sending'].includes(r.status);
        const messaged = r.steps_sent > 0 && !!r.last_sent_at && Date.parse(r.last_sent_at) > since;
        if (queued || messaged) busy.add(r.lead_id);
      }
    }
  }
  return NextResponse.json({ busy: [...busy] });
}
