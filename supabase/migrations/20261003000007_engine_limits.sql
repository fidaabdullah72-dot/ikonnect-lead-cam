-- WhatsApp-side limits observed by the engine, shown on the number health page:
-- { new_chat_quota, new_chat_used, cycle_end, timelock_until, timelock_type, checked_at }
alter table public.whatsapp_accounts add column limits jsonb not null default '{}'::jsonb;
