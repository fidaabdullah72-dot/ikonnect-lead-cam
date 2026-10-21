'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cpu, ExternalLink, KeyRound, MapPin, ServerCog, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { ScoringSettings } from '@batsols/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { getSupabase } from '@/lib/supabase/client';
import { useEngineStatus } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage, timeAgo } from '@/lib/utils';

export default function IntegrationsPage() {
  const { workspace, can, setWorkspace } = useWorkspace();
  const engine = useEngineStatus();
  // A separate scraper-only engine (ENGINE_ROLE=scraper) reports in on its own row.
  const scraper = useQuery({
    queryKey: ['engine-scraper'],
    queryFn: async () => (await getSupabase().from('engine_status').select('heartbeat_at').eq('id', 'scraper').maybeSingle()).data,
    refetchInterval: 60_000,
  });
  const scraperOnline = Boolean(scraper.data?.heartbeat_at && Date.now() - new Date(scraper.data.heartbeat_at).getTime() < 120_000);
  const browserReady = Boolean(engine.status?.info?.browser) || scraperOnline;
  const integ = useQuery({
    queryKey: ['integrations', workspace.id],
    enabled: can.admin,
    queryFn: async () => (await getSupabase().from('workspace_integrations').select('*').eq('workspace_id', workspace.id).maybeSingle()).data,
  });
  const [key, setKey] = React.useState('');
  React.useEffect(() => setKey(integ.data?.google_places_api_key ?? ''), [integ.data]);
  const [scoring, setScoring] = React.useState<ScoringSettings>({ website_target: 'any', min_rating: 4, min_reviews: 20, ...(workspace.settings.scoring ?? {}) });
  const [busy, setBusy] = React.useState(false);

  async function saveKey() {
    const { error } = await getSupabase().from('workspace_integrations').upsert({ workspace_id: workspace.id, google_places_api_key: key.trim() || null });
    if (error) return toast.error(errorMessage(error));
    toast.success('Google Places key saved');
  }
  async function saveScoring() {
    setBusy(true);
    const sb = getSupabase();
    const settings = { ...workspace.settings, scoring };
    const { data, error } = await sb.from('workspaces').update({ settings }).eq('id', workspace.id).select('*').single();
    if (error) {
      setBusy(false);
      return toast.error(errorMessage(error));
    }
    setWorkspace(data);
    const { data: n } = await sb.rpc('rescore_leads', { p_workspace: workspace.id });
    setBusy(false);
    toast.success(`Scoring updated · ${n ?? 0} leads rescored`);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader icon={<ServerCog />} title="BatSols engine" description="Runs WhatsApp, campaigns, the lead finder and automations." />
        <CardContent className="flex flex-wrap items-center gap-4 text-[13px]">
          <Badge tone={engine.online ? 'success' : 'danger'} dot pulse={engine.online}>
            {engine.online ? 'Online' : 'Offline'}
          </Badge>
          <span className="text-muted">Last heartbeat {timeAgo(engine.status?.heartbeat_at)}</span>
          {engine.status?.version && <span className="text-muted">Version {engine.status.version}</span>}
          <span className="text-muted">{engine.status?.info?.connected ?? 0} WhatsApp sessions connected</span>
          <span className="text-muted">Google Maps search {browserReady ? 'available' : 'not available'}</span>
        </CardContent>
      </Card>

      {can.admin && (
        <Card>
          <CardHeader icon={<MapPin />} title="Google Places API" description="Powers the recommended lead-finder source: reliable, fast and within Google’s terms." />
          <CardContent className="space-y-3">
            <Field label="API key" hint="Google Cloud Console → APIs & Services → enable “Places API (New)” → Credentials → Create API key.">
              <Input type="password" leading={<KeyRound />} value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" />
            </Field>
            <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href="https://console.cloud.google.com/apis/library/places.googleapis.com" target="_blank" rel="noreferrer">
              Open Google Cloud <ExternalLink className="size-3" />
            </a>
            <Callout tone="info">Google gives a free monthly allowance; each search returns up to 20 businesses per request. Only admins can see this key.</Callout>
          </CardContent>
          <CardFooter>
            <Button variant="primary" onClick={saveKey}>
              Save key
            </Button>
          </CardFooter>
        </Card>
      )}

      {can.admin && (
        <Card>
          <CardHeader icon={<Sparkles />} title="Lead scoring" description="Every lead gets a 0–100 quality score (Hot 70+, Warm 40–69, Cold). Tell BatSols what a good lead looks like for you." />
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <Field label="You sell to businesses…">
              <NativeSelect value={scoring.website_target ?? 'any'} onChange={(e) => setScoring({ ...scoring, website_target: e.target.value as ScoringSettings['website_target'] })}>
                <option value="any">With or without a website</option>
                <option value="without">Without a website (web design)</option>
                <option value="with">With a website (chatbots, SEO, ads)</option>
              </NativeSelect>
            </Field>
            <Field label="Good Google rating">
              <Input type="number" step="0.1" min={0} max={5} value={scoring.min_rating ?? 4} onChange={(e) => setScoring({ ...scoring, min_rating: Number(e.target.value) })} />
            </Field>
            <Field label="Good number of reviews">
              <Input type="number" min={0} value={scoring.min_reviews ?? 20} onChange={(e) => setScoring({ ...scoring, min_reviews: Number(e.target.value) })} />
            </Field>
            <p className="text-xs text-muted sm:col-span-3">
              Points: phone (+15), mobile (+15), verified on WhatsApp (+20), rating and reviews (up to +25), website match (+15), email (+5), replied (+15). Opted-out leads score 0.
            </p>
          </CardContent>
          <CardFooter>
            <Button variant="primary" onClick={saveScoring} loading={busy}>
              <Cpu /> Save & rescore all leads
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
