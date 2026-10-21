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
