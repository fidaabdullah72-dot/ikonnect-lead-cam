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
