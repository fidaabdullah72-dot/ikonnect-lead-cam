-- ============================================================================
-- BatSols v2: team chat, lead scoring & qualifier, duplicates/merge, saved
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
