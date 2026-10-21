-- ============================================================================
-- Inbox folders per teammate and per team
--
--   * conversations.member_ids: the teammates in a chat — the owner of the
--     WhatsApp number plus everyone who sent a message in it (typed in the
--     dashboard, or a campaign they run). The inbox shows a folder per
--     teammate (and per team) from it.
--   * conversations.last_sender_id: who sent the latest outgoing message, so
--     the chat list can say "Ali: …" instead of "You: …".
--   * inbox_folders(): conversation and unread counts per folder (RLS applies,
--     so everyone only counts the chats they can see).
-- ============================================================================

alter table public.conversations add column if not exists member_ids uuid[] not null default '{}';
alter table public.conversations add column if not exists last_sender_id uuid references public.profiles (id) on delete set null;
create index if not exists conversations_members_idx on public.conversations using gin (member_ids);

-- Who sent an outgoing message: the person who typed it, else the campaign's
-- creator, else (sent from the phone itself) the number's owner.
create or replace function public.message_sender(p_sent_by uuid, p_campaign uuid, p_account uuid)
returns uuid language sql stable security definer set search_path = ''
as $$
  select coalesce(
    p_sent_by,
    (select c.created_by from public.campaigns c where c.id = p_campaign),
    (select a.owner_id from public.whatsapp_accounts a where a.id = p_account)
  );
$$;
revoke execute on function public.message_sender(uuid, uuid, uuid) from public, anon, authenticated;

-- A new chat starts in the number owner's folder.
create or replace function public.conversations_set_members()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  owner uuid;
begin
  select a.owner_id into owner from public.whatsapp_accounts a where a.id = new.account_id;
  if owner is not null and not (owner = any (new.member_ids)) then
    new.member_ids := new.member_ids || owner;
  end if;
  return new;
end;
$$;
drop trigger if exists conversations_set_members on public.conversations;
create trigger conversations_set_members before insert on public.conversations
  for each row execute function public.conversations_set_members();

-- Sending a message puts the chat in the sender's folder.
create or replace function public.messages_track_sender()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid;
begin
  if new.direction <> 'out' or new.conversation_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.conversation_id is not distinct from new.conversation_id then
    return null;
  end if;
  uid := public.message_sender(new.sent_by, new.campaign_id, new.account_id);
  if uid is null then
    return null;
  end if;
  update public.conversations
     set member_ids = case when uid = any (member_ids) then member_ids else member_ids || uid end,
         last_sender_id = uid
   where id = new.conversation_id
     and (last_sender_id is distinct from uid or not (uid = any (member_ids)));
  return null;
end;
$$;
drop trigger if exists messages_track_sender on public.messages;
create trigger messages_track_sender after insert or update of conversation_id on public.messages
  for each row execute function public.messages_track_sender();

-- A number handed to someone else brings its chats into their folder too.
create or replace function public.wa_accounts_owner_to_conversations()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.owner_id is not null and new.owner_id is distinct from old.owner_id then
    update public.conversations
       set member_ids = member_ids || new.owner_id
     where account_id = new.id and not (new.owner_id = any (member_ids));
  end if;
  return null;
end;
$$;
drop trigger if exists wa_accounts_owner_to_conversations on public.whatsapp_accounts;
create trigger wa_accounts_owner_to_conversations after update of owner_id on public.whatsapp_accounts
  for each row execute function public.wa_accounts_owner_to_conversations();

-- Existing chats.
update public.conversations c
   set member_ids = coalesce((
         select array_agg(distinct s.uid)
         from (
           select a.owner_id as uid from public.whatsapp_accounts a where a.id = c.account_id
           union
           select public.message_sender(m.sent_by, m.campaign_id, m.account_id)
           from public.messages m
           where m.conversation_id = c.id and m.direction = 'out'
         ) s
         where s.uid is not null
       ), '{}'),
       last_sender_id = (
         select public.message_sender(m.sent_by, m.campaign_id, m.account_id)
         from public.messages m
         where m.conversation_id = c.id and m.direction = 'out'
         order by m.created_at desc
         limit 1
       );

-- Conversation and unread counts for all chats, per teammate folder and per
-- team folder (archived chats excluded).
create or replace function public.inbox_folders(p_workspace uuid)
returns table (kind text, id uuid, conversations integer, unread integer)
language sql stable set search_path = ''
as $$
  with c as (
    select c.id, c.member_ids, c.unread_count
    from public.conversations c
    where c.workspace_id = p_workspace and not c.archived
  )
  select 'all', null::uuid, count(*)::int, (count(*) filter (where c.unread_count > 0))::int
  from c
  union all
  select 'member', u.uid, count(*)::int, (count(*) filter (where c.unread_count > 0))::int
  from c cross join lateral unnest(c.member_ids) as u(uid)
  group by u.uid
  union all
  select 'team', tm.team_id, count(distinct c.id)::int, (count(distinct c.id) filter (where c.unread_count > 0))::int
  from c join public.team_members tm on tm.workspace_id = p_workspace and tm.user_id = any (c.member_ids)
  group by tm.team_id;
$$;
revoke execute on function public.inbox_folders(uuid) from public, anon;
