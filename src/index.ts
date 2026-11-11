import { accountWired, loadAccount, processAuth } from './account.ts';
import * as bot from './bot.ts';
import { APP_READY, NEWS, TELEGRAM, TIMING, UCODE } from './config.ts';
import {
   adoptGroup,
   adoptJoined,
   bindByToken,
   chatByTelegramId,
   checkGroups,
   loadChats,
   loadDeals,
   markLost,
   migrate,
   noteRights,
   noticeJoin,
   openForNewDeals,
   processLeaving,
   processRequested,
   renameFree,
   renewInvites,
   renewLinks,
   state,
   syncTitles,
} from './groups.ts';
import { countMembers, members, noteMember, processRemovals } from './members.ts';
import { hasContent, receive, sendPending } from './messages.ts';
import { aiModel } from './news/ai.ts';
import { collectNews } from './news/index.ts';
import { ensureKeys } from './secrets.ts';
import { listRows, str, UcodeError, updateRow } from './ucode.ts';

/* The fund's Telegram bot server (dashboard repo, docs/telegram.md): every
   new deal gets its group, every message of a group comes into the deal's
   journal, and what the team writes in «Чат и письма» goes to the group.
   Any other group the bot is added to opens in «Чат и письма» too.
   It also collects the news for the website (src/news, docs/news.md).
   It reads Telegram by long polling and the panel's requests from ucode, so it
   needs no public address. Run exactly one copy per bot: Telegram gives a
   bot's updates to one reader only. */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const retryable = (error: unknown) =>
   (error instanceof UcodeError && error.retryable) ||
   (error instanceof bot.TelegramError && (error.code === 0 || error.code === 429 || error.code >= 500));

// The bot's state, for the panel: who it is, how groups open, that it runs.
const heartbeat = async () => {
   const [settings] = await listRows('fund_settings');
   if (!settings) return;
   const since = str(settings.telegram_since) || new Date().toISOString();
   state.since = since;
   await updateRow('fund_settings', {
      guid: settings.guid,
      telegram_bot: state.botUsername,
      telegram_mode: accountWired() ? 'account' : 'link',
      telegram_seen_at: new Date().toISOString(),
      telegram_since: since,
   });
};

const START = /^\/start(?:@(\w+))?(?:\s+(\S+))?/;

const handle = async (update: bot.TgUpdate) => {
   const message = update.message ?? update.edited_message;
   if (message) {
      const chatId = String(message.chat.id);
      if (message.chat.type === 'private') {
         if (!update.edited_message)
            await bot.sendMessage(
               chatId,
               'Это бот фонда SQB Ventures. Он работает в группах сделок: пишите в группу своей сделки.',
            );
         return;
      }
      if (message.migrate_to_chat_id) {
         await migrate(chatId, String(message.migrate_to_chat_id));
         return;
      }
      const known = chatByTelegramId(chatId);
      const open = str(known?.status) === 'active';
      const title = message.chat.title ?? '';
      const start = message.text?.match(START);
      if (start && (!start[1] || start[1].toLowerCase() === state.botUsername.toLowerCase())) {
         // a deal's link; a plain /start opens the group as one of no deal
         if (start[2] && !str(known?.deals_id)) await bindByToken(chatId, start[2]);
         else if (!open) await adoptGroup(chatId, title);
         return;
      }
      if (message.new_chat_title) await renameFree(chatId, message.new_chat_title);
      // who came and who left, as the group shows it
      if (open && known && (message.new_chat_members?.length || message.left_chat_member)) {
         for (const user of message.new_chat_members ?? []) await noteMember(known, user, 'member');
         if (message.left_chat_member) await noteMember(known, message.left_chat_member, 'left');
         await countMembers(known);
      }
      if (message.new_chat_members?.some(({ id }) => id === state.botId)) {
         if (!open) noticeJoin(chatId, title);
         return;
      }
      // the bot sees a group the panel does not show: it opens there now
      if (!open && hasContent(message)) {
         if (str(known?.status) === 'leaving' || str(known?.status) === 'removed') return;
         await adoptGroup(chatId, title);
      }
      await receive(message, Boolean(update.edited_message));
      // whoever writes is in the group
      const group = chatByTelegramId(chatId);
      if (group && str(group.status) === 'active' && message.from && !message.from.is_bot && !message.sender_chat)
         await noteMember(group, message.from);
      return;
   }
   // someone else joined, left, or changed rights (the bot is an admin)
   const change = update.chat_member;
   if (change) {
      const group = chatByTelegramId(String(change.chat.id));
      if (group && str(group.status) === 'active') {
         await noteMember(group, change.new_chat_member.user, change.new_chat_member.status);
         await countMembers(group);
      }
      return;
   }
   const member = update.my_chat_member;
   if (!member || !['group', 'supergroup'].includes(member.chat.type)) return;
   const chatId = String(member.chat.id);
   const status = member.new_chat_member.status;
   if (['left', 'kicked'].includes(status)) {
      await markLost(chatId);
      return;
   }
   // added, or its rights changed: a group not shown yet opens in a moment
   const admin = status === 'administrator' || status === 'creator';
   if (!(await noteRights(chatId, admin))) noticeJoin(chatId, member.chat.title ?? '', admin);
};

// Telegram's updates, one at a time; a failure that may pass keeps its place.
const readUpdates = async () => {
   let offset = 0;
   for (;;) {
      let updates: bot.TgUpdate[];
      try {
         updates = await bot.getUpdates(offset);
      } catch (error) {
         const conflict = error instanceof bot.TelegramError && error.code === 409;
         console.error(
            conflict
               ? '[updates] another copy of this bot is running (or a webhook is set): stop it'
               : `[updates] ${(error as Error).message}`,
         );
         await sleep(((error as bot.TelegramError).retryAfter || 5) * 1000);
         continue;
      }
      for (const update of updates) {
         try {
            await handle(update);
            offset = update.update_id + 1;
         } catch (error) {
            console.error(`[updates] ${(error as Error).message}`);
            if (retryable(error)) {
               await sleep(5000);
               break; // the same update comes again
            }
            offset = update.update_id + 1;
         }
      }
   }
};

// A task again and again, its failures logged and waited out.
const every = async (ms: number, task: () => Promise<void>, name: string) => {
   for (;;) {
      try {
         await task();
      } catch (error) {
         console.error(`[${name}] ${(error as Error).message}`);
      }
      await sleep(ms);
   }
};

const main = async () => {
   if (!UCODE.apiKey) {
      console.error('Set UCODE_API_KEY (.env.example).');
      process.exit(1);
   }
   // the news for the website, with or without Telegram (src/news)
   console.log(
      `[news] ${aiModel() ? `Claude (${aiModel()}) picks and summarises the articles` : 'no ANTHROPIC_API_KEY: articles are picked by keywords and the fund’s names'}`,
   );
   void every(NEWS.tickMs, collectNews, 'news');
   if (!TELEGRAM.botToken) {
      console.error('[bot] no TELEGRAM_BOT_TOKEN: the deals’ Telegram groups are off');
      return;
   }
   const me = await bot.getMe();
   state.botUsername = me.username ?? '';
   state.botId = me.id;
   members.botId = me.id;
   state.readsAll = me.can_read_all_group_messages === true;
   const [settings] = await listRows('fund_settings');
   if (settings) {
      await ensureKeys(settings, APP_READY);
      await loadAccount(settings);
   }
   console.log(
      `[bot] @${state.botUsername}: ${accountWired() ? "the fund's account creates each new deal's group" : 'no fund account yet: a person adds the bot to a group by the deal’s link, or the account is connected in Настройки → Интеграции'}`,
   );
   await heartbeat();
   await loadDeals();
   await loadChats();
   await checkGroups();

   void every(TIMING.heartbeatMs, heartbeat, 'heartbeat');
   void every(
      TIMING.dealsMs,
      async () => {
         await loadDeals();
         await openForNewDeals();
         await syncTitles();
         // the people the panel asked to remove from a group
         await processRemovals(state.chats);
      },
      'deals',
   );
   void every(
      TIMING.queueMs,
      async () => {
         // the fund account's sign-in steps from the panel, and its state
         const [settings] = await listRows('fund_settings');
         if (settings) {
            // the account as stored first: a sign-in finished below is
            // already newer than this read of the settings
            await loadAccount(settings);
            await processAuth(settings);
         }
         await loadChats();
         await processRequested();
         await adoptJoined();
         await processLeaving();
         await renewInvites();
         await renewLinks();
         await sendPending();
      },
      'queue',
   );
   await readUpdates();
};

void main();
