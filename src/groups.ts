import { randomBytes } from 'node:crypto';
import { accountWired, createGroup, floodWaitOf } from './account.ts';
import * as bot from './bot.ts';
import { TIMING } from './config.ts';
import { createRow, listRows, type Row, str, updateRow } from './ucode.ts';

/* The deals' groups (tg_chats, batch 26). Every deal made after the bot's
   server first ran gets one: the fund's account creates it, or, without the
   account, a person adds the bot to a group by the link the panel shows.
   The panel asks for one for an older deal, or again after a failure
   (`status` `requested`). */

export interface Deal {
   id: string;
   company: string;
   stage: string;
   logo: string;
   createdAt: string;
}

export const state = {
   botUsername: '',
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
   group becomes that deal's; a wrong or old link makes the bot leave. */
export const bindByToken = async (chatId: string, token: string) => {
   await loadChats();
   const row = state.chats.find(
      (item) => str(item.link_token) === token && str(item.status) === 'waiting_bot',
   );
   const deal = row && state.deals.get(str(row.deals_id));
   const bound = chatByTelegramId(chatId);
   if (bound && bound.guid !== row?.guid) {
      await bot.sendMessage(chatId, 'Эта группа уже связана с другой сделкой фонда.');
      return;
   }
   if (!row || !deal || Date.parse(str(row.link_expires_at)) < Date.now()) {
      await bot.sendMessage(
         chatId,
         'Эта ссылка не подходит или устарела. Откройте новую в разделе «Чат и письма» платформы фонда.',
      );
      await bot.leaveChat(chatId);
      return;
   }
   await updateRow('tg_chats', {
      guid: row.guid,
      chat_id: chatId,
      status: 'active',
      created_via: 'link',
      linked_at: now(),
      link_token: '',
      title: titleOf(deal),
      error: '',
   });
   log(`${deal.company}: group linked by a person`);
   await setUp(row, deal, chatId, true);
   await loadChats();
};

// The bot was removed from a group, or the group became a supergroup.
export const markLost = async (chatId: string) => {
   const row = chatByTelegramId(chatId);
   if (!row || str(row.status) !== 'active') return;
   await updateRow('tg_chats', { guid: row.guid, status: 'lost' });
   log(`${str(row.title)}: the bot is no longer in the group`);
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
      }
      await updateRow('tg_chats', { guid: row.guid, title: titleOf(deal) });
   }
};
