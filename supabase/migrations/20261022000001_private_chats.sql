-- ============================================================================
-- Private WhatsApp chats
--
--   * Owners and admins see every chat with leads.
--   * Everyone else sees only their own chats: chats on their own WhatsApp
--     numbers and chats they sent a message in (conversations.member_ids).
--     They no longer see admins' or other members' chats, even on shared
--     numbers or with leads they can see.
--   * Messages follow their chat.
-- Safe to run more than once.
-- ============================================================================

-- The caller's own chat (or an admin): used by the messages policy.
create or replace function public.can_view_conversation(cid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = cid
      and public.is_member(c.workspace_id)
      and (
        public.is_admin(c.workspace_id)
        or (select auth.uid()) = any (c.member_ids)
        or exists (select 1 from public.whatsapp_accounts a where a.id = c.account_id and a.owner_id = (select auth.uid()))
      )
  );
$$;
revoke execute on function public.can_view_conversation(uuid) from public, anon;

drop policy if exists "conversations: visible" on public.conversations;
drop policy if exists "conversations: own or admin" on public.conversations;
create policy "conversations: own or admin" on public.conversations
  for select to authenticated using (
    public.is_admin(workspace_id)
    or (
      public.is_member(workspace_id)
      and (
        (select auth.uid()) = any (member_ids)
        or exists (select 1 from public.whatsapp_accounts a where a.id = account_id and a.owner_id = (select auth.uid()))
      )
    )
  );

drop policy if exists "conversations: writers update visible" on public.conversations;
drop policy if exists "conversations: writers update own or admin" on public.conversations;
create policy "conversations: writers update own or admin" on public.conversations
  for update to authenticated
  using (
    public.can_write(workspace_id)
    and (
      public.is_admin(workspace_id)
      or (select auth.uid()) = any (member_ids)
      or exists (select 1 from public.whatsapp_accounts a where a.id = account_id and a.owner_id = (select auth.uid()))
    )
  )
  with check (public.can_write(workspace_id));

drop policy if exists "messages: visible" on public.messages;
drop policy if exists "messages: own chats or admin" on public.messages;
create policy "messages: own chats or admin" on public.messages
  for select to authenticated using (
    public.is_admin(workspace_id)
    or (
      public.is_member(workspace_id)
      and (
        (conversation_id is not null and public.can_view_conversation(conversation_id))
        -- Typed in the dashboard and still waiting for the engine (no chat yet).
        or (conversation_id is null and sent_by = (select auth.uid()))
        or (conversation_id is null and exists (select 1 from public.whatsapp_accounts a where a.id = account_id and a.owner_id = (select auth.uid())))
      )
    )
  );
