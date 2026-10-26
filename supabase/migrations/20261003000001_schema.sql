-- ============================================================================
-- BatWos CRM — core schema
-- Every business table carries workspace_id; access is enforced by RLS
-- (see 20261003000002_rls.sql). User references point at public.profiles so
-- PostgREST can embed member names (profiles.id = auth.users.id).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Users, workspaces & membership
-- ---------------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null default '',
  full_name   text not null default '',
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.workspaces (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(btrim(name)) between 1 and 80),
  timezone         text not null default 'Asia/Karachi',
  default_country  text not null default 'PK' check (default_country ~ '^[A-Z]{2}$'),
  -- { capture_unknown_inbound, opt_out_keywords[], auto_stage_on_send, auto_stage_on_reply }
  settings         jsonb not null default '{}'::jsonb,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  role          text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.workspace_invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  email         text,          -- optional: restrict the invite to this address
  role          text not null default 'member' check (role in ('admin', 'member', 'viewer')),
  token         text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  invited_by    uuid references public.profiles (id) on delete set null,
  expires_at    timestamptz not null default now() + interval '7 days',
  accepted_at   timestamptz,
  accepted_by   uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index workspace_invites_ws_idx on public.workspace_invites (workspace_id);

-- Secrets readable only by admins (and the engine).
create table public.workspace_integrations (
  workspace_id           uuid primary key references public.workspaces (id) on delete cascade,
  google_places_api_key  text,
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Pipeline & leads
-- ---------------------------------------------------------------------------

create table public.pipeline_stages (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 40),
  color         text not null default '#6366f1',
  position      integer not null default 0,
  kind          text not null default 'open' check (kind in ('new', 'contacted', 'replied', 'open', 'won', 'lost')),
  created_at    timestamptz not null default now(),
  unique (workspace_id, id)
);
create index pipeline_stages_ws_idx on public.pipeline_stages (workspace_id, position);

create table public.scrape_jobs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  created_by       uuid references public.profiles (id) on delete set null,
  name             text not null default '',
  provider         text not null default 'places' check (provider in ('places', 'browser')),
  keywords         text[] not null default '{}',
  locations        text[] not null default '{}',
  queries          text[] not null default '{}',
  max_per_query    integer not null default 60 check (max_per_query between 1 and 500),
  enrich           boolean not null default false,
  tags             text[] not null default '{}',
  assign_to        uuid references public.profiles (id) on delete set null,
  status           text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  cancel_requested boolean not null default false,
  -- { current, total, query }
  progress         jsonb not null default '{}'::jsonb,
  -- { found, inserted, duplicates, no_phone, with_website, without_website, enriched, errors }
  stats            jsonb not null default '{}'::jsonb,
  -- [{ t, level, text }] (most recent ~300)
  logs             jsonb not null default '[]'::jsonb,
  error            text,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, id)
);
create index scrape_jobs_ws_idx on public.scrape_jobs (workspace_id, created_at desc);
create index scrape_jobs_queue_idx on public.scrape_jobs (status, created_at) where status in ('queued', 'running');

create table public.leads (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  business_name      text not null check (char_length(btrim(business_name)) between 1 and 300),
  contact_name       text,
  phone              text check (phone ~ '^[0-9]{7,15}$'),    -- international digits, no '+'
  phone_raw          text,
  phone_type         text not null default 'unknown' check (phone_type in ('mobile', 'landline', 'unknown')),
  wa_status          text not null default 'unknown' check (wa_status in ('unknown', 'valid', 'invalid')),
  wa_checked_at      timestamptz,
  email              text,
  website            text,
  has_website        boolean generated always as (website is not null and btrim(website) <> '') stored,
  address            text,
  city               text,
  country            text,
  category           text,
  rating             numeric(2, 1) check (rating between 0 and 5),
  reviews_count      integer check (reviews_count >= 0),
  google_maps_url    text,
  place_id           text,
  latitude           double precision,
  longitude          double precision,
  -- { instagram, facebook, linkedin, twitter, youtube, tiktok }
  socials            jsonb not null default '{}'::jsonb,
  source             text not null default 'manual' check (source in ('scraper', 'import', 'manual', 'inbound')),
  scrape_job_id      uuid,
  stage_id           uuid,
  owner_id           uuid references public.profiles (id) on delete set null,
  tags               text[] not null default '{}',
  deal_value         numeric(14, 2) not null default 0 check (deal_value >= 0),
  opted_out          boolean not null default false,
  opted_out_at       timestamptz,
  last_contacted_at  timestamptz,
  last_replied_at    timestamptz,
  custom             jsonb not null default '{}'::jsonb,
  created_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- NULLs are distinct, so leads without phone / place id are allowed; these power upserts.
  constraint leads_ws_phone_key unique (workspace_id, phone),
  constraint leads_ws_place_key unique (workspace_id, place_id),
  unique (workspace_id, id),
  foreign key (workspace_id, scrape_job_id) references public.scrape_jobs (workspace_id, id) on delete set null (scrape_job_id),
  foreign key (workspace_id, stage_id) references public.pipeline_stages (workspace_id, id) on delete set null (stage_id)
);
create index leads_ws_created_idx on public.leads (workspace_id, created_at desc);
create index leads_ws_stage_idx on public.leads (workspace_id, stage_id);
create index leads_ws_owner_idx on public.leads (workspace_id, owner_id);
create index leads_ws_city_idx on public.leads (workspace_id, city);
create index leads_ws_category_idx on public.leads (workspace_id, category);
create index leads_tags_idx on public.leads using gin (tags);
create index leads_scrape_job_idx on public.leads (scrape_job_id) where scrape_job_id is not null;

create table public.lead_notes (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  lead_id       uuid not null,
  author_id     uuid references public.profiles (id) on delete set null,
  body          text not null check (char_length(btrim(body)) between 1 and 10000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index lead_notes_lead_idx on public.lead_notes (lead_id, created_at desc);

create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  lead_id       uuid,
  title         text not null check (char_length(btrim(title)) between 1 and 300),
  due_at        timestamptz,
  assignee_id   uuid references public.profiles (id) on delete set null,
  completed_at  timestamptz,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index tasks_ws_assignee_idx on public.tasks (workspace_id, assignee_id, completed_at, due_at);
create index tasks_lead_idx on public.tasks (lead_id);

create table public.activities (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  lead_id       uuid,
  actor_id      uuid references public.profiles (id) on delete set null,
  type          text not null,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index activities_lead_idx on public.activities (lead_id, created_at desc);
create index activities_ws_idx on public.activities (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- WhatsApp
-- ---------------------------------------------------------------------------

create table public.whatsapp_accounts (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  owner_id           uuid references public.profiles (id) on delete set null,
  label              text not null default 'WhatsApp' check (char_length(btrim(label)) between 1 and 60),
  phone              text,
  display_name       text,
  status             text not null default 'disconnected'
                     check (status in ('disconnected', 'connecting', 'qr', 'pairing', 'connected', 'logged_out', 'error')),
  -- What the user wants. The engine converges `status` towards it.
  desired_state      text not null default 'disconnected' check (desired_state in ('connected', 'disconnected', 'logged_out')),
  -- If set when connecting, the engine requests an 8-character pairing code instead of a QR.
  pairing_phone      text check (pairing_phone ~ '^[0-9]{7,15}$'),
  last_error         text,
  connected_at       timestamptz,
  last_seen_at       timestamptz,
  daily_limit        integer not null default 40 check (daily_limit between 1 and 1000),
  warmup_started_at  timestamptz,   -- null = warm-up off
  shared             boolean not null default true,  -- teammates may use it in campaigns
  paused_until       timestamptz,   -- set by the engine after a rate-limit signal
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, id)
);
create index whatsapp_accounts_ws_idx on public.whatsapp_accounts (workspace_id);

-- QR / pairing codes live apart so only the account owner and admins can read them.
create table public.whatsapp_link_codes (
  account_id    uuid primary key,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  qr            text,
  pairing_code  text,
  updated_at    timestamptz not null default now(),
  foreign key (workspace_id, account_id) references public.whatsapp_accounts (workspace_id, id) on delete cascade
);

-- Baileys signal/auth state. Engine-only (no RLS policies at all).
create table public.wa_auth_keys (
  account_id  uuid not null references public.whatsapp_accounts (id) on delete cascade,
  key         text not null,
  value       text not null,
  updated_at  timestamptz not null default now(),
  primary key (account_id, key)
);

create table public.message_templates (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  category      text not null default 'general',
  body          text not null check (char_length(body) between 1 and 4000),
  media_url     text,
  media_type    text check (media_type in ('image', 'document', 'video')),
  media_name    text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index message_templates_ws_idx on public.message_templates (workspace_id, name);

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------

create table public.campaigns (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 1 and 120),
  description    text,
  status         text not null default 'draft'
                 check (status in ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
  created_by     uuid references public.profiles (id) on delete set null,
  -- Snapshot of the audience filters used (for display).
  audience       jsonb not null default '{}'::jsonb,
  account_ids    uuid[] not null default '{}',
  -- See packages/shared/src/campaign.ts (CampaignSettings)
  settings       jsonb not null default '{}'::jsonb,
  scheduled_at   timestamptz,
  started_at     timestamptz,
  completed_at   timestamptz,
  paused_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, id)
);
create index campaigns_ws_idx on public.campaigns (workspace_id, created_at desc);
create index campaigns_active_idx on public.campaigns (status) where status in ('scheduled', 'running');

create table public.campaign_steps (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid not null,
  position      integer not null check (position >= 0),
  -- Wait this long after the previous step (ignored for step 0).
  delay_hours   integer not null default 0 check (delay_hours between 0 and 2160),
  -- [{ body, media_url, media_type, media_name }]
  variants      jsonb not null default '[]'::jsonb check (jsonb_typeof(variants) = 'array'),
  created_at    timestamptz not null default now(),
  unique (campaign_id, position),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade
);

create table public.campaign_recipients (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  campaign_id    uuid not null,
  lead_id        uuid not null,
  -- Sticky sender: follow-ups go out from the same number as the first message.
  account_id     uuid,
  status         text not null default 'pending'
                 check (status in ('pending', 'waiting', 'sending', 'completed', 'replied', 'failed', 'skipped', 'cancelled')),
  steps_sent     integer not null default 0,
  variant_index  integer,
  delivery       text not null default 'none' check (delivery in ('none', 'sent', 'delivered', 'read')),
  next_send_at   timestamptz,
  last_sent_at   timestamptz,
  replied_at     timestamptz,
  error          text,
  attempts       integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (campaign_id, lead_id),
  unique (workspace_id, id),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade,
  foreign key (workspace_id, account_id) references public.whatsapp_accounts (workspace_id, id) on delete set null (account_id)
);
create index campaign_recipients_queue_idx on public.campaign_recipients (campaign_id, status, next_send_at);
create index campaign_recipients_lead_idx on public.campaign_recipients (lead_id);

-- ---------------------------------------------------------------------------
-- Inbox
-- ---------------------------------------------------------------------------

create table public.conversations (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces (id) on delete cascade,
  account_id            uuid not null,
  lead_id               uuid not null,
  assigned_to           uuid references public.profiles (id) on delete set null,
  last_message_at       timestamptz,
  last_message_preview  text,
  last_direction        text check (last_direction in ('in', 'out')),
  unread_count          integer not null default 0,
  archived              boolean not null default false,
  created_at            timestamptz not null default now(),
  unique (account_id, lead_id),
  unique (workspace_id, id),
  foreign key (workspace_id, account_id) references public.whatsapp_accounts (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index conversations_ws_idx on public.conversations (workspace_id, last_message_at desc nulls last);
create index conversations_lead_idx on public.conversations (lead_id);

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  conversation_id  uuid,
  lead_id          uuid not null,
  account_id       uuid,
  campaign_id      uuid,
  recipient_id     uuid,
  step             integer,
  direction        text not null check (direction in ('in', 'out')),
  body             text not null default '',
  media_url        text,
  media_type       text check (media_type in ('image', 'document', 'video', 'audio', 'sticker', 'other')),
  media_name       text,
  wa_message_id    text,
  status           text not null default 'queued'
                   check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'received')),
  error            text,
  sent_by          uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (workspace_id, conversation_id) references public.conversations (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade,
  foreign key (workspace_id, account_id) references public.whatsapp_accounts (workspace_id, id) on delete set null (account_id),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete set null (campaign_id),
  foreign key (workspace_id, recipient_id) references public.campaign_recipients (workspace_id, id) on delete set null (recipient_id)
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);
create index messages_lead_idx on public.messages (lead_id, created_at);
create index messages_ws_created_idx on public.messages (workspace_id, created_at desc);
create index messages_wa_id_idx on public.messages (account_id, wa_message_id) where wa_message_id is not null;
create index messages_campaign_idx on public.messages (campaign_id) where campaign_id is not null;
create index messages_outbox_idx on public.messages (created_at) where status = 'queued' and direction = 'out';

-- ---------------------------------------------------------------------------
-- Background jobs, notifications, engine heartbeat
-- ---------------------------------------------------------------------------

create table public.engine_jobs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  type          text not null check (type in ('verify_whatsapp', 'enrich_leads')),
  -- verify_whatsapp: { lead_ids[], account_id }   enrich_leads: { lead_ids[] }
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress      jsonb not null default '{}'::jsonb,
  result        jsonb not null default '{}'::jsonb,
  error         text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
create index engine_jobs_queue_idx on public.engine_jobs (status, created_at) where status in ('queued', 'running');
create index engine_jobs_ws_idx on public.engine_jobs (workspace_id, created_at desc);

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  type          text not null,
  title         text not null,
  body          text,
  link          text,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, workspace_id, created_at desc);

create table public.engine_status (
  id            text primary key default 'main',
  version       text,
  started_at    timestamptz,
  heartbeat_at  timestamptz,
  info          jsonb not null default '{}'::jsonb
);
