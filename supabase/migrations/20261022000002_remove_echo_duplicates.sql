-- ============================================================================
-- Remove duplicate copies of sent messages
--
-- WhatsApp reports every message we send back to us. Until now the engine
-- could save that report as a second "sent from the phone" message before the
-- original was saved, so messages typed in the dashboard (or sent by a
-- campaign) showed twice in the chat. The engine no longer does that; this
-- removes the copies already saved: an outgoing message with no sender and no
-- campaign, in the same chat as a dashboard/campaign message with the same
-- text, sent within 3 minutes of it. Safe to run more than once.
-- ============================================================================

delete from public.messages echo
using public.messages original
where echo.direction = 'out'
  and echo.sent_by is null
  and echo.campaign_id is null
  and echo.conversation_id is not null
  and original.id <> echo.id
  and original.conversation_id = echo.conversation_id
  and original.direction = 'out'
  and (original.sent_by is not null or original.campaign_id is not null)
  and original.body = echo.body
  and coalesce(original.media_type, '') = coalesce(echo.media_type, '')
  and abs(extract(epoch from (original.created_at - echo.created_at))) < 180;
