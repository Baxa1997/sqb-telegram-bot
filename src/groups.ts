import { randomBytes } from 'node:crypto';
import { accountWired, createGroup, floodWaitOf } from './account.ts';
import * as bot from './bot.ts';
import { TIMING } from './config.ts';
import { seedMembers } from './members.ts';
import { createRow, deleteRow, listRows, type Row, str, updateRow } from './ucode.ts';

/* The deals' groups (tg_chats, batch 26). Every deal made after the bot's
   server first ran gets one: the fund's account creates it, or, without the
   account, a person adds the bot to a group by the link the panel shows.
   The panel asks for one for an older deal, or again after a failure
   (`status` `requested`).
   Any other group the bot is added to opens too, as a chat of no deal
   (`created_via` `added`, batch 30), until the panel links it to a deal. */

export interface Deal {
   id: string;
   company: string;
   stage: string;
   logo: string;
   createdAt: string;
}

export const state = {
   botUsername: '',
   botId: 0,
   readsAll: false, // privacy mode is off: the bot sees all messages without being an admin
   since: '', // ISO: deals made after it get a group by themselves
   deals: new Map<string, Deal>(),
   chats: [] as Row[],
};

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text: string) => console.log(`[groups] ${text}`);

export const titleOf = (deal: Deal) => `Сделка: ${deal.company}`.slice(0, 128);

export const loadDeals = async () => {
   const rows = await listRows('deals');
   state.deals = new Map(
      rows.map((row) => [
         row.guid,
         {
            id: row.guid,
            company: str(row.company) || str(row.number) || 'без названия',
            stage: str(row.stage),
            logo: str(row.logo),
            createdAt: str(row.created_at),
         },
      ]),
   );
};

export const loadChats = async () => {
   state.chats = await listRows('tg_chats');
};

export const chatOfDeal = (dealId: string) =>
   state.chats.find((row) => str(row.deals_id) === dealId);

// The group a Telegram chat is, if it is one of the deals'.
export const chatByTelegramId = (chatId: string) =>
   state.chats.find(
      (row) => str(row.chat_id) === chatId && str(row.status) !== 'failed',
   );

const newToken = () => randomBytes(12).toString('base64url');
const expiry = () =>
   new Date(Date.now() + TIMING.linkDays * 86400000).toISOString();

// Each deal made since the server first ran, without a group yet, asks for one.
export const openForNewDeals = async () => {
   if (!state.since) return;
   const since = Date.parse(state.since);
   for (const deal of state.deals.values()) {
      if (chatOfDeal(deal.id) || !(Date.parse(deal.createdAt) > since)) continue;
      const guid = await createRow('tg_chats', {
         deals_id: deal.id,
         title: titleOf(deal),
         status: 'requested',
         requested_by_id: '',
      });
      state.chats.push({ guid, deals_id: deal.id, status: 'requested' });
      log(`new deal ${deal.company}: a group is asked for`);
   }
};

/* A group just made or linked: its name, description, the deal's logo, its
   invite link, a first message, and a line in the deal's history. Each step
   that fails (the bot lacks a right) is skipped, not fatal. */
const setUp = async (row: Row, deal: Deal, chatId: string, rename: boolean) => {
   const quietly = async (what: string, step: () => Promise<unknown>) => {
      try {
         await step();
      } catch (error) {
         log(`${deal.company}: ${what} skipped: ${(error as Error).message}`);
      }
   };
   if (rename) await quietly('title', () => bot.setChatTitle(chatId, titleOf(deal)));
   await quietly('description', () =>
      bot.setChatDescription(
         chatId,
         'Группа сделки фонда SQB Ventures. Сообщения группы сохраняются в платформе фонда.',
      ),
   );
   if (deal.logo)
      await quietly('photo', async () => {
         const response = await fetch(deal.logo, { signal: AbortSignal.timeout(30000) });
         if (!response.ok) throw new Error(`logo ${response.status}`);
         await bot.setChatPhoto(chatId, await response.blob());
      });
   await quietly('invite link', async () => {
      const link = await bot.exportInviteLink(chatId);
      await updateRow('tg_chats', { guid: row.guid, invite_link: link });
   });
   await quietly('first message', () =>
      bot.sendMessage(
         chatId,
         `Группа сделки «${bot.escapeHtml(deal.company)}» открыта. Всё, что пишут здесь, сохраняется в платформе фонда SQB Ventures, в разделе «Чат и письма»; ответы команды из платформы приходят сюда от бота.`,
      ),
   );
   await quietly('members', () => seedMembers({ ...row, chat_id: chatId }));
   await quietly('history', () =>
      createRow('deal_events', {
         kind: 'text',
         text: 'Открыта группа сделки в Telegram',
         at: now(),
         stage: deal.stage,
         deals_id: deal.id,
         employee_id: '',
      }),
   );
};

/* The groups asked for, one at a time: the fund's account makes each; without
   it, or when Telegram refuses, the deal waits for a person with the link. */
export const processRequested = async () => {
   // once the fund's account is linked, deals still waiting for a person's
   // link get their group from it too
   const asked =
      state.chats.find((row) => str(row.status) === 'requested') ??
      (accountWired() && state.botUsername
         ? state.chats.find((row) => str(row.status) === 'waiting_bot')
         : undefined);
   if (!asked) return;
   const deal = state.deals.get(str(asked.deals_id));
   if (!deal) return;
   const byLink = (error = '') =>
      updateRow('tg_chats', {
         guid: asked.guid,
         status: 'waiting_bot',
         link_token: newToken(),
         link_expires_at: expiry(),
         title: titleOf(deal),
         error,
      });

   if (!accountWired() || !state.botUsername) {
      await byLink();
      log(`${deal.company}: waiting for a person to add the bot by the link`);
      return;
   }
   await updateRow('tg_chats', { guid: asked.guid, status: 'creating' });
   try {
      const chatId = await createGroup(
         titleOf(deal),
         'Группа сделки фонда SQB Ventures.',
         state.botUsername,
      );
      await updateRow('tg_chats', {
         guid: asked.guid,
         chat_id: chatId,
         status: 'active',
         created_via: 'account',
         linked_at: now(),
         title: titleOf(deal),
         error: '',
      });
      // known at once: a message written in the first seconds is not lost
      Object.assign(asked, { chat_id: chatId, status: 'active' });
      log(`${deal.company}: group created by the fund's account`);
      await setUp(asked, deal, chatId, false);
      await sleep(TIMING.betweenGroupsMs);
   } catch (error) {
      const wait = floodWaitOf(error);
      if (wait) {
         // Telegram asks to slow down: the deal stays asked for
         await updateRow('tg_chats', { guid: asked.guid, status: 'requested' });
         log(`Telegram asks to wait ${wait} s before the next group`);
         await sleep(wait * 1000);
         return;
      }
      log(`${deal.company}: the account could not create the group: ${(error as Error).message}`);
      await byLink(`Аккаунт фонда не создал группу: ${(error as Error).message}`);
   }
};

// A link to add the bot that has run out gets a new one.
export const renewLinks = async () => {
   for (const row of state.chats)
      if (
         str(row.status) === 'waiting_bot' &&
         Date.parse(str(row.link_expires_at)) < Date.now()
      )
         await updateRow('tg_chats', {
            guid: row.guid,
            link_token: newToken(),
            link_expires_at: expiry(),
         });
};

/* `/start <token>` in a group: a person added the bot by a deal's link. The
   group becomes that deal's; a wrong or old link makes the bot leave, unless
   the group is already open in the panel without a deal. */
export const bindByToken = async (chatId: string, token: string) => {
   joined.delete(chatId); // the deal's link wins over a plain join
   await loadChats();
   const row = state.chats.find(
      (item) => str(item.link_token) === token && str(item.status) === 'waiting_bot',
   );
   const deal = row && state.deals.get(str(row.deals_id));
   const bound = chatByTelegramId(chatId);
   // a group open in the panel without a deal: it becomes the deal's
   const free = bound && !str(bound.deals_id) ? bound : undefined;
   if (bound && !free && bound.guid !== row?.guid) {
      await bot.sendMessage(chatId, 'Эта группа уже связана с другой сделкой фонда.');
      return;
   }
   if (!row || !deal || Date.parse(str(row.link_expires_at)) < Date.now()) {
      await bot.sendMessage(
         chatId,
         'Эта ссылка не подходит или устарела. Откройте новую в разделе «Чат и письма» платформы фонда.',
      );
      if (!free) await bot.leaveChat(chatId);
      return;
   }
   // the group's own row is kept, so its earlier messages stay with it
   const target = free ?? row;
   if (free) {
      await moveToDeal(free, deal);
      await deleteRow('tg_chats', row.guid);
   }
   await updateRow('tg_chats', {
      guid: target.guid,
      ...(free && { deals_id: deal.id }),
      chat_id: chatId,
      status: 'active',
      created_via: 'link',
      linked_at: now(),
      link_token: '',
      title: titleOf(deal),
      error: '',
   });
   log(`${deal.company}: group linked by a person`);
   await setUp(target, deal, chatId, true);
   await loadChats();
};

/* A group's messages, kept while it had no deal, go to the deal's journal
   with their files. */
const moveToDeal = async (row: Row, deal: Deal) => {
   const lines = (await listRows('deal_events', { tg_group_id: row.guid })).filter(
      (line) => !str(line.deals_id),
   );
   if (!lines.length) return;
   const ids = new Set(lines.map((line) => line.guid));
   const files = (await listRows('attachments', { section: 'chat' })).filter(
      (file) => ids.has(str(file.item_id)) && !str(file.deals_id),
   );
   for (const line of lines)
      await updateRow('deal_events', { guid: line.guid, deals_id: deal.id, stage: deal.stage });
   for (const file of files)
      await updateRow('attachments', { guid: file.guid, deals_id: deal.id });
   log(`${deal.company}: ${lines.length} earlier messages of the group moved to the deal`);
};

// ---- any group the bot is added to

const NOT_ADMIN =
   'Бот не администратор группы и видит только команды и ответы на свои сообщения. Сделайте его администратором в Telegram.';

/* Groups the bot joined, adopted a few seconds later: a deal's link sends
   `/start <token>` right after the join, and then the group is that deal's. */
const joined = new Map<string, { title: string; admin?: boolean; at: number }>();
const JOIN_WAIT_MS = 10_000;

// `admin` unknown (a service line about the join) keeps what was known.
export const noticeJoin = (chatId: string, title: string, admin?: boolean) => {
   const before = joined.get(chatId);
   joined.set(chatId, {
      title: title || before?.title || '',
      admin: admin ?? before?.admin,
      at: before?.at ?? Date.now(),
   });
};

// The row of a Telegram chat in any state, the active one first.
const rowOfChat = (chatId: string) =>
   chatByTelegramId(chatId) ?? state.chats.find((row) => str(row.chat_id) === chatId);

const hintOf = (admin: boolean) => (admin || state.readsAll ? '' : NOT_ADMIN);

const greet = async (chatId: string, admin: boolean, back: boolean) => {
   try {
      await bot.sendMessage(
         chatId,
         [
            back
               ? 'Бот фонда SQB Ventures снова в группе: её сообщения опять приходят в платформу фонда.'
               : 'Бот фонда SQB Ventures подключён. Сообщения этой группы видит команда фонда в своей платформе, в разделе «Чат и письма»; ответы команды приходят сюда от бота.',
            ...(hintOf(admin)
               ? ['Сделайте бота администратором группы: без этого он видит только команды и ответы на свои сообщения.']
               : []),
         ].join('\n\n'),
      );
   } catch (error) {
      log(`greeting skipped: ${(error as Error).message}`);
   }
};

/* The bot is in a group the panel does not show yet: by a plain «add member»,
   with or without the fund's account. It opens as a chat of no deal; one the
   bot had before (removed, or a deal still waiting for it) is open again. */
const adopt = async (chatId: string, title: string, admin?: boolean) => {
   const known = rowOfChat(chatId);
   if (known && ['active', 'creating', 'leaving'].includes(str(known.status))) return known;
   const rights =
      admin ?? (await bot.isAdmin(chatId, state.botId).catch(() => true));
   const error = hintOf(rights);
   if (known) {
      await updateRow('tg_chats', {
         guid: known.guid,
         status: 'active',
         link_token: '',
         linked_at: now(),
         error,
      });
      Object.assign(known, { status: 'active', link_token: '', error });
      log(`${str(known.title)}: the bot is in the group again`);
      await greet(chatId, rights, true);
      await seedMembers(known);
      return known;
   }
   const fields = {
      chat_id: chatId,
      title: (title || 'Группа в Telegram').slice(0, 128),
      status: 'active',
      created_via: 'added',
      linked_at: now(),
      requested_by_id: '',
      error,
   };
   const guid = await createRow('tg_chats', fields);
   const row: Row = { guid, ...fields };
   state.chats.push(row);
   log(`${fields.title}: the bot was added to the group, which opens in the panel`);
   try {
      const link = await bot.exportInviteLink(chatId);
      await updateRow('tg_chats', { guid, invite_link: link });
      row.invite_link = link;
   } catch (error) {
      log(`${fields.title}: no invite link: ${(error as Error).message}`);
   }
   await greet(chatId, rights, false);
   await seedMembers(row);
   return row;
};

export const adoptGroup = async (chatId: string, title: string, admin?: boolean) => {
   const row = await adopt(chatId, title, admin);
   joined.delete(chatId);
   return row;
};

// The groups joined a while ago that no deal's link took.
export const adoptJoined = async () => {
   for (const [chatId, join] of [...joined])
      if (Date.now() - join.at >= JOIN_WAIT_MS)
         await adoptGroup(chatId, join.title, join.admin);
};

/* The bot's rights changed in a group the panel shows: the hint to make it
   an admin comes and goes. False when the group is not open in the panel. */
export const noteRights = async (chatId: string, admin: boolean) => {
   const row = chatByTelegramId(chatId);
   if (!row || str(row.status) !== 'active') return false;
   if (admin) linkTried.delete(row.guid); // it may make the invite link now
   const error = hintOf(admin);
   const current = str(row.error);
   if (current !== error && (!current || current === NOT_ADMIN)) {
      await updateRow('tg_chats', { guid: row.guid, error });
      row.error = error;
   }
   return true;
};

/* An open group without its invite link: the panel emptied it for a new one
   (which cancels the old), or the bot could not make one. A refusal is not
   tried again until the bot's rights change; a group opened in the last
   minute is left to its own setting up. */
const linkTried = new Set<string>();
export const renewInvites = async () => {
   for (const row of state.chats) {
      if (str(row.status) !== 'active' || str(row.invite_link) || linkTried.has(row.guid)) continue;
      if (Date.now() - Date.parse(str(row.linked_at)) < 60_000) continue;
      try {
         const link = await bot.exportInviteLink(str(row.chat_id));
         await updateRow('tg_chats', { guid: row.guid, invite_link: link });
         row.invite_link = link;
         log(`${str(row.title)}: a new invite link`);
      } catch (error) {
         // no right to invite: wait for a change of rights; else the next round
         if (error instanceof bot.TelegramError && [400, 403].includes(error.code))
            linkTried.add(row.guid);
         log(`${str(row.title)}: no invite link: ${(error as Error).message}`);
      }
   }
};

// A group of no deal renamed in Telegram keeps its name in the panel.
export const renameFree = async (chatId: string, title: string) => {
   const row = chatByTelegramId(chatId);
   if (!row || str(row.deals_id) || !title) return;
   await updateRow('tg_chats', { guid: row.guid, title: title.slice(0, 128) });
   row.title = title;
};

/* The panel asked the bot to leave a group of no deal (`status` `leaving`):
   it says goodbye, leaves, and the row is `removed`. Added again later, the
   group opens again with its messages. */
export const processLeaving = async () => {
   for (const row of state.chats.filter((item) => str(item.status) === 'leaving')) {
      const chatId = str(row.chat_id);
      try {
         await bot.sendMessage(chatId, 'Бот фонда SQB Ventures отключён от этой группы.');
      } catch {
         // already out of it
      }
      try {
         await bot.leaveChat(chatId);
      } catch (error) {
         // Telegram's «not in the chat» or a bad request: it is out anyway
         if (!(error instanceof bot.TelegramError) || ![400, 403].includes(error.code))
            throw error;
      }
      await updateRow('tg_chats', { guid: row.guid, status: 'removed' });
      row.status = 'removed';
      log(`${str(row.title)}: the bot left the group, as the panel asked`);
   }
};

// The bot was removed from a group, or is not in it at all: the panel then
// offers «Подключить заново».
export const markLost = async (chatId: string, error = '') => {
   joined.delete(chatId); // added and taken out again within seconds
   const row = chatByTelegramId(chatId);
   if (!row || str(row.status) !== 'active') return;
   await updateRow('tg_chats', { guid: row.guid, status: 'lost', ...(error && { error }) });
   row.status = 'lost';
   log(`${str(row.title)}: the bot is no longer in the group`);
};

/* On start, each active group is asked whether this bot is in it. After a
   change of bot (a new TELEGRAM_BOT_TOKEN) the groups the old bot opened would
   otherwise look active while nothing reaches them. Other failures (Telegram
   unreachable) leave the group as it is. */
export const checkGroups = async () => {
   for (const row of state.chats.filter((item) => str(item.status) === 'active'))
      try {
         await bot.getChat(str(row.chat_id));
         await seedMembers(row);
      } catch (error) {
         if (bot.notInChat(error))
            await markLost(str(row.chat_id), 'Бота нет в этой группе: возможно, сменили бота');
      }
};

export const migrate = async (fromId: string, toId: string) => {
   const row = chatByTelegramId(fromId);
   if (!row) return;
   await updateRow('tg_chats', { guid: row.guid, chat_id: toId });
   row.chat_id = toId;
};

// A deal renamed in the panel renames its group.
export const syncTitles = async () => {
   for (const row of state.chats) {
      if (str(row.status) !== 'active') continue;
      const deal = state.deals.get(str(row.deals_id));
      if (!deal || titleOf(deal) === str(row.title)) continue;
      try {
         await bot.setChatTitle(str(row.chat_id), titleOf(deal));
      } catch (error) {
         log(`${deal.company}: not renamed: ${(error as Error).message}`);
         if (bot.notInChat(error)) await markLost(str(row.chat_id));
      }
      await updateRow('tg_chats', { guid: row.guid, title: titleOf(deal) });
   }
};
