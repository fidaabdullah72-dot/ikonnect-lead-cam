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
