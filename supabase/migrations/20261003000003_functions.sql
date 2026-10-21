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
