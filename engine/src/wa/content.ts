import { getContentType, isLidUser, isPnUser, normalizeMessageContent, type WAMessage, type WAMessageKey } from 'baileys';
import { jidToDigits } from '@batsols/shared';

export type MediaKind = 'image' | 'document' | 'video' | 'audio' | 'sticker' | 'other';

export interface ExtractedContent {
  text: string;
  mediaType: MediaKind | null;
  mediaName: string | null;
  mimetype: string | null;
}

const IGNORED = new Set([
  'protocolMessage',
  'reactionMessage',
  'senderKeyDistributionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'encReactionMessage',
  'messageContextInfo',
  'editedMessage',
  // System and status notices: nothing the lead typed, so never a reply.
  'fastRatchetKeySenderKeyDistributionMessage',
  'deviceSentMessage',
  'call',
  'callLogMesssage',
  'bcallMessage',
  'scheduledCallCreationMessage',
  'scheduledCallEditMessage',
  'placeholderMessage',
  'messageHistoryBundle',
  'messageHistoryNotice',
  'stickerSyncRmrMessage',
  'requestPhoneNumberMessage',
  'encEventResponseMessage',
  'encCommentMessage',
  'pollResultSnapshotMessage',
  'albumMessage',
  'associatedChildMessage',
  'statusMentionMessage',
  'groupStatusMentionMessage',
  'groupStatusMessage',
  'statusAddYours',
  'statusNotificationMessage',
  'statusQuestionAnswerMessage',
  'statusQuotedMessage',
  'statusStickerInteractionMessage',
  'limitSharingMessage',
  'botInvokeMessage',
  'botTaskMessage',
  'botForwardedMessage',
  'richResponseMessage',
  'secretEncryptedMessage',
  'newsletterAdminInviteMessage',
  'groupMentionedMessage',
]);

/** An emoji reaction to another message; emoji '' means the reaction was removed. */
export function extractReaction(msg: WAMessage): { targetId: string; emoji: string } | null {
  const r = normalizeMessageContent(msg.message)?.reactionMessage;
  if (!r?.key?.id) return null;
  return { targetId: r.key.id, emoji: r.text ?? '' };
}

/** Pull readable text and media info out of any WhatsApp message; null = not a user-visible message. */
export function extractContent(msg: WAMessage): ExtractedContent | null {
  const m = normalizeMessageContent(msg.message);
  if (!m) return null;
  const type = getContentType(m);
  if (!type || IGNORED.has(type)) return null;

  const out: ExtractedContent = { text: '', mediaType: null, mediaName: null, mimetype: null };
  switch (type) {
    case 'conversation':
      out.text = m.conversation ?? '';
      break;
    case 'extendedTextMessage':
      out.text = m.extendedTextMessage?.text ?? '';
      break;
    case 'imageMessage':
      out.mediaType = 'image';
      out.text = m.imageMessage?.caption ?? '';
      out.mimetype = m.imageMessage?.mimetype ?? 'image/jpeg';
      break;
    case 'videoMessage':
      out.mediaType = 'video';
      out.text = m.videoMessage?.caption ?? '';
      out.mimetype = m.videoMessage?.mimetype ?? 'video/mp4';
      break;
    case 'ptvMessage': // round video note
      out.mediaType = 'video';
      out.mimetype = m.ptvMessage?.mimetype ?? 'video/mp4';
      break;
    case 'audioMessage':
      out.mediaType = 'audio';
      out.mimetype = m.audioMessage?.mimetype ?? 'audio/ogg';
      break;
    case 'documentMessage':
      out.mediaType = 'document';
      out.text = m.documentMessage?.caption ?? '';
      out.mediaName = m.documentMessage?.fileName ?? 'Document';
      out.mimetype = m.documentMessage?.mimetype ?? 'application/octet-stream';
      break;
    case 'documentWithCaptionMessage': {
      const d = m.documentWithCaptionMessage?.message?.documentMessage;
      out.mediaType = 'document';
      out.text = d?.caption ?? '';
      out.mediaName = d?.fileName ?? 'Document';
      out.mimetype = d?.mimetype ?? 'application/octet-stream';
      break;
    }
    case 'stickerMessage':
      out.mediaType = 'sticker';
      out.mimetype = 'image/webp';
      break;
    case 'locationMessage':
    case 'liveLocationMessage': {
      const loc = m.locationMessage ?? m.liveLocationMessage;
      out.mediaType = 'other';
      out.text = `[Location] ${loc?.degreesLatitude ?? ''}, ${loc?.degreesLongitude ?? ''}`.trim();
      break;
    }
    case 'contactMessage':
      out.mediaType = 'other';
      out.text = `[Contact] ${m.contactMessage?.displayName ?? ''}`.trim();
      break;
    case 'contactsArrayMessage':
      out.mediaType = 'other';
      out.text = '[Contacts]';
      break;
    case 'buttonsResponseMessage':
      out.text = m.buttonsResponseMessage?.selectedDisplayText ?? '';
      break;
    case 'listResponseMessage':
      out.text = m.listResponseMessage?.title ?? m.listResponseMessage?.singleSelectReply?.selectedRowId ?? '';
      break;
    case 'templateButtonReplyMessage':
      out.text = m.templateButtonReplyMessage?.selectedDisplayText ?? '';
      break;
    case 'interactiveResponseMessage':
      out.text = m.interactiveResponseMessage?.body?.text ?? '';
      break;
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      out.mediaType = 'other';
      out.text = `[Poll] ${(m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3)?.name ?? ''}`.trim();
      break;
    default:
      out.mediaType = 'other';
      out.text = '';
  }
  if (!out.text && !out.mediaType) return null;
  return out;
}

/** Preview line for conversation lists. */
export function previewOf(c: ExtractedContent): string {
  if (c.text) return c.text;
  switch (c.mediaType) {
    case 'image':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Voice message';
    case 'document':
      return c.mediaName ?? 'Document';
    case 'sticker':
      return 'Sticker';
    default:
      return 'Message';
  }
}

/** Phone digits of the chat partner (handles WhatsApp's new LID addressing). */
export async function partnerDigits(
  key: WAMessageKey,
  lidToPn: (lid: string) => Promise<string | null>,
): Promise<string | null> {
  const jid = key.remoteJid ?? undefined;
  if (!jid) return null;
  if (isPnUser(jid)) return jidToDigits(jid);
  if (key.remoteJidAlt && isPnUser(key.remoteJidAlt)) return jidToDigits(key.remoteJidAlt);
  if (isLidUser(jid)) {
    const pn = await lidToPn(jid).catch(() => null);
    if (pn) return jidToDigits(pn);
  }
  return null;
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
};

export function mimeFromName(name: string | null | undefined): string {
  const ext = (name ?? '').split('?')[0]!.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

export function extFromMime(mime: string | null | undefined): string {
  const entry = Object.entries(EXT_MIME).find(([, m]) => m === mime);
  return entry?.[0] ?? (mime?.split('/')[1]?.split(';')[0] ?? 'bin');
}
