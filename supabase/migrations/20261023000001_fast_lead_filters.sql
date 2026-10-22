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

