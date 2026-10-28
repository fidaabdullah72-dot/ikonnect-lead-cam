import { defaultCampaignSettings, type CampaignSettings, type CampaignVariant, type LeadFilters } from '@batsols/shared';

export interface BuilderStep {
  key: string;
  delay_hours: number;
  variants: CampaignVariant[];
}

export interface BuilderState {
  name: string;
  description: string;
  audience: {
    mode: 'filters' | 'selection' | 'lists';
    filters: LeadFilters;
    ids: string[] | null;
    /** Lead lists to message (mode 'lists'); `filters` can narrow them down. */
    list_ids: string[];
    /** Skip leads already in another active campaign (no double outreach). */
    skipActive: boolean;
    /** Skip leads contacted in the last N days (null = don't). */
    skipContactedDays: number | null;
    onlyVerified: boolean;
    /** Message only this many of the matching leads, best-scored first (null = all). */
    limit: number | null;
  };
  steps: BuilderStep[];
  account_ids: string[];
  settings: CampaignSettings;
  launch: 'now' | 'schedule' | 'draft';
  scheduled_at: string;
}

export const newKey = () => Math.random().toString(36).slice(2, 10);

export const emptyVariant = (): CampaignVariant => ({ body: '', media_url: null, media_type: null, media_name: null });

export function initialState(timezone: string): BuilderState {
  return {
    name: '',
    description: '',
    audience: { mode: 'filters', filters: {}, ids: null, list_ids: [], skipActive: true, skipContactedDays: 30, onlyVerified: false, limit: null },
    steps: [{ key: newKey(), delay_hours: 0, variants: [emptyVariant()] }],
    account_ids: [],
    settings: defaultCampaignSettings(timezone),
    launch: 'now',
    scheduled_at: '',
  };
}

/** Safe mode: nothing faster than "Standard" (2–4 minutes apart) is allowed — see SAFE_PACE. */
export const PACE_PRESETS = [
  {
    id: 'safest',
    label: 'Safest',
    hint: 'New, warming or recently restricted numbers',
    values: { min_delay_sec: 240, max_delay_sec: 480, batch_size: 6, batch_pause_min: 30 },
  },
  {
    id: 'safe',
    label: 'Safe',
    hint: 'Recommended for every number',
    values: { min_delay_sec: 150, max_delay_sec: 300, batch_size: 8, batch_pause_min: 20 },
  },
  {
    id: 'standard',
    label: 'Standard',
    hint: 'Only for long-active numbers with good replies',
    values: { min_delay_sec: 120, max_delay_sec: 240, batch_size: 10, batch_pause_min: 15 },
  },
] as const;

/** Matches no lead: a hand-picked audience with nothing picked must not mean “everyone”. */
export const NO_LEAD = '00000000-0000-0000-0000-000000000000';

/** The audience before the sending rules: hand-picked leads, leads in the picked lists, or leads matching filters. */
export function audienceFilters(a: BuilderState['audience']): LeadFilters {
  if (a.mode === 'selection') return { ids: a.ids?.length ? a.ids : [NO_LEAD] };
  // An empty pick must not mean "every lead".
  if (a.mode === 'lists') return { ...a.filters, list_ids: a.list_ids.length ? a.list_ids : [NO_LEAD] };
  return a.filters;
}

/** The "how many leads" cap; hand-picked audiences are never capped. */
export const audienceLimit = (a: BuilderState['audience']) => (a.mode !== 'selection' && a.limit && a.limit > 0 ? a.limit : null);

/** Filters that decide who actually receives the campaign. */
export function effectiveFilters(a: BuilderState['audience'], skipLandlines: boolean): LeadFilters {
  return {
    ...audienceFilters(a),
    sendable: true,
    ...(a.skipActive ? { not_in_active_campaign: true } : {}),
    ...(a.skipContactedDays ? { not_contacted_days: a.skipContactedDays } : {}),
    ...(a.onlyVerified ? { wa_status: ['valid'] } : {}),
    ...(skipLandlines ? { phone_types: ['mobile', 'unknown'] } : {}),
  };
}
