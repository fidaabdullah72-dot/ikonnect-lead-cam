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
