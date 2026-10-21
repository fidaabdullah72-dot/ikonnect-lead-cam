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
