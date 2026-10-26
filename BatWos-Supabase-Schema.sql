-- =============================================================================
-- BatWos — complete database setup for a NEW Supabase project
--
-- How to use:
--   1. Supabase dashboard → your project → SQL Editor → New query
--   2. Paste this whole file and click "Run" (takes ~10 seconds)
--   3. You should see "Success. No rows returned"
--
-- Run it ONCE, on an empty project. It is one transaction: if anything fails,
-- nothing is changed and you can simply run it again after fixing the cause.
-- It also records the migrations, so later updates can be applied with
-- `supabase db push`.
-- =============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 20261003000001_schema.sql
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 20261003000002_rls.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Row-Level Security
-- Roles: owner > admin > member > viewer.
--   viewer  : read everything in the workspace
--   member  : + create/edit leads, notes, tasks, templates, own campaigns & WhatsApp numbers
--   admin   : + team, settings, stages, any campaign / number
--   owner   : + delete workspace, manage owners
-- The engine uses the service-role key and bypasses RLS.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so policies don't recurse through RLS)
-- ---------------------------------------------------------------------------

create or replace function public.workspace_role(ws uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select m.role from public.workspace_members m
  where m.workspace_id = ws and m.user_id = (select auth.uid());
$$;

create or replace function public.is_member(ws uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.can_write(ws uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin', 'member')
  );
$$;

create or replace function public.is_admin(ws uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function public.is_owner(ws uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role = 'owner'
  );
$$;

create or replace function public.shares_workspace_with(other uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members me
    join public.workspace_members them on them.workspace_id = me.workspace_id
    where me.user_id = (select auth.uid()) and them.user_id = other
  );
$$;

-- Can the current user send from this WhatsApp number?
create or replace function public.can_use_account(acc uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.whatsapp_accounts a
    where a.id = acc
      and public.can_write(a.workspace_id)
      and (a.owner_id = (select auth.uid()) or a.shared or public.is_admin(a.workspace_id))
  );
$$;

-- Can the current user edit this campaign (creator with write access, or an admin)?
create or replace function public.can_edit_campaign(cid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.campaigns c
    where c.id = cid
      and ((c.created_by = (select auth.uid()) and public.can_write(c.workspace_id)) or public.is_admin(c.workspace_id))
  );
$$;

-- ---------------------------------------------------------------------------
-- Baseline privileges. Supabase grants ALL on public tables to anon/authenticated
-- by default; anon gets nothing here and some tables get column-level UPDATE only.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on public.wa_auth_keys from authenticated;

revoke update on
  public.profiles, public.workspaces, public.workspace_members, public.scrape_jobs,
  public.whatsapp_accounts, public.whatsapp_link_codes, public.campaigns,
  public.campaign_recipients, public.conversations, public.messages,
  public.engine_jobs, public.notifications, public.engine_status, public.activities
from authenticated;

grant update (full_name, avatar_url) on public.profiles to authenticated;
grant update (name, timezone, default_country, settings) on public.workspaces to authenticated;
grant update (role) on public.workspace_members to authenticated;
grant update (name, cancel_requested) on public.scrape_jobs to authenticated;
grant update (label, desired_state, pairing_phone, daily_limit, warmup_started_at, shared) on public.whatsapp_accounts to authenticated;
grant update (name, description, status, audience, account_ids, settings, scheduled_at, paused_reason) on public.campaigns to authenticated;
grant update (status) on public.campaign_recipients to authenticated;
grant update (assigned_to, archived, unread_count) on public.conversations to authenticated;
grant update (status) on public.engine_jobs to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Writes to these happen only through the engine or SECURITY DEFINER functions.
revoke insert, delete on
  public.workspaces, public.workspace_members, public.whatsapp_link_codes,
  public.engine_status, public.notifications, public.conversations, public.profiles
from authenticated;
grant delete on public.workspace_members, public.notifications, public.workspaces to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table public.profiles               enable row level security;
alter table public.workspaces             enable row level security;
alter table public.workspace_members      enable row level security;
alter table public.workspace_invites      enable row level security;
alter table public.workspace_integrations enable row level security;
alter table public.pipeline_stages        enable row level security;
alter table public.scrape_jobs            enable row level security;
alter table public.leads                  enable row level security;
alter table public.lead_notes             enable row level security;
alter table public.tasks                  enable row level security;
alter table public.activities             enable row level security;
alter table public.whatsapp_accounts      enable row level security;
alter table public.whatsapp_link_codes    enable row level security;
alter table public.wa_auth_keys           enable row level security;
alter table public.message_templates      enable row level security;
alter table public.campaigns              enable row level security;
alter table public.campaign_steps         enable row level security;
alter table public.campaign_recipients    enable row level security;
alter table public.conversations          enable row level security;
alter table public.messages               enable row level security;
alter table public.engine_jobs            enable row level security;
alter table public.notifications          enable row level security;
alter table public.engine_status          enable row level security;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- profiles
create policy "profiles: read self and teammates" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or public.shares_workspace_with(id));
create policy "profiles: update self" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- workspaces
create policy "workspaces: members read" on public.workspaces
  for select to authenticated using (public.is_member(id));
create policy "workspaces: admins update" on public.workspaces
  for update to authenticated using (public.is_admin(id)) with check (public.is_admin(id));
create policy "workspaces: owners delete" on public.workspaces
  for delete to authenticated using (public.is_owner(id));

-- workspace_members (role changes guarded further by trigger)
create policy "members: read" on public.workspace_members
  for select to authenticated using (public.is_member(workspace_id));
create policy "members: admins change roles" on public.workspace_members
  for update to authenticated using (public.is_admin(workspace_id)) with check (public.is_admin(workspace_id));
create policy "members: admins remove, anyone leaves" on public.workspace_members
  for delete to authenticated using (public.is_admin(workspace_id) or user_id = (select auth.uid()));

-- workspace_invites
create policy "invites: admins read" on public.workspace_invites
  for select to authenticated using (public.is_admin(workspace_id));
create policy "invites: admins create" on public.workspace_invites
  for insert to authenticated with check (public.is_admin(workspace_id) and invited_by = (select auth.uid()) and accepted_at is null);
create policy "invites: admins revoke" on public.workspace_invites
  for delete to authenticated using (public.is_admin(workspace_id));

-- workspace_integrations
create policy "integrations: admins read" on public.workspace_integrations
  for select to authenticated using (public.is_admin(workspace_id));
create policy "integrations: admins insert" on public.workspace_integrations
  for insert to authenticated with check (public.is_admin(workspace_id));
create policy "integrations: admins update" on public.workspace_integrations
  for update to authenticated using (public.is_admin(workspace_id)) with check (public.is_admin(workspace_id));

-- pipeline_stages
create policy "stages: members read" on public.pipeline_stages
  for select to authenticated using (public.is_member(workspace_id));
create policy "stages: admins insert" on public.pipeline_stages
  for insert to authenticated with check (public.is_admin(workspace_id));
create policy "stages: admins update" on public.pipeline_stages
  for update to authenticated using (public.is_admin(workspace_id)) with check (public.is_admin(workspace_id));
create policy "stages: admins delete" on public.pipeline_stages
  for delete to authenticated using (public.is_admin(workspace_id));

-- scrape_jobs
create policy "scrape_jobs: members read" on public.scrape_jobs
  for select to authenticated using (public.is_member(workspace_id));
create policy "scrape_jobs: writers queue" on public.scrape_jobs
  for insert to authenticated with check (
    public.can_write(workspace_id) and created_by = (select auth.uid()) and status = 'queued'
  );
create policy "scrape_jobs: writers cancel/rename" on public.scrape_jobs
  for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));
create policy "scrape_jobs: creator or admin deletes finished jobs" on public.scrape_jobs
  for delete to authenticated using (
    status <> 'running' and (public.is_admin(workspace_id) or (created_by = (select auth.uid()) and public.can_write(workspace_id)))
  );

-- leads
create policy "leads: members read" on public.leads
  for select to authenticated using (public.is_member(workspace_id));
create policy "leads: writers insert" on public.leads
  for insert to authenticated with check (public.can_write(workspace_id));
create policy "leads: writers update" on public.leads
  for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));
create policy "leads: admins or owner/creator delete" on public.leads
  for delete to authenticated using (
    public.is_admin(workspace_id)
    or (public.can_write(workspace_id) and (owner_id = (select auth.uid()) or created_by = (select auth.uid())))
  );

-- lead_notes
create policy "notes: members read" on public.lead_notes
  for select to authenticated using (public.is_member(workspace_id));
create policy "notes: writers add" on public.lead_notes
  for insert to authenticated with check (public.can_write(workspace_id) and author_id = (select auth.uid()));
create policy "notes: author edits" on public.lead_notes
  for update to authenticated using (author_id = (select auth.uid()) and public.can_write(workspace_id))
  with check (author_id = (select auth.uid()));
create policy "notes: author or admin deletes" on public.lead_notes
  for delete to authenticated using (
    (author_id = (select auth.uid()) and public.can_write(workspace_id)) or public.is_admin(workspace_id)
  );

-- tasks
create policy "tasks: members read" on public.tasks
  for select to authenticated using (public.is_member(workspace_id));
create policy "tasks: writers add" on public.tasks
  for insert to authenticated with check (public.can_write(workspace_id) and created_by = (select auth.uid()));
create policy "tasks: writers update" on public.tasks
  for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));
create policy "tasks: creator, assignee or admin deletes" on public.tasks
  for delete to authenticated using (
    public.is_admin(workspace_id)
    or (public.can_write(workspace_id) and (created_by = (select auth.uid()) or assignee_id = (select auth.uid())))
  );

-- activities (append-only from the browser)
create policy "activities: members read" on public.activities
  for select to authenticated using (public.is_member(workspace_id));
create policy "activities: writers log" on public.activities
  for insert to authenticated with check (public.can_write(workspace_id) and actor_id = (select auth.uid()));

-- whatsapp_accounts
create policy "wa_accounts: members read" on public.whatsapp_accounts
  for select to authenticated using (public.is_member(workspace_id));
create policy "wa_accounts: writers add own" on public.whatsapp_accounts
  for insert to authenticated with check (public.can_write(workspace_id) and owner_id = (select auth.uid()));
create policy "wa_accounts: owner or admin updates" on public.whatsapp_accounts
  for update to authenticated
  using ((owner_id = (select auth.uid()) and public.can_write(workspace_id)) or public.is_admin(workspace_id))
  with check ((owner_id = (select auth.uid()) and public.can_write(workspace_id)) or public.is_admin(workspace_id));
create policy "wa_accounts: owner or admin deletes" on public.whatsapp_accounts
  for delete to authenticated
  using ((owner_id = (select auth.uid()) and public.can_write(workspace_id)) or public.is_admin(workspace_id));

-- whatsapp_link_codes: only the person connecting (or an admin) sees the QR
create policy "link_codes: owner or admin reads" on public.whatsapp_link_codes
  for select to authenticated using (
    public.is_admin(workspace_id)
    or exists (select 1 from public.whatsapp_accounts a where a.id = account_id and a.owner_id = (select auth.uid()))
  );

-- wa_auth_keys: no policies => no browser access at all.

-- message_templates
create policy "templates: members read" on public.message_templates
  for select to authenticated using (public.is_member(workspace_id));
create policy "templates: writers add" on public.message_templates
  for insert to authenticated with check (public.can_write(workspace_id) and created_by = (select auth.uid()));
create policy "templates: writers update" on public.message_templates
  for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));
create policy "templates: creator or admin deletes" on public.message_templates
  for delete to authenticated using (
    public.is_admin(workspace_id) or (created_by = (select auth.uid()) and public.can_write(workspace_id))
  );

-- campaigns
create policy "campaigns: members read" on public.campaigns
  for select to authenticated using (public.is_member(workspace_id));
create policy "campaigns: writers create" on public.campaigns
  for insert to authenticated with check (public.can_write(workspace_id) and created_by = (select auth.uid()));
create policy "campaigns: creator or admin updates" on public.campaigns
  for update to authenticated using (public.can_edit_campaign(id)) with check (public.can_write(workspace_id));
create policy "campaigns: creator or admin deletes" on public.campaigns
  for delete to authenticated using (public.can_edit_campaign(id));

-- campaign_steps
create policy "steps: members read" on public.campaign_steps
  for select to authenticated using (public.is_member(workspace_id));
create policy "steps: editors insert" on public.campaign_steps
  for insert to authenticated with check (public.can_edit_campaign(campaign_id));
create policy "steps: editors update" on public.campaign_steps
  for update to authenticated using (public.can_edit_campaign(campaign_id)) with check (public.can_edit_campaign(campaign_id));
create policy "steps: editors delete" on public.campaign_steps
  for delete to authenticated using (public.can_edit_campaign(campaign_id));

-- campaign_recipients
create policy "recipients: members read" on public.campaign_recipients
  for select to authenticated using (public.is_member(workspace_id));
create policy "recipients: editors insert" on public.campaign_recipients
  for insert to authenticated with check (public.can_edit_campaign(campaign_id) and status = 'pending');
create policy "recipients: editors update" on public.campaign_recipients
  for update to authenticated using (public.can_edit_campaign(campaign_id)) with check (public.can_edit_campaign(campaign_id));
create policy "recipients: editors delete" on public.campaign_recipients
  for delete to authenticated using (public.can_edit_campaign(campaign_id));

-- conversations
create policy "conversations: members read" on public.conversations
  for select to authenticated using (public.is_member(workspace_id));
create policy "conversations: writers update" on public.conversations
  for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));

-- messages: the browser may only queue outbound messages from numbers it can use
create policy "messages: members read" on public.messages
  for select to authenticated using (public.is_member(workspace_id));
create policy "messages: writers queue outbound" on public.messages
  for insert to authenticated with check (
    public.can_write(workspace_id)
    and direction = 'out'
    and status = 'queued'
    and sent_by = (select auth.uid())
    and campaign_id is null
    and recipient_id is null
    and account_id is not null
    and public.can_use_account(account_id)
  );

-- engine_jobs
create policy "engine_jobs: members read" on public.engine_jobs
  for select to authenticated using (public.is_member(workspace_id));
create policy "engine_jobs: writers queue" on public.engine_jobs
  for insert to authenticated with check (
    public.can_write(workspace_id) and created_by = (select auth.uid()) and status = 'queued'
  );
create policy "engine_jobs: creator or admin cancels" on public.engine_jobs
  for update to authenticated
  using (public.is_admin(workspace_id) or (created_by = (select auth.uid()) and public.can_write(workspace_id)))
  with check (status = 'cancelled');

-- notifications: strictly personal
create policy "notifications: read own" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()) and public.is_member(workspace_id));
create policy "notifications: mark own read" on public.notifications
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "notifications: delete own" on public.notifications
  for delete to authenticated using (user_id = (select auth.uid()));

-- engine_status: any signed-in user may see whether the engine is online
create policy "engine_status: read" on public.engine_status
  for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- 20261003000003_functions.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Functions, triggers and views
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Small utilities
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'workspaces', 'workspace_integrations', 'scrape_jobs', 'leads', 'lead_notes', 'tasks',
    'whatsapp_accounts', 'message_templates', 'campaigns', 'campaign_recipients', 'messages'
  ] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
                   t || '_updated_at', t);
  end loop;
end $$;

-- jsonb array -> text[] ('{}' for null / non-arrays)
create or replace function public.jarr(j jsonb)
returns text[] language sql immutable set search_path = ''
as $$
  select case when jsonb_typeof(j) = 'array'
              then coalesce(array(select jsonb_array_elements_text(j)), '{}')
              else '{}'::text[] end;
$$;

create or replace function public.try_uuid(t text)
returns uuid language plpgsql immutable set search_path = ''
as $$
begin
  return t::uuid;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- New auth user -> profile
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------

create or replace function public.create_default_stages(ws uuid)
returns void language sql security definer set search_path = ''
as $$
  insert into public.pipeline_stages (workspace_id, name, color, position, kind) values
    (ws, 'New',            '#64748b', 0, 'new'),
    (ws, 'Contacted',      '#3b82f6', 1, 'contacted'),
    (ws, 'Replied',        '#06b6d4', 2, 'replied'),
    (ws, 'Interested',     '#8b5cf6', 3, 'open'),
    (ws, 'Meeting Booked', '#f59e0b', 4, 'open'),
    (ws, 'Proposal Sent',  '#ec4899', 5, 'open'),
    (ws, 'Won',            '#10b981', 6, 'won'),
    (ws, 'Lost',           '#ef4444', 7, 'lost');
$$;
revoke execute on function public.create_default_stages(uuid) from public, anon, authenticated;

create or replace function public.create_workspace(p_name text, p_timezone text default 'Asia/Karachi', p_country text default 'PK')
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  ws uuid;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  insert into public.workspaces (name, timezone, default_country, created_by, settings)
  values (
    btrim(p_name), coalesce(nullif(p_timezone, ''), 'UTC'), upper(coalesce(nullif(p_country, ''), 'PK')), uid,
    jsonb_build_object(
      'opt_out_keywords', jsonb_build_array('stop', 'unsubscribe', 'remove', 'not interested'),
      'capture_unknown_inbound', false,
      'auto_stage_on_send', true,
      'auto_stage_on_reply', true
    )
  )
  returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, uid, 'owner');
  insert into public.workspace_integrations (workspace_id) values (ws);
  perform public.create_default_stages(ws);
  return ws;
end;
$$;
revoke execute on function public.create_workspace(text, text, text) from public, anon;
grant execute on function public.create_workspace(text, text, text) to authenticated;

-- Guard membership changes: owners are protected and a workspace keeps >= 1 owner.
create or replace function public.guard_workspace_members()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  owners int;
begin
  if tg_op = 'UPDATE' then
    if new.workspace_id <> old.workspace_id or new.user_id <> old.user_id then
      raise exception 'Membership cannot be moved' using errcode = '42501';
    end if;
    if new.role = old.role then
      return new;
    end if;
    if actor is not null and (old.role = 'owner' or new.role = 'owner') and not public.is_owner(old.workspace_id) then
      raise exception 'Only owners can grant or change the owner role' using errcode = '42501';
    end if;
    if old.role = 'owner' then
      select count(*) into owners from public.workspace_members where workspace_id = old.workspace_id and role = 'owner';
      if owners <= 1 then
        raise exception 'A workspace needs at least one owner' using errcode = 'P0001';
      end if;
    end if;
    return new;
  end if;

  -- DELETE (skip checks when the whole workspace is being deleted)
  if not exists (select 1 from public.workspaces where id = old.workspace_id) then
    return old;
  end if;
  if actor is not null and old.role = 'owner' and old.user_id <> actor and not public.is_owner(old.workspace_id) then
    raise exception 'Only owners can remove an owner' using errcode = '42501';
  end if;
  if old.role = 'owner' then
    select count(*) into owners from public.workspace_members where workspace_id = old.workspace_id and role = 'owner';
    if owners <= 1 then
      raise exception 'A workspace needs at least one owner' using errcode = 'P0001';
    end if;
  end if;
  return old;
end;
$$;

create trigger workspace_members_guard
  before update or delete on public.workspace_members
  for each row execute function public.guard_workspace_members();

-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------

-- Public preview for the invite landing page (token is a 256-bit secret).
create or replace function public.get_invite(p_token text)
returns table (workspace_name text, role text, email text, invited_by_name text, expired boolean, accepted boolean)
language sql stable security definer set search_path = ''
as $$
  select w.name, i.role, i.email, p.full_name, i.expires_at < now(), i.accepted_at is not null
  from public.workspace_invites i
  join public.workspaces w on w.id = i.workspace_id
  left join public.profiles p on p.id = i.invited_by
  where i.token = p_token;
$$;
revoke execute on function public.get_invite(text) from public;
grant execute on function public.get_invite(text) to anon, authenticated;

create or replace function public.accept_invite(p_token text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  inv public.workspace_invites%rowtype;
  user_email text;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select * into inv from public.workspace_invites where token = p_token for update;
  if not found then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;
  if inv.accepted_at is not null then
    if inv.accepted_by = uid then
      return inv.workspace_id;
    end if;
    raise exception 'This invite has already been used' using errcode = 'P0001';
  end if;
  if inv.expires_at < now() then
    raise exception 'This invite has expired' using errcode = 'P0001';
  end if;
  select email into user_email from auth.users where id = uid;
  if inv.email is not null and lower(inv.email) <> lower(coalesce(user_email, '')) then
    raise exception 'This invite was sent to a different email address' using errcode = '42501';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (inv.workspace_id, uid, inv.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invites set accepted_at = now(), accepted_by = uid where id = inv.id;
  return inv.workspace_id;
end;
$$;
revoke execute on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Leads: defaults, history, notifications
-- ---------------------------------------------------------------------------

create or replace function public.leads_before_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.stage_id is null then
      select s.id into new.stage_id
      from public.pipeline_stages s
      where s.workspace_id = new.workspace_id
      order by (s.kind = 'new') desc, s.position
      limit 1;
    end if;
    if new.created_by is null then
      new.created_by := (select auth.uid());
    end if;
  end if;

  -- trim + dedupe tags
  new.tags := coalesce(
    (select array_agg(distinct btrim(t)) from unnest(new.tags) t where btrim(t) <> ''),
    '{}'
  );

  if new.opted_out and (tg_op = 'INSERT' or not old.opted_out) then
    new.opted_out_at := coalesce(new.opted_out_at, now());
  elsif not new.opted_out then
    new.opted_out_at := null;
  end if;
  return new;
end;
$$;

create trigger leads_before_write
  before insert or update on public.leads
  for each row execute function public.leads_before_write();

create or replace function public.leads_after_update()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if new.stage_id is distinct from old.stage_id then
    insert into public.activities (workspace_id, lead_id, actor_id, type, data)
    values (new.workspace_id, new.id, actor, 'stage_changed',
            jsonb_build_object('from', old.stage_id, 'to', new.stage_id,
              'from_name', (select name from public.pipeline_stages where id = old.stage_id),
              'to_name', (select name from public.pipeline_stages where id = new.stage_id)));
  end if;

  if new.owner_id is distinct from old.owner_id then
    insert into public.activities (workspace_id, lead_id, actor_id, type, data)
    values (new.workspace_id, new.id, actor, 'assigned', jsonb_build_object('from', old.owner_id, 'to', new.owner_id));
    if new.owner_id is not null and new.owner_id is distinct from actor then
      insert into public.notifications (workspace_id, user_id, type, title, body, link)
      values (new.workspace_id, new.owner_id, 'lead_assigned', 'Lead assigned to you', new.business_name,
              '/leads?lead=' || new.id);
    end if;
  end if;

  if new.opted_out and not old.opted_out then
    insert into public.activities (workspace_id, lead_id, actor_id, type, data)
    values (new.workspace_id, new.id, actor, 'opted_out', '{}'::jsonb);
  end if;
  return null;
end;
$$;

create trigger leads_after_update
  after update on public.leads
  for each row execute function public.leads_after_update();

create or replace function public.tasks_notify()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  if new.assignee_id is not null
     and new.assignee_id is distinct from actor
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    insert into public.notifications (workspace_id, user_id, type, title, body, link)
    values (new.workspace_id, new.assignee_id, 'task_assigned', 'New task for you', new.title, '/tasks');
  end if;
  return null;
end;
$$;

create trigger tasks_notify
  after insert or update on public.tasks
  for each row execute function public.tasks_notify();

-- ---------------------------------------------------------------------------
-- Lead search. One function powers the leads table, campaign audiences and
-- bulk actions so they always agree. SECURITY INVOKER => RLS applies.
--
-- p_filters keys (all optional):
--   q, stage_ids[], has_website, cities[], categories[], tags[], owner_ids[],
--   unassigned, wa_status[], phone_types[], sources[], min_rating, min_reviews,
--   opted_out, contacted ('never'|'contacted'|'replied'|'not_replied'),
--   not_contacted_days, scrape_job_id, created_from, created_to, has_phone,
--   has_email, sendable
-- ---------------------------------------------------------------------------

create or replace function public.filtered_leads(p_workspace uuid, p_filters jsonb default '{}'::jsonb)
returns setof public.leads
language sql stable set search_path = ''
as $$
  select l.*
  from public.leads l
  cross join lateral (
    select
      nullif(btrim(coalesce(p_filters ->> 'q', '')), '') as q,
      regexp_replace(coalesce(p_filters ->> 'q', ''), '\D', '', 'g') as q_digits
  ) s
  where l.workspace_id = p_workspace
    and (
      s.q is null
      or l.business_name ilike '%' || s.q || '%'
      or l.address ilike '%' || s.q || '%'
      or l.city ilike '%' || s.q || '%'
      or l.category ilike '%' || s.q || '%'
      or l.email ilike '%' || s.q || '%'
      or l.contact_name ilike '%' || s.q || '%'
      or l.website ilike '%' || s.q || '%'
      or (length(s.q_digits) >= 3 and l.phone like '%' || s.q_digits || '%')
    )
    and (cardinality(public.jarr(p_filters -> 'stage_ids')) = 0 or l.stage_id::text = any (public.jarr(p_filters -> 'stage_ids')))
    and (p_filters -> 'has_website' is null or jsonb_typeof(p_filters -> 'has_website') <> 'boolean'
         or l.has_website = (p_filters ->> 'has_website')::boolean)
    and (cardinality(public.jarr(p_filters -> 'cities')) = 0 or l.city = any (public.jarr(p_filters -> 'cities')))
    and (cardinality(public.jarr(p_filters -> 'categories')) = 0 or l.category = any (public.jarr(p_filters -> 'categories')))
    and (cardinality(public.jarr(p_filters -> 'tags')) = 0 or l.tags && public.jarr(p_filters -> 'tags'))
    and (
      (cardinality(public.jarr(p_filters -> 'owner_ids')) = 0 and coalesce((p_filters ->> 'unassigned')::boolean, false) = false)
      or l.owner_id::text = any (public.jarr(p_filters -> 'owner_ids'))
      or (coalesce((p_filters ->> 'unassigned')::boolean, false) and l.owner_id is null)
    )
    and (cardinality(public.jarr(p_filters -> 'wa_status')) = 0 or l.wa_status = any (public.jarr(p_filters -> 'wa_status')))
    and (cardinality(public.jarr(p_filters -> 'phone_types')) = 0 or l.phone_type = any (public.jarr(p_filters -> 'phone_types')))
    and (cardinality(public.jarr(p_filters -> 'sources')) = 0 or l.source = any (public.jarr(p_filters -> 'sources')))
    and (p_filters ->> 'min_rating' is null or coalesce(l.rating, 0) >= (p_filters ->> 'min_rating')::numeric)
    and (p_filters ->> 'min_reviews' is null or coalesce(l.reviews_count, 0) >= (p_filters ->> 'min_reviews')::int)
    and (p_filters -> 'opted_out' is null or jsonb_typeof(p_filters -> 'opted_out') <> 'boolean'
         or l.opted_out = (p_filters ->> 'opted_out')::boolean)
    and (
      p_filters ->> 'contacted' is null
      or (p_filters ->> 'contacted' = 'never' and l.last_contacted_at is null)
      or (p_filters ->> 'contacted' = 'contacted' and l.last_contacted_at is not null)
      or (p_filters ->> 'contacted' = 'replied' and l.last_replied_at is not null)
      or (p_filters ->> 'contacted' = 'not_replied' and l.last_contacted_at is not null and l.last_replied_at is null)
    )
    and (p_filters ->> 'not_contacted_days' is null or l.last_contacted_at is null
         or l.last_contacted_at < now() - make_interval(days => (p_filters ->> 'not_contacted_days')::int))
    and (p_filters ->> 'scrape_job_id' is null or l.scrape_job_id = public.try_uuid(p_filters ->> 'scrape_job_id'))
    and (p_filters ->> 'created_from' is null or l.created_at >= (p_filters ->> 'created_from')::timestamptz)
    and (p_filters ->> 'created_to' is null or l.created_at < (p_filters ->> 'created_to')::timestamptz)
    and (p_filters -> 'has_phone' is null or jsonb_typeof(p_filters -> 'has_phone') <> 'boolean'
         or (l.phone is not null) = (p_filters ->> 'has_phone')::boolean)
    and (p_filters -> 'has_email' is null or jsonb_typeof(p_filters -> 'has_email') <> 'boolean'
         or (coalesce(l.email, '') <> '') = (p_filters ->> 'has_email')::boolean)
    and (
      coalesce((p_filters ->> 'sendable')::boolean, false) = false
      or (l.phone is not null and not l.opted_out and l.wa_status <> 'invalid')
    );
$$;

-- Distinct values for filter dropdowns.
create or replace function public.lead_facets(p_workspace uuid)
returns jsonb language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'cities', coalesce((
      select jsonb_agg(jsonb_build_object('value', city, 'count', n) order by n desc)
      from (select city, count(*) n from public.leads where workspace_id = p_workspace and coalesce(city, '') <> ''
            group by city order by count(*) desc limit 200) c), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('value', category, 'count', n) order by n desc)
      from (select category, count(*) n from public.leads where workspace_id = p_workspace and coalesce(category, '') <> ''
            group by category order by count(*) desc limit 200) c), '[]'::jsonb),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('value', tag, 'count', n) order by n desc)
      from (select t.tag, count(*) n from public.leads l, unnest(l.tags) as t(tag)
            where l.workspace_id = p_workspace group by t.tag order by count(*) desc limit 300) c), '[]'::jsonb)
  );
$$;

-- Bulk actions over explicit ids or "everything matching these filters".
create or replace function public.leads_bulk_action(
  p_workspace uuid,
  p_action text,
  p_ids uuid[] default null,
  p_filters jsonb default null,
  p_value jsonb default null
)
returns integer language plpgsql volatile set search_path = ''
as $$
declare
  n integer := 0;
  target uuid[];
begin
  if p_ids is null and p_filters is null then
    raise exception 'Pass lead ids or filters' using errcode = '22023';
  end if;
  if not public.can_write(p_workspace) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  if p_ids is not null then
    select coalesce(array_agg(id), '{}') into target from public.leads where workspace_id = p_workspace and id = any (p_ids);
  else
    select coalesce(array_agg(id), '{}') into target from public.filtered_leads(p_workspace, p_filters);
  end if;

  case p_action
    when 'set_stage' then
      update public.leads set stage_id = public.try_uuid(p_value #>> '{}') where id = any (target);
    when 'set_owner' then
      update public.leads set owner_id = public.try_uuid(p_value #>> '{}') where id = any (target);
    when 'add_tags' then
      update public.leads set tags = tags || public.jarr(p_value) where id = any (target);
    when 'remove_tags' then
      update public.leads
      set tags = coalesce(array(select t from unnest(tags) t where t <> all (public.jarr(p_value))), '{}')
      where id = any (target);
    when 'opt_out' then
      update public.leads set opted_out = true where id = any (target);
    when 'opt_in' then
      update public.leads set opted_out = false where id = any (target);
    when 'delete' then
      delete from public.leads where id = any (target);
    else
      raise exception 'Unknown action %', p_action using errcode = '22023';
  end case;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Delete a stage, moving its leads elsewhere first.
create or replace function public.delete_stage(p_stage uuid, p_move_to uuid default null)
returns void language plpgsql volatile set search_path = ''
as $$
declare
  ws uuid;
begin
  select workspace_id into ws from public.pipeline_stages where id = p_stage;
  if ws is null or not public.is_admin(ws) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_move_to is not null then
    update public.leads set stage_id = p_move_to where workspace_id = ws and stage_id = p_stage;
  end if;
  delete from public.pipeline_stages where id = p_stage;
end;
$$;

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------

create or replace function public.campaign_add_recipients(
  p_campaign uuid,
  p_filters jsonb default null,
  p_lead_ids uuid[] default null
)
returns integer language plpgsql volatile set search_path = ''
as $$
declare
  ws uuid;
  n integer;
begin
  if p_filters is null and p_lead_ids is null then
    raise exception 'Pass filters or lead ids' using errcode = '22023';
  end if;
  select workspace_id into ws from public.campaigns where id = p_campaign;
  if ws is null or not public.can_edit_campaign(p_campaign) then
    raise exception 'Campaign not found' using errcode = '42501';
  end if;

  insert into public.campaign_recipients (workspace_id, campaign_id, lead_id)
  select ws, p_campaign, l.id
  from public.filtered_leads(ws, coalesce(p_filters, '{}'::jsonb) || '{"sendable": true}'::jsonb) l
  where p_lead_ids is null or l.id = any (p_lead_ids)
  on conflict (campaign_id, lead_id) do nothing;

  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace view public.campaign_stats
with (security_invoker = true) as
select
  c.id as campaign_id,
  c.workspace_id,
  count(r.id)::int                                                    as total,
  count(r.id) filter (where r.status = 'pending')::int                as pending,
  count(r.id) filter (where r.status = 'waiting')::int                as waiting,
  count(r.id) filter (where r.steps_sent > 0)::int                    as sent,
  count(r.id) filter (where r.delivery in ('delivered', 'read'))::int as delivered,
  count(r.id) filter (where r.delivery = 'read')::int                 as read,
  count(r.id) filter (where r.status = 'replied')::int                as replied,
  count(r.id) filter (where r.status = 'failed')::int                 as failed,
  count(r.id) filter (where r.status = 'skipped')::int                as skipped,
  count(r.id) filter (where r.status = 'completed')::int              as completed,
  max(r.last_sent_at)                                                 as last_sent_at
from public.campaigns c
left join public.campaign_recipients r on r.campaign_id = c.id
group by c.id, c.workspace_id;

grant select on public.campaign_stats to authenticated;

-- Per-variant performance for A/B testing.
create or replace function public.campaign_variant_stats(p_campaign uuid)
returns table (step integer, variant_index integer, sent integer, delivered integer, read integer, replied integer)
language sql stable set search_path = ''
as $$
  select m.step, coalesce(r.variant_index, 0),
         count(*)::int,
         count(*) filter (where m.status in ('delivered', 'read'))::int,
         count(*) filter (where m.status = 'read')::int,
         count(*) filter (where r.status = 'replied')::int
  from public.messages m
  join public.campaign_recipients r on r.id = m.recipient_id
  where m.campaign_id = p_campaign and m.direction = 'out' and m.status in ('sent', 'delivered', 'read')
  group by m.step, coalesce(r.variant_index, 0)
  order by 1, 2;
$$;

-- Engine only: atomically take the next due recipient for a sender.
create or replace function public.claim_next_recipient(p_campaign uuid, p_account uuid)
returns setof public.campaign_recipients
language sql volatile security definer set search_path = ''
as $$
  update public.campaign_recipients r
     set status = 'sending',
         account_id = coalesce(r.account_id, p_account),
         attempts = r.attempts + 1,
         updated_at = now()
   where r.id = (
     select q.id
     from public.campaign_recipients q
     where q.campaign_id = p_campaign
       and q.status in ('pending', 'waiting')
       and (q.next_send_at is null or q.next_send_at <= now())
       and (q.account_id is null or q.account_id = p_account)
     order by (q.status = 'waiting') desc, q.next_send_at nulls first, q.created_at
     limit 1
     for update skip locked
   )
  returning r.*;
$$;
revoke execute on function public.claim_next_recipient(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Analytics (SECURITY INVOKER: RLS applies; explicit membership check gives a clear error)
-- ---------------------------------------------------------------------------

create or replace function public.dashboard_overview(p_workspace uuid, p_days integer default 14)
returns jsonb language plpgsql stable set search_path = ''
as $$
declare
  tz text;
  today_start timestamptz;
  since timestamptz;
  days int := greatest(1, least(coalesce(p_days, 14), 365));
  result jsonb;
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  select coalesce(timezone, 'UTC') into tz from public.workspaces where id = p_workspace;
  today_start := date_trunc('day', now() at time zone tz) at time zone tz;
  since := today_start - make_interval(days => days - 1);

  with
  lead_totals as (
    select count(*)::int as total,
           count(*) filter (where created_at >= now() - interval '7 days')::int as new_7d,
           count(*) filter (where created_at >= since)::int as new_period,
           count(*) filter (where has_website)::int as with_website,
           count(*) filter (where not has_website)::int as without_website,
           count(*) filter (where wa_status = 'valid')::int as on_whatsapp,
           count(*) filter (where opted_out)::int as opted_out
    from public.leads where workspace_id = p_workspace
  ),
  msg as (
    select
      count(*) filter (where direction = 'out' and status in ('sent', 'delivered', 'read') and created_at >= today_start)::int as sent_today,
      count(*) filter (where direction = 'out' and status in ('sent', 'delivered', 'read'))::int as sent,
      count(*) filter (where direction = 'out' and status in ('delivered', 'read'))::int as delivered,
      count(*) filter (where direction = 'out' and status = 'read')::int as read,
      count(*) filter (where direction = 'out' and status = 'failed')::int as failed,
      count(*) filter (where direction = 'in')::int as received,
      count(distinct lead_id) filter (where direction = 'out' and status in ('sent', 'delivered', 'read'))::int as leads_messaged,
      count(distinct lead_id) filter (where direction = 'in')::int as leads_replied
    from public.messages
    where workspace_id = p_workspace and created_at >= since
  ),
  series as (
    select d::date as day,
      (select count(*) from public.messages m where m.workspace_id = p_workspace and m.direction = 'out'
         and m.status in ('sent', 'delivered', 'read')
         and m.created_at >= (d at time zone tz) and m.created_at < ((d + interval '1 day') at time zone tz))::int as sent,
      (select count(*) from public.messages m where m.workspace_id = p_workspace and m.direction = 'out'
         and m.status in ('delivered', 'read')
         and m.created_at >= (d at time zone tz) and m.created_at < ((d + interval '1 day') at time zone tz))::int as delivered,
      (select count(*) from public.messages m where m.workspace_id = p_workspace and m.direction = 'out'
         and m.status = 'read'
         and m.created_at >= (d at time zone tz) and m.created_at < ((d + interval '1 day') at time zone tz))::int as read,
      (select count(*) from public.messages m where m.workspace_id = p_workspace and m.direction = 'in'
         and m.created_at >= (d at time zone tz) and m.created_at < ((d + interval '1 day') at time zone tz))::int as replies,
      (select count(*) from public.leads l where l.workspace_id = p_workspace
         and l.created_at >= (d at time zone tz) and l.created_at < ((d + interval '1 day') at time zone tz))::int as leads
    from generate_series(date_trunc('day', since at time zone tz), date_trunc('day', now() at time zone tz), interval '1 day') d
  ),
  stages as (
    select s.id, s.name, s.color, s.kind, s.position,
           count(l.id)::int as count, coalesce(sum(l.deal_value), 0)::numeric as value
    from public.pipeline_stages s
    left join public.leads l on l.stage_id = s.id
    where s.workspace_id = p_workspace
    group by s.id
  ),
  cities as (
    select city as name, count(*)::int as count from public.leads
    where workspace_id = p_workspace and coalesce(city, '') <> ''
    group by city order by count(*) desc limit 6
  ),
  categories as (
    select category as name, count(*)::int as count from public.leads
    where workspace_id = p_workspace and coalesce(category, '') <> ''
    group by category order by count(*) desc limit 6
  )
  select jsonb_build_object(
    'timezone', tz,
    'days', days,
    'leads', (select to_jsonb(lead_totals) from lead_totals),
    'messages', (select to_jsonb(msg) from msg),
    'campaigns_active', (select count(*) from public.campaigns where workspace_id = p_workspace and status in ('running', 'scheduled')),
    'accounts_connected', (select count(*) from public.whatsapp_accounts where workspace_id = p_workspace and status = 'connected'),
    'accounts_total', (select count(*) from public.whatsapp_accounts where workspace_id = p_workspace),
    'won', (select jsonb_build_object('count', coalesce(sum(count), 0), 'value', coalesce(sum(value), 0)) from stages where kind = 'won'),
    'open_value', (select coalesce(sum(value), 0) from stages where kind not in ('won', 'lost')),
    'series', coalesce((select jsonb_agg(to_jsonb(series) order by day) from series), '[]'::jsonb),
    'stages', coalesce((select jsonb_agg(to_jsonb(stages) order by position) from stages), '[]'::jsonb),
    'top_cities', coalesce((select jsonb_agg(to_jsonb(cities)) from cities), '[]'::jsonb),
    'top_categories', coalesce((select jsonb_agg(to_jsonb(categories)) from categories), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create or replace function public.team_performance(p_workspace uuid, p_days integer default 30)
returns table (
  user_id uuid, full_name text, email text, role text,
  messages_sent integer, replies integer, leads_owned integer, won integer, won_value numeric, accounts_connected integer
)
language plpgsql stable set search_path = ''
as $$
declare
  since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  return query
  select
    m.user_id, p.full_name, p.email, m.role,
    (select count(*) from public.messages x
       left join public.campaigns c on c.id = x.campaign_id
      where x.workspace_id = p_workspace and x.direction = 'out' and x.status in ('sent', 'delivered', 'read')
        and x.created_at >= since and coalesce(x.sent_by, c.created_by) = m.user_id)::int,
    (select count(*) from public.messages x
       join public.whatsapp_accounts a on a.id = x.account_id
      where x.workspace_id = p_workspace and x.direction = 'in' and x.created_at >= since and a.owner_id = m.user_id)::int,
    (select count(*) from public.leads l where l.workspace_id = p_workspace and l.owner_id = m.user_id)::int,
    (select count(*) from public.leads l join public.pipeline_stages s on s.id = l.stage_id
      where l.workspace_id = p_workspace and l.owner_id = m.user_id and s.kind = 'won')::int,
    (select coalesce(sum(l.deal_value), 0) from public.leads l join public.pipeline_stages s on s.id = l.stage_id
      where l.workspace_id = p_workspace and l.owner_id = m.user_id and s.kind = 'won'),
    (select count(*) from public.whatsapp_accounts a
      where a.workspace_id = p_workspace and a.owner_id = m.user_id and a.status = 'connected')::int
  from public.workspace_members m
  join public.profiles p on p.id = m.user_id
  where m.workspace_id = p_workspace
  order by 5 desc, 6 desc;
end;
$$;

-- ----------------------------------------------------------------------------
-- 20261003000004_realtime_storage.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Realtime + Storage (guarded so the migration also runs on plain Postgres)
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.whatsapp_accounts,
      public.whatsapp_link_codes,
      public.scrape_jobs,
      public.messages,
      public.conversations,
      public.campaigns,
      public.campaign_recipients,
      public.notifications,
      public.engine_jobs,
      public.engine_status;
  end if;
end $$;

-- Media attachments for campaigns/templates: public-read bucket, uploads only
-- into a folder named after a workspace the user can write to:
--   media/<workspace_id>/<random>.<ext>
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('media', 'media', true, 16777216)
    on conflict (id) do nothing;

    execute $p$
      create policy "media: writers upload" on storage.objects
        for insert to authenticated
        with check (bucket_id = 'media' and public.can_write(public.try_uuid((storage.foldername(name))[1])))
    $p$;
    execute $p$
      create policy "media: writers delete" on storage.objects
        for delete to authenticated
        using (bucket_id = 'media' and public.can_write(public.try_uuid((storage.foldername(name))[1])))
    $p$;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 20261003000005_team_quality_automation.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- BatWos v2: team chat, lead scoring & qualifier, duplicates/merge, saved
-- segments, automations, campaign live log, number health, engine lease.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Lead scoring
-- ---------------------------------------------------------------------------

alter table public.leads add column score integer not null default 0 check (score between 0 and 100);
alter table public.leads add column score_tier text generated always as (
  case when score >= 70 then 'hot' when score >= 40 then 'warm' else 'cold' end
) stored;
create index leads_ws_score_idx on public.leads (workspace_id, score desc);

-- s = workspaces.settings->'scoring': { website_target: any|with|without, min_rating, min_reviews }
create or replace function public.compute_lead_score(l public.leads, s jsonb)
returns integer language plpgsql immutable set search_path = ''
as $$
declare
  score integer := 0;
  target text := coalesce(s ->> 'website_target', 'any');
  good_rating numeric := coalesce((s ->> 'min_rating')::numeric, 4.0);
  good_reviews integer := greatest(1, coalesce((s ->> 'min_reviews')::integer, 20));
  has_site boolean := l.website is not null and btrim(l.website) <> '';
begin
  if l.opted_out then
    return 0;
  end if;
  if l.phone is not null then
    score := score + 15 + case l.phone_type when 'mobile' then 15 when 'unknown' then 5 else 0 end;
  end if;
  score := score + case l.wa_status when 'valid' then 20 when 'invalid' then -25 else 0 end;
  if l.rating is not null then
    score := score + case
      when l.rating >= good_rating + 0.5 then 15
      when l.rating >= good_rating then 10
      when l.rating >= good_rating - 0.5 then 5
      else 0 end;
  end if;
  if l.reviews_count is not null then
    score := score + case
      when l.reviews_count >= good_reviews * 4 then 10
      when l.reviews_count >= good_reviews then 7
      when l.reviews_count >= greatest(1, good_reviews / 4) then 3
      else 0 end;
  end if;
  score := score + case
    when target = 'without' and not has_site then 15
    when target = 'with' and has_site then 15
    when target = 'any' then 5
    else 0 end;
  if coalesce(l.email, '') <> '' then
    score := score + 5;
  end if;
  if l.last_replied_at is not null then
    score := score + 15;
  end if;
  return greatest(0, least(100, score));
end;
$$;

-- Recompute the score on every write (the generated tier follows).
create or replace function public.leads_before_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.stage_id is null then
      select s.id into new.stage_id
      from public.pipeline_stages s
      where s.workspace_id = new.workspace_id
      order by (s.kind = 'new') desc, s.position
      limit 1;
    end if;
    if new.created_by is null then
      new.created_by := (select auth.uid());
    end if;
  end if;

  new.tags := coalesce(
    (select array_agg(distinct btrim(t)) from unnest(new.tags) t where btrim(t) <> ''),
    '{}'
  );

  if new.opted_out and (tg_op = 'INSERT' or not old.opted_out) then
    new.opted_out_at := coalesce(new.opted_out_at, now());
  elsif not new.opted_out then
    new.opted_out_at := null;
  end if;

  new.score := public.compute_lead_score(new, (select w.settings -> 'scoring' from public.workspaces w where w.id = new.workspace_id));
  return new;
end;
$$;

-- updated_at that can be skipped for housekeeping updates (rescoring).
create or replace function public.leads_touch()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if coalesce(current_setting('batsols.skip_touch', true), '') = '1' then
    return new;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists leads_updated_at on public.leads;
create trigger leads_updated_at before update on public.leads
  for each row execute function public.leads_touch();

create or replace function public.rescore_leads(p_workspace uuid)
returns integer language plpgsql volatile set search_path = ''
as $$
declare
  n integer;
begin
  if not public.is_admin(p_workspace) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  perform set_config('batsols.skip_touch', '1', true);
  update public.leads set score = score where workspace_id = p_workspace;
  get diagnostics n = row_count;
  perform set_config('batsols.skip_touch', '', true);
  return n;
end;
$$;

-- Score existing rows.
update public.leads set score = score;

-- ---------------------------------------------------------------------------
-- Scraper qualifier rules
-- { min_rating, min_reviews, require_mobile, skip_closed, website: any|with|without, exclude_keywords[] }
-- ---------------------------------------------------------------------------

alter table public.scrape_jobs add column qualify jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Lead search v2: + score, tier, no-double-outreach
-- ---------------------------------------------------------------------------

create or replace function public.filtered_leads(p_workspace uuid, p_filters jsonb default '{}'::jsonb)
returns setof public.leads
language sql stable set search_path = ''
as $$
  select l.*
  from public.leads l
  cross join lateral (
    select
      nullif(btrim(coalesce(p_filters ->> 'q', '')), '') as q,
      regexp_replace(coalesce(p_filters ->> 'q', ''), '\D', '', 'g') as q_digits
  ) s
  where l.workspace_id = p_workspace
    and (
      s.q is null
      or l.business_name ilike '%' || s.q || '%'
      or l.address ilike '%' || s.q || '%'
      or l.city ilike '%' || s.q || '%'
      or l.category ilike '%' || s.q || '%'
      or l.email ilike '%' || s.q || '%'
      or l.contact_name ilike '%' || s.q || '%'
      or l.website ilike '%' || s.q || '%'
      or (length(s.q_digits) >= 3 and l.phone like '%' || s.q_digits || '%')
    )
    and (cardinality(public.jarr(p_filters -> 'stage_ids')) = 0 or l.stage_id::text = any (public.jarr(p_filters -> 'stage_ids')))
    and (p_filters -> 'has_website' is null or jsonb_typeof(p_filters -> 'has_website') <> 'boolean'
         or l.has_website = (p_filters ->> 'has_website')::boolean)
    and (cardinality(public.jarr(p_filters -> 'cities')) = 0 or l.city = any (public.jarr(p_filters -> 'cities')))
    and (cardinality(public.jarr(p_filters -> 'categories')) = 0 or l.category = any (public.jarr(p_filters -> 'categories')))
    and (cardinality(public.jarr(p_filters -> 'tags')) = 0 or l.tags && public.jarr(p_filters -> 'tags'))
    and (
      (cardinality(public.jarr(p_filters -> 'owner_ids')) = 0 and coalesce((p_filters ->> 'unassigned')::boolean, false) = false)
      or l.owner_id::text = any (public.jarr(p_filters -> 'owner_ids'))
      or (coalesce((p_filters ->> 'unassigned')::boolean, false) and l.owner_id is null)
    )
    and (cardinality(public.jarr(p_filters -> 'wa_status')) = 0 or l.wa_status = any (public.jarr(p_filters -> 'wa_status')))
    and (cardinality(public.jarr(p_filters -> 'phone_types')) = 0 or l.phone_type = any (public.jarr(p_filters -> 'phone_types')))
    and (cardinality(public.jarr(p_filters -> 'sources')) = 0 or l.source = any (public.jarr(p_filters -> 'sources')))
    and (cardinality(public.jarr(p_filters -> 'tiers')) = 0 or l.score_tier = any (public.jarr(p_filters -> 'tiers')))
    and (p_filters ->> 'min_score' is null or l.score >= (p_filters ->> 'min_score')::int)
    and (p_filters ->> 'min_rating' is null or coalesce(l.rating, 0) >= (p_filters ->> 'min_rating')::numeric)
    and (p_filters ->> 'min_reviews' is null or coalesce(l.reviews_count, 0) >= (p_filters ->> 'min_reviews')::int)
    and (p_filters -> 'opted_out' is null or jsonb_typeof(p_filters -> 'opted_out') <> 'boolean'
         or l.opted_out = (p_filters ->> 'opted_out')::boolean)
    and (
      p_filters ->> 'contacted' is null
      or (p_filters ->> 'contacted' = 'never' and l.last_contacted_at is null)
      or (p_filters ->> 'contacted' = 'contacted' and l.last_contacted_at is not null)
      or (p_filters ->> 'contacted' = 'replied' and l.last_replied_at is not null)
      or (p_filters ->> 'contacted' = 'not_replied' and l.last_contacted_at is not null and l.last_replied_at is null)
    )
    and (p_filters ->> 'not_contacted_days' is null or l.last_contacted_at is null
         or l.last_contacted_at < now() - make_interval(days => (p_filters ->> 'not_contacted_days')::int))
    and (p_filters ->> 'scrape_job_id' is null or l.scrape_job_id = public.try_uuid(p_filters ->> 'scrape_job_id'))
    and (p_filters ->> 'created_from' is null or l.created_at >= (p_filters ->> 'created_from')::timestamptz)
    and (p_filters ->> 'created_to' is null or l.created_at < (p_filters ->> 'created_to')::timestamptz)
    and (p_filters -> 'has_phone' is null or jsonb_typeof(p_filters -> 'has_phone') <> 'boolean'
         or (l.phone is not null) = (p_filters ->> 'has_phone')::boolean)
    and (p_filters -> 'has_email' is null or jsonb_typeof(p_filters -> 'has_email') <> 'boolean'
         or (coalesce(l.email, '') <> '') = (p_filters ->> 'has_email')::boolean)
    and (
      coalesce((p_filters ->> 'sendable')::boolean, false) = false
      or (l.phone is not null and not l.opted_out and l.wa_status <> 'invalid')
    )
    -- Never let two campaigns (or two teammates) work the same lead at once.
    and (
      coalesce((p_filters ->> 'not_in_active_campaign')::boolean, false) = false
      or not exists (
        select 1 from public.campaign_recipients r
        join public.campaigns c on c.id = r.campaign_id
        where r.lead_id = l.id
          and c.status in ('scheduled', 'running', 'paused')
          and r.status in ('pending', 'waiting', 'sending')
          and c.id is distinct from public.try_uuid(p_filters ->> 'exclude_campaign_id')
      )
    );
$$;

-- ---------------------------------------------------------------------------
-- Duplicates & merge
-- ---------------------------------------------------------------------------

create table public.duplicate_dismissals (
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  match_type    text not null,
  match_key     text not null,
  dismissed_by  uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, match_type, match_key)
);

create or replace function public.lead_duplicate_groups(p_workspace uuid, p_limit integer default 200)
returns table (match_type text, match_key text, lead_ids uuid[], names text[], total integer)
language sql stable set search_path = ''
as $$
  with base as (
    select id, business_name, created_at,
      regexp_replace(lower(business_name), '[^[:alnum:]]+', '', 'g') as nkey,
      lower(btrim(coalesce(city, ''))) as ckey,
      nullif(regexp_replace(lower(btrim(coalesce(website, ''))), '^(https?://)?(www\.)?([^/?#:]+).*$', '\3'), '') as domain
    from public.leads
    where workspace_id = p_workspace
  ),
  groups as (
    select 'name_city'::text as match_type, nkey || '|' || ckey as match_key,
           array_agg(id order by created_at) as lead_ids, array_agg(business_name order by created_at) as names, count(*)::int as total
    from base where length(nkey) >= 3
    group by nkey, ckey having count(*) > 1
    union all
    select 'website', domain, array_agg(id order by created_at), array_agg(business_name order by created_at), count(*)::int
    from base
    where domain is not null
      and domain not in ('facebook.com', 'm.facebook.com', 'instagram.com', 'linktr.ee', 'wa.me', 'google.com', 'business.site',
                         'sites.google.com', 'business.google.com', 'youtube.com', 'linkedin.com', 'twitter.com', 'x.com', 'tiktok.com')
    group by domain having count(*) > 1
  )
  select g.* from groups g
  where not exists (
    select 1 from public.duplicate_dismissals d
    where d.workspace_id = p_workspace and d.match_type = g.match_type and d.match_key = g.match_key
  )
  order by g.total desc, g.match_key
  limit p_limit;
$$;

-- Fold `p_merge` leads into `p_keep`: history moves over, blanks get filled, merged rows are deleted.
create or replace function public.merge_leads(p_keep uuid, p_merge uuid[])
returns integer language plpgsql volatile security definer set search_path = ''
as $$
declare
  k public.leads%rowtype;
  m public.leads%rowtype;
  conv public.conversations%rowtype;
  existing uuid;
  merged uuid[] := '{}';
  names text[] := '{}';
  v_phone text; v_phone_raw text; v_phone_type text; v_wa text; v_email text; v_website text; v_contact text;
  v_address text; v_city text; v_country text; v_category text; v_maps text; v_place text;
  v_rating numeric; v_reviews integer; v_lat double precision; v_lng double precision;
  v_tags text[] := '{}'; v_socials jsonb := '{}'::jsonb; v_deal numeric := 0;
  v_contacted timestamptz; v_replied timestamptz; v_opted boolean := false;
begin
  select * into k from public.leads where id = p_keep for update;
  if not found then
    raise exception 'Lead not found' using errcode = 'P0002';
  end if;
  if not public.can_write(k.workspace_id) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  for m in select * from public.leads where id = any (p_merge) and id <> p_keep and workspace_id = k.workspace_id for update loop
    -- Conversations are unique per (number, lead): fold into an existing one when needed.
    for conv in select * from public.conversations where lead_id = m.id loop
      select id into existing from public.conversations where account_id = conv.account_id and lead_id = p_keep;
      if existing is not null then
        update public.messages set conversation_id = existing where conversation_id = conv.id;
        update public.conversations
           set unread_count = unread_count + conv.unread_count,
               last_message_at = greatest(last_message_at, conv.last_message_at)
         where id = existing;
        delete from public.conversations where id = conv.id;
      else
        update public.conversations set lead_id = p_keep where id = conv.id;
      end if;
    end loop;
    update public.messages set lead_id = p_keep where lead_id = m.id;
    update public.lead_notes set lead_id = p_keep where lead_id = m.id;
    update public.tasks set lead_id = p_keep where lead_id = m.id;
    update public.activities set lead_id = p_keep where lead_id = m.id;
    update public.chat_messages set lead_id = p_keep where lead_id = m.id;
    delete from public.campaign_recipients r
     where r.lead_id = m.id
       and exists (select 1 from public.campaign_recipients x where x.campaign_id = r.campaign_id and x.lead_id = p_keep);
    update public.campaign_recipients set lead_id = p_keep where lead_id = m.id;

    v_phone := coalesce(v_phone, m.phone); v_phone_raw := coalesce(v_phone_raw, m.phone_raw);
    v_phone_type := coalesce(v_phone_type, nullif(m.phone_type, 'unknown'));
    v_wa := coalesce(v_wa, nullif(m.wa_status, 'unknown'));
    v_email := coalesce(v_email, m.email); v_website := coalesce(v_website, m.website);
    v_contact := coalesce(v_contact, m.contact_name); v_address := coalesce(v_address, m.address);
    v_city := coalesce(v_city, m.city); v_country := coalesce(v_country, m.country);
    v_category := coalesce(v_category, m.category); v_maps := coalesce(v_maps, m.google_maps_url);
    v_place := coalesce(v_place, m.place_id);
    if m.reviews_count is not null and (v_reviews is null or m.reviews_count > v_reviews) then
      v_reviews := m.reviews_count; v_rating := m.rating;
    end if;
    v_lat := coalesce(v_lat, m.latitude); v_lng := coalesce(v_lng, m.longitude);
    v_tags := v_tags || m.tags; v_socials := m.socials || v_socials;
    v_deal := greatest(v_deal, m.deal_value);
    v_contacted := greatest(v_contacted, m.last_contacted_at);
    v_replied := greatest(v_replied, m.last_replied_at);
    v_opted := v_opted or m.opted_out;
    merged := merged || m.id;
    names := names || m.business_name;
  end loop;

  if cardinality(merged) = 0 then
    return 0;
  end if;

  delete from public.leads where id = any (merged);

  update public.leads set
    phone = coalesce(phone, v_phone),
    phone_raw = coalesce(phone_raw, v_phone_raw),
    phone_type = case when phone is null and v_phone is not null then coalesce(v_phone_type, 'unknown') else phone_type end,
    wa_status = case when wa_status = 'unknown' then coalesce(v_wa, 'unknown') else wa_status end,
    email = coalesce(email, v_email),
    website = coalesce(website, v_website),
    contact_name = coalesce(contact_name, v_contact),
    address = coalesce(address, v_address),
    city = coalesce(city, v_city),
    country = coalesce(country, v_country),
    category = coalesce(category, v_category),
    google_maps_url = coalesce(google_maps_url, v_maps),
    place_id = coalesce(place_id, v_place),
    rating = case when v_reviews is not null and v_reviews > coalesce(reviews_count, -1) then v_rating else rating end,
    reviews_count = greatest(reviews_count, v_reviews),
    latitude = coalesce(latitude, v_lat),
    longitude = coalesce(longitude, v_lng),
    tags = tags || v_tags,
    socials = v_socials || socials,
    deal_value = greatest(deal_value, v_deal),
    last_contacted_at = greatest(last_contacted_at, v_contacted),
    last_replied_at = greatest(last_replied_at, v_replied),
    opted_out = opted_out or v_opted
  where id = p_keep;

  insert into public.activities (workspace_id, lead_id, actor_id, type, data)
  values (k.workspace_id, p_keep, (select auth.uid()), 'merged', jsonb_build_object('names', to_jsonb(names), 'count', cardinality(merged)));

  return cardinality(merged);
end;
$$;
revoke execute on function public.merge_leads(uuid, uuid[]) from public, anon;
grant execute on function public.merge_leads(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Saved segments (lead views)
-- ---------------------------------------------------------------------------

create table public.saved_views (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  filters       jsonb not null default '{}'::jsonb,
  shared        boolean not null default true,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index saved_views_ws_idx on public.saved_views (workspace_id, name);

-- ---------------------------------------------------------------------------
-- Tasks: type (to-do, call, meeting, follow-up)
-- ---------------------------------------------------------------------------

alter table public.tasks add column type text not null default 'todo' check (type in ('todo', 'call', 'meeting', 'follow_up'));
alter table public.tasks add column notes text;

-- ---------------------------------------------------------------------------
-- Team chat
-- ---------------------------------------------------------------------------

create table public.chat_channels (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  kind             text not null default 'channel' check (kind in ('channel', 'dm')),
  name             text,
  description      text,
  is_private       boolean not null default false,
  is_default       boolean not null default false,   -- new members join automatically
  dm_key           text,                              -- sorted member ids (DMs only)
  created_by       uuid references public.profiles (id) on delete set null,
  last_message_at  timestamptz,
  archived         boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, dm_key),
  check (kind = 'dm' or char_length(btrim(coalesce(name, ''))) between 1 and 60)
);
create unique index chat_channels_name_uq on public.chat_channels (workspace_id, lower(name)) where kind = 'channel';

create table public.chat_members (
  channel_id    uuid not null,
  workspace_id  uuid not null,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  last_read_at  timestamptz not null default now(),
  muted         boolean not null default false,
  joined_at     timestamptz not null default now(),
  primary key (channel_id, user_id),
  foreign key (workspace_id, channel_id) references public.chat_channels (workspace_id, id) on delete cascade
);
create index chat_members_user_idx on public.chat_members (user_id, workspace_id);

create table public.chat_messages (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  channel_id    uuid not null,
  author_id     uuid references public.profiles (id) on delete set null,
  body          text not null default '' check (char_length(body) <= 8000),
  lead_id       uuid,
  reply_to      uuid references public.chat_messages (id) on delete set null,
  mentions      uuid[] not null default '{}',
  edited_at     timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (workspace_id, channel_id) references public.chat_channels (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete set null (lead_id)
);
create index chat_messages_channel_idx on public.chat_messages (channel_id, created_at desc);

create table public.chat_reactions (
  message_id    uuid not null references public.chat_messages (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  emoji         text not null check (char_length(emoji) between 1 and 16),
  created_at    timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create or replace function public.is_chat_member(cid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.chat_members m where m.channel_id = cid and m.user_id = (select auth.uid()));
$$;

-- Visible = public channel in my workspace, or a channel/DM I belong to.
create or replace function public.can_see_channel(cid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chat_channels c
    where c.id = cid
      and public.is_member(c.workspace_id)
      and ((c.kind = 'channel' and not c.is_private) or public.is_chat_member(c.id))
  );
$$;

create or replace function public.chat_create_channel(
  p_workspace uuid, p_name text, p_description text default null, p_private boolean default false, p_member_ids uuid[] default '{}'
)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  cid uuid;
begin
  if uid is null or not public.is_member(p_workspace) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.chat_channels (workspace_id, kind, name, description, is_private, created_by)
  values (p_workspace, 'channel', btrim(regexp_replace(lower(btrim(p_name)), '[[:space:]#]+', '-', 'g'), '-'), nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_private, false), uid)
  returning id into cid;
  insert into public.chat_members (channel_id, workspace_id, user_id)
  select cid, p_workspace, u
  from unnest(array_append(coalesce(p_member_ids, '{}'), uid)) as u
  where exists (select 1 from public.workspace_members wm where wm.workspace_id = p_workspace and wm.user_id = u)
  on conflict do nothing;
  return cid;
end;
$$;
revoke execute on function public.chat_create_channel(uuid, text, text, boolean, uuid[]) from public, anon;
grant execute on function public.chat_create_channel(uuid, text, text, boolean, uuid[]) to authenticated;

-- Open (or reuse) a direct message with one or more teammates.
create or replace function public.chat_open_dm(p_workspace uuid, p_user_ids uuid[])
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  members uuid[];
  key text;
  cid uuid;
begin
  if uid is null or not public.is_member(p_workspace) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select array_agg(distinct u order by u) into members
  from unnest(array_append(coalesce(p_user_ids, '{}'), uid)) u
  where exists (select 1 from public.workspace_members wm where wm.workspace_id = p_workspace and wm.user_id = u);
  if cardinality(members) < 1 then
    raise exception 'Pick at least one teammate' using errcode = '22023';
  end if;
  key := array_to_string(members, ',');
  insert into public.chat_channels (workspace_id, kind, is_private, dm_key, created_by)
  values (p_workspace, 'dm', true, key, uid)
  on conflict (workspace_id, dm_key) do nothing;
  select id into cid from public.chat_channels where workspace_id = p_workspace and dm_key = key;
  insert into public.chat_members (channel_id, workspace_id, user_id)
  select cid, p_workspace, u from unnest(members) u
  on conflict do nothing;
  return cid;
end;
$$;
revoke execute on function public.chat_open_dm(uuid, uuid[]) from public, anon;
grant execute on function public.chat_open_dm(uuid, uuid[]) to authenticated;

-- Add teammates to a channel I'm in (or any channel, for admins).
create or replace function public.chat_add_members(p_channel uuid, p_user_ids uuid[])
returns integer language plpgsql volatile security definer set search_path = ''
as $$
declare
  ws uuid;
  n integer;
begin
  select workspace_id into ws from public.chat_channels where id = p_channel and kind = 'channel';
  if ws is null or not (public.is_chat_member(p_channel) or public.is_admin(ws)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.chat_members (channel_id, workspace_id, user_id)
  select p_channel, ws, u from unnest(p_user_ids) u
  where exists (select 1 from public.workspace_members wm where wm.workspace_id = ws and wm.user_id = u)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.chat_add_members(uuid, uuid[]) from public, anon;
grant execute on function public.chat_add_members(uuid, uuid[]) to authenticated;

-- Unread counts for every channel I belong to.
create or replace function public.chat_overview(p_workspace uuid)
returns table (channel_id uuid, unread integer, mentions integer, last_message_at timestamptz)
language sql stable set search_path = ''
as $$
  select c.id,
    (select count(*) from public.chat_messages m
      where m.channel_id = c.id and m.created_at > cm.last_read_at and m.author_id is distinct from (select auth.uid()) and m.deleted_at is null)::int,
    (select count(*) from public.chat_messages m
      where m.channel_id = c.id and m.created_at > cm.last_read_at and (select auth.uid()) = any (m.mentions) and m.deleted_at is null)::int,
    c.last_message_at
  from public.chat_channels c
  join public.chat_members cm on cm.channel_id = c.id and cm.user_id = (select auth.uid())
  where c.workspace_id = p_workspace and not c.archived;
$$;

create or replace function public.chat_messages_after_insert()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  chan public.chat_channels%rowtype;
  author_name text;
begin
  select * into chan from public.chat_channels where id = new.channel_id;
  update public.chat_channels set last_message_at = new.created_at where id = new.channel_id;
  -- The author has obviously read up to their own message.
  update public.chat_members set last_read_at = new.created_at where channel_id = new.channel_id and user_id = new.author_id;

  select coalesce(nullif(full_name, ''), email) into author_name from public.profiles where id = new.author_id;
  insert into public.notifications (workspace_id, user_id, type, title, body, link)
  select new.workspace_id, u, 'mention',
         author_name || ' mentioned you' || case when chan.kind = 'channel' then ' in #' || chan.name else '' end,
         left(new.body, 160), '/chat?c=' || new.channel_id
  from unnest(new.mentions) u
  where u is distinct from new.author_id
    and exists (select 1 from public.workspace_members wm where wm.workspace_id = new.workspace_id and wm.user_id = u);
  return null;
end;
$$;
create trigger chat_messages_after_insert after insert on public.chat_messages
  for each row execute function public.chat_messages_after_insert();

-- New workspace members join default channels automatically.
create or replace function public.workspace_members_after_insert()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.chat_members (channel_id, workspace_id, user_id)
  select c.id, c.workspace_id, new.user_id
  from public.chat_channels c
  where c.workspace_id = new.workspace_id and c.is_default and c.kind = 'channel'
  on conflict do nothing;
  return null;
end;
$$;
create trigger workspace_members_after_insert after insert on public.workspace_members
  for each row execute function public.workspace_members_after_insert();

-- Leaving a workspace removes you from its chats.
create or replace function public.workspace_members_after_delete()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.chat_members where workspace_id = old.workspace_id and user_id = old.user_id;
  return null;
end;
$$;
create trigger workspace_members_after_delete after delete on public.workspace_members
  for each row execute function public.workspace_members_after_delete();

create trigger chat_channels_updated_at before update on public.chat_channels
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Workspace creation v2: scoring defaults + #general
-- ---------------------------------------------------------------------------

create or replace function public.create_workspace(p_name text, p_timezone text default 'Asia/Karachi', p_country text default 'PK')
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  ws uuid;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  insert into public.workspaces (name, timezone, default_country, created_by, settings)
  values (
    btrim(p_name), coalesce(nullif(p_timezone, ''), 'UTC'), upper(coalesce(nullif(p_country, ''), 'PK')), uid,
    jsonb_build_object(
      'opt_out_keywords', jsonb_build_array('stop', 'unsubscribe', 'remove', 'not interested'),
      'capture_unknown_inbound', false,
      'auto_stage_on_send', true,
      'auto_stage_on_reply', true,
      'scoring', jsonb_build_object('website_target', 'any', 'min_rating', 4.0, 'min_reviews', 20)
    )
  )
  returning id into ws;
  insert into public.chat_channels (workspace_id, kind, name, description, is_default, created_by)
  values (ws, 'channel', 'general', 'Team-wide announcements and chat', true, uid);
  -- Owner membership also joins #general through the trigger above.
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, uid, 'owner');
  insert into public.workspace_integrations (workspace_id) values (ws);
  perform public.create_default_stages(ws);
  return ws;
end;
$$;

-- Existing workspaces get a #general too.
insert into public.chat_channels (workspace_id, kind, name, description, is_default, created_by)
select w.id, 'channel', 'general', 'Team-wide announcements and chat', true, w.created_by
from public.workspaces w
where not exists (select 1 from public.chat_channels c where c.workspace_id = w.id and c.kind = 'channel' and lower(c.name) = 'general');
insert into public.chat_members (channel_id, workspace_id, user_id)
select c.id, c.workspace_id, m.user_id
from public.chat_channels c join public.workspace_members m on m.workspace_id = c.workspace_id
where c.is_default
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Campaign live log
-- ---------------------------------------------------------------------------

create table public.campaign_events (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid not null,
  lead_id       uuid,
  account_id    uuid,
  type          text not null check (type in ('sent', 'failed', 'skipped', 'replied', 'opted_out', 'started', 'paused', 'resumed', 'completed', 'waiting', 'info')),
  message       text not null default '',
  created_at    timestamptz not null default now(),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade
);
create index campaign_events_campaign_idx on public.campaign_events (campaign_id, id desc);

-- ---------------------------------------------------------------------------
-- Automations
-- ---------------------------------------------------------------------------

create table public.automations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  enabled       boolean not null default true,
  trigger       text not null check (trigger in ('reply_received', 'keyword', 'stage_changed', 'campaign_no_reply', 'lead_created')),
  -- { keywords[], match: any|exact, stage_id, campaign_id, first_reply_only, outside_hours: {start,end,days,timezone}, sources[] }
  conditions    jsonb not null default '{}'::jsonb,
  -- [{ type: send_template|move_stage|assign|add_tag|create_task|notify, ... }]
  actions       jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array'),
  created_by    uuid references public.profiles (id) on delete set null,
  run_count     integer not null default 0,
  last_run_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index automations_ws_idx on public.automations (workspace_id, trigger) where enabled;
create trigger automations_updated_at before update on public.automations
  for each row execute function public.set_updated_at();

create table public.automation_runs (
  id             bigint generated always as identity primary key,
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  automation_id  uuid not null references public.automations (id) on delete cascade,
  lead_id        uuid,
  status         text not null check (status in ('success', 'failed', 'skipped')),
  detail         text not null default '',
  created_at     timestamptz not null default now()
);
create index automation_runs_idx on public.automation_runs (automation_id, id desc);

-- Events produced inside Postgres (stage changes, new leads) for the engine to process.
create table public.automation_queue (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  trigger       text not null,
  lead_id       uuid,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);
create index automation_queue_pending_idx on public.automation_queue (id) where processed_at is null;

-- Requests from the engine's automation runner carry this header; their
-- side effects must not enqueue more automation events (no loops).
create or replace function public.is_automation_request()
returns boolean language sql stable set search_path = ''
as $$
  select coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-batsols-automation') = '1',
    false
  );
$$;

create or replace function public.leads_enqueue_automation()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if public.is_automation_request() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from public.automations a where a.workspace_id = new.workspace_id and a.enabled and a.trigger = 'lead_created') then
      insert into public.automation_queue (workspace_id, trigger, lead_id, payload)
      values (new.workspace_id, 'lead_created', new.id, jsonb_build_object('source', new.source));
    end if;
  elsif new.stage_id is distinct from old.stage_id then
    if exists (select 1 from public.automations a where a.workspace_id = new.workspace_id and a.enabled and a.trigger = 'stage_changed') then
      insert into public.automation_queue (workspace_id, trigger, lead_id, payload)
      values (new.workspace_id, 'stage_changed', new.id, jsonb_build_object('from', old.stage_id, 'to', new.stage_id));
    end if;
  end if;
  return null;
end;
$$;
create trigger leads_enqueue_automation after insert or update on public.leads
  for each row execute function public.leads_enqueue_automation();

-- ---------------------------------------------------------------------------
-- Engine: single active instance lease, number health
-- ---------------------------------------------------------------------------

alter table public.engine_status add column instance_id text;
alter table public.engine_status add column lease_until timestamptz;

alter table public.whatsapp_accounts add column disconnect_count integer not null default 0;
alter table public.whatsapp_accounts add column last_disconnect_at timestamptz;

create or replace function public.engine_acquire_lease(p_instance text, p_ttl_seconds integer default 45)
returns boolean language plpgsql volatile security definer set search_path = ''
as $$
declare
  ok boolean;
begin
  insert into public.engine_status (id) values ('main') on conflict (id) do nothing;
  update public.engine_status
     set instance_id = p_instance,
         lease_until = now() + make_interval(secs => p_ttl_seconds),
         heartbeat_at = now()
   where id = 'main'
     and (instance_id is null or instance_id = p_instance or lease_until is null or lease_until < now())
  returning true into ok;
  return coalesce(ok, false);
end;
$$;

create or replace function public.engine_release_lease(p_instance text)
returns void language sql volatile security definer set search_path = ''
as $$
  update public.engine_status set instance_id = null, lease_until = null where id = 'main' and instance_id = p_instance;
$$;

revoke execute on function public.engine_acquire_lease(text, integer) from public, anon, authenticated;
revoke execute on function public.engine_release_lease(text) from public, anon, authenticated;

create or replace function public.account_health(p_workspace uuid, p_days integer default 7)
returns table (account_id uuid, sent_today integer, sent integer, delivered integer, read integer, failed integer, replies integer)
language plpgsql stable set search_path = ''
as $$
declare
  tz text;
  today_start timestamptz;
  since timestamptz;
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  select coalesce(timezone, 'UTC') into tz from public.workspaces where id = p_workspace;
  today_start := date_trunc('day', now() at time zone tz) at time zone tz;
  since := least(today_start, now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90))));
  return query
  select a.id,
    count(m.id) filter (where m.direction = 'out' and m.status in ('sent', 'delivered', 'read') and m.created_at >= today_start)::int,
    count(m.id) filter (where m.direction = 'out' and m.status in ('sent', 'delivered', 'read'))::int,
    count(m.id) filter (where m.direction = 'out' and m.status in ('delivered', 'read'))::int,
    count(m.id) filter (where m.direction = 'out' and m.status = 'read')::int,
    count(m.id) filter (where m.direction = 'out' and m.status = 'failed')::int,
    count(m.id) filter (where m.direction = 'in')::int
  from public.whatsapp_accounts a
  left join public.messages m on m.account_id = a.id and m.created_at >= since
  where a.workspace_id = p_workspace
  group by a.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS for the new tables
-- ---------------------------------------------------------------------------

alter table public.duplicate_dismissals enable row level security;
alter table public.saved_views enable row level security;
alter table public.chat_channels enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_reactions enable row level security;
alter table public.campaign_events enable row level security;
alter table public.automations enable row level security;
alter table public.automation_runs enable row level security;
alter table public.automation_queue enable row level security;

revoke all on public.duplicate_dismissals, public.saved_views, public.chat_channels, public.chat_members,
  public.chat_messages, public.chat_reactions, public.campaign_events, public.automations,
  public.automation_runs, public.automation_queue from anon;
revoke all on public.automation_queue from authenticated;
revoke insert, update, delete on public.campaign_events, public.automation_runs from authenticated;

revoke update on public.chat_channels, public.chat_members, public.chat_messages from authenticated;
grant update (name, description, is_private, archived) on public.chat_channels to authenticated;
grant update (last_read_at, muted) on public.chat_members to authenticated;
grant update (body, edited_at, deleted_at) on public.chat_messages to authenticated;
revoke insert on public.chat_channels from authenticated;  -- via chat_create_channel / chat_open_dm

create policy "dismissals: members read" on public.duplicate_dismissals
  for select to authenticated using (public.is_member(workspace_id));
create policy "dismissals: writers add" on public.duplicate_dismissals
  for insert to authenticated with check (public.can_write(workspace_id) and dismissed_by = (select auth.uid()));
create policy "dismissals: writers remove" on public.duplicate_dismissals
  for delete to authenticated using (public.can_write(workspace_id));

create policy "views: read shared or own" on public.saved_views
  for select to authenticated using (public.is_member(workspace_id) and (shared or created_by = (select auth.uid())));
create policy "views: writers add" on public.saved_views
  for insert to authenticated with check (public.can_write(workspace_id) and created_by = (select auth.uid()));
create policy "views: creator or admin updates" on public.saved_views
  for update to authenticated
  using (created_by = (select auth.uid()) or public.is_admin(workspace_id))
  with check (public.is_member(workspace_id));
create policy "views: creator or admin deletes" on public.saved_views
  for delete to authenticated using (created_by = (select auth.uid()) or public.is_admin(workspace_id));

create policy "channels: visible" on public.chat_channels
  for select to authenticated using (public.is_member(workspace_id) and ((kind = 'channel' and not is_private) or public.is_chat_member(id)));
create policy "channels: creator or admin edits" on public.chat_channels
  for update to authenticated
  using (kind = 'channel' and (created_by = (select auth.uid()) or public.is_admin(workspace_id)))
  with check (public.is_member(workspace_id));
create policy "channels: creator or admin deletes" on public.chat_channels
  for delete to authenticated
  using (kind = 'channel' and not is_default and (created_by = (select auth.uid()) or public.is_admin(workspace_id)));

create policy "chat members: visible with channel" on public.chat_members
  for select to authenticated using (public.can_see_channel(channel_id));
create policy "chat members: join public channels" on public.chat_members
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.chat_channels c where c.id = channel_id and c.workspace_id = chat_members.workspace_id
                and c.kind = 'channel' and not c.is_private and public.is_member(c.workspace_id))
  );
create policy "chat members: update own" on public.chat_members
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "chat members: leave or remove" on public.chat_members
  for delete to authenticated using (
    user_id = (select auth.uid())
    or exists (select 1 from public.chat_channels c where c.id = channel_id and c.kind = 'channel'
               and (c.created_by = (select auth.uid()) or public.is_admin(c.workspace_id)))
  );

create policy "chat messages: read" on public.chat_messages
  for select to authenticated using (public.can_see_channel(channel_id));
create policy "chat messages: members post" on public.chat_messages
  for insert to authenticated with check (
    author_id = (select auth.uid()) and public.is_chat_member(channel_id) and deleted_at is null
    and (char_length(btrim(body)) > 0 or lead_id is not null)
  );
create policy "chat messages: author edits" on public.chat_messages
  for update to authenticated using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "chat messages: author or admin deletes" on public.chat_messages
  for delete to authenticated using (author_id = (select auth.uid()) or public.is_admin(workspace_id));

create policy "reactions: read" on public.chat_reactions
  for select to authenticated using (exists (select 1 from public.chat_messages m where m.id = message_id and public.can_see_channel(m.channel_id)));
create policy "reactions: add own" on public.chat_reactions
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.chat_messages m where m.id = message_id and m.workspace_id = chat_reactions.workspace_id and public.is_chat_member(m.channel_id))
  );
create policy "reactions: remove own" on public.chat_reactions
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "campaign events: members read" on public.campaign_events
  for select to authenticated using (public.is_member(workspace_id));

create policy "automations: members read" on public.automations
  for select to authenticated using (public.is_member(workspace_id));
create policy "automations: admins create" on public.automations
  for insert to authenticated with check (public.is_admin(workspace_id) and created_by = (select auth.uid()));
create policy "automations: admins update" on public.automations
  for update to authenticated using (public.is_admin(workspace_id)) with check (public.is_admin(workspace_id));
create policy "automations: admins delete" on public.automations
  for delete to authenticated using (public.is_admin(workspace_id));

create policy "automation runs: members read" on public.automation_runs
  for select to authenticated using (public.is_member(workspace_id));

-- automation_queue: engine only (no policies).

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.chat_channels,
      public.chat_members,
      public.chat_messages,
      public.chat_reactions,
      public.campaign_events;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 20261003000006_member_spaces_access.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Personal member spaces, teams, lead lists, access grants, permissions and
-- team reports.
--
-- Visibility model
--   owner / admin / viewer : see the whole workspace (viewer is read-only)
--   member                 : sees what they own + what is shared with them
--                            (directly or through a team). Admins can let
--                            members see all leads with a workspace setting.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Members: active flag, title, permissions
-- ---------------------------------------------------------------------------

alter table public.workspace_members add column active boolean not null default true;
alter table public.workspace_members add column title text;
-- { scrape, create_campaigns, connect_whatsapp, export, import, delete_leads, use_ai: bool, max_numbers: int, daily_message_cap: int|null }
alter table public.workspace_members add column permissions jsonb not null default '{}'::jsonb;
grant update (role, active, title, permissions) on public.workspace_members to authenticated;

-- Membership helpers now require an active membership.
create or replace function public.workspace_role(ws uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select m.role from public.workspace_members m
  where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.active;
$$;

create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.active);
$$;

create or replace function public.can_write(ws uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.active and m.role in ('owner', 'admin', 'member')
  );
$$;

create or replace function public.is_admin(ws uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.active and m.role in ('owner', 'admin')
  );
$$;

create or replace function public.is_owner(ws uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.active and m.role = 'owner'
  );
$$;

-- Owners, admins and viewers see everything in the workspace.
create or replace function public.sees_all(ws uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.active and m.role in ('owner', 'admin', 'viewer')
  );
$$;

create or replace function public.sees_all_leads(ws uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select public.sees_all(ws) or (
    public.is_member(ws)
    and coalesce((select (w.settings ->> 'members_see_all_leads')::boolean from public.workspaces w where w.id = ws), false)
  );
$$;

-- Per-member permission with sensible defaults. Admins can do everything; viewers nothing.
create or replace function public.member_can(ws uuid, perm text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select case
      when m.role in ('owner', 'admin') then true
      when m.role = 'viewer' then false
      else coalesce(
        (m.permissions ->> perm)::boolean,
        perm in ('scrape', 'create_campaigns', 'connect_whatsapp', 'export', 'import', 'use_ai')
      )
    end
    from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.active
  ), false);
$$;

-- Owners can't be suspended; keep the last-owner protection.
create or replace function public.guard_member_active()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if not new.active and new.role = 'owner' then
    raise exception 'Owners can’t be suspended. Change their role first.' using errcode = 'P0001';
  end if;
  if (select auth.uid()) is not null and new.user_id = (select auth.uid()) and new.active is distinct from old.active then
    raise exception 'You can’t suspend yourself' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger workspace_members_active_guard before update of active, role on public.workspace_members
  for each row execute function public.guard_member_active();

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------

create table public.teams (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  description   text,
  color         text not null default '#4f46e5',
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index teams_name_uq on public.teams (workspace_id, lower(name));

create table public.team_members (
  team_id       uuid not null,
  workspace_id  uuid not null,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  added_at      timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (workspace_id, team_id) references public.teams (workspace_id, id) on delete cascade
);
create index team_members_user_idx on public.team_members (user_id, workspace_id);

-- Leaving the workspace removes team memberships.
create or replace function public.workspace_members_after_delete()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.chat_members where workspace_id = old.workspace_id and user_id = old.user_id;
  delete from public.team_members where workspace_id = old.workspace_id and user_id = old.user_id;
  delete from public.resource_access where workspace_id = old.workspace_id and user_id = old.user_id;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lead lists ("groups" of leads that can be shared)
-- ---------------------------------------------------------------------------

create table public.lead_lists (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  description   text,
  color         text not null default '#4f46e5',
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, id)
);
create index lead_lists_ws_idx on public.lead_lists (workspace_id, name);
create trigger lead_lists_updated_at before update on public.lead_lists
  for each row execute function public.set_updated_at();

create table public.lead_list_items (
  list_id       uuid not null,
  workspace_id  uuid not null,
  lead_id       uuid not null,
  added_by      uuid references public.profiles (id) on delete set null,
  added_at      timestamptz not null default now(),
  primary key (list_id, lead_id),
  foreign key (workspace_id, list_id) references public.lead_lists (workspace_id, id) on delete cascade,
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index lead_list_items_lead_idx on public.lead_list_items (lead_id);

-- ---------------------------------------------------------------------------
-- Access grants (to a member or to a whole team)
-- ---------------------------------------------------------------------------

create table public.resource_access (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  resource_type  text not null check (resource_type in ('lead_list', 'campaign', 'automation', 'template', 'whatsapp_account')),
  resource_id    uuid not null,
  user_id        uuid references public.profiles (id) on delete cascade,
  team_id        uuid,
  access         text not null default 'manage' check (access in ('view', 'manage')),
  granted_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  check ((user_id is null) <> (team_id is null)),
  foreign key (workspace_id, team_id) references public.teams (workspace_id, id) on delete cascade
);
create unique index resource_access_uq on public.resource_access (resource_type, resource_id, coalesce(user_id, team_id));
create index resource_access_user_idx on public.resource_access (user_id) where user_id is not null;
create index resource_access_team_idx on public.resource_access (team_id) where team_id is not null;

create or replace function public.has_grant(p_type text, p_id uuid, p_manage boolean default false)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.resource_access g
    where g.resource_type = p_type and g.resource_id = p_id
      and public.is_member(g.workspace_id)
      and (
        g.user_id = (select auth.uid())
        or g.team_id in (select tm.team_id from public.team_members tm where tm.user_id = (select auth.uid()))
      )
      and (not p_manage or g.access = 'manage')
  );
$$;

create or replace function public.has_any_grant(p_type text, p_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.resource_access g where g.resource_type = p_type and g.resource_id = p_id);
$$;

-- Grants go away with the resource.
create or replace function public.delete_resource_grants()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.resource_access where resource_type = tg_argv[0] and resource_id = old.id;
  return null;
end;
$$;
create trigger lead_lists_drop_grants after delete on public.lead_lists for each row execute function public.delete_resource_grants('lead_list');
create trigger campaigns_drop_grants after delete on public.campaigns for each row execute function public.delete_resource_grants('campaign');
create trigger automations_drop_grants after delete on public.automations for each row execute function public.delete_resource_grants('automation');
create trigger templates_drop_grants after delete on public.message_templates for each row execute function public.delete_resource_grants('template');
create trigger wa_accounts_drop_grants after delete on public.whatsapp_accounts for each row execute function public.delete_resource_grants('whatsapp_account');

-- ---------------------------------------------------------------------------
-- Resource scope columns
-- ---------------------------------------------------------------------------

-- Workspace templates are visible to everyone; personal ones to their creator (+ grants).
alter table public.message_templates add column scope text not null default 'workspace' check (scope in ('workspace', 'personal'));
create or replace function public.templates_default_scope()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not public.is_admin(new.workspace_id) then
    new.scope := 'personal';
  end if;
  return new;
end;
$$;
create trigger templates_default_scope before insert on public.message_templates
  for each row execute function public.templates_default_scope();
-- Personal automations act only on their owner's leads and numbers; null = workspace-wide.
alter table public.automations add column owner_id uuid references public.profiles (id) on delete cascade;
-- Numbers are personal unless shared.
alter table public.whatsapp_accounts alter column shared set default false;

-- ---------------------------------------------------------------------------
-- Visibility functions
-- ---------------------------------------------------------------------------

create or replace function public.can_view_list(lid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.lead_lists l
    where l.id = lid and public.is_member(l.workspace_id)
      and (public.sees_all(l.workspace_id) or l.created_by = (select auth.uid()) or public.has_grant('lead_list', l.id))
  );
$$;

create or replace function public.can_edit_list(lid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.lead_lists l
    where l.id = lid and public.can_write(l.workspace_id)
      and (public.is_admin(l.workspace_id) or l.created_by = (select auth.uid()) or public.has_grant('lead_list', l.id, true))
  );
$$;

create or replace function public.can_view_campaign(cid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.campaigns c
    where c.id = cid and public.is_member(c.workspace_id)
      and (public.sees_all(c.workspace_id) or c.created_by = (select auth.uid()) or public.has_grant('campaign', c.id))
  );
$$;

create or replace function public.can_edit_campaign(cid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.campaigns c
    where c.id = cid and public.can_write(c.workspace_id)
      and (public.is_admin(c.workspace_id) or c.created_by = (select auth.uid()) or public.has_grant('campaign', c.id, true))
  );
$$;

create or replace function public.can_view_account(acc uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.whatsapp_accounts a
    where a.id = acc and public.is_member(a.workspace_id)
      and (public.sees_all(a.workspace_id) or a.owner_id = (select auth.uid()) or a.shared or public.has_grant('whatsapp_account', a.id))
  );
$$;

create or replace function public.can_use_account(acc uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.whatsapp_accounts a
    where a.id = acc and public.can_write(a.workspace_id)
      and (public.is_admin(a.workspace_id) or a.owner_id = (select auth.uid()) or a.shared or public.has_grant('whatsapp_account', a.id, true))
  );
$$;

-- A member sees a lead if they own it, it sits in a list shared with them,
-- it is in a campaign they can see, or it talks to one of their numbers.
create or replace function public.can_view_lead(lid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.leads l
    where l.id = lid
      and (
        public.sees_all_leads(l.workspace_id)
        or (public.is_member(l.workspace_id) and (
          l.owner_id = (select auth.uid())
          or exists (select 1 from public.lead_list_items li where li.lead_id = l.id and public.can_view_list(li.list_id))
          or exists (select 1 from public.campaign_recipients r where r.lead_id = l.id and public.can_view_campaign(r.campaign_id))
          or exists (select 1 from public.conversations c join public.whatsapp_accounts a on a.id = c.account_id
                     where c.lead_id = l.id and a.owner_id = (select auth.uid()))
        ))
      )
  );
$$;

create or replace function public.can_view_automation(aid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.automations a
    where a.id = aid and public.is_member(a.workspace_id)
      and (
        public.sees_all(a.workspace_id)
        or a.owner_id = (select auth.uid())
        or (a.owner_id is null and (public.has_grant('automation', a.id) or not public.has_any_grant('automation', a.id)))
      )
  );
$$;

-- Who may share a resource: admins and the resource's creator/owner.
create or replace function public.can_share(p_type text, p_id uuid)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  ws uuid;
  creator uuid;
begin
  case p_type
    when 'lead_list' then select workspace_id, created_by into ws, creator from public.lead_lists where id = p_id;
    when 'campaign' then select workspace_id, created_by into ws, creator from public.campaigns where id = p_id;
    when 'automation' then select workspace_id, coalesce(owner_id, created_by) into ws, creator from public.automations where id = p_id;
    when 'template' then select workspace_id, created_by into ws, creator from public.message_templates where id = p_id;
    when 'whatsapp_account' then select workspace_id, owner_id into ws, creator from public.whatsapp_accounts where id = p_id;
    else return false;
  end case;
  return ws is not null and public.can_write(ws) and (public.is_admin(ws) or creator = (select auth.uid()));
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership defaults & limits
-- ---------------------------------------------------------------------------

-- Leads a member creates without an owner become theirs (otherwise they'd vanish from their view).
create or replace function public.leads_default_owner()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.owner_id is null and (select auth.uid()) is not null and not public.sees_all_leads(new.workspace_id) then
    new.owner_id := (select auth.uid());
  end if;
  return new;
end;
$$;
create trigger leads_default_owner before insert on public.leads
  for each row execute function public.leads_default_owner();

-- Max WhatsApp numbers per member (permissions.max_numbers, default 3).
create or replace function public.wa_accounts_limit()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  lim integer;
  have integer;
begin
  if (select auth.uid()) is null or public.is_admin(new.workspace_id) then
    return new;
  end if;
  select coalesce((m.permissions ->> 'max_numbers')::int, 3) into lim
  from public.workspace_members m where m.workspace_id = new.workspace_id and m.user_id = new.owner_id;
  select count(*) into have from public.whatsapp_accounts where workspace_id = new.workspace_id and owner_id = new.owner_id;
  if have >= coalesce(lim, 3) then
    raise exception 'You can connect up to % WhatsApp numbers. Ask an admin to raise your limit.', coalesce(lim, 3) using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger wa_accounts_limit before insert on public.whatsapp_accounts
  for each row execute function public.wa_accounts_limit();

-- ---------------------------------------------------------------------------
-- Policies: replace workspace-wide reads with personal-space visibility
-- ---------------------------------------------------------------------------

drop policy if exists "leads: members read" on public.leads;
drop policy if exists "leads: writers update" on public.leads;
drop policy if exists "leads: admins or owner/creator delete" on public.leads;
create policy "leads: visible" on public.leads
  for select to authenticated using (
    public.sees_all_leads(workspace_id)
    or (public.is_member(workspace_id) and (
      owner_id = (select auth.uid())
      or exists (select 1 from public.lead_list_items li where li.lead_id = leads.id and public.can_view_list(li.list_id))
      or exists (select 1 from public.campaign_recipients r where r.lead_id = leads.id and public.can_view_campaign(r.campaign_id))
      or exists (select 1 from public.conversations c join public.whatsapp_accounts a on a.id = c.account_id
                 where c.lead_id = leads.id and a.owner_id = (select auth.uid()))
    ))
  );
create policy "leads: writers update visible" on public.leads
  for update to authenticated
  using (public.can_write(workspace_id) and public.can_view_lead(id))
  with check (public.can_write(workspace_id));
create policy "leads: admins or permitted owners delete" on public.leads
  for delete to authenticated using (
    public.is_admin(workspace_id)
    or (public.member_can(workspace_id, 'delete_leads') and (owner_id = (select auth.uid()) or created_by = (select auth.uid())))
  );

drop policy if exists "notes: members read" on public.lead_notes;
drop policy if exists "notes: writers add" on public.lead_notes;
create policy "notes: visible with lead" on public.lead_notes
  for select to authenticated using (public.can_view_lead(lead_id));
create policy "notes: writers add on visible leads" on public.lead_notes
  for insert to authenticated with check (public.can_write(workspace_id) and author_id = (select auth.uid()) and public.can_view_lead(lead_id));

drop policy if exists "tasks: members read" on public.tasks;
drop policy if exists "tasks: writers update" on public.tasks;
create policy "tasks: visible" on public.tasks
  for select to authenticated using (
    public.sees_all(workspace_id)
    or (public.is_member(workspace_id) and (
      assignee_id = (select auth.uid()) or created_by = (select auth.uid()) or (lead_id is not null and public.can_view_lead(lead_id))
    ))
  );
create policy "tasks: writers update visible" on public.tasks
  for update to authenticated
  using (public.can_write(workspace_id) and (public.is_admin(workspace_id) or assignee_id = (select auth.uid()) or created_by = (select auth.uid())
         or (lead_id is not null and public.can_view_lead(lead_id))))
  with check (public.can_write(workspace_id));

drop policy if exists "activities: members read" on public.activities;
create policy "activities: visible with lead" on public.activities
  for select to authenticated using (
    (lead_id is not null and public.can_view_lead(lead_id)) or (lead_id is null and public.sees_all(workspace_id))
  );

drop policy if exists "wa_accounts: members read" on public.whatsapp_accounts;
drop policy if exists "wa_accounts: writers add own" on public.whatsapp_accounts;
create policy "wa_accounts: visible" on public.whatsapp_accounts
  for select to authenticated using (
    public.is_member(workspace_id)
    and (public.sees_all(workspace_id) or owner_id = (select auth.uid()) or shared or public.has_grant('whatsapp_account', id))
  );
create policy "wa_accounts: permitted members add own" on public.whatsapp_accounts
  for insert to authenticated with check (
    public.can_write(workspace_id) and owner_id = (select auth.uid()) and public.member_can(workspace_id, 'connect_whatsapp')
  );

drop policy if exists "conversations: members read" on public.conversations;
drop policy if exists "conversations: writers update" on public.conversations;
create policy "conversations: visible" on public.conversations
  for select to authenticated using (
    public.sees_all(workspace_id) or (public.is_member(workspace_id) and (public.can_view_account(account_id) or public.can_view_lead(lead_id)))
  );
create policy "conversations: writers update visible" on public.conversations
  for update to authenticated
  using (public.can_write(workspace_id) and (public.sees_all(workspace_id) or public.can_view_account(account_id) or public.can_view_lead(lead_id)))
  with check (public.can_write(workspace_id));

drop policy if exists "messages: members read" on public.messages;
create policy "messages: visible" on public.messages
  for select to authenticated using (
    public.sees_all(workspace_id)
    or (public.is_member(workspace_id) and ((account_id is not null and public.can_view_account(account_id)) or public.can_view_lead(lead_id)))
  );
drop policy if exists "messages: writers queue outbound" on public.messages;
create policy "messages: writers queue outbound" on public.messages
  for insert to authenticated with check (
    public.can_write(workspace_id)
    and direction = 'out'
    and status = 'queued'
    and sent_by = (select auth.uid())
    and campaign_id is null
    and recipient_id is null
    and account_id is not null
    and public.can_use_account(account_id)
    and public.can_view_lead(lead_id)
  );

drop policy if exists "campaigns: members read" on public.campaigns;
drop policy if exists "campaigns: writers create" on public.campaigns;
-- Policies on a table evaluate its own columns (a function re-reading the row by id
-- can't see rows inserted by the same statement, which breaks INSERT ... RETURNING).
create policy "campaigns: visible" on public.campaigns
  for select to authenticated using (
    public.is_member(workspace_id)
    and (public.sees_all(workspace_id) or created_by = (select auth.uid()) or public.has_grant('campaign', id))
  );
create policy "campaigns: permitted members create" on public.campaigns
  for insert to authenticated with check (
    public.can_write(workspace_id) and created_by = (select auth.uid()) and public.member_can(workspace_id, 'create_campaigns')
  );

drop policy if exists "steps: members read" on public.campaign_steps;
create policy "steps: visible with campaign" on public.campaign_steps
  for select to authenticated using (public.can_view_campaign(campaign_id));

drop policy if exists "recipients: members read" on public.campaign_recipients;
create policy "recipients: visible with campaign" on public.campaign_recipients
  for select to authenticated using (public.can_view_campaign(campaign_id));

drop policy if exists "campaign events: members read" on public.campaign_events;
create policy "campaign events: visible with campaign" on public.campaign_events
  for select to authenticated using (public.can_view_campaign(campaign_id));

drop policy if exists "scrape_jobs: members read" on public.scrape_jobs;
drop policy if exists "scrape_jobs: writers queue" on public.scrape_jobs;
drop policy if exists "scrape_jobs: writers cancel/rename" on public.scrape_jobs;
create policy "scrape_jobs: own or all" on public.scrape_jobs
  for select to authenticated using (public.sees_all(workspace_id) or (public.is_member(workspace_id) and created_by = (select auth.uid())));
create policy "scrape_jobs: permitted members queue" on public.scrape_jobs
  for insert to authenticated with check (
    public.can_write(workspace_id) and created_by = (select auth.uid()) and status = 'queued' and public.member_can(workspace_id, 'scrape')
  );
create policy "scrape_jobs: creator or admin cancels" on public.scrape_jobs
  for update to authenticated
  using (public.can_write(workspace_id) and (public.is_admin(workspace_id) or created_by = (select auth.uid())))
  with check (public.can_write(workspace_id));

drop policy if exists "engine_jobs: members read" on public.engine_jobs;
create policy "engine_jobs: own or all" on public.engine_jobs
  for select to authenticated using (public.sees_all(workspace_id) or (public.is_member(workspace_id) and created_by = (select auth.uid())));

drop policy if exists "templates: members read" on public.message_templates;
drop policy if exists "templates: writers add" on public.message_templates;
drop policy if exists "templates: writers update" on public.message_templates;
create policy "templates: visible" on public.message_templates
  for select to authenticated using (
    public.is_member(workspace_id)
    and (scope = 'workspace' or public.sees_all(workspace_id) or created_by = (select auth.uid()) or public.has_grant('template', id))
  );
create policy "templates: writers add" on public.message_templates
  for insert to authenticated with check (
    public.can_write(workspace_id) and created_by = (select auth.uid()) and (scope = 'personal' or public.is_admin(workspace_id))
  );
create policy "templates: creator, admin or granted update" on public.message_templates
  for update to authenticated
  using (public.can_write(workspace_id) and (public.is_admin(workspace_id) or created_by = (select auth.uid()) or public.has_grant('template', id, true)))
  with check (public.can_write(workspace_id) and (scope = 'personal' or public.is_admin(workspace_id)));

drop policy if exists "automations: members read" on public.automations;
drop policy if exists "automations: admins create" on public.automations;
drop policy if exists "automations: admins update" on public.automations;
drop policy if exists "automations: admins delete" on public.automations;
create policy "automations: visible" on public.automations
  for select to authenticated using (
    public.is_member(workspace_id)
    and (
      public.sees_all(workspace_id)
      or owner_id = (select auth.uid())
      or (owner_id is null and (public.has_grant('automation', id) or not public.has_any_grant('automation', id)))
    )
  );
create policy "automations: admins or personal create" on public.automations
  for insert to authenticated with check (
    created_by = (select auth.uid())
    and (public.is_admin(workspace_id) or (public.can_write(workspace_id) and owner_id = (select auth.uid())))
  );
revoke update on public.automations from authenticated;
grant update (name, enabled, trigger, conditions, actions) on public.automations to authenticated;
create policy "automations: admins, owner or granted update" on public.automations
  for update to authenticated
  using (public.is_admin(workspace_id) or (public.can_write(workspace_id) and (owner_id = (select auth.uid()) or public.has_grant('automation', id, true))))
  with check (public.can_write(workspace_id));
create policy "automations: admins or owner delete" on public.automations
  for delete to authenticated using (public.is_admin(workspace_id) or (public.can_write(workspace_id) and owner_id = (select auth.uid())));

drop policy if exists "automation runs: members read" on public.automation_runs;
create policy "automation runs: visible with automation" on public.automation_runs
  for select to authenticated using (public.can_view_automation(automation_id));

-- Members management: admins edit role / active / title / permissions (guards above).
-- (existing update policy "members: admins change roles" already restricts to admins)

-- New tables
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.lead_lists enable row level security;
alter table public.lead_list_items enable row level security;
alter table public.resource_access enable row level security;
revoke all on public.teams, public.team_members, public.lead_lists, public.lead_list_items, public.resource_access from anon;
revoke update on public.resource_access, public.team_members, public.lead_list_items from authenticated;

create policy "teams: members read" on public.teams for select to authenticated using (public.is_member(workspace_id));
create policy "teams: admins create" on public.teams for insert to authenticated with check (public.is_admin(workspace_id));
create policy "teams: admins update" on public.teams for update to authenticated using (public.is_admin(workspace_id)) with check (public.is_admin(workspace_id));
create policy "teams: admins delete" on public.teams for delete to authenticated using (public.is_admin(workspace_id));

create policy "team members: members read" on public.team_members for select to authenticated using (public.is_member(workspace_id));
create policy "team members: admins add" on public.team_members for insert to authenticated with check (
  public.is_admin(workspace_id)
  and exists (select 1 from public.workspace_members m where m.workspace_id = team_members.workspace_id and m.user_id = team_members.user_id)
);
create policy "team members: admins remove" on public.team_members for delete to authenticated using (public.is_admin(workspace_id));

create policy "lists: visible" on public.lead_lists for select to authenticated using (
  public.is_member(workspace_id)
  and (public.sees_all(workspace_id) or created_by = (select auth.uid()) or public.has_grant('lead_list', id))
);
create policy "lists: writers create" on public.lead_lists for insert to authenticated with check (public.can_write(workspace_id) and created_by = (select auth.uid()));
create policy "lists: editors update" on public.lead_lists for update to authenticated using (public.can_edit_list(id)) with check (public.can_write(workspace_id));
create policy "lists: admin or creator delete" on public.lead_lists for delete to authenticated using (
  public.is_admin(workspace_id) or (public.can_write(workspace_id) and created_by = (select auth.uid()))
);

create policy "list items: visible with list" on public.lead_list_items for select to authenticated using (public.can_view_list(list_id));
create policy "list items: editors add visible leads" on public.lead_list_items for insert to authenticated with check (
  public.can_edit_list(list_id) and public.can_view_lead(lead_id) and added_by = (select auth.uid())
);
create policy "list items: editors remove" on public.lead_list_items for delete to authenticated using (public.can_edit_list(list_id));

create policy "access: admins see all, members their own" on public.resource_access for select to authenticated using (
  public.is_member(workspace_id)
  and (public.sees_all(workspace_id) or user_id = (select auth.uid())
       or team_id in (select tm.team_id from public.team_members tm where tm.user_id = (select auth.uid()))
       or public.can_share(resource_type, resource_id))
);
create policy "access: sharers grant" on public.resource_access for insert to authenticated with check (
  public.can_share(resource_type, resource_id)
  and granted_by = (select auth.uid())
  and (user_id is null or exists (select 1 from public.workspace_members m where m.workspace_id = resource_access.workspace_id and m.user_id = resource_access.user_id))
);
create policy "access: sharers revoke" on public.resource_access for delete to authenticated using (public.can_share(resource_type, resource_id));

-- ---------------------------------------------------------------------------
-- Lists in lead search
-- ---------------------------------------------------------------------------

-- Lead search v3: + list_ids
create or replace function public.filtered_leads(p_workspace uuid, p_filters jsonb default '{}'::jsonb)
returns setof public.leads
language sql stable set search_path = ''
as $$
  select l.*
  from public.leads l
  cross join lateral (
    select
      nullif(btrim(coalesce(p_filters ->> 'q', '')), '') as q,
      regexp_replace(coalesce(p_filters ->> 'q', ''), '\D', '', 'g') as q_digits
  ) s
  where l.workspace_id = p_workspace
    and (
      s.q is null
      or l.business_name ilike '%' || s.q || '%'
      or l.address ilike '%' || s.q || '%'
      or l.city ilike '%' || s.q || '%'
      or l.category ilike '%' || s.q || '%'
      or l.email ilike '%' || s.q || '%'
      or l.contact_name ilike '%' || s.q || '%'
      or l.website ilike '%' || s.q || '%'
      or (length(s.q_digits) >= 3 and l.phone like '%' || s.q_digits || '%')
    )
    and (cardinality(public.jarr(p_filters -> 'stage_ids')) = 0 or l.stage_id::text = any (public.jarr(p_filters -> 'stage_ids')))
    and (p_filters -> 'has_website' is null or jsonb_typeof(p_filters -> 'has_website') <> 'boolean'
         or l.has_website = (p_filters ->> 'has_website')::boolean)
    and (cardinality(public.jarr(p_filters -> 'cities')) = 0 or l.city = any (public.jarr(p_filters -> 'cities')))
    and (cardinality(public.jarr(p_filters -> 'categories')) = 0 or l.category = any (public.jarr(p_filters -> 'categories')))
    and (cardinality(public.jarr(p_filters -> 'tags')) = 0 or l.tags && public.jarr(p_filters -> 'tags'))
    and (
      (cardinality(public.jarr(p_filters -> 'owner_ids')) = 0 and coalesce((p_filters ->> 'unassigned')::boolean, false) = false)
      or l.owner_id::text = any (public.jarr(p_filters -> 'owner_ids'))
      or (coalesce((p_filters ->> 'unassigned')::boolean, false) and l.owner_id is null)
    )
    and (cardinality(public.jarr(p_filters -> 'wa_status')) = 0 or l.wa_status = any (public.jarr(p_filters -> 'wa_status')))
    and (cardinality(public.jarr(p_filters -> 'phone_types')) = 0 or l.phone_type = any (public.jarr(p_filters -> 'phone_types')))
    and (cardinality(public.jarr(p_filters -> 'sources')) = 0 or l.source = any (public.jarr(p_filters -> 'sources')))
    and (cardinality(public.jarr(p_filters -> 'tiers')) = 0 or l.score_tier = any (public.jarr(p_filters -> 'tiers')))
    and (p_filters ->> 'min_score' is null or l.score >= (p_filters ->> 'min_score')::int)
    and (p_filters ->> 'min_rating' is null or coalesce(l.rating, 0) >= (p_filters ->> 'min_rating')::numeric)
    and (p_filters ->> 'min_reviews' is null or coalesce(l.reviews_count, 0) >= (p_filters ->> 'min_reviews')::int)
    and (p_filters -> 'opted_out' is null or jsonb_typeof(p_filters -> 'opted_out') <> 'boolean'
         or l.opted_out = (p_filters ->> 'opted_out')::boolean)
    and (
      p_filters ->> 'contacted' is null
      or (p_filters ->> 'contacted' = 'never' and l.last_contacted_at is null)
      or (p_filters ->> 'contacted' = 'contacted' and l.last_contacted_at is not null)
      or (p_filters ->> 'contacted' = 'replied' and l.last_replied_at is not null)
      or (p_filters ->> 'contacted' = 'not_replied' and l.last_contacted_at is not null and l.last_replied_at is null)
    )
    and (p_filters ->> 'not_contacted_days' is null or l.last_contacted_at is null
         or l.last_contacted_at < now() - make_interval(days => (p_filters ->> 'not_contacted_days')::int))
    and (p_filters ->> 'scrape_job_id' is null or l.scrape_job_id = public.try_uuid(p_filters ->> 'scrape_job_id'))
    and (p_filters ->> 'created_from' is null or l.created_at >= (p_filters ->> 'created_from')::timestamptz)
    and (p_filters ->> 'created_to' is null or l.created_at < (p_filters ->> 'created_to')::timestamptz)
    and (p_filters -> 'has_phone' is null or jsonb_typeof(p_filters -> 'has_phone') <> 'boolean'
         or (l.phone is not null) = (p_filters ->> 'has_phone')::boolean)
    and (p_filters -> 'has_email' is null or jsonb_typeof(p_filters -> 'has_email') <> 'boolean'
         or (coalesce(l.email, '') <> '') = (p_filters ->> 'has_email')::boolean)
    and (
      coalesce((p_filters ->> 'sendable')::boolean, false) = false
      or (l.phone is not null and not l.opted_out and l.wa_status <> 'invalid')
    )
    -- Never let two campaigns (or two teammates) work the same lead at once.
    and (
      coalesce((p_filters ->> 'not_in_active_campaign')::boolean, false) = false
      or not exists (
        select 1 from public.campaign_recipients r
        join public.campaigns c on c.id = r.campaign_id
        where r.lead_id = l.id
          and c.status in ('scheduled', 'running', 'paused')
          and r.status in ('pending', 'waiting', 'sending')
          and c.id is distinct from public.try_uuid(p_filters ->> 'exclude_campaign_id')
      )
    )
    and (
      cardinality(public.jarr(p_filters -> 'list_ids')) = 0
      or exists (select 1 from public.lead_list_items li
                 where li.lead_id = l.id and li.list_id::text = any (public.jarr(p_filters -> 'list_ids')))
    );
$$;

-- Add many leads to a list (selected ids or a filter), respecting visibility.
create or replace function public.lead_list_add(p_list uuid, p_ids uuid[] default null, p_filters jsonb default null)
returns integer language plpgsql volatile set search_path = ''
as $$
declare
  ws uuid;
  n integer;
begin
  if p_ids is null and p_filters is null then
    raise exception 'Pass lead ids or filters' using errcode = '22023';
  end if;
  select workspace_id into ws from public.lead_lists where id = p_list;
  if ws is null or not public.can_edit_list(p_list) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.lead_list_items (list_id, workspace_id, lead_id, added_by)
  select p_list, ws, l.id, (select auth.uid())
  from public.filtered_leads(ws, coalesce(p_filters, '{}'::jsonb)) l
  where p_ids is null or l.id = any (p_ids)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Team reports (SECURITY DEFINER: admins/viewers see everyone, members themselves)
-- ---------------------------------------------------------------------------

create or replace function public.report_members(p_workspace uuid, p_from timestamptz, p_to timestamptz)
returns table (
  user_id uuid, full_name text, email text, role text, active boolean, teams text[],
  messages_sent integer, delivered integer, read integer, failed integer, replies integer,
  leads_contacted integer, leads_replied integer, leads_owned integer, leads_added integer,
  campaigns_created integer, meetings integer, won integer, won_value numeric,
  numbers integer, numbers_connected integer, last_active_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  everyone boolean;
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  everyone := public.sees_all(p_workspace);
  return query
  with mem as (
    select m.user_id, m.role, m.active from public.workspace_members m
    where m.workspace_id = p_workspace and (everyone or m.user_id = me)
  ),
  outbound as (
    select coalesce(x.sent_by, a.owner_id) as uid, x.status, x.lead_id, x.created_at
    from public.messages x
    left join public.whatsapp_accounts a on a.id = x.account_id
    where x.workspace_id = p_workspace and x.direction = 'out' and x.created_at >= p_from and x.created_at < p_to
  ),
  inbound as (
    select a.owner_id as uid, x.lead_id, x.created_at
    from public.messages x
    join public.whatsapp_accounts a on a.id = x.account_id
    where x.workspace_id = p_workspace and x.direction = 'in' and x.created_at >= p_from and x.created_at < p_to
  ),
  o as (
    select uid,
      count(*) filter (where status in ('sent', 'delivered', 'read'))::int as sent,
      count(*) filter (where status in ('delivered', 'read'))::int as delivered,
      count(*) filter (where status = 'read')::int as read,
      count(*) filter (where status = 'failed')::int as failed,
      count(distinct lead_id) filter (where status in ('sent', 'delivered', 'read'))::int as contacted,
      max(created_at) as last_out
    from outbound group by uid
  ),
  i as (
    select uid, count(*)::int as replies, count(distinct lead_id)::int as replied, max(created_at) as last_in
    from inbound group by uid
  ),
  owned as (
    select l.owner_id as uid,
      count(*)::int as owned,
      count(*) filter (where s.kind = 'won')::int as won,
      coalesce(sum(l.deal_value) filter (where s.kind = 'won'), 0) as won_value
    from public.leads l left join public.pipeline_stages s on s.id = l.stage_id
    where l.workspace_id = p_workspace group by l.owner_id
  ),
  added as (
    select l.created_by as uid, count(*)::int as n from public.leads l
    where l.workspace_id = p_workspace and l.created_at >= p_from and l.created_at < p_to group by l.created_by
  ),
  camps as (
    select c.created_by as uid, count(*)::int as n from public.campaigns c
    where c.workspace_id = p_workspace and c.created_at >= p_from and c.created_at < p_to group by c.created_by
  ),
  meets as (
    select t.assignee_id as uid, count(*)::int as n from public.tasks t
    where t.workspace_id = p_workspace and t.type = 'meeting' and coalesce(t.due_at, t.created_at) >= p_from and coalesce(t.due_at, t.created_at) < p_to
    group by t.assignee_id
  ),
  nums as (
    select a.owner_id as uid, count(*)::int as n, count(*) filter (where a.status = 'connected')::int as c
    from public.whatsapp_accounts a where a.workspace_id = p_workspace group by a.owner_id
  ),
  tms as (
    select tm.user_id as uid, array_agg(t.name order by t.name) as names
    from public.team_members tm join public.teams t on t.id = tm.team_id
    where tm.workspace_id = p_workspace group by tm.user_id
  )
  select mem.user_id, p.full_name, p.email, mem.role, mem.active, coalesce(tms.names, '{}'),
    coalesce(o.sent, 0), coalesce(o.delivered, 0), coalesce(o.read, 0), coalesce(o.failed, 0), coalesce(i.replies, 0),
    coalesce(o.contacted, 0), coalesce(i.replied, 0), coalesce(owned.owned, 0), coalesce(added.n, 0),
    coalesce(camps.n, 0), coalesce(meets.n, 0), coalesce(owned.won, 0), coalesce(owned.won_value, 0),
    coalesce(nums.n, 0), coalesce(nums.c, 0), greatest(o.last_out, i.last_in)
  from mem
  join public.profiles p on p.id = mem.user_id
  left join o on o.uid = mem.user_id
  left join i on i.uid = mem.user_id
  left join owned on owned.uid = mem.user_id
  left join added on added.uid = mem.user_id
  left join camps on camps.uid = mem.user_id
  left join meets on meets.uid = mem.user_id
  left join nums on nums.uid = mem.user_id
  left join tms on tms.uid = mem.user_id
  order by coalesce(o.sent, 0) desc, p.full_name;
end;
$$;

create or replace function public.report_teams(p_workspace uuid, p_from timestamptz, p_to timestamptz)
returns table (
  team_id uuid, name text, color text, members integer,
  messages_sent integer, delivered integer, read integer, replies integer, leads_contacted integer, won integer, won_value numeric
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.sees_all(p_workspace) then
    raise exception 'Only admins and viewers can see team reports' using errcode = '42501';
  end if;
  return query
  select t.id, t.name, t.color, count(r.user_id)::int,
    coalesce(sum(r.messages_sent), 0)::int, coalesce(sum(r.delivered), 0)::int, coalesce(sum(r.read), 0)::int,
    coalesce(sum(r.replies), 0)::int, coalesce(sum(r.leads_contacted), 0)::int, coalesce(sum(r.won), 0)::int,
    coalesce(sum(r.won_value), 0)
  from public.teams t
  left join public.team_members tm on tm.team_id = t.id
  left join public.report_members(p_workspace, p_from, p_to) r on r.user_id = tm.user_id
  where t.workspace_id = p_workspace
  group by t.id, t.name, t.color
  order by 5 desc;
end;
$$;

-- Campaign × sender breakdown: who sent what in which campaign.
create or replace function public.report_campaign_senders(p_workspace uuid, p_from timestamptz, p_to timestamptz, p_campaign uuid default null)
returns table (
  campaign_id uuid, campaign_name text, campaign_status text, user_id uuid, full_name text, account_id uuid, account_label text,
  messages_sent integer, delivered integer, read integer, failed integer, leads_contacted integer, replied integer
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  everyone boolean;
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  everyone := public.sees_all(p_workspace);
  return query
  with sent as (
    select x.campaign_id, x.account_id, x.status, x.lead_id
    from public.messages x
    where x.workspace_id = p_workspace and x.direction = 'out' and x.campaign_id is not null
      and x.created_at >= p_from and x.created_at < p_to
      and (p_campaign is null or x.campaign_id = p_campaign)
  ),
  agg as (
    select s.campaign_id, s.account_id,
      count(*) filter (where s.status in ('sent', 'delivered', 'read'))::int as sent,
      count(*) filter (where s.status in ('delivered', 'read'))::int as delivered,
      count(*) filter (where s.status = 'read')::int as read,
      count(*) filter (where s.status = 'failed')::int as failed,
      count(distinct s.lead_id) filter (where s.status in ('sent', 'delivered', 'read'))::int as contacted
    from sent s group by s.campaign_id, s.account_id
  ),
  rep as (
    select r.campaign_id, r.account_id, count(*) filter (where r.status = 'replied')::int as replied
    from public.campaign_recipients r
    where r.workspace_id = p_workspace and (p_campaign is null or r.campaign_id = p_campaign)
    group by r.campaign_id, r.account_id
  )
  select c.id, c.name, c.status, a.owner_id, p.full_name, a.id, a.label,
    agg.sent, agg.delivered, agg.read, agg.failed, agg.contacted, coalesce(rep.replied, 0)
  from agg
  join public.campaigns c on c.id = agg.campaign_id
  left join public.whatsapp_accounts a on a.id = agg.account_id
  left join public.profiles p on p.id = a.owner_id
  left join rep on rep.campaign_id = agg.campaign_id and rep.account_id is not distinct from agg.account_id
  where everyone or a.owner_id = me or c.created_by = me or public.has_grant('campaign', c.id)
  order by c.created_at desc, agg.sent desc;
end;
$$;

-- Daily series per member for charts.
create or replace function public.report_daily(p_workspace uuid, p_from timestamptz, p_to timestamptz)
returns table (day date, user_id uuid, sent integer, replies integer)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  everyone boolean;
  tz text;
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  everyone := public.sees_all(p_workspace);
  select coalesce(timezone, 'UTC') into tz from public.workspaces where id = p_workspace;
  return query
  select (x.created_at at time zone tz)::date as d,
    case when x.direction = 'out' then coalesce(x.sent_by, a.owner_id) else a.owner_id end as uid,
    count(*) filter (where x.direction = 'out' and x.status in ('sent', 'delivered', 'read'))::int,
    count(*) filter (where x.direction = 'in')::int
  from public.messages x
  left join public.whatsapp_accounts a on a.id = x.account_id
  where x.workspace_id = p_workspace and x.created_at >= p_from and x.created_at < p_to
    and (everyone or (case when x.direction = 'out' then coalesce(x.sent_by, a.owner_id) else a.owner_id end) = me)
  group by 1, 2
  order by 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.lead_lists, public.resource_access;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 20261003000007_engine_limits.sql
-- ----------------------------------------------------------------------------
-- WhatsApp-side limits observed by the engine, shown on the number health page:
-- { new_chat_quota, new_chat_used, cycle_end, timelock_until, timelock_type, checked_at }
alter table public.whatsapp_accounts add column limits jsonb not null default '{}'::jsonb;

-- ----------------------------------------------------------------------------
-- 20261003000008_filter_ids.sql
-- ----------------------------------------------------------------------------
-- Lead search v4: explicit `ids` (hand-picked selections travel in the request body, not the URL).
create or replace function public.filtered_leads(p_workspace uuid, p_filters jsonb default '{}'::jsonb)
returns setof public.leads
language sql stable set search_path = ''
as $$
  select l.*
  from public.leads l
  cross join lateral (
    select
      nullif(btrim(coalesce(p_filters ->> 'q', '')), '') as q,
      regexp_replace(coalesce(p_filters ->> 'q', ''), '\D', '', 'g') as q_digits
  ) s
  where l.workspace_id = p_workspace
    and (
      s.q is null
      or l.business_name ilike '%' || s.q || '%'
      or l.address ilike '%' || s.q || '%'
      or l.city ilike '%' || s.q || '%'
      or l.category ilike '%' || s.q || '%'
      or l.email ilike '%' || s.q || '%'
      or l.contact_name ilike '%' || s.q || '%'
      or l.website ilike '%' || s.q || '%'
      or (length(s.q_digits) >= 3 and l.phone like '%' || s.q_digits || '%')
    )
    and (cardinality(public.jarr(p_filters -> 'stage_ids')) = 0 or l.stage_id::text = any (public.jarr(p_filters -> 'stage_ids')))
    and (p_filters -> 'has_website' is null or jsonb_typeof(p_filters -> 'has_website') <> 'boolean'
         or l.has_website = (p_filters ->> 'has_website')::boolean)
    and (cardinality(public.jarr(p_filters -> 'cities')) = 0 or l.city = any (public.jarr(p_filters -> 'cities')))
    and (cardinality(public.jarr(p_filters -> 'categories')) = 0 or l.category = any (public.jarr(p_filters -> 'categories')))
    and (cardinality(public.jarr(p_filters -> 'tags')) = 0 or l.tags && public.jarr(p_filters -> 'tags'))
    and (
      (cardinality(public.jarr(p_filters -> 'owner_ids')) = 0 and coalesce((p_filters ->> 'unassigned')::boolean, false) = false)
      or l.owner_id::text = any (public.jarr(p_filters -> 'owner_ids'))
      or (coalesce((p_filters ->> 'unassigned')::boolean, false) and l.owner_id is null)
    )
    and (cardinality(public.jarr(p_filters -> 'wa_status')) = 0 or l.wa_status = any (public.jarr(p_filters -> 'wa_status')))
    and (cardinality(public.jarr(p_filters -> 'phone_types')) = 0 or l.phone_type = any (public.jarr(p_filters -> 'phone_types')))
    and (cardinality(public.jarr(p_filters -> 'sources')) = 0 or l.source = any (public.jarr(p_filters -> 'sources')))
    and (cardinality(public.jarr(p_filters -> 'tiers')) = 0 or l.score_tier = any (public.jarr(p_filters -> 'tiers')))
    and (p_filters ->> 'min_score' is null or l.score >= (p_filters ->> 'min_score')::int)
    and (p_filters ->> 'min_rating' is null or coalesce(l.rating, 0) >= (p_filters ->> 'min_rating')::numeric)
    and (p_filters ->> 'min_reviews' is null or coalesce(l.reviews_count, 0) >= (p_filters ->> 'min_reviews')::int)
    and (p_filters -> 'opted_out' is null or jsonb_typeof(p_filters -> 'opted_out') <> 'boolean'
         or l.opted_out = (p_filters ->> 'opted_out')::boolean)
    and (
      p_filters ->> 'contacted' is null
      or (p_filters ->> 'contacted' = 'never' and l.last_contacted_at is null)
      or (p_filters ->> 'contacted' = 'contacted' and l.last_contacted_at is not null)
      or (p_filters ->> 'contacted' = 'replied' and l.last_replied_at is not null)
      or (p_filters ->> 'contacted' = 'not_replied' and l.last_contacted_at is not null and l.last_replied_at is null)
    )
    and (p_filters ->> 'not_contacted_days' is null or l.last_contacted_at is null
         or l.last_contacted_at < now() - make_interval(days => (p_filters ->> 'not_contacted_days')::int))
    and (p_filters ->> 'scrape_job_id' is null or l.scrape_job_id = public.try_uuid(p_filters ->> 'scrape_job_id'))
    and (p_filters ->> 'created_from' is null or l.created_at >= (p_filters ->> 'created_from')::timestamptz)
    and (p_filters ->> 'created_to' is null or l.created_at < (p_filters ->> 'created_to')::timestamptz)
    and (p_filters -> 'has_phone' is null or jsonb_typeof(p_filters -> 'has_phone') <> 'boolean'
         or (l.phone is not null) = (p_filters ->> 'has_phone')::boolean)
    and (p_filters -> 'has_email' is null or jsonb_typeof(p_filters -> 'has_email') <> 'boolean'
         or (coalesce(l.email, '') <> '') = (p_filters ->> 'has_email')::boolean)
    and (
      coalesce((p_filters ->> 'sendable')::boolean, false) = false
      or (l.phone is not null and not l.opted_out and l.wa_status <> 'invalid')
    )
    -- Never let two campaigns (or two teammates) work the same lead at once.
    and (
      coalesce((p_filters ->> 'not_in_active_campaign')::boolean, false) = false
      or not exists (
        select 1 from public.campaign_recipients r
        join public.campaigns c on c.id = r.campaign_id
        where r.lead_id = l.id
          and c.status in ('scheduled', 'running', 'paused')
          and r.status in ('pending', 'waiting', 'sending')
          and c.id is distinct from public.try_uuid(p_filters ->> 'exclude_campaign_id')
      )
    )
    and (cardinality(public.jarr(p_filters -> 'ids')) = 0 or l.id::text = any (public.jarr(p_filters -> 'ids')))
    and (
      cardinality(public.jarr(p_filters -> 'list_ids')) = 0
      or exists (select 1 from public.lead_list_items li
                 where li.lead_id = l.id and li.list_id::text = any (public.jarr(p_filters -> 'list_ids')))
    );
$$;

-- ----------------------------------------------------------------------------
-- 20261010000001_reactions.sql
-- ----------------------------------------------------------------------------
-- Reactions: WhatsApp emoji reactions on messages (both ways) and live
-- updates for team-chat reactions.

-- ---------------------------------------------------------------------------
-- WhatsApp reactions
-- ---------------------------------------------------------------------------

-- reaction_in  = the lead's reaction to this message
-- reaction_out = our reaction to this message (pending until the engine sends it)
alter table public.messages
  add column reaction_in          text check (char_length(reaction_in) <= 16),
  add column reaction_out         text check (char_length(reaction_out) <= 16),
  add column reaction_out_pending boolean not null default false;
create index messages_reaction_queue_idx on public.messages (updated_at) where reaction_out_pending;

-- React to a WhatsApp message from the dashboard ('' or null removes it).
-- The engine picks it up from the queue and sends it from the same number.
create or replace function public.message_react(p_message uuid, p_emoji text)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  m public.messages;
  e text := nullif(btrim(coalesce(p_emoji, '')), '');
begin
  select * into m from public.messages where id = p_message;
  if m.id is null or m.account_id is null or m.wa_message_id is null then
    raise exception 'This message can''t be reacted to yet';
  end if;
  if not public.can_use_account(m.account_id) then
    raise exception 'You can''t send from this WhatsApp number' using errcode = '42501';
  end if;
  if e is not null and char_length(e) > 16 then
    raise exception 'Invalid reaction';
  end if;
  update public.messages set reaction_out = e, reaction_out_pending = true where id = p_message;
end;
$$;
revoke execute on function public.message_react(uuid, text) from public, anon;
grant execute on function public.message_react(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Team chat: live reaction updates
-- ---------------------------------------------------------------------------
-- Realtime can't filter DELETE events, so removed reactions never reached other
-- people. Every reaction change now touches its message, which clients already
-- follow per channel.

alter table public.chat_messages add column reacted_at timestamptz;

create or replace function public.chat_reactions_touch_message()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  update public.chat_messages set reacted_at = now()
  where id = coalesce(new.message_id, old.message_id);
  return null;
end;
$$;
create trigger chat_reactions_touch_message after insert or delete on public.chat_reactions
  for each row execute function public.chat_reactions_touch_message();

-- ----------------------------------------------------------------------------
-- 20261011000001_engine_signals.sql
-- ----------------------------------------------------------------------------
-- Engine wake-up signals.
--
-- The engine used to poll every work table every 2–4 seconds, which on its own
-- used several GB of Supabase egress a month. Now triggers bump a row here when
-- there is new work, the engine hears it over Realtime and reacts at once, and
-- falls back to a slow poll in case a signal is missed.

create table public.engine_signals (
  kind text primary key,
  at   timestamptz not null default now()
);
alter table public.engine_signals enable row level security; -- engine (service role) only
revoke all on public.engine_signals from anon, authenticated;

create or replace function public.engine_signal_trigger()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.engine_signals (kind, at) values (tg_argv[0], now())
  on conflict (kind) do update set at = excluded.at;
  return null;
end;
$$;
revoke execute on function public.engine_signal_trigger() from public, anon, authenticated;

-- Messages typed in the dashboard (or re-queued) → outbox; reactions → reaction sender.
create trigger engine_signal_outbox_insert after insert on public.messages
  for each row when (new.direction = 'out' and new.status = 'queued')
  execute function public.engine_signal_trigger('outbox');
create trigger engine_signal_outbox_requeue after update of status on public.messages
  for each row when (new.direction = 'out' and new.status = 'queued' and old.status is distinct from 'queued')
  execute function public.engine_signal_trigger('outbox');
create trigger engine_signal_reactions after update of reaction_out, reaction_out_pending on public.messages
  for each row when (new.reaction_out_pending)
  execute function public.engine_signal_trigger('reactions');

-- WhatsApp numbers: connect / disconnect / log out / pairing code / added / removed.
create trigger engine_signal_accounts_rows after insert or delete on public.whatsapp_accounts
  for each statement execute function public.engine_signal_trigger('accounts');
create trigger engine_signal_accounts_update after update on public.whatsapp_accounts
  for each row when (
    old.desired_state is distinct from new.desired_state
    or old.pairing_phone is distinct from new.pairing_phone
    or old.label is distinct from new.label
    or old.owner_id is distinct from new.owner_id
  )
  execute function public.engine_signal_trigger('accounts');
-- A number came online: send what was waiting for it.
create trigger engine_signal_account_connected after update of status on public.whatsapp_accounts
  for each row when (new.status = 'connected' and old.status is distinct from 'connected')
  execute function public.engine_signal_trigger('connected');

-- Campaigns: started/paused/edited, steps changed, leads added or retried.
create trigger engine_signal_campaigns_rows after insert or delete on public.campaigns
  for each statement execute function public.engine_signal_trigger('campaigns');
create trigger engine_signal_campaigns_update after update on public.campaigns
  for each row when (
    old.status is distinct from new.status
    or old.settings is distinct from new.settings
    or old.account_ids is distinct from new.account_ids
    or old.scheduled_at is distinct from new.scheduled_at
  )
  execute function public.engine_signal_trigger('campaigns');
create trigger engine_signal_campaign_steps after insert or update or delete on public.campaign_steps
  for each statement execute function public.engine_signal_trigger('campaigns');
create trigger engine_signal_recipients_added after insert on public.campaign_recipients
  for each statement execute function public.engine_signal_trigger('campaigns');
create trigger engine_signal_recipients_retry after update of status on public.campaign_recipients
  for each row when (new.status = 'pending' and old.status in ('failed', 'skipped', 'cancelled'))
  execute function public.engine_signal_trigger('campaigns');

-- Lead searches, background jobs, automation events.
create trigger engine_signal_scrape after insert on public.scrape_jobs
  for each statement execute function public.engine_signal_trigger('scrape');
create trigger engine_signal_jobs after insert on public.engine_jobs
  for each statement execute function public.engine_signal_trigger('jobs');
create trigger engine_signal_automation after insert on public.automation_queue
  for each statement execute function public.engine_signal_trigger('automation');

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.engine_signals;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 20261014000001_shared_lead_bank.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Shared lead bank
--
--   * The whole team works one lead inventory: members now see every lead in
--     the workspace by default (admins can still switch to private spaces with
--     settings.members_see_all_leads = false). Duplicates stay blocked by the
--     unique (workspace, phone) and (workspace, Google place id) keys, which
--     also settle two teammates scraping the same business at the same time.
--   * Everyone sees the team's lead searches (who scraped what, when).
--   * New lead filters: country, website quality (real site / none / only a
--     social page / broken link), business name, website domain, added by,
--     campaign membership.
--   * lead_inventory(): the lead-bank numbers for the dashboard.
--   * Lead searches remember which country they search in; stopping a queued
--     search finishes it at once.
-- ============================================================================

create or replace function public.sees_all_leads(ws uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select public.sees_all(ws) or (
    public.is_member(ws)
    and coalesce((select (w.settings ->> 'members_see_all_leads')::boolean from public.workspaces w where w.id = ws), true)
  );
$$;

drop policy if exists "scrape_jobs: own or all" on public.scrape_jobs;
create policy "scrape_jobs: members read" on public.scrape_jobs
  for select to authenticated using (public.is_member(workspace_id));

alter table public.scrape_jobs add column if not exists country text check (country ~ '^[A-Z]{2}$');

-- Stopping a search that is still waiting in the queue finishes it right away
-- (the engine only checks for "stop" on the search it is running).
create or replace function public.scrape_jobs_cancel_queued()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.cancel_requested and not old.cancel_requested and new.status = 'queued' then
    new.status := 'cancelled';
    new.finished_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists scrape_jobs_cancel_queued on public.scrape_jobs;
create trigger scrape_jobs_cancel_queued before update of cancel_requested on public.scrape_jobs
  for each row execute function public.scrape_jobs_cancel_queued();

-- ---------------------------------------------------------------------------
-- Website domain + quality
-- ---------------------------------------------------------------------------

-- "https://www.Example.com/contact" → "example.com"
alter table public.leads add column if not exists website_domain text generated always as (
  nullif(lower(regexp_replace(regexp_replace(btrim(coalesce(website, '')), '^[a-z][a-z0-9+.-]*://', '', 'i'), '^www\.|[/?#:].*$', '', 'gi')), '')
) stored;

create index if not exists leads_ws_country_idx on public.leads (workspace_id, country);
create index if not exists leads_ws_created_by_idx on public.leads (workspace_id, created_by);
create index if not exists leads_ws_domain_idx on public.leads (workspace_id, website_domain);

-- none: no website · social: only a Facebook/Instagram/WhatsApp/… page ·
-- invalid: not a usable address · site: a real website
create or replace function public.website_kind(domain text)
returns text language sql immutable set search_path = ''
as $$
  select case
    when domain is null then 'none'
    when domain !~ '^[^\s./]+(\.[^\s./]+)*\.[^\s./0-9]{2,}$' then 'invalid'
    when domain ~ '(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|wa\.me|whatsapp\.com|linktr\.ee|tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|linkedin\.com|t\.me|pinterest\.com|snapchat\.com|google\.com|goo\.gl|g\.page|business\.site|sites\.google\.com)$' then 'social'
    else 'site'
  end;
$$;

-- Leads in the workspace's campaigns — across the whole team, whoever owns the campaign.
create or replace function public.campaign_lead_ids(p_workspace uuid, p_campaigns uuid[] default null)
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select distinct r.lead_id
  from public.campaign_recipients r
  where r.workspace_id = p_workspace
    and public.is_member(p_workspace)
    and (p_campaigns is null or r.campaign_id = any (p_campaigns));
$$;

-- ---------------------------------------------------------------------------
-- Lead filters (adds countries, website, name, domain, created_by_ids,
-- campaign, campaign_ids, exclude_campaign_ids)
-- ---------------------------------------------------------------------------

create or replace function public.filtered_leads(p_workspace uuid, p_filters jsonb default '{}'::jsonb)
returns setof public.leads
language sql stable set search_path = ''
as $$
  select l.*
  from public.leads l
  cross join lateral (
    select
      nullif(btrim(coalesce(p_filters ->> 'q', '')), '') as q,
      regexp_replace(coalesce(p_filters ->> 'q', ''), '\D', '', 'g') as q_digits,
      nullif(btrim(coalesce(p_filters ->> 'name', '')), '') as name,
      nullif(lower(btrim(coalesce(p_filters ->> 'domain', ''))), '') as domain
  ) s
  where l.workspace_id = p_workspace
    and (
      s.q is null
      or l.business_name ilike '%' || s.q || '%'
      or l.address ilike '%' || s.q || '%'
      or l.city ilike '%' || s.q || '%'
      or l.category ilike '%' || s.q || '%'
      or l.email ilike '%' || s.q || '%'
      or l.contact_name ilike '%' || s.q || '%'
      or l.website ilike '%' || s.q || '%'
      or (length(s.q_digits) >= 3 and l.phone like '%' || s.q_digits || '%')
    )
    and (s.name is null or l.business_name ilike '%' || s.name || '%')
    and (s.domain is null or l.website_domain like '%' || s.domain || '%')
    and (cardinality(public.jarr(p_filters -> 'stage_ids')) = 0 or l.stage_id::text = any (public.jarr(p_filters -> 'stage_ids')))
    and (p_filters -> 'has_website' is null or jsonb_typeof(p_filters -> 'has_website') <> 'boolean'
         or l.has_website = (p_filters ->> 'has_website')::boolean)
    and (
      p_filters ->> 'website' is null
      or (p_filters ->> 'website' = 'no_site' and public.website_kind(l.website_domain) <> 'site')
      or public.website_kind(l.website_domain) = p_filters ->> 'website'
    )
    and (cardinality(public.jarr(p_filters -> 'cities')) = 0 or l.city = any (public.jarr(p_filters -> 'cities')))
    and (cardinality(public.jarr(p_filters -> 'countries')) = 0 or upper(l.country) = any (public.jarr(p_filters -> 'countries')))
    and (cardinality(public.jarr(p_filters -> 'categories')) = 0 or l.category = any (public.jarr(p_filters -> 'categories')))
    and (cardinality(public.jarr(p_filters -> 'tags')) = 0 or l.tags && public.jarr(p_filters -> 'tags'))
    and (
      (cardinality(public.jarr(p_filters -> 'owner_ids')) = 0 and coalesce((p_filters ->> 'unassigned')::boolean, false) = false)
      or l.owner_id::text = any (public.jarr(p_filters -> 'owner_ids'))
      or (coalesce((p_filters ->> 'unassigned')::boolean, false) and l.owner_id is null)
    )
    and (cardinality(public.jarr(p_filters -> 'created_by_ids')) = 0 or l.created_by::text = any (public.jarr(p_filters -> 'created_by_ids')))
    and (cardinality(public.jarr(p_filters -> 'wa_status')) = 0 or l.wa_status = any (public.jarr(p_filters -> 'wa_status')))
    and (cardinality(public.jarr(p_filters -> 'phone_types')) = 0 or l.phone_type = any (public.jarr(p_filters -> 'phone_types')))
    and (cardinality(public.jarr(p_filters -> 'sources')) = 0 or l.source = any (public.jarr(p_filters -> 'sources')))
    and (cardinality(public.jarr(p_filters -> 'tiers')) = 0 or l.score_tier = any (public.jarr(p_filters -> 'tiers')))
    and (p_filters ->> 'min_score' is null or l.score >= (p_filters ->> 'min_score')::int)
    and (p_filters ->> 'min_rating' is null or coalesce(l.rating, 0) >= (p_filters ->> 'min_rating')::numeric)
    and (p_filters ->> 'min_reviews' is null or coalesce(l.reviews_count, 0) >= (p_filters ->> 'min_reviews')::int)
    and (p_filters -> 'opted_out' is null or jsonb_typeof(p_filters -> 'opted_out') <> 'boolean'
         or l.opted_out = (p_filters ->> 'opted_out')::boolean)
    and (
      p_filters ->> 'contacted' is null
      or (p_filters ->> 'contacted' = 'never' and l.last_contacted_at is null)
      or (p_filters ->> 'contacted' = 'contacted' and l.last_contacted_at is not null)
      or (p_filters ->> 'contacted' = 'replied' and l.last_replied_at is not null)
      or (p_filters ->> 'contacted' = 'not_replied' and l.last_contacted_at is not null and l.last_replied_at is null)
    )
    and (p_filters ->> 'not_contacted_days' is null or l.last_contacted_at is null
         or l.last_contacted_at < now() - make_interval(days => (p_filters ->> 'not_contacted_days')::int))
    and (p_filters ->> 'scrape_job_id' is null or l.scrape_job_id = public.try_uuid(p_filters ->> 'scrape_job_id'))
    and (p_filters ->> 'created_from' is null or l.created_at >= (p_filters ->> 'created_from')::timestamptz)
    and (p_filters ->> 'created_to' is null or l.created_at < (p_filters ->> 'created_to')::timestamptz)
    and (p_filters -> 'has_phone' is null or jsonb_typeof(p_filters -> 'has_phone') <> 'boolean'
         or (l.phone is not null) = (p_filters ->> 'has_phone')::boolean)
    and (p_filters -> 'has_email' is null or jsonb_typeof(p_filters -> 'has_email') <> 'boolean'
         or (coalesce(l.email, '') <> '') = (p_filters ->> 'has_email')::boolean)
    and (
      coalesce((p_filters ->> 'sendable')::boolean, false) = false
      or (l.phone is not null and not l.opted_out and l.wa_status <> 'invalid')
    )
    -- never: in no campaign yet · any: in at least one campaign
    and (
      p_filters ->> 'campaign' is null
      or (p_filters ->> 'campaign' = 'never' and l.id not in (select public.campaign_lead_ids(p_workspace)))
      or (p_filters ->> 'campaign' = 'any' and l.id in (select public.campaign_lead_ids(p_workspace)))
    )
    and (
      cardinality(public.jarr(p_filters -> 'campaign_ids')) = 0
      or l.id in (select public.campaign_lead_ids(p_workspace,
                    array(select public.try_uuid(x) from unnest(public.jarr(p_filters -> 'campaign_ids')) x)))
    )
    and (
      cardinality(public.jarr(p_filters -> 'exclude_campaign_ids')) = 0
      or l.id not in (select public.campaign_lead_ids(p_workspace,
                        array(select public.try_uuid(x) from unnest(public.jarr(p_filters -> 'exclude_campaign_ids')) x)))
    )
    -- Never let two campaigns (or two teammates) work the same lead at once.
    and (
      coalesce((p_filters ->> 'not_in_active_campaign')::boolean, false) = false
      or not exists (
        select 1 from public.campaign_recipients r
        join public.campaigns c on c.id = r.campaign_id
        where r.lead_id = l.id
          and c.status in ('scheduled', 'running', 'paused')
          and r.status in ('pending', 'waiting', 'sending')
          and c.id is distinct from public.try_uuid(p_filters ->> 'exclude_campaign_id')
      )
    )
    and (cardinality(public.jarr(p_filters -> 'ids')) = 0 or l.id::text = any (public.jarr(p_filters -> 'ids')))
    and (
      cardinality(public.jarr(p_filters -> 'list_ids')) = 0
      or exists (select 1 from public.lead_list_items li
                 where li.lead_id = l.id and li.list_id::text = any (public.jarr(p_filters -> 'list_ids')))
    );
$$;

-- Facets now include countries.
create or replace function public.lead_facets(p_workspace uuid)
returns jsonb language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'cities', coalesce((
      select jsonb_agg(jsonb_build_object('value', city, 'count', n) order by n desc)
      from (select city, count(*) n from public.leads where workspace_id = p_workspace and coalesce(city, '') <> ''
            group by city order by count(*) desc limit 200) c), '[]'::jsonb),
    'countries', coalesce((
      select jsonb_agg(jsonb_build_object('value', country, 'count', n) order by n desc)
      from (select upper(country) as country, count(*) n from public.leads where workspace_id = p_workspace and coalesce(country, '') <> ''
            group by upper(country) order by count(*) desc limit 250) c), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('value', category, 'count', n) order by n desc)
      from (select category, count(*) n from public.leads where workspace_id = p_workspace and coalesce(category, '') <> ''
            group by category order by count(*) desc limit 200) c), '[]'::jsonb),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('value', tag, 'count', n) order by n desc)
      from (select t.tag, count(*) n from public.leads l, unnest(l.tags) as t(tag)
            where l.workspace_id = p_workspace group by t.tag order by count(*) desc limit 300) c), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Lead-bank numbers for the dashboard (counts the leads the caller can see —
-- with the shared bank that is the whole team's inventory).
-- ---------------------------------------------------------------------------

create or replace function public.lead_inventory(p_workspace uuid)
returns jsonb language plpgsql stable set search_path = ''
as $$
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  return (
    with
    l as (select * from public.leads where workspace_id = p_workspace),
    camp as (select public.campaign_lead_ids(p_workspace) as id),
    totals as (
      select count(*)::int as total,
             count(*) filter (where l.created_at >= now() - interval '24 hours')::int as new_24h,
             count(*) filter (where l.created_at >= now() - interval '7 days')::int as new_7d,
             count(*) filter (where l.source = 'scraper')::int as scraped,
             count(*) filter (where l.id in (select id from camp))::int as in_campaigns,
             count(*) filter (where l.phone is not null and not l.opted_out and l.wa_status <> 'invalid'
                                and l.id not in (select id from camp))::int as available,
             count(*) filter (where l.last_contacted_at is not null)::int as contacted,
             count(*) filter (where l.last_replied_at is not null)::int as replied,
             count(*) filter (where public.website_kind(l.website_domain) = 'site')::int as with_site,
             count(*) filter (where public.website_kind(l.website_domain) <> 'site')::int as without_site,
             count(distinct upper(l.country))::int as countries
      from l
    ),
    by_member as (
      select l.created_by as user_id, count(*)::int as count,
             count(*) filter (where l.created_at >= now() - interval '7 days')::int as new_7d,
             max(l.created_at) as last_added
      from l where l.created_by is not null
      group by l.created_by order by count(*) desc limit 25
    ),
    by_country as (
      select upper(l.country) as code, count(*)::int as count
      from l where coalesce(l.country, '') <> ''
      group by upper(l.country) order by count(*) desc limit 8
    ),
    jobs as (
      select j.id, j.name, j.created_by, j.status, j.country, j.created_at, j.finished_at,
             coalesce((j.stats ->> 'inserted')::int, 0) as inserted,
             coalesce((j.stats ->> 'duplicates')::int, 0) as duplicates
      from public.scrape_jobs j where j.workspace_id = p_workspace
      order by j.created_at desc limit 8
    )
    select jsonb_build_object(
      'totals', (select to_jsonb(totals) from totals),
      'by_member', coalesce((select jsonb_agg(to_jsonb(b)) from by_member b), '[]'::jsonb),
      'by_country', coalesce((select jsonb_agg(to_jsonb(c)) from by_country c), '[]'::jsonb),
      'recent_jobs', coalesce((select jsonb_agg(to_jsonb(j) order by j.created_at desc) from jobs j), '[]'::jsonb)
    )
  );
end;
$$;

revoke execute on function public.campaign_lead_ids(uuid, uuid[]) from public, anon;
grant execute on function public.campaign_lead_ids(uuid, uuid[]) to authenticated;
revoke execute on function public.lead_inventory(uuid) from public, anon;
grant execute on function public.lead_inventory(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 20261017000001_lead_finder_deep_search.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Lead finder: admin tool, deep search, memory of searched map areas
--
--   * The lead finder (Google Maps searches) is for owners and admins. Members
--     and viewers no longer see or start lead searches unless an admin turns on
--     "Use the lead finder" for them (permissions.scrape = true).
--   * A search can be "deep": the engine geocodes each location (any city,
--     area or country in the world), splits it into map zones and searches
--     zone by zone, going closer in where a zone keeps yielding new businesses.
--   * scrape_coverage remembers which zones were searched for which keyword, so
--     running the same search again explores zones not searched yet instead of
--     returning the same businesses. Engine-only table.
-- ============================================================================

-- Per-member permission with sensible defaults. Admins can do everything; viewers
-- nothing; members everything except the lead finder and deleting leads.
create or replace function public.member_can(ws uuid, perm text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select case
      when m.role in ('owner', 'admin') then true
      when m.role = 'viewer' then false
      else coalesce(
        (m.permissions ->> perm)::boolean,
        perm in ('create_campaigns', 'connect_whatsapp', 'export', 'import', 'use_ai')
      )
    end
    from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.active
  ), false);
$$;

drop policy if exists "scrape_jobs: members read" on public.scrape_jobs;
drop policy if exists "scrape_jobs: own or all" on public.scrape_jobs;
drop policy if exists "scrape_jobs: lead finder users read" on public.scrape_jobs;
create policy "scrape_jobs: lead finder users read" on public.scrape_jobs
  for select to authenticated using (public.member_can(workspace_id, 'scrape'));

-- ---------------------------------------------------------------------------
-- Search options
-- ---------------------------------------------------------------------------

-- standard: one Google search per keyword × location · deep: zone by zone
alter table public.scrape_jobs add column if not exists depth text not null default 'standard' check (depth in ('standard', 'deep'));
-- Deep: at most this many map zones per keyword × location in one run (null = no limit).
alter table public.scrape_jobs add column if not exists area_limit integer check (area_limit between 1 and 5000);
-- Deep: search zones again even if they were searched recently.
alter table public.scrape_jobs add column if not exists recheck boolean not null default false;

-- ---------------------------------------------------------------------------
-- Searched map zones per keyword (engine-only)
-- ---------------------------------------------------------------------------

create table if not exists public.scrape_coverage (
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  keyword       text not null,                  -- lower case, single spaces
  zone          text not null,                  -- map tile "zoom/x/y", or "q:<query>" for a standard search
  area          text not null default '',       -- the location it was searched for (lower case)
  found         integer not null default 0,     -- businesses Google listed
  fresh         integer not null default 0,     -- of those, not in the workspace yet
  dense         boolean not null default false, -- yielded a lot: search its sub-zones next time
  job_id        uuid references public.scrape_jobs (id) on delete set null,
  searched_at   timestamptz not null default now(),
  primary key (workspace_id, keyword, zone)
);
create index if not exists scrape_coverage_job_idx on public.scrape_coverage (job_id) where job_id is not null;

alter table public.scrape_coverage enable row level security;
revoke all on public.scrape_coverage from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 20261017000002_inbox_folders.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Inbox folders per teammate and per team
--
--   * conversations.member_ids: the teammates in a chat — the owner of the
--     WhatsApp number plus everyone who sent a message in it (typed in the
--     dashboard, or a campaign they run). The inbox shows a folder per
--     teammate (and per team) from it.
--   * conversations.last_sender_id: who sent the latest outgoing message, so
--     the chat list can say "Ali: …" instead of "You: …".
--   * inbox_folders(): conversation and unread counts per folder (RLS applies,
--     so everyone only counts the chats they can see).
-- ============================================================================

alter table public.conversations add column if not exists member_ids uuid[] not null default '{}';
alter table public.conversations add column if not exists last_sender_id uuid references public.profiles (id) on delete set null;
create index if not exists conversations_members_idx on public.conversations using gin (member_ids);

-- Who sent an outgoing message: the person who typed it, else the campaign's
-- creator, else (sent from the phone itself) the number's owner.
create or replace function public.message_sender(p_sent_by uuid, p_campaign uuid, p_account uuid)
returns uuid language sql stable security definer set search_path = ''
as $$
  select coalesce(
    p_sent_by,
    (select c.created_by from public.campaigns c where c.id = p_campaign),
    (select a.owner_id from public.whatsapp_accounts a where a.id = p_account)
  );
$$;
revoke execute on function public.message_sender(uuid, uuid, uuid) from public, anon, authenticated;

-- A new chat starts in the number owner's folder.
create or replace function public.conversations_set_members()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  owner uuid;
begin
  select a.owner_id into owner from public.whatsapp_accounts a where a.id = new.account_id;
  if owner is not null and not (owner = any (new.member_ids)) then
    new.member_ids := new.member_ids || owner;
  end if;
  return new;
end;
$$;
drop trigger if exists conversations_set_members on public.conversations;
create trigger conversations_set_members before insert on public.conversations
  for each row execute function public.conversations_set_members();

-- Sending a message puts the chat in the sender's folder.
create or replace function public.messages_track_sender()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid;
begin
  if new.direction <> 'out' or new.conversation_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.conversation_id is not distinct from new.conversation_id then
    return null;
  end if;
  uid := public.message_sender(new.sent_by, new.campaign_id, new.account_id);
  if uid is null then
    return null;
  end if;
  update public.conversations
     set member_ids = case when uid = any (member_ids) then member_ids else member_ids || uid end,
         last_sender_id = uid
   where id = new.conversation_id
     and (last_sender_id is distinct from uid or not (uid = any (member_ids)));
  return null;
end;
$$;
drop trigger if exists messages_track_sender on public.messages;
create trigger messages_track_sender after insert or update of conversation_id on public.messages
  for each row execute function public.messages_track_sender();

-- A number handed to someone else brings its chats into their folder too.
create or replace function public.wa_accounts_owner_to_conversations()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.owner_id is not null and new.owner_id is distinct from old.owner_id then
    update public.conversations
       set member_ids = member_ids || new.owner_id
     where account_id = new.id and not (new.owner_id = any (member_ids));
  end if;
  return null;
end;
$$;
drop trigger if exists wa_accounts_owner_to_conversations on public.whatsapp_accounts;
create trigger wa_accounts_owner_to_conversations after update of owner_id on public.whatsapp_accounts
  for each row execute function public.wa_accounts_owner_to_conversations();

-- Existing chats.
update public.conversations c
   set member_ids = coalesce((
         select array_agg(distinct s.uid)
         from (
           select a.owner_id as uid from public.whatsapp_accounts a where a.id = c.account_id
           union
           select public.message_sender(m.sent_by, m.campaign_id, m.account_id)
           from public.messages m
           where m.conversation_id = c.id and m.direction = 'out'
         ) s
         where s.uid is not null
       ), '{}'),
       last_sender_id = (
         select public.message_sender(m.sent_by, m.campaign_id, m.account_id)
         from public.messages m
         where m.conversation_id = c.id and m.direction = 'out'
         order by m.created_at desc
         limit 1
       );

-- Conversation and unread counts for all chats, per teammate folder and per
-- team folder (archived chats excluded).
create or replace function public.inbox_folders(p_workspace uuid)
returns table (kind text, id uuid, conversations integer, unread integer)
language sql stable set search_path = ''
as $$
  with c as (
    select c.id, c.member_ids, c.unread_count
    from public.conversations c
    where c.workspace_id = p_workspace and not c.archived
  )
  select 'all', null::uuid, count(*)::int, (count(*) filter (where c.unread_count > 0))::int
  from c
  union all
  select 'member', u.uid, count(*)::int, (count(*) filter (where c.unread_count > 0))::int
  from c cross join lateral unnest(c.member_ids) as u(uid)
  group by u.uid
  union all
  select 'team', tm.team_id, count(distinct c.id)::int, (count(distinct c.id) filter (where c.unread_count > 0))::int
  from c join public.team_members tm on tm.workspace_id = p_workspace and tm.user_id = any (c.member_ids)
  group by tm.team_id;
$$;
revoke execute on function public.inbox_folders(uuid) from public, anon;

-- ----------------------------------------------------------------------------
-- 20261022000001_private_chats.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Private WhatsApp chats
--
--   * Owners and admins see every chat with leads.
--   * Everyone else sees only their own chats: chats on their own WhatsApp
--     numbers and chats they sent a message in (conversations.member_ids).
--     They no longer see admins' or other members' chats, even on shared
--     numbers or with leads they can see.
--   * Messages follow their chat.
-- Safe to run more than once.
-- ============================================================================

-- The caller's own chat (or an admin): used by the messages policy.
create or replace function public.can_view_conversation(cid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = cid
      and public.is_member(c.workspace_id)
      and (
        public.is_admin(c.workspace_id)
        or (select auth.uid()) = any (c.member_ids)
        or exists (select 1 from public.whatsapp_accounts a where a.id = c.account_id and a.owner_id = (select auth.uid()))
      )
  );
$$;
revoke execute on function public.can_view_conversation(uuid) from public, anon;

drop policy if exists "conversations: visible" on public.conversations;
drop policy if exists "conversations: own or admin" on public.conversations;
create policy "conversations: own or admin" on public.conversations
  for select to authenticated using (
    public.is_admin(workspace_id)
    or (
      public.is_member(workspace_id)
      and (
        (select auth.uid()) = any (member_ids)
        or exists (select 1 from public.whatsapp_accounts a where a.id = account_id and a.owner_id = (select auth.uid()))
      )
    )
  );

drop policy if exists "conversations: writers update visible" on public.conversations;
drop policy if exists "conversations: writers update own or admin" on public.conversations;
create policy "conversations: writers update own or admin" on public.conversations
  for update to authenticated
  using (
    public.can_write(workspace_id)
    and (
      public.is_admin(workspace_id)
      or (select auth.uid()) = any (member_ids)
      or exists (select 1 from public.whatsapp_accounts a where a.id = account_id and a.owner_id = (select auth.uid()))
    )
  )
  with check (public.can_write(workspace_id));

drop policy if exists "messages: visible" on public.messages;
drop policy if exists "messages: own chats or admin" on public.messages;
create policy "messages: own chats or admin" on public.messages
  for select to authenticated using (
    public.is_admin(workspace_id)
    or (
      public.is_member(workspace_id)
      and (
        (conversation_id is not null and public.can_view_conversation(conversation_id))
        -- Typed in the dashboard and still waiting for the engine (no chat yet).
        or (conversation_id is null and sent_by = (select auth.uid()))
        or (conversation_id is null and exists (select 1 from public.whatsapp_accounts a where a.id = account_id and a.owner_id = (select auth.uid())))
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 20261022000002_remove_echo_duplicates.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Remove duplicate copies of sent messages
--
-- WhatsApp reports every message we send back to us. Until now the engine
-- could save that report as a second "sent from the phone" message before the
-- original was saved, so messages typed in the dashboard (or sent by a
-- campaign) showed twice in the chat. The engine no longer does that; this
-- removes the copies already saved: an outgoing message with no sender and no
-- campaign, in the same chat as a dashboard/campaign message with the same
-- text, sent within 3 minutes of it. Safe to run more than once.
-- ============================================================================

delete from public.messages echo
using public.messages original
where echo.direction = 'out'
  and echo.sent_by is null
  and echo.campaign_id is null
  and echo.conversation_id is not null
  and original.id <> echo.id
  and original.conversation_id = echo.conversation_id
  and original.direction = 'out'
  and (original.sent_by is not null or original.campaign_id is not null)
  and original.body = echo.body
  and coalesce(original.media_type, '') = coalesce(echo.media_type, '')
  and abs(extract(epoch from (original.created_at - echo.created_at))) < 180;

-- ----------------------------------------------------------------------------
-- 20261023000001_fast_lead_filters.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Fast lead filters
--
--   * The leads row-security rule checked the caller's membership (two
--     lookups) for every single lead. With ~20,000 leads a filtered list took
--     longer than the database's 8-second limit and failed, so filters looked
--     broken. The caller's workspaces are now looked up once per query.
--   * Search: "+92" finds numbers starting with 92 (country code), and local
--     formats such as "0300 1234567" match the stored international number.
--   * New filter: phone_codes (country calling codes, e.g. ["92", "44"]).
--   * filtered_leads builds a query with only the filters in use (fast in the API).
-- Safe to run more than once.
-- ============================================================================

-- Workspaces the caller is an active member of.
create or replace function public.my_workspace_ids()
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid()) and m.active;
$$;

-- Workspaces where the caller sees every lead (owners, admins, viewers; members
-- when "members see all leads" is on, the default).
create or replace function public.my_all_leads_workspace_ids()
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select m.workspace_id
  from public.workspace_members m
  join public.workspaces w on w.id = m.workspace_id
  where m.user_id = (select auth.uid()) and m.active
    and (m.role in ('owner', 'admin', 'viewer') or coalesce((w.settings ->> 'members_see_all_leads')::boolean, true));
$$;
revoke execute on function public.my_workspace_ids() from public, anon;
revoke execute on function public.my_all_leads_workspace_ids() from public, anon;

-- Same rule as before; the membership checks run once per query (array(select …)
-- is evaluated once), not once per lead.
drop policy if exists "leads: visible" on public.leads;
create policy "leads: visible" on public.leads
  for select to authenticated using (
    workspace_id = any (array(select public.my_all_leads_workspace_ids()))
    or (workspace_id = any (array(select public.my_workspace_ids())) and (
      owner_id = (select auth.uid())
      or exists (select 1 from public.lead_list_items li where li.lead_id = leads.id and public.can_view_list(li.list_id))
      or exists (select 1 from public.campaign_recipients r where r.lead_id = leads.id and public.can_view_campaign(r.campaign_id))
      or exists (select 1 from public.conversations c join public.whatsapp_accounts a on a.id = c.account_id
                 where c.lead_id = leads.id and a.owner_id = (select auth.uid()))
    ))
  );

drop policy if exists "leads: writers update visible" on public.leads;
create policy "leads: writers update visible" on public.leads
  for update to authenticated
  using (
    public.can_write(workspace_id)
    and (workspace_id = any (array(select public.my_all_leads_workspace_ids())) or public.can_view_lead(id))
  )
  with check (public.can_write(workspace_id));

-- ---------------------------------------------------------------------------
-- Lead filters (phone search, phone_codes)
-- ---------------------------------------------------------------------------

-- Built as a query with only the filters in use: the API passes the arguments as
-- sub-queries, so a plain SQL function re-read the filter JSON for every lead
-- (1.9–22 s on 20,000 leads, past the 8 s limit). Values are quoted with %L.
-- Same rules as before; runs with the caller's rights, so row security applies.
create or replace function public.filtered_leads(p_workspace uuid, p_filters jsonb default '{}'::jsonb)
returns setof public.leads
language plpgsql stable set search_path = ''
as $$
declare
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  w text[] := array['l.workspace_id = $1'];
  q text := nullif(btrim(coalesce(f ->> 'q', '')), '');
  q_digits text := regexp_replace(coalesce(f ->> 'q', ''), '\D', '', 'g');
  -- "0300 1234567" (local format): without the leading 0 it matches the stored "92300…"
  q_local text := ltrim(regexp_replace(coalesce(f ->> 'q', ''), '\D', '', 'g'), '0');
  v text;
  arr text[];
  b boolean;
begin
  if q is not null then
    v := '%' || q || '%';
    w := w || format(
      '(l.business_name ilike %1$L or l.address ilike %1$L or l.city ilike %1$L or l.category ilike %1$L'
      ' or l.email ilike %1$L or l.contact_name ilike %1$L or l.website ilike %1$L%2$s%3$s)',
      v,
      -- "+92", "+44 20": numbers starting with that country code
      case when left(q, 1) = '+' and length(q_digits) >= 1 then format(' or l.phone like %L', q_digits || '%') else '' end,
      case when length(q_local) >= 3 then format(' or l.phone like %L', '%' || q_local || '%') else '' end
    );
  end if;

  v := nullif(btrim(coalesce(f ->> 'name', '')), '');
  if v is not null then w := w || format('l.business_name ilike %L', '%' || v || '%'); end if;
  v := nullif(lower(btrim(coalesce(f ->> 'domain', ''))), '');
  if v is not null then w := w || format('l.website_domain like %L', '%' || v || '%'); end if;

  arr := public.jarr(f -> 'stage_ids');
  if cardinality(arr) > 0 then w := w || format('l.stage_id::text = any (%L::text[])', arr); end if;
  if jsonb_typeof(f -> 'has_website') = 'boolean' then w := w || format('l.has_website = %L', (f ->> 'has_website')::boolean); end if;
  v := f ->> 'website';
  if v = 'no_site' then w := w || 'public.website_kind(l.website_domain) <> ''site'''::text;
  elsif v is not null then w := w || format('public.website_kind(l.website_domain) = %L', v);
  end if;

  arr := public.jarr(f -> 'cities');
  if cardinality(arr) > 0 then w := w || format('l.city = any (%L::text[])', arr); end if;
  arr := public.jarr(f -> 'countries');
  if cardinality(arr) > 0 then w := w || format('upper(l.country) = any (%L::text[])', arr); end if;
  arr := public.jarr(f -> 'categories');
  if cardinality(arr) > 0 then w := w || format('l.category = any (%L::text[])', arr); end if;
  -- Phone country codes, e.g. ["92", "971"]: numbers starting with one of them
  arr := array(select x || '%' from unnest(public.jarr(f -> 'phone_codes')) x where x ~ '^[0-9]{1,4}$');
  if cardinality(arr) > 0 then w := w || format('l.phone like any (%L::text[])', arr); end if;
  arr := public.jarr(f -> 'tags');
  if cardinality(arr) > 0 then w := w || format('l.tags && %L::text[]', arr); end if;

  arr := public.jarr(f -> 'owner_ids');
  b := coalesce((f ->> 'unassigned')::boolean, false);
  if cardinality(arr) > 0 or b then
    w := w || format('(%s)', concat_ws(' or ',
      case when cardinality(arr) > 0 then format('l.owner_id::text = any (%L::text[])', arr) end,
      case when b then 'l.owner_id is null' end));
  end if;
  arr := public.jarr(f -> 'created_by_ids');
  if cardinality(arr) > 0 then w := w || format('l.created_by::text = any (%L::text[])', arr); end if;
  arr := public.jarr(f -> 'wa_status');
  if cardinality(arr) > 0 then w := w || format('l.wa_status = any (%L::text[])', arr); end if;
  arr := public.jarr(f -> 'phone_types');
  if cardinality(arr) > 0 then w := w || format('l.phone_type = any (%L::text[])', arr); end if;
  arr := public.jarr(f -> 'sources');
  if cardinality(arr) > 0 then w := w || format('l.source = any (%L::text[])', arr); end if;
  arr := public.jarr(f -> 'tiers');
  if cardinality(arr) > 0 then w := w || format('l.score_tier = any (%L::text[])', arr); end if;

  if f ->> 'min_score' is not null then w := w || format('l.score >= %L::int', f ->> 'min_score'); end if;
  if f ->> 'min_rating' is not null then w := w || format('coalesce(l.rating, 0) >= %L::numeric', f ->> 'min_rating'); end if;
  if f ->> 'min_reviews' is not null then w := w || format('coalesce(l.reviews_count, 0) >= %L::int', f ->> 'min_reviews'); end if;
  if jsonb_typeof(f -> 'opted_out') = 'boolean' then w := w || format('l.opted_out = %L', (f ->> 'opted_out')::boolean); end if;

  case f ->> 'contacted'
    when 'never' then w := w || 'l.last_contacted_at is null'::text;
    when 'contacted' then w := w || 'l.last_contacted_at is not null'::text;
    when 'replied' then w := w || 'l.last_replied_at is not null'::text;
    when 'not_replied' then w := w || '(l.last_contacted_at is not null and l.last_replied_at is null)'::text;
    else null;
  end case;
  if f ->> 'not_contacted_days' is not null then
    w := w || format('(l.last_contacted_at is null or l.last_contacted_at < now() - make_interval(days => %L::int))', f ->> 'not_contacted_days');
  end if;
  if f ->> 'scrape_job_id' is not null then w := w || format('l.scrape_job_id = %L::uuid', public.try_uuid(f ->> 'scrape_job_id')); end if;
  if f ->> 'created_from' is not null then w := w || format('l.created_at >= %L::timestamptz', f ->> 'created_from'); end if;
  if f ->> 'created_to' is not null then w := w || format('l.created_at < %L::timestamptz', f ->> 'created_to'); end if;
  if jsonb_typeof(f -> 'has_phone') = 'boolean' then w := w || format('(l.phone is not null) = %L', (f ->> 'has_phone')::boolean); end if;
  if jsonb_typeof(f -> 'has_email') = 'boolean' then w := w || format('(coalesce(l.email, '''') <> '''') = %L', (f ->> 'has_email')::boolean); end if;
  if coalesce((f ->> 'sendable')::boolean, false) then
    w := w || '(l.phone is not null and not l.opted_out and l.wa_status <> ''invalid'')'::text;
  end if;

  -- never: in no campaign yet · any: in at least one campaign
  if f ->> 'campaign' = 'never' then w := w || 'l.id not in (select public.campaign_lead_ids($1))'::text;
  elsif f ->> 'campaign' = 'any' then w := w || 'l.id in (select public.campaign_lead_ids($1))'::text;
  end if;
  arr := public.jarr(f -> 'campaign_ids');
  if cardinality(arr) > 0 then
    w := w || format('l.id in (select public.campaign_lead_ids($1, array(select public.try_uuid(x) from unnest(%L::text[]) x)))', arr);
  end if;
  arr := public.jarr(f -> 'exclude_campaign_ids');
  if cardinality(arr) > 0 then
    w := w || format('l.id not in (select public.campaign_lead_ids($1, array(select public.try_uuid(x) from unnest(%L::text[]) x)))', arr);
  end if;
  -- Never let two campaigns (or two teammates) work the same lead at once.
  if coalesce((f ->> 'not_in_active_campaign')::boolean, false) then
    w := w || format(
      'not exists (select 1 from public.campaign_recipients r join public.campaigns c on c.id = r.campaign_id'
      ' where r.lead_id = l.id and c.status in (''scheduled'', ''running'', ''paused'')'
      ' and r.status in (''pending'', ''waiting'', ''sending'') and c.id is distinct from %L::uuid)',
      public.try_uuid(f ->> 'exclude_campaign_id'));
  end if;
  arr := public.jarr(f -> 'ids');
  if cardinality(arr) > 0 then w := w || format('l.id::text = any (%L::text[])', arr); end if;
  arr := public.jarr(f -> 'list_ids');
  if cardinality(arr) > 0 then
    w := w || format('exists (select 1 from public.lead_list_items li where li.lead_id = l.id and li.list_id::text = any (%L::text[]))', arr);
  end if;

  return query execute 'select l.* from public.leads l where ' || array_to_string(w, ' and ') using p_workspace;
end;
$$;


-- ----------------------------------------------------------------------------
-- 20261026000001_reply_detection_and_lists.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- Reply detection and lead lists
--
--   * Automatic replies (WhatsApp Business greeting / away messages) arrive a
--     few seconds after a campaign message reaches the phone. They were
--     counted as replies, stopped follow-ups and moved leads to "Replied".
--     They are now flagged (messages.auto_reply), shown in the chat, and left
--     out of every reply count. messages.delivered_at records when a message
--     reached the lead's phone (the moment an automatic reply is sent).
--   * A reply only counts for a campaign the lead was actually messaged in,
--     on the number that messaged them, after the first campaign message.
--   * Past data is corrected: automatic replies are flagged, recipients that
--     never really replied are put back (follow-ups continue), and leads'
--     "last replied" date and Replied stage are recalculated.
--   * Reports, the dashboard and number health count only real replies.
--   * lead_list_stats: per list, how many leads were contacted, replied, are
--     in campaigns, won, and how many campaigns used the list.
-- Safe to run more than once.
-- ============================================================================

alter table public.messages add column if not exists auto_reply boolean not null default false;
alter table public.messages add column if not exists delivered_at timestamptz;

-- ---------------------------------------------------------------------------
-- Correct past data
-- ---------------------------------------------------------------------------

-- Incoming messages that arrived within seconds of a campaign message to the
-- same lead on the same number: automatic replies.
update public.messages m set auto_reply = true
where m.direction = 'in' and not m.auto_reply
  and exists (
    select 1 from public.messages o
    where o.lead_id = m.lead_id and o.account_id = m.account_id
      and o.direction = 'out' and o.campaign_id is not null
      and m.created_at between o.created_at - interval '5 seconds' and o.created_at + interval '20 seconds'
  );

-- Recipients marked "replied" without a real reply after their first campaign
-- message (on the number that messaged them).
with fake as (
  select r.id, r.steps_sent, c.status as campaign_status,
    (select count(*) from public.campaign_steps s where s.campaign_id = r.campaign_id) as steps
  from public.campaign_recipients r
  join public.campaigns c on c.id = r.campaign_id
  where r.status = 'replied'
    and not exists (
      select 1 from public.messages i
      where i.lead_id = r.lead_id and i.direction = 'in' and not i.auto_reply
        and (r.account_id is null or i.account_id = r.account_id)
        and i.created_at >= coalesce(
          (select min(o.created_at) from public.messages o where o.recipient_id = r.id and o.direction = 'out'),
          r.last_sent_at,
          'infinity'::timestamptz
        ) - interval '5 seconds'
    )
),
fixed as (
  update public.campaign_recipients r set
    status = case
      when f.steps_sent = 0 then 'skipped'
      when f.steps_sent < f.steps and f.campaign_status in ('running', 'paused', 'scheduled') then 'waiting'
      else 'completed'
    end,
    replied_at = null,
    error = case when f.steps_sent = 0 then 'Messaged us before the campaign reached them' else r.error end,
    next_send_at = case
      when f.steps_sent > 0 and f.steps_sent < f.steps then greatest(coalesce(r.next_send_at, now()), now())
      else r.next_send_at
    end
  from fake f
  where r.id = f.id
  returning r.campaign_id, r.lead_id
)
update public.campaign_events e
set type = 'info', message = 'Not counted as a reply (automatic reply): ' || e.message
from fixed x
where e.campaign_id = x.campaign_id and e.lead_id = x.lead_id and e.type = 'replied';

-- Leads' last reply = their last real reply; leads moved to "Replied" only by
-- an automatic reply go back to the first "Contacted" stage.
with affected as (
  select distinct m.lead_id from public.messages m where m.auto_reply
),
real_reply as (
  select a.lead_id,
    (select max(i.created_at) from public.messages i where i.lead_id = a.lead_id and i.direction = 'in' and not i.auto_reply) as last_in
  from affected a
)
update public.leads l set
  last_replied_at = rr.last_in,
  stage_id = case
    when rr.last_in is null and (select s.kind from public.pipeline_stages s where s.id = l.stage_id) = 'replied'
      then coalesce(
        (select s.id from public.pipeline_stages s where s.workspace_id = l.workspace_id and s.kind = 'contacted' order by s.position limit 1),
        l.stage_id)
    else l.stage_id
  end
from real_reply rr
where l.id = rr.lead_id and l.last_replied_at is distinct from rr.last_in;

-- ---------------------------------------------------------------------------
-- Reports count only real replies
-- ---------------------------------------------------------------------------

create or replace function public.dashboard_overview(p_workspace uuid, p_days integer default 14)
returns jsonb language plpgsql stable set search_path = ''
as $$
declare
  tz text;
  today_start timestamptz;
  since timestamptz;
  days int := greatest(1, least(coalesce(p_days, 14), 365));
  result jsonb;
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  select coalesce(timezone, 'UTC') into tz from public.workspaces where id = p_workspace;
  today_start := date_trunc('day', now() at time zone tz) at time zone tz;
  since := today_start - make_interval(days => days - 1);

  with
  lead_totals as (
    select count(*)::int as total,
           count(*) filter (where created_at >= now() - interval '7 days')::int as new_7d,
           count(*) filter (where created_at >= since)::int as new_period,
           count(*) filter (where has_website)::int as with_website,
           count(*) filter (where not has_website)::int as without_website,
           count(*) filter (where wa_status = 'valid')::int as on_whatsapp,
           count(*) filter (where opted_out)::int as opted_out
    from public.leads where workspace_id = p_workspace
  ),
  msg as (
    select
      count(*) filter (where direction = 'out' and status in ('sent', 'delivered', 'read') and created_at >= today_start)::int as sent_today,
      count(*) filter (where direction = 'out' and status in ('sent', 'delivered', 'read'))::int as sent,
      count(*) filter (where direction = 'out' and status in ('delivered', 'read'))::int as delivered,
      count(*) filter (where direction = 'out' and status = 'read')::int as read,
      count(*) filter (where direction = 'out' and status = 'failed')::int as failed,
      count(*) filter (where direction = 'in' and not auto_reply)::int as received,
      count(distinct lead_id) filter (where direction = 'out' and status in ('sent', 'delivered', 'read'))::int as leads_messaged,
      count(distinct lead_id) filter (where direction = 'in' and not auto_reply)::int as leads_replied
    from public.messages
    where workspace_id = p_workspace and created_at >= since
  ),
  series as (
    select d::date as day,
      (select count(*) from public.messages m where m.workspace_id = p_workspace and m.direction = 'out'
         and m.status in ('sent', 'delivered', 'read')
         and m.created_at >= (d at time zone tz) and m.created_at < ((d + interval '1 day') at time zone tz))::int as sent,
      (select count(*) from public.messages m where m.workspace_id = p_workspace and m.direction = 'out'
         and m.status in ('delivered', 'read')
         and m.created_at >= (d at time zone tz) and m.created_at < ((d + interval '1 day') at time zone tz))::int as delivered,
      (select count(*) from public.messages m where m.workspace_id = p_workspace and m.direction = 'out'
         and m.status = 'read'
         and m.created_at >= (d at time zone tz) and m.created_at < ((d + interval '1 day') at time zone tz))::int as read,
      (select count(*) from public.messages m where m.workspace_id = p_workspace and m.direction = 'in' and not m.auto_reply
         and m.created_at >= (d at time zone tz) and m.created_at < ((d + interval '1 day') at time zone tz))::int as replies,
      (select count(*) from public.leads l where l.workspace_id = p_workspace
         and l.created_at >= (d at time zone tz) and l.created_at < ((d + interval '1 day') at time zone tz))::int as leads
    from generate_series(date_trunc('day', since at time zone tz), date_trunc('day', now() at time zone tz), interval '1 day') d
  ),
  stages as (
    select s.id, s.name, s.color, s.kind, s.position,
           count(l.id)::int as count, coalesce(sum(l.deal_value), 0)::numeric as value
    from public.pipeline_stages s
    left join public.leads l on l.stage_id = s.id
    where s.workspace_id = p_workspace
    group by s.id
  ),
  cities as (
    select city as name, count(*)::int as count from public.leads
    where workspace_id = p_workspace and coalesce(city, '') <> ''
    group by city order by count(*) desc limit 6
  ),
  categories as (
    select category as name, count(*)::int as count from public.leads
    where workspace_id = p_workspace and coalesce(category, '') <> ''
    group by category order by count(*) desc limit 6
  )
  select jsonb_build_object(
    'timezone', tz,
    'days', days,
    'leads', (select to_jsonb(lead_totals) from lead_totals),
    'messages', (select to_jsonb(msg) from msg),
    'campaigns_active', (select count(*) from public.campaigns where workspace_id = p_workspace and status in ('running', 'scheduled')),
    'accounts_connected', (select count(*) from public.whatsapp_accounts where workspace_id = p_workspace and status = 'connected'),
    'accounts_total', (select count(*) from public.whatsapp_accounts where workspace_id = p_workspace),
    'won', (select jsonb_build_object('count', coalesce(sum(count), 0), 'value', coalesce(sum(value), 0)) from stages where kind = 'won'),
    'open_value', (select coalesce(sum(value), 0) from stages where kind not in ('won', 'lost')),
    'series', coalesce((select jsonb_agg(to_jsonb(series) order by day) from series), '[]'::jsonb),
    'stages', coalesce((select jsonb_agg(to_jsonb(stages) order by position) from stages), '[]'::jsonb),
    'top_cities', coalesce((select jsonb_agg(to_jsonb(cities)) from cities), '[]'::jsonb),
    'top_categories', coalesce((select jsonb_agg(to_jsonb(categories)) from categories), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create or replace function public.team_performance(p_workspace uuid, p_days integer default 30)
returns table (
  user_id uuid, full_name text, email text, role text,
  messages_sent integer, replies integer, leads_owned integer, won integer, won_value numeric, accounts_connected integer
)
language plpgsql stable set search_path = ''
as $$
declare
  since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  return query
  select
    m.user_id, p.full_name, p.email, m.role,
    (select count(*) from public.messages x
       left join public.campaigns c on c.id = x.campaign_id
      where x.workspace_id = p_workspace and x.direction = 'out' and x.status in ('sent', 'delivered', 'read')
        and x.created_at >= since and coalesce(x.sent_by, c.created_by) = m.user_id)::int,
    (select count(*) from public.messages x
       join public.whatsapp_accounts a on a.id = x.account_id
      where x.workspace_id = p_workspace and x.direction = 'in' and not x.auto_reply and x.created_at >= since and a.owner_id = m.user_id)::int,
    (select count(*) from public.leads l where l.workspace_id = p_workspace and l.owner_id = m.user_id)::int,
    (select count(*) from public.leads l join public.pipeline_stages s on s.id = l.stage_id
      where l.workspace_id = p_workspace and l.owner_id = m.user_id and s.kind = 'won')::int,
    (select coalesce(sum(l.deal_value), 0) from public.leads l join public.pipeline_stages s on s.id = l.stage_id
      where l.workspace_id = p_workspace and l.owner_id = m.user_id and s.kind = 'won'),
    (select count(*) from public.whatsapp_accounts a
      where a.workspace_id = p_workspace and a.owner_id = m.user_id and a.status = 'connected')::int
  from public.workspace_members m
  join public.profiles p on p.id = m.user_id
  where m.workspace_id = p_workspace
  order by 5 desc, 6 desc;
end;
$$;

create or replace function public.account_health(p_workspace uuid, p_days integer default 7)
returns table (account_id uuid, sent_today integer, sent integer, delivered integer, read integer, failed integer, replies integer)
language plpgsql stable set search_path = ''
as $$
declare
  tz text;
  today_start timestamptz;
  since timestamptz;
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  select coalesce(timezone, 'UTC') into tz from public.workspaces where id = p_workspace;
  today_start := date_trunc('day', now() at time zone tz) at time zone tz;
  since := least(today_start, now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90))));
  return query
  select a.id,
    count(m.id) filter (where m.direction = 'out' and m.status in ('sent', 'delivered', 'read') and m.created_at >= today_start)::int,
    count(m.id) filter (where m.direction = 'out' and m.status in ('sent', 'delivered', 'read'))::int,
    count(m.id) filter (where m.direction = 'out' and m.status in ('delivered', 'read'))::int,
    count(m.id) filter (where m.direction = 'out' and m.status = 'read')::int,
    count(m.id) filter (where m.direction = 'out' and m.status = 'failed')::int,
    count(m.id) filter (where m.direction = 'in' and not m.auto_reply)::int
  from public.whatsapp_accounts a
  left join public.messages m on m.account_id = a.id and m.created_at >= since
  where a.workspace_id = p_workspace
  group by a.id;
end;
$$;

create or replace function public.report_members(p_workspace uuid, p_from timestamptz, p_to timestamptz)
returns table (
  user_id uuid, full_name text, email text, role text, active boolean, teams text[],
  messages_sent integer, delivered integer, read integer, failed integer, replies integer,
  leads_contacted integer, leads_replied integer, leads_owned integer, leads_added integer,
  campaigns_created integer, meetings integer, won integer, won_value numeric,
  numbers integer, numbers_connected integer, last_active_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  everyone boolean;
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  everyone := public.sees_all(p_workspace);
  return query
  with mem as (
    select m.user_id, m.role, m.active from public.workspace_members m
    where m.workspace_id = p_workspace and (everyone or m.user_id = me)
  ),
  outbound as (
    select coalesce(x.sent_by, a.owner_id) as uid, x.status, x.lead_id, x.created_at
    from public.messages x
    left join public.whatsapp_accounts a on a.id = x.account_id
    where x.workspace_id = p_workspace and x.direction = 'out' and x.created_at >= p_from and x.created_at < p_to
  ),
  inbound as (
    select a.owner_id as uid, x.lead_id, x.created_at
    from public.messages x
    join public.whatsapp_accounts a on a.id = x.account_id
    where x.workspace_id = p_workspace and x.direction = 'in' and not x.auto_reply and x.created_at >= p_from and x.created_at < p_to
  ),
  o as (
    select uid,
      count(*) filter (where status in ('sent', 'delivered', 'read'))::int as sent,
      count(*) filter (where status in ('delivered', 'read'))::int as delivered,
      count(*) filter (where status = 'read')::int as read,
      count(*) filter (where status = 'failed')::int as failed,
      count(distinct lead_id) filter (where status in ('sent', 'delivered', 'read'))::int as contacted,
      max(created_at) as last_out
    from outbound group by uid
  ),
  i as (
    select uid, count(*)::int as replies, count(distinct lead_id)::int as replied, max(created_at) as last_in
    from inbound group by uid
  ),
  owned as (
    select l.owner_id as uid,
      count(*)::int as owned,
      count(*) filter (where s.kind = 'won')::int as won,
      coalesce(sum(l.deal_value) filter (where s.kind = 'won'), 0) as won_value
    from public.leads l left join public.pipeline_stages s on s.id = l.stage_id
    where l.workspace_id = p_workspace group by l.owner_id
  ),
  added as (
    select l.created_by as uid, count(*)::int as n from public.leads l
    where l.workspace_id = p_workspace and l.created_at >= p_from and l.created_at < p_to group by l.created_by
  ),
  camps as (
    select c.created_by as uid, count(*)::int as n from public.campaigns c
    where c.workspace_id = p_workspace and c.created_at >= p_from and c.created_at < p_to group by c.created_by
  ),
  meets as (
    select t.assignee_id as uid, count(*)::int as n from public.tasks t
    where t.workspace_id = p_workspace and t.type = 'meeting' and coalesce(t.due_at, t.created_at) >= p_from and coalesce(t.due_at, t.created_at) < p_to
    group by t.assignee_id
  ),
  nums as (
    select a.owner_id as uid, count(*)::int as n, count(*) filter (where a.status = 'connected')::int as c
    from public.whatsapp_accounts a where a.workspace_id = p_workspace group by a.owner_id
  ),
  tms as (
    select tm.user_id as uid, array_agg(t.name order by t.name) as names
    from public.team_members tm join public.teams t on t.id = tm.team_id
    where tm.workspace_id = p_workspace group by tm.user_id
  )
  select mem.user_id, p.full_name, p.email, mem.role, mem.active, coalesce(tms.names, '{}'),
    coalesce(o.sent, 0), coalesce(o.delivered, 0), coalesce(o.read, 0), coalesce(o.failed, 0), coalesce(i.replies, 0),
    coalesce(o.contacted, 0), coalesce(i.replied, 0), coalesce(owned.owned, 0), coalesce(added.n, 0),
    coalesce(camps.n, 0), coalesce(meets.n, 0), coalesce(owned.won, 0), coalesce(owned.won_value, 0),
    coalesce(nums.n, 0), coalesce(nums.c, 0), greatest(o.last_out, i.last_in)
  from mem
  join public.profiles p on p.id = mem.user_id
  left join o on o.uid = mem.user_id
  left join i on i.uid = mem.user_id
  left join owned on owned.uid = mem.user_id
  left join added on added.uid = mem.user_id
  left join camps on camps.uid = mem.user_id
  left join meets on meets.uid = mem.user_id
  left join nums on nums.uid = mem.user_id
  left join tms on tms.uid = mem.user_id
  order by coalesce(o.sent, 0) desc, p.full_name;
end;
$$;

create or replace function public.report_daily(p_workspace uuid, p_from timestamptz, p_to timestamptz)
returns table (day date, user_id uuid, sent integer, replies integer)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  everyone boolean;
  tz text;
begin
  if not public.is_member(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  everyone := public.sees_all(p_workspace);
  select coalesce(timezone, 'UTC') into tz from public.workspaces where id = p_workspace;
  return query
  select (x.created_at at time zone tz)::date as d,
    case when x.direction = 'out' then coalesce(x.sent_by, a.owner_id) else a.owner_id end as uid,
    count(*) filter (where x.direction = 'out' and x.status in ('sent', 'delivered', 'read'))::int,
    count(*) filter (where x.direction = 'in' and not x.auto_reply)::int
  from public.messages x
  left join public.whatsapp_accounts a on a.id = x.account_id
  where x.workspace_id = p_workspace and x.created_at >= p_from and x.created_at < p_to
    and (everyone or (case when x.direction = 'out' then coalesce(x.sent_by, a.owner_id) else a.owner_id end) = me)
  group by 1, 2
  order by 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lead list tracking
-- ---------------------------------------------------------------------------

-- One row per list the caller can see. Runs with the caller's rights.
create or replace function public.lead_list_stats(p_workspace uuid)
returns table (
  list_id uuid, total integer, sendable integer, contacted integer, replied integer, opted_out integer,
  in_campaigns integer, in_active_campaigns integer, won integer, campaigns integer, last_added_at timestamptz
)
language sql stable set search_path = ''
as $$
  select li.list_id,
    count(*)::int,
    count(*) filter (where l.phone is not null and not l.opted_out and l.wa_status <> 'invalid')::int,
    count(*) filter (where l.last_contacted_at is not null)::int,
    count(*) filter (where l.last_replied_at is not null)::int,
    count(*) filter (where l.opted_out)::int,
    count(*) filter (where exists (select 1 from public.campaign_recipients r where r.lead_id = l.id))::int,
    count(*) filter (where exists (
      select 1 from public.campaign_recipients r join public.campaigns c on c.id = r.campaign_id
      where r.lead_id = l.id and c.status in ('scheduled', 'running', 'paused') and r.status in ('pending', 'waiting', 'sending')
    ))::int,
    count(*) filter (where s.kind = 'won')::int,
    (select count(*) from public.campaigns c
      where c.workspace_id = p_workspace
        and (coalesce(c.audience -> 'list_ids', '[]'::jsonb) ? li.list_id::text
             or coalesce(c.audience -> 'filters' -> 'list_ids', '[]'::jsonb) ? li.list_id::text))::int,
    max(li.added_at)
  from public.lead_list_items li
  join public.leads l on l.id = li.lead_id
  left join public.pipeline_stages s on s.id = l.stage_id
  where li.workspace_id = p_workspace
  group by li.list_id;
$$;
revoke execute on function public.lead_list_stats(uuid) from public, anon;
grant execute on function public.lead_list_stats(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Record the applied migrations (lets `supabase db push` add future ones)
-- ----------------------------------------------------------------------------
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values
  ('20261003000001', 'schema'),
  ('20261003000002', 'rls'),
  ('20261003000003', 'functions'),
  ('20261003000004', 'realtime_storage'),
  ('20261003000005', 'team_quality_automation'),
  ('20261003000006', 'member_spaces_access'),
  ('20261003000007', 'engine_limits'),
  ('20261003000008', 'filter_ids'),
  ('20261010000001', 'reactions'),
  ('20261011000001', 'engine_signals'),
  ('20261014000001', 'shared_lead_bank'),
  ('20261017000001', 'lead_finder_deep_search'),
  ('20261017000002', 'inbox_folders'),
  ('20261022000001', 'private_chats'),
  ('20261022000002', 'remove_echo_duplicates'),
  ('20261023000001', 'fast_lead_filters'),
  ('20261026000001', 'reply_detection_and_lists')
on conflict (version) do nothing;

commit;
