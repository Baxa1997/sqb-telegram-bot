import * as bot from './bot.ts';
import { MAX_UPLOAD } from './config.ts';
import { chatByTelegramId, markLost, state } from './groups.ts';
import {
   createRow,
   getRow,
   guidOf,
   listRows,
   str,
   updateRow,
   uploadFile,
} from './ucode.ts';

/* A deal group's messages, both ways. Each is a line of the deal's journal
   (deal_events, kind `message`), the same as one written in the panel, so
   «Чат и письма» shows them together:
   - from Telegram: `source` telegram, its `author` and `tg_message_id`, its
     file in ucode Files and an `attachments` row (section chat);
   - from the panel: a line with `tg_state` pending is sent by the bot, signed
     with the employee's name, and becomes `sent` or `failed`. */

const log = (text: string) => console.log(`[messages] ${text}`);
const iso = (unix: number) => new Date(unix * 1000).toISOString();

const authorOf = (message: bot.TgMessage) => {
   if (message.sender_chat) return message.sender_chat.title ?? 'Администратор группы';
   const from = message.from;
   if (!from) return 'Telegram';
   const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
   return name || (from.username ? `@${from.username}` : 'Telegram');
};

// The message's file, the largest photo size for a photo.
const fileOf = (message: bot.TgMessage) => {
   const pick = (
      ref: { file_id: string; file_size?: number; file_name?: string } | undefined,
      kind: string,
   ) => (ref ? { ...ref, kind } : null);
   return (
      pick(message.document, 'document') ??
      pick(message.photo?.[message.photo.length - 1], 'photo') ??
      pick(message.video, 'video') ??
      pick(message.audio, 'audio') ??
      pick(message.voice, 'voice') ??
      pick(message.video_note, 'video_note') ??
      pick(message.animation, 'animation')
   );
};

// What a message without text or file says.
const otherText = (message: bot.TgMessage) =>
   message.sticker
      ? `Стикер ${message.sticker.emoji ?? ''}`.trim()
      : message.location
        ? 'Геопозиция'
        : message.contact
          ? `Контакт: ${message.contact.first_name}, ${message.contact.phone_number}`
          : message.poll
            ? `Опрос: ${message.poll.question}`
            : '';

// A message written in a deal's group comes into the deal's journal.
export const receive = async (message: bot.TgMessage, edited: boolean) => {
   const chatId = String(message.chat.id);
   const row = chatByTelegramId(chatId);
   // another bot's message is skipped; an anonymous admin's comes from the group itself
   if (!row || str(row.status) !== 'active' || (message.from?.is_bot && !message.sender_chat)) return;
   const dealId = str(row.deals_id);
   const telegramId = `${chatId}:${message.message_id}`;
   const guid = guidOf(telegramId);
   let text = message.text ?? message.caption ?? '';
   const file = fileOf(message);
   // a service line (the group made, a member joined) or a kind not kept
   if (!text && !file && !otherText(message)) return;

   if (edited) {
      if (await getRow('deal_events', guid)) await updateRow('deal_events', { guid, text });
      return;
   }
   if (await getRow('deal_events', guid)) return; // already in

   if (file) {
      const fileGuid = guidOf(`${telegramId}:file`);
      const downloaded = await bot.downloadFile(file.file_id);
      if (!downloaded) {
         text = `${text}\n[Файл больше 20 МБ: откройте его в группе в Telegram]`.trim();
      } else if (!(await getRow('attachments', fileGuid))) {
         const extension = downloaded.path.split('.').pop() ?? 'bin';
         const name = file.file_name || `${file.kind}_${message.message_id}.${extension}`;
         const stored = await uploadFile(new File([downloaded.bytes], name));
         await createRow('attachments', {
            guid: fileGuid,
            kind: 'file',
            title: name,
            url: stored.url,
            file_id: stored.id,
            section: 'chat',
            item_id: guid,
            deals_id: dealId,
            added_by_id: '',
            added_at: iso(message.date),
         });
      }
   }
   if (!text && !file) text = otherText(message);

   await createRow('deal_events', {
      guid,
      kind: 'message',
      text,
      at: iso(message.date),
      stage: state.deals.get(dealId)?.stage ?? '',
      deals_id: dealId,
      employee_id: '',
      source: 'telegram',
      author: authorOf(message),
      tg_message_id: telegramId,
   });
   log(`${str(row.title)}: a message from ${authorOf(message)} is in the platform`);
};

// ---- from the panel to Telegram

let names = new Map<string, string>();
let namesAt = 0;
const employeeName = async (id: string) => {
   if (Date.now() - namesAt > 5 * 60000) {
      const rows = await listRows('employees');
      names = new Map(
         rows.map((row) => [row.guid, str(row.full_name) || str(row.short_name)]),
      );
      namesAt = Date.now();
   }
   return names.get(id) ?? '';
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// how long a reply that Telegram could not take is tried again
const RETRY_MS = 30 * 60000;

// The panel's messages waiting to go to their deal's group.
export const sendPending = async () => {
   const pending = await listRows('deal_events', { tg_state: 'pending' });
   for (const line of pending) {
      const dealId = str(line.deals_id);
      const group = state.chats.find(
         (row) => str(row.deals_id) === dealId && str(row.status) === 'active',
      );
      if (!group) {
         await updateRow('deal_events', { guid: line.guid, tg_state: 'failed' });
         continue;
      }
      const chatId = str(group.chat_id);
      const name = (await employeeName(str(line.employee_id))) || 'Команда фонда';
      const header = `<b>${bot.escapeHtml(name)}</b> · SQB Ventures`;
      const text = str(line.text);
      const files = (await listRows('attachments', { item_id: line.guid })).filter(
         (row) => str(row.section) === 'chat',
      );
      let firstId = 0;
      try {
         if (text) {
            const sent = await bot.sendMessage(chatId, `${header}\n${bot.escapeHtml(text)}`);
            firstId = sent.message_id;
         }
         for (const file of files) {
            const title = str(file.title) || 'file';
            const response = await fetch(str(file.url), {
               signal: AbortSignal.timeout(120000),
            });
            const blob = response.ok ? await response.blob() : null;
            const sent =
               blob && blob.size <= MAX_UPLOAD
                  ? await bot.sendDocument(chatId, blob, title, text ? '' : header)
                  : await bot.sendMessage(
                       chatId,
                       `${header}\n📎 <a href="${bot.escapeHtml(str(file.url))}">${bot.escapeHtml(title)}</a>`,
                    );
            firstId ||= sent.message_id;
         }
         await updateRow('deal_events', {
            guid: line.guid,
            tg_state: 'sent',
            tg_message_id: `${chatId}:${firstId}`,
         });
      } catch (error) {
         if (error instanceof bot.TelegramError && error.code === 429) {
            log(`Telegram asks to wait ${error.retryAfter} s`);
            await sleep(error.retryAfter * 1000);
            return; // the rest stay pending
         }
         /* Telegram or the network failed for a moment and nothing went out:
            the line stays pending and goes on the next round, for up to
            RETRY_MS; a part already sent is not sent twice. */
         const passing =
            !(error instanceof bot.TelegramError) || error.code === 0 || error.code >= 500;
         if (passing && !firstId && Date.now() - Date.parse(str(line.at)) < RETRY_MS) {
            log(`not sent to ${str(group.title)} yet, tried again shortly: ${(error as Error).message}`);
            return;
         }
         log(`not sent to ${str(group.title)}: ${(error as Error).message}`);
         await updateRow('deal_events', { guid: line.guid, tg_state: 'failed' });
         if (bot.notInChat(error)) await markLost(chatId);
      }
   }
};
