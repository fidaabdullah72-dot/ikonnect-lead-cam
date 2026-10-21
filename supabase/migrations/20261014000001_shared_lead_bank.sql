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
