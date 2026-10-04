export interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly language_code?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: 'private' | 'group' | 'supergroup' | 'channel';
  readonly title?: string;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
}

export interface TelegramDocument {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

export interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly date: number;
  readonly text?: string;
  readonly document?: TelegramDocument;
  readonly photo?: readonly TelegramPhotoSize[];
  readonly caption?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

export type TelegramMessageType = 'text' | 'document' | 'photo' | 'unknown';

export interface TelegramBotEvent {
  readonly update_id: number;
  readonly message_id: number;
  readonly chat_id: number;
  readonly user_id: number;
  readonly user_display_name: string;
  readonly message_type: TelegramMessageType;
  readonly text?: string;
  readonly document?: TelegramDocument;
  readonly photo?: readonly TelegramPhotoSize[];
  readonly caption?: string;
  readonly timestamp: number;
  readonly reply_to_message_id?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function validateTelegramUpdate(
  payload: unknown
): { ok: true; value: TelegramBotEvent } | { ok: false; reason: string } {
  if (!isObject(payload)) return { ok: false, reason: 'not_object' };

  const updateId = payload.update_id;
  if (!isPositiveInt(updateId)) return { ok: false, reason: 'invalid_update_id' };

  const msg = payload.message;
  if (!isObject(msg)) return { ok: false, reason: 'no_message' };

  const messageId = msg.message_id;
  if (!isPositiveInt(messageId)) return { ok: false, reason: 'invalid_message_id' };

  const chat = msg.chat;
  if (!isObject(chat)) return { ok: false, reason: 'no_chat' };
  const chatId = chat.id;
  if (typeof chatId !== 'number' || !Number.isInteger(chatId)) {
    return { ok: false, reason: 'invalid_chat_id' };
  }

  const from = msg.from;
  if (!isObject(from)) return { ok: false, reason: 'no_from' };
  const userId = from.id;
  if (!isPositiveInt(userId)) return { ok: false, reason: 'invalid_user_id' };

  const firstName = typeof from.first_name === 'string' ? from.first_name : '';
  const lastName = typeof from.last_name === 'string' ? from.last_name : '';
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || `user_${userId}`;

  const date = msg.date;
  if (typeof date !== 'number') return { ok: false, reason: 'invalid_date' };

  let messageType: TelegramMessageType = 'unknown';
  let document: TelegramDocument | undefined;
  let photo: readonly TelegramPhotoSize[] | undefined;

  if (isObject(msg.document)) {
    const doc = msg.document;
    if (typeof doc.file_id !== 'string' || typeof doc.file_unique_id !== 'string') {
      return { ok: false, reason: 'invalid_document' };
    }
    messageType = 'document';
    document = {
      file_id: doc.file_id,
      file_unique_id: doc.file_unique_id,
      ...(typeof doc.file_name === 'string' ? { file_name: doc.file_name } : {}),
      ...(typeof doc.mime_type === 'string' ? { mime_type: doc.mime_type } : {}),
      ...(typeof doc.file_size === 'number' ? { file_size: doc.file_size } : {}),
    };
  } else if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    messageType = 'photo';
    photo = msg.photo as readonly TelegramPhotoSize[];
  } else if (typeof msg.text === 'string') {
    messageType = 'text';
  }

  let replyToMessageId: number | undefined;
  if (isObject(msg.reply_to_message)) {
    const rtm = msg.reply_to_message;
    if (isPositiveInt(rtm.message_id)) {
      replyToMessageId = rtm.message_id;
    }
  }

  return {
    ok: true,
    value: {
      update_id: updateId,
      message_id: messageId,
      chat_id: chatId,
      user_id: userId,
      user_display_name: displayName,
      message_type: messageType,
      ...(typeof msg.text === 'string' ? { text: msg.text } : {}),
      ...(document ? { document } : {}),
      ...(photo ? { photo } : {}),
      ...(typeof msg.caption === 'string' ? { caption: msg.caption } : {}),
      timestamp: date,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    },
  };
}
