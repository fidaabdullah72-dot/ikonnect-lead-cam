-- ============================================================================
-- Assignment notifications
--
--   * Assigning a campaign (or sharing a list, number, automation or template)
--     with a teammate or a team now notifies those people, with a link to it.
--     The person who assigned it is not notified, nor are inactive members.
-- Safe to run more than once.
-- ============================================================================

create or replace function public.resource_access_notify()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_name text;
  v_title text;
  v_link text;
  v_by text;
begin
  case new.resource_type
    when 'campaign' then
      select name into v_name from public.campaigns where id = new.resource_id;
      v_title := 'Campaign assigned to you';
      v_link := '/campaigns/' || new.resource_id;
    when 'lead_list' then
      select name into v_name from public.lead_lists where id = new.resource_id;
      v_title := 'Lead list shared with you';
      v_link := '/leads?list=' || new.resource_id;
    when 'whatsapp_account' then
      select label into v_name from public.whatsapp_accounts where id = new.resource_id;
      v_title := 'WhatsApp number shared with you';
      v_link := '/whatsapp';
    when 'automation' then
      select name into v_name from public.automations where id = new.resource_id;
      v_title := 'Automation shared with you';
      v_link := '/automations';
    when 'template' then
      select name into v_name from public.message_templates where id = new.resource_id;
      v_title := 'Template shared with you';
      v_link := '/templates';
    else
      return null;
  end case;
  select coalesce(nullif(btrim(p.full_name), ''), p.email) into v_by from public.profiles p where p.id = new.granted_by;

  insert into public.notifications (workspace_id, user_id, type, title, body, link)
  select new.workspace_id, m.user_id, 'assigned', v_title,
         concat_ws(' · ', v_name, 'by ' || v_by,
                   case when new.access = 'manage' then 'you can run and edit it' else 'you can follow its progress' end),
         v_link
  from public.workspace_members m
  where m.workspace_id = new.workspace_id
    and m.active
    and m.user_id is distinct from new.granted_by
    and (m.user_id = new.user_id
         or (new.team_id is not null and m.user_id in (select tm.user_id from public.team_members tm where tm.team_id = new.team_id)));
  return null;
end;
$$;
revoke execute on function public.resource_access_notify() from public, anon, authenticated;

drop trigger if exists resource_access_notify on public.resource_access;
create trigger resource_access_notify after insert on public.resource_access
  for each row execute function public.resource_access_notify();
