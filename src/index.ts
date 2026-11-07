import { accountWired, loadAccount, processAuth } from './account.ts';
import * as bot from './bot.ts';
import { APP_READY, TELEGRAM, TIMING, UCODE } from './config.ts';
import {
   bindByToken,
   chatByTelegramId,
   loadChats,
   loadDeals,
   markLost,
   migrate,
   openForNewDeals,
   processRequested,
   renewLinks,
   state,
   syncTitles,
} from './groups.ts';
import { receive, sendPending } from './messages.ts';
import { ensureKeys } from './secrets.ts';
import { listRows, str, UcodeError, updateRow } from './ucode.ts';

/* The fund's Telegram bot server (dashboard repo, docs/telegram.md): every
   new deal gets its group, every message of a group comes into the deal's
   journal, and what the team writes in «Чат и письма» goes to the group.
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
      const start = message.text?.match(START);
      if (start && (!start[1] || start[1].toLowerCase() === state.botUsername.toLowerCase())) {
         if (start[2] && !chatByTelegramId(chatId)) await bindByToken(chatId, start[2]);
         return;
      }
      await receive(message, Boolean(update.edited_message));
      return;
   }
   const member = update.my_chat_member;
   if (member && ['left', 'kicked'].includes(member.new_chat_member.status))
      await markLost(String(member.chat.id));
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
   if (!TELEGRAM.botToken || !UCODE.apiKey) {
      console.error('Set TELEGRAM_BOT_TOKEN and UCODE_API_KEY (.env.example).');
      process.exit(1);
   }
   const me = await bot.getMe();
   state.botUsername = me.username ?? '';
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

   void every(TIMING.heartbeatMs, heartbeat, 'heartbeat');
   void every(
      TIMING.dealsMs,
      async () => {
         await loadDeals();
         await openForNewDeals();
         await syncTitles();
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
         await renewLinks();
         await sendPending();
      },
      'queue',
   );
   await readUpdates();
};

void main();
