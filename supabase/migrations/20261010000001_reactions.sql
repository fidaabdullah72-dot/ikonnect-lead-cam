-- Reactions: WhatsApp emoji reactions on messages (both ways) and live
-- updates for team-chat reactions.

-- ---------------------------------------------------------------------------
-- WhatsApp reactions
-- ---------------------------------------------------------------------------

-- reaction_in  = the lead's reaction to this message
-- reaction_out = our reaction to this message (pending until the engine sends it)
alter table public.messages
  add column reaction_in          text check (char_length(reaction_in) <= 16),
  add column reaction_out         text check (char_length(reaction_out) <= 16),
  add column reaction_out_pending boolean not null default false;
create index messages_reaction_queue_idx on public.messages (updated_at) where reaction_out_pending;

-- React to a WhatsApp message from the dashboard ('' or null removes it).
-- The engine picks it up from the queue and sends it from the same number.
create or replace function public.message_react(p_message uuid, p_emoji text)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  m public.messages;
  e text := nullif(btrim(coalesce(p_emoji, '')), '');
begin
  select * into m from public.messages where id = p_message;
  if m.id is null or m.account_id is null or m.wa_message_id is null then
    raise exception 'This message can''t be reacted to yet';
  end if;
  if not public.can_use_account(m.account_id) then
    raise exception 'You can''t send from this WhatsApp number' using errcode = '42501';
  end if;
  if e is not null and char_length(e) > 16 then
    raise exception 'Invalid reaction';
  end if;
  update public.messages set reaction_out = e, reaction_out_pending = true where id = p_message;
end;
$$;
revoke execute on function public.message_react(uuid, text) from public, anon;
grant execute on function public.message_react(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Team chat: live reaction updates
-- ---------------------------------------------------------------------------
-- Realtime can't filter DELETE events, so removed reactions never reached other
-- people. Every reaction change now touches its message, which clients already
-- follow per channel.

alter table public.chat_messages add column reacted_at timestamptz;

create or replace function public.chat_reactions_touch_message()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  update public.chat_messages set reacted_at = now()
  where id = coalesce(new.message_id, old.message_id);
  return null;
end;
$$;
create trigger chat_reactions_touch_message after insert or delete on public.chat_reactions
  for each row execute function public.chat_reactions_touch_message();
