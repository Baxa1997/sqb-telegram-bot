import { MAX_DOWNLOAD, TELEGRAM } from './config.ts';

/* The Telegram Bot API (core.telegram.org/bots/api), the few methods this
   server uses, over plain HTTPS. The token is part of every address, so no
   address is ever logged. */

export class TelegramError extends Error {
   code: number;
   retryAfter: number; // seconds, on 429
   constructor(message: string, code: number, retryAfter = 0) {
      super(message);
      this.name = 'TelegramError';
      this.code = code;
      this.retryAfter = retryAfter;
   }
}

const BASE = 'https://api.telegram.org';

export const call = async <T>(
   method: string,
   params: Record<string, unknown> | FormData = {},
   timeoutMs = 30000,
): Promise<T> => {
   const form = params instanceof FormData;
   let reply: {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
   };
   try {
      const response = await fetch(`${BASE}/bot${TELEGRAM.botToken}/${method}`, {
         method: 'POST',
         headers: form ? undefined : { 'content-type': 'application/json' },
         body: form ? params : JSON.stringify(params),
         signal: AbortSignal.timeout(timeoutMs),
      });
      reply = (await response.json()) as typeof reply;
   } catch (error) {
      throw new TelegramError(`${method}: ${(error as Error).message}`, 0);
   }
   if (!reply.ok)
      throw new TelegramError(
         `${method}: ${reply.description ?? 'failed'}`,
         reply.error_code ?? 0,
         reply.parameters?.retry_after ?? 0,
      );
   return reply.result as T;
};

// ---- what the updates hold (only the fields read here)

export interface TgUser {
   id: number;
   is_bot: boolean;
   first_name: string;
   last_name?: string;
   username?: string;
}

export interface TgChat {
   id: number;
   type: 'private' | 'group' | 'supergroup' | 'channel';
   title?: string;
}

interface TgFileRef {
   file_id: string;
   file_size?: number;
   file_name?: string;
   mime_type?: string;
}

export interface TgMessage {
   message_id: number;
   date: number;
   chat: TgChat;
   from?: TgUser;
   sender_chat?: TgChat; // the group itself, for an anonymous admin
   text?: string;
   caption?: string;
   photo?: TgFileRef[];
   document?: TgFileRef;
   video?: TgFileRef;
   audio?: TgFileRef;
   voice?: TgFileRef;
   video_note?: TgFileRef;
   animation?: TgFileRef;
   sticker?: { emoji?: string };
   location?: unknown;
   contact?: { first_name: string; phone_number: string };
   poll?: { question: string };
   migrate_to_chat_id?: number;
   new_chat_members?: TgUser[];
   left_chat_member?: TgUser;
   new_chat_title?: string;
}

export interface TgChatMemberUpdated {
   chat: TgChat;
   new_chat_member: { status: string; user: TgUser };
}

export interface TgUpdate {
   update_id: number;
   message?: TgMessage;
   edited_message?: TgMessage;
   my_chat_member?: TgChatMemberUpdated;
}

// ---- the methods

export const getMe = () => call<TgUser>('getMe');

export const getUpdates = (offset: number) =>
   call<TgUpdate[]>(
      'getUpdates',
      {
         offset,
         timeout: 25,
         allowed_updates: ['message', 'edited_message', 'my_chat_member'],
      },
      40000,
   );

export const sendMessage = (chatId: string, html: string) =>
   call<TgMessage>('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
   });

export const sendDocument = (
   chatId: string,
   file: Blob,
   name: string,
   captionHtml: string,
) => {
   const form = new FormData();
   form.append('chat_id', chatId);
   form.append('document', file, name);
   if (captionHtml) {
      form.append('caption', captionHtml);
      form.append('parse_mode', 'HTML');
   }
   return call<TgMessage>('sendDocument', form, 120000);
};

export const setChatTitle = (chatId: string, title: string) =>
   call<boolean>('setChatTitle', { chat_id: chatId, title });

export const setChatPhoto = (chatId: string, photo: Blob) => {
   const form = new FormData();
   form.append('chat_id', chatId);
   form.append('photo', photo, 'logo.png');
   return call<boolean>('setChatPhoto', form, 60000);
};

export const setChatDescription = (chatId: string, description: string) =>
   call<boolean>('setChatDescription', { chat_id: chatId, description });

export const exportInviteLink = (chatId: string) =>
   call<string>('exportChatInviteLink', { chat_id: chatId });

export const leaveChat = (chatId: string) =>
   call<boolean>('leaveChat', { chat_id: chatId });

// A file of a message, if the Bot API lets the bot fetch it (20 MB).
export const downloadFile = async (fileId: string) => {
   const file = await call<{ file_path?: string; file_size?: number }>(
      'getFile',
      { file_id: fileId },
   );
   if (!file.file_path || (file.file_size ?? 0) > MAX_DOWNLOAD) return null;
   const response = await fetch(
      `${BASE}/file/bot${TELEGRAM.botToken}/${file.file_path}`,
      { signal: AbortSignal.timeout(120000) },
   );
   if (!response.ok) throw new TelegramError('file download failed', response.status);
   return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      path: file.file_path,
   };
};

// Text written into an HTML message: only these three need escaping.
export const escapeHtml = (text: string) =>
   text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
