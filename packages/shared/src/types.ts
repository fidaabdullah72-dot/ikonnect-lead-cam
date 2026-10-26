/**
 * Row types mirroring supabase/migrations. Kept by hand (no Supabase CLI in the
 * build); the DB tests in supabase/tests exercise the same columns.
 */
import type { CampaignSettings, CampaignVariant } from './campaign';
import type { CampaignStatus, LeadSource, MessageStatus, RecipientStatus, Role, StageKind, WaAccountStatus } from './constants';

type Timestamp = string;
type UUID = string;

export type Profile = {
  id: UUID;
  email: string;
  full_name: string;
  avatar_url: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type WorkspaceSettings = {
  opt_out_keywords?: string[];
  capture_unknown_inbound?: boolean;
  auto_stage_on_send?: boolean;
  auto_stage_on_reply?: boolean;
  company_name?: string;
  currency?: string;
  scoring?: ScoringSettings;
  members_see_all_leads?: boolean;
};

export type ScoringSettings = {
  /** Which leads you pitch: those with a website, without one, or either. */
  website_target?: 'any' | 'with' | 'without';
  min_rating?: number;
  min_reviews?: number;
};

export type Workspace = {
  id: UUID;
  name: string;
  timezone: string;
  default_country: string;
  settings: WorkspaceSettings;
  created_by: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type MemberPermissions = {
  scrape?: boolean;
  create_campaigns?: boolean;
  connect_whatsapp?: boolean;
  export?: boolean;
  import?: boolean;
  delete_leads?: boolean;
  use_ai?: boolean;
  max_numbers?: number;
  daily_message_cap?: number | null;
};

export type WorkspaceMember = {
  workspace_id: UUID;
  user_id: UUID;
  role: Role;
  active: boolean;
  title: string | null;
  permissions: MemberPermissions;
  created_at: Timestamp;
};

export type Team = {
  id: UUID;
  workspace_id: UUID;
  name: string;
  description: string | null;
  color: string;
  created_by: UUID | null;
  created_at: Timestamp;
};

export type TeamMember = {
  team_id: UUID;
  workspace_id: UUID;
  user_id: UUID;
  added_at: Timestamp;
};

export type LeadList = {
  id: UUID;
  workspace_id: UUID;
  name: string;
  description: string | null;
  color: string;
  created_by: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** public.lead_list_stats(): how a list is doing. */
export type LeadListStats = {
  list_id: UUID;
  total: number;
  /** Has a phone, not opted out, not known to be off WhatsApp. */
  sendable: number;
  contacted: number;
  replied: number;
  opted_out: number;
  in_campaigns: number;
  in_active_campaigns: number;
  won: number;
  /** Campaigns whose audience used this list. */
  campaigns: number;
  last_added_at: Timestamp | null;
};

export type LeadListItem = {
  list_id: UUID;
  workspace_id: UUID;
  lead_id: UUID;
  added_by: UUID | null;
  added_at: Timestamp;
};

export type ResourceType = 'lead_list' | 'campaign' | 'automation' | 'template' | 'whatsapp_account';

export type ResourceAccess = {
  id: UUID;
  workspace_id: UUID;
  resource_type: ResourceType;
  resource_id: UUID;
  user_id: UUID | null;
  team_id: UUID | null;
  access: 'view' | 'manage';
  granted_by: UUID | null;
  created_at: Timestamp;
};

export type MemberReportRow = {
  user_id: UUID;
  full_name: string;
  email: string;
  role: Role;
  active: boolean;
  teams: string[];
  messages_sent: number;
  delivered: number;
  read: number;
  failed: number;
  replies: number;
  leads_contacted: number;
  leads_replied: number;
  leads_owned: number;
  leads_added: number;
  campaigns_created: number;
  meetings: number;
  won: number;
  won_value: number;
  numbers: number;
  numbers_connected: number;
  last_active_at: Timestamp | null;
};

export type TeamReportRow = {
  team_id: UUID;
  name: string;
  color: string;
  members: number;
  messages_sent: number;
  delivered: number;
  read: number;
  replies: number;
  leads_contacted: number;
  won: number;
  won_value: number;
};

export type CampaignSenderRow = {
  campaign_id: UUID;
  campaign_name: string;
  campaign_status: string;
  user_id: UUID | null;
  full_name: string | null;
  account_id: UUID | null;
  account_label: string | null;
  messages_sent: number;
  delivered: number;
  read: number;
  failed: number;
  leads_contacted: number;
  replied: number;
};

export type DailyReportRow = { day: string; user_id: UUID | null; sent: number; replies: number };

export type WorkspaceInvite = {
  id: UUID;
  workspace_id: UUID;
  email: string | null;
  role: Exclude<Role, 'owner'>;
  token: string;
  invited_by: UUID | null;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  accepted_by: UUID | null;
  created_at: Timestamp;
};

export type WorkspaceIntegrations = {
  workspace_id: UUID;
  google_places_api_key: string | null;
  updated_at: Timestamp;
};

export type PipelineStage = {
  id: UUID;
  workspace_id: UUID;
  name: string;
  color: string;
  position: number;
  kind: StageKind;
  created_at: Timestamp;
};

export type ScrapeLog = {
  t: string;
  level: 'info' | 'success' | 'warning' | 'error';
  text: string;
};

export type ScrapeQualify = {
  min_rating?: number;
  min_reviews?: number;
  require_mobile?: boolean;
  skip_closed?: boolean;
  website?: 'any' | 'with' | 'without';
  exclude_keywords?: string[];
};

export type ScrapeStats = {
  disqualified?: number;
  found?: number;
  inserted?: number;
  duplicates?: number;
  no_phone?: number;
  with_website?: number;
  without_website?: number;
  enriched?: number;
  errors?: number;
};

export type ScrapeJob = {
  id: UUID;
  workspace_id: UUID;
  created_by: UUID | null;
  name: string;
  provider: 'places' | 'browser';
  /** ISO country the search runs in (null: the workspace's country). */
  country: string | null;
  keywords: string[];
  locations: string[];
  queries: string[];
  /** standard: one Google search per keyword × location · deep: zone by zone across each location's map area. */
  depth: 'standard' | 'deep';
  /** Deep: at most this many map zones per keyword × location in one run (null: no limit). */
  area_limit: number | null;
  /** Deep: search zones again even if they were searched in the last 90 days. */
  recheck: boolean;
  /** Standard: results per search · deep: new businesses per map zone. */
  max_per_query: number;
  enrich: boolean;
  tags: string[];
  assign_to: UUID | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  cancel_requested: boolean;
  progress: { current?: number; total?: number; query?: string };
  stats: ScrapeStats;
  qualify: ScrapeQualify;
  logs: ScrapeLog[];
  error: string | null;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** A map zone (or standard search) already searched for a keyword — the engine's memory for deep searches. */
export type ScrapeCoverage = {
  workspace_id: UUID;
  keyword: string;
  /** Map tile "zoom/x/y", or "q:<query>" for a standard search. */
  zone: string;
  area: string;
  found: number;
  fresh: number;
  dense: boolean;
  job_id: UUID | null;
  searched_at: Timestamp;
};

export type LeadSocials = {
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  twitter?: string;
  youtube?: string;
  tiktok?: string;
};

export type Lead = {
  id: UUID;
  workspace_id: UUID;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  phone_raw: string | null;
  phone_type: 'mobile' | 'landline' | 'unknown';
  wa_status: 'unknown' | 'valid' | 'invalid';
  wa_checked_at: Timestamp | null;
  email: string | null;
  website: string | null;
  has_website: boolean;
  /** "example.com", derived from website. */
  website_domain: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  category: string | null;
  rating: number | null;
  reviews_count: number | null;
  google_maps_url: string | null;
  place_id: string | null;
  latitude: number | null;
  longitude: number | null;
  socials: LeadSocials;
  source: LeadSource;
  scrape_job_id: UUID | null;
  stage_id: UUID | null;
  owner_id: UUID | null;
  tags: string[];
  deal_value: number;
  score: number;
  score_tier: 'hot' | 'warm' | 'cold';
  opted_out: boolean;
  opted_out_at: Timestamp | null;
  last_contacted_at: Timestamp | null;
  last_replied_at: Timestamp | null;
  custom: Record<string, unknown>;
  created_by: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type LeadNote = {
  id: UUID;
  workspace_id: UUID;
  lead_id: UUID;
  author_id: UUID | null;
  body: string;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type TaskType = 'todo' | 'call' | 'meeting' | 'follow_up';

export type Task = {
  id: UUID;
  workspace_id: UUID;
  lead_id: UUID | null;
  type: TaskType;
  title: string;
  notes: string | null;
  due_at: Timestamp | null;
  assignee_id: UUID | null;
  completed_at: Timestamp | null;
  created_by: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type Activity = {
  id: UUID;
  workspace_id: UUID;
  lead_id: UUID | null;
  actor_id: UUID | null;
  type: string;
  data: Record<string, unknown>;
  created_at: Timestamp;
};

export type WhatsappAccount = {
  id: UUID;
  workspace_id: UUID;
  owner_id: UUID | null;
  label: string;
  phone: string | null;
  display_name: string | null;
  status: WaAccountStatus;
  desired_state: 'connected' | 'disconnected' | 'logged_out';
  pairing_phone: string | null;
  last_error: string | null;
  connected_at: Timestamp | null;
  last_seen_at: Timestamp | null;
  daily_limit: number;
  warmup_started_at: Timestamp | null;
  shared: boolean;
  paused_until: Timestamp | null;
  disconnect_count: number;
  last_disconnect_at: Timestamp | null;
  limits: { new_chat_quota?: number; new_chat_used?: number; cycle_end?: string; timelock_until?: string | null; timelock_type?: string; checked_at?: string };
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type WhatsappLinkCode = {
  account_id: UUID;
  workspace_id: UUID;
  qr: string | null;
  pairing_code: string | null;
  updated_at: Timestamp;
};

export type MessageTemplate = {
  id: UUID;
  workspace_id: UUID;
  scope: 'workspace' | 'personal';
  name: string;
  category: string;
  body: string;
  media_url: string | null;
  media_type: 'image' | 'document' | 'video' | null;
  media_name: string | null;
  created_by: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type CampaignAudience = {
  mode?: 'filters' | 'selection' | 'lists';
  filters?: LeadFilters;
  /** Lead lists the audience was built from (mode 'lists'). */
  list_ids?: UUID[] | null;
  options?: { skipActive?: boolean; skipContactedDays?: number | null; onlyVerified?: boolean };
  lead_count?: number;
};

export type Campaign = {
  id: UUID;
  workspace_id: UUID;
  name: string;
  description: string | null;
  status: CampaignStatus;
  created_by: UUID | null;
  audience: CampaignAudience;
  account_ids: UUID[];
  settings: Partial<CampaignSettings>;
  scheduled_at: Timestamp | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  paused_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type CampaignStep = {
  id: UUID;
  workspace_id: UUID;
  campaign_id: UUID;
  position: number;
  delay_hours: number;
  variants: CampaignVariant[];
  created_at: Timestamp;
};

export type CampaignRecipient = {
  id: UUID;
  workspace_id: UUID;
  campaign_id: UUID;
  lead_id: UUID;
  account_id: UUID | null;
  status: RecipientStatus;
  steps_sent: number;
  variant_index: number | null;
  delivery: 'none' | 'sent' | 'delivered' | 'read';
  next_send_at: Timestamp | null;
  last_sent_at: Timestamp | null;
  replied_at: Timestamp | null;
  error: string | null;
  attempts: number;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type CampaignStats = {
  campaign_id: UUID;
  workspace_id: UUID;
  total: number;
  pending: number;
  waiting: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
  completed: number;
  last_sent_at: Timestamp | null;
};

export type Conversation = {
  id: UUID;
  workspace_id: UUID;
  account_id: UUID;
  lead_id: UUID;
  assigned_to: UUID | null;
  last_message_at: Timestamp | null;
  last_message_preview: string | null;
  last_direction: 'in' | 'out' | null;
  unread_count: number;
  archived: boolean;
  /** Teammates in the chat: the number's owner and everyone who sent a message (inbox folders). */
  member_ids: UUID[];
  /** Who sent the latest outgoing message. */
  last_sender_id: UUID | null;
  created_at: Timestamp;
};

/** Inbox folder counts (inbox_folders): all chats (id null), then one row per teammate and per team. */
export type InboxFolderCount = {
  kind: 'all' | 'member' | 'team';
  id: UUID | null;
  conversations: number;
  unread: number;
};

export type Message = {
  id: UUID;
  workspace_id: UUID;
  conversation_id: UUID | null;
  lead_id: UUID;
  account_id: UUID | null;
  campaign_id: UUID | null;
  recipient_id: UUID | null;
  step: number | null;
  direction: 'in' | 'out';
  body: string;
  media_url: string | null;
  media_type: 'image' | 'document' | 'video' | 'audio' | 'sticker' | 'other' | null;
  media_name: string | null;
  wa_message_id: string | null;
  status: MessageStatus;
  error: string | null;
  sent_by: UUID | null;
  /** The lead's emoji reaction to this message. */
  reaction_in: string | null;
  /** Our emoji reaction; pending until the engine has sent it. */
  reaction_out: string | null;
  reaction_out_pending: boolean;
  /** An incoming WhatsApp Business greeting/away message: shown in the chat, never counted as a reply. */
  auto_reply: boolean;
  /** When an outgoing message reached the lead's phone. */
  delivered_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type EngineJob = {
  id: UUID;
  workspace_id: UUID;
  type: 'verify_whatsapp' | 'enrich_leads';
  payload: { lead_ids?: UUID[]; account_id?: UUID };
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: { done?: number; total?: number };
  result: Record<string, number>;
  error: string | null;
  created_by: UUID | null;
  created_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
};

export type Notification = {
  id: UUID;
  workspace_id: UUID;
  user_id: UUID;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: Timestamp | null;
  created_at: Timestamp;
};

export type EngineStatus = {
  id: string;
  instance_id: string | null;
  lease_until: Timestamp | null;
  version: string | null;
  started_at: Timestamp | null;
  heartbeat_at: Timestamp | null;
  info: { sessions?: number; connected?: number; campaigns?: number; scraping?: boolean; browser?: boolean };
};

export type WebsiteKind = 'site' | 'none' | 'social' | 'invalid';

/** Filters understood by public.filtered_leads(). */
export type LeadFilters = {
  q?: string;
  stage_ids?: UUID[];
  has_website?: boolean;
  /** site: a real website · none: no website · social: only a social page · invalid: broken link · no_site: anything but a real website */
  website?: WebsiteKind | 'no_site';
  /** Business name contains. */
  name?: string;
  /** Website domain contains. */
  domain?: string;
  cities?: string[];
  /** ISO codes. */
  countries?: string[];
  categories?: string[];
  /** Phone country calling codes, digits only: ["92", "971"]. */
  phone_codes?: string[];
  tags?: string[];
  owner_ids?: UUID[];
  unassigned?: boolean;
  /** Added (scraped / imported / created) by. */
  created_by_ids?: UUID[];
  /** never: in no campaign yet · any: in at least one campaign */
  campaign?: 'never' | 'any';
  campaign_ids?: UUID[];
  exclude_campaign_ids?: UUID[];
  wa_status?: Lead['wa_status'][];
  phone_types?: Lead['phone_type'][];
  sources?: LeadSource[];
  min_rating?: number;
  min_reviews?: number;
  opted_out?: boolean;
  contacted?: 'never' | 'contacted' | 'replied' | 'not_replied';
  not_contacted_days?: number;
  scrape_job_id?: UUID;
  created_from?: Timestamp;
  created_to?: Timestamp;
  has_phone?: boolean;
  has_email?: boolean;
  sendable?: boolean;
  tiers?: Array<'hot' | 'warm' | 'cold'>;
  min_score?: number;
  not_in_active_campaign?: boolean;
  exclude_campaign_id?: UUID;
  list_ids?: UUID[];
  ids?: UUID[];
};

export type SavedView = {
  id: UUID;
  workspace_id: UUID;
  name: string;
  filters: LeadFilters;
  shared: boolean;
  created_by: UUID | null;
  created_at: Timestamp;
};

export type DuplicateGroup = {
  match_type: 'name_city' | 'website';
  match_key: string;
  lead_ids: UUID[];
  names: string[];
  total: number;
};

export type ChatChannel = {
  id: UUID;
  workspace_id: UUID;
  kind: 'channel' | 'dm';
  name: string | null;
  description: string | null;
  is_private: boolean;
  is_default: boolean;
  dm_key: string | null;
  created_by: UUID | null;
  last_message_at: Timestamp | null;
  archived: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type ChatMember = {
  channel_id: UUID;
  workspace_id: UUID;
  user_id: UUID;
  last_read_at: Timestamp;
  muted: boolean;
  joined_at: Timestamp;
};

export type ChatMessage = {
  id: UUID;
  workspace_id: UUID;
  channel_id: UUID;
  author_id: UUID | null;
  body: string;
  lead_id: UUID | null;
  reply_to: UUID | null;
  mentions: UUID[];
  edited_at: Timestamp | null;
  deleted_at: Timestamp | null;
  /** Bumped whenever a reaction is added or removed (drives live updates). */
  reacted_at: Timestamp | null;
  created_at: Timestamp;
};

export type ChatReaction = {
  message_id: UUID;
  workspace_id: UUID;
  user_id: UUID;
  emoji: string;
  created_at: Timestamp;
};

export type CampaignEvent = {
  id: number;
  workspace_id: UUID;
  campaign_id: UUID;
  lead_id: UUID | null;
  account_id: UUID | null;
  type: 'sent' | 'failed' | 'skipped' | 'replied' | 'opted_out' | 'started' | 'paused' | 'resumed' | 'completed' | 'waiting' | 'info';
  message: string;
  created_at: Timestamp;
};

export type AutomationTrigger = 'reply_received' | 'keyword' | 'stage_changed' | 'campaign_no_reply' | 'lead_created';

export type AutomationAction =
  | { type: 'send_template'; template_id: UUID }
  | { type: 'send_text'; body: string }
  | { type: 'move_stage'; stage_id: UUID }
  | { type: 'assign'; user_id: UUID | 'round_robin' }
  | { type: 'add_tag'; tag: string }
  | { type: 'create_task'; title: string; due_in_hours?: number; assignee?: UUID | 'owner' }
  | { type: 'notify'; target: 'owner' | 'admins' | UUID; message?: string };

export type AutomationConditions = {
  keywords?: string[];
  match?: 'any' | 'exact';
  stage_id?: UUID;
  from_stage_id?: UUID;
  campaign_id?: UUID;
  first_reply_only?: boolean;
  outside_hours?: { start: string; end: string; days: number[]; timezone: string } | null;
  sources?: string[];
};

export type Automation = {
  id: UUID;
  workspace_id: UUID;
  /** null = workspace-wide (optionally assigned to members/teams); set = personal to that member */
  owner_id: UUID | null;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationConditions;
  actions: AutomationAction[];
  created_by: UUID | null;
  run_count: number;
  last_run_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type AutomationRun = {
  id: number;
  workspace_id: UUID;
  automation_id: UUID;
  lead_id: UUID | null;
  status: 'success' | 'failed' | 'skipped';
  detail: string;
  created_at: Timestamp;
};

export type AccountHealth = {
  account_id: UUID;
  sent_today: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replies: number;
};

export type ChatOverviewRow = { channel_id: UUID; unread: number; mentions: number; last_message_at: Timestamp | null };

/** public.lead_inventory(): the team's lead bank. */
export type LeadInventory = {
  totals: {
    total: number;
    new_24h: number;
    new_7d: number;
    scraped: number;
    in_campaigns: number;
    available: number;
    contacted: number;
    replied: number;
    with_site: number;
    without_site: number;
    countries: number;
  };
  by_member: Array<{ user_id: UUID; count: number; new_7d: number; last_added: Timestamp }>;
  by_country: Array<{ code: string; count: number }>;
  recent_jobs: Array<{
    id: UUID;
    name: string;
    created_by: UUID | null;
    status: ScrapeJob['status'];
    country: string | null;
    created_at: Timestamp;
    finished_at: Timestamp | null;
    inserted: number;
    duplicates: number;
  }>;
};

export type DashboardOverview = {
  timezone: string;
  days: number;
  leads: { total: number; new_7d: number; new_period: number; with_website: number; without_website: number; on_whatsapp: number; opted_out: number };
  messages: { sent_today: number; sent: number; delivered: number; read: number; failed: number; received: number; leads_messaged: number; leads_replied: number };
  campaigns_active: number;
  accounts_connected: number;
  accounts_total: number;
  won: { count: number; value: number };
  open_value: number;
  series: Array<{ day: string; sent: number; delivered: number; read: number; replies: number; leads: number }>;
  stages: Array<{ id: UUID; name: string; color: string; kind: StageKind; position: number; count: number; value: number }>;
  top_cities: Array<{ name: string; count: number }>;
  top_categories: Array<{ name: string; count: number }>;
};

export type TeamPerformanceRow = {
  user_id: UUID;
  full_name: string;
  email: string;
  role: Role;
  messages_sent: number;
  replies: number;
  leads_owned: number;
  won: number;
  won_value: number;
  accounts_connected: number;
};

export type LeadFacets = {
  cities: Array<{ value: string; count: number }>;
  countries: Array<{ value: string; count: number }>;
  categories: Array<{ value: string; count: number }>;
  tags: Array<{ value: string; count: number }>;
};

// ---------------------------------------------------------------------------
// Supabase `Database` type for typed clients
// ---------------------------------------------------------------------------

type Rel<Name extends string, Cols extends string[], Ref extends string, RefCols extends string[] = ['id']> = {
  foreignKeyName: Name;
  columns: Cols;
  isOneToOne: false;
  referencedRelation: Ref;
  referencedColumns: RefCols;
};

/** Columns with DB defaults (or generated) are optional on insert. */
type TableDef<Row, Required extends keyof Row, Rels extends unknown[] = []> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>;
  Update: Partial<Row>;
  Relationships: Rels;
};

export type Database = {
  public: {
    Tables: {
      profiles: TableDef<Profile, 'id'>;
      workspaces: TableDef<Workspace, 'name'>;
      workspace_members: TableDef<
        WorkspaceMember,
        'workspace_id' | 'user_id',
        [
          Rel<'workspace_members_user_id_fkey', ['user_id'], 'profiles'>,
          Rel<'workspace_members_workspace_id_fkey', ['workspace_id'], 'workspaces'>,
        ]
      >;
      workspace_invites: TableDef<WorkspaceInvite, 'workspace_id'>;
      workspace_integrations: TableDef<WorkspaceIntegrations, 'workspace_id'>;
      pipeline_stages: TableDef<PipelineStage, 'workspace_id' | 'name'>;
      scrape_jobs: TableDef<ScrapeJob, 'workspace_id'>;
      scrape_coverage: TableDef<ScrapeCoverage, 'workspace_id' | 'keyword' | 'zone'>;
      leads: TableDef<Lead, 'workspace_id' | 'business_name'>;
      lead_notes: TableDef<LeadNote, 'workspace_id' | 'lead_id' | 'body'>;
      tasks: TableDef<
        Task,
        'workspace_id' | 'title',
        [Rel<'tasks_workspace_id_lead_id_fkey', ['workspace_id', 'lead_id'], 'leads', ['workspace_id', 'id']>]
      >;
      activities: TableDef<Activity, 'workspace_id' | 'type'>;
      whatsapp_accounts: TableDef<WhatsappAccount, 'workspace_id'>;
      whatsapp_link_codes: TableDef<WhatsappLinkCode, 'account_id' | 'workspace_id'>;
      message_templates: TableDef<MessageTemplate, 'workspace_id' | 'name' | 'body'>;
      campaigns: TableDef<Campaign, 'workspace_id' | 'name'>;
      campaign_steps: TableDef<CampaignStep, 'workspace_id' | 'campaign_id' | 'position'>;
      campaign_recipients: TableDef<
        CampaignRecipient,
        'workspace_id' | 'campaign_id' | 'lead_id',
        [Rel<'campaign_recipients_workspace_id_lead_id_fkey', ['workspace_id', 'lead_id'], 'leads', ['workspace_id', 'id']>]
      >;
      conversations: TableDef<
        Conversation,
        'workspace_id' | 'account_id' | 'lead_id',
        [
          Rel<'conversations_workspace_id_lead_id_fkey', ['workspace_id', 'lead_id'], 'leads', ['workspace_id', 'id']>,
          Rel<'conversations_workspace_id_account_id_fkey', ['workspace_id', 'account_id'], 'whatsapp_accounts', ['workspace_id', 'id']>,
        ]
      >;
      messages: TableDef<Message, 'workspace_id' | 'lead_id' | 'direction'>;
      engine_jobs: TableDef<EngineJob, 'workspace_id' | 'type'>;
      notifications: TableDef<Notification, 'workspace_id' | 'user_id' | 'type' | 'title'>;
      engine_status: TableDef<EngineStatus, 'id'>;
      wa_auth_keys: TableDef<{ account_id: UUID; key: string; value: string; updated_at: Timestamp }, 'account_id' | 'key' | 'value'>;
      saved_views: TableDef<SavedView, 'workspace_id' | 'name'>;
      duplicate_dismissals: TableDef<
        { workspace_id: UUID; match_type: string; match_key: string; dismissed_by: UUID | null; created_at: Timestamp },
        'workspace_id' | 'match_type' | 'match_key'
      >;
      chat_channels: TableDef<ChatChannel, 'workspace_id'>;
      chat_members: TableDef<ChatMember, 'channel_id' | 'workspace_id' | 'user_id'>;
      chat_messages: TableDef<
        ChatMessage,
        'workspace_id' | 'channel_id',
        [Rel<'chat_messages_workspace_id_lead_id_fkey', ['workspace_id', 'lead_id'], 'leads', ['workspace_id', 'id']>]
      >;
      chat_reactions: TableDef<ChatReaction, 'message_id' | 'workspace_id' | 'user_id' | 'emoji'>;
      campaign_events: TableDef<CampaignEvent, 'workspace_id' | 'campaign_id' | 'type'>;
      automations: TableDef<Automation, 'workspace_id' | 'name' | 'trigger'>;
      automation_runs: TableDef<AutomationRun, 'workspace_id' | 'automation_id' | 'status'>;
      teams: TableDef<Team, 'workspace_id' | 'name'>;
      team_members: TableDef<TeamMember, 'team_id' | 'workspace_id' | 'user_id'>;
      lead_lists: TableDef<LeadList, 'workspace_id' | 'name'>;
      lead_list_items: TableDef<LeadListItem, 'list_id' | 'workspace_id' | 'lead_id'>;
      resource_access: TableDef<ResourceAccess, 'workspace_id' | 'resource_type' | 'resource_id'>;
      automation_queue: TableDef<
        { id: number; workspace_id: UUID; trigger: string; lead_id: UUID | null; payload: Record<string, unknown>; created_at: Timestamp; processed_at: Timestamp | null },
        'workspace_id' | 'trigger'
      >;
    };
    Views: {
      campaign_stats: { Row: CampaignStats; Relationships: [] };
    };
    Functions: {
      create_workspace: { Args: { p_name: string; p_timezone?: string; p_country?: string }; Returns: string };
      get_invite: {
        Args: { p_token: string };
        Returns: Array<{ workspace_name: string; role: Role; email: string | null; invited_by_name: string | null; expired: boolean; accepted: boolean }>;
      };
      accept_invite: { Args: { p_token: string }; Returns: string };
      filtered_leads: {
        Args: { p_workspace: string; p_filters?: LeadFilters };
        Returns: Lead[];
        SetofOptions: { from: '*'; to: 'leads'; isOneToOne: false; isSetofReturn: true };
      };
      lead_facets: { Args: { p_workspace: string }; Returns: LeadFacets };
      lead_inventory: { Args: { p_workspace: string }; Returns: LeadInventory };
      leads_bulk_action: {
        Args: { p_workspace: string; p_action: string; p_ids?: string[] | null; p_filters?: LeadFilters | null; p_value?: unknown };
        Returns: number;
      };
      delete_stage: { Args: { p_stage: string; p_move_to?: string | null }; Returns: undefined };
      campaign_add_recipients: { Args: { p_campaign: string; p_filters?: LeadFilters | null; p_lead_ids?: string[] | null }; Returns: number };
      campaign_variant_stats: {
        Args: { p_campaign: string };
        Returns: Array<{ step: number; variant_index: number; sent: number; delivered: number; read: number; replied: number }>;
      };
      claim_next_recipient: {
        Args: { p_campaign: string; p_account: string };
        Returns: CampaignRecipient[];
        SetofOptions: { from: '*'; to: 'campaign_recipients'; isOneToOne: false; isSetofReturn: true };
      };
      dashboard_overview: { Args: { p_workspace: string; p_days?: number }; Returns: DashboardOverview };
      team_performance: { Args: { p_workspace: string; p_days?: number }; Returns: TeamPerformanceRow[] };
      rescore_leads: { Args: { p_workspace: string }; Returns: number };
      lead_duplicate_groups: { Args: { p_workspace: string; p_limit?: number }; Returns: DuplicateGroup[] };
      merge_leads: { Args: { p_keep: string; p_merge: string[] }; Returns: number };
      chat_create_channel: {
        Args: { p_workspace: string; p_name: string; p_description?: string | null; p_private?: boolean; p_member_ids?: string[] };
        Returns: string;
      };
      chat_open_dm: { Args: { p_workspace: string; p_user_ids: string[] }; Returns: string };
      chat_add_members: { Args: { p_channel: string; p_user_ids: string[] }; Returns: number };
      message_react: { Args: { p_message: string; p_emoji: string }; Returns: undefined };
      chat_overview: { Args: { p_workspace: string }; Returns: ChatOverviewRow[] };
      account_health: { Args: { p_workspace: string; p_days?: number }; Returns: AccountHealth[] };
      engine_acquire_lease: { Args: { p_instance: string; p_ttl_seconds?: number }; Returns: boolean };
      engine_release_lease: { Args: { p_instance: string }; Returns: undefined };
      lead_list_add: { Args: { p_list: string; p_ids?: string[] | null; p_filters?: LeadFilters | null }; Returns: number };
      lead_list_stats: { Args: { p_workspace: string }; Returns: LeadListStats[] };
      report_members: { Args: { p_workspace: string; p_from: string; p_to: string }; Returns: MemberReportRow[] };
      report_teams: { Args: { p_workspace: string; p_from: string; p_to: string }; Returns: TeamReportRow[] };
      report_campaign_senders: { Args: { p_workspace: string; p_from: string; p_to: string; p_campaign?: string | null }; Returns: CampaignSenderRow[] };
      report_daily: { Args: { p_workspace: string; p_from: string; p_to: string }; Returns: DailyReportRow[] };
      inbox_folders: { Args: { p_workspace: string }; Returns: InboxFolderCount[] };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
