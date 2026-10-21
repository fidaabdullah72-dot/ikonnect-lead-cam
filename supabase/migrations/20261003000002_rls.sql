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
