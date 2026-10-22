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
    mode: 'filters' | 'selection';
    filters: LeadFilters;
    ids: string[] | null;
    /** Skip leads already in another active campaign (no double outreach). */
    skipActive: boolean;
    /** Skip leads contacted in the last N days (null = don't). */
    skipContactedDays: number | null;
    onlyVerified: boolean;
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
    audience: { mode: 'filters', filters: {}, ids: null, skipActive: true, skipContactedDays: 30, onlyVerified: false },
    steps: [{ key: newKey(), delay_hours: 0, variants: [emptyVariant()] }],
    account_ids: [],
    settings: defaultCampaignSettings(timezone),
    launch: 'now',
    scheduled_at: '',
  };
}

export const PACE_PRESETS = [
  {
    id: 'safe',
    label: 'Safe',
    hint: 'Best for new or warming numbers',
    values: { min_delay_sec: 75, max_delay_sec: 180, batch_size: 12, batch_pause_min: 15 },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'Recommended for established numbers',
    values: { min_delay_sec: 45, max_delay_sec: 120, batch_size: 15, batch_pause_min: 10 },
  },
  {
    id: 'fast',
    label: 'Fast',
    hint: 'Only for long-active numbers — higher ban risk',
    values: { min_delay_sec: 25, max_delay_sec: 60, batch_size: 25, batch_pause_min: 5 },
  },
] as const;

/** Matches no lead: a hand-picked audience with nothing picked must not mean “everyone”. */
export const NO_LEAD = '00000000-0000-0000-0000-000000000000';

/** Filters that decide who actually receives the campaign. */
export function effectiveFilters(a: BuilderState['audience'], skipLandlines: boolean): LeadFilters {
  return {
    ...(a.mode === 'selection' ? { ids: a.ids?.length ? a.ids : [NO_LEAD] } : a.filters),
    sendable: true,
    ...(a.skipActive ? { not_in_active_campaign: true } : {}),
    ...(a.skipContactedDays ? { not_contacted_days: a.skipContactedDays } : {}),
    ...(a.onlyVerified ? { wa_status: ['valid'] } : {}),
    ...(skipLandlines ? { phone_types: ['mobile', 'unknown'] } : {}),
  };
}
