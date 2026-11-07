import QRCode from 'qrcode';
import type { TelegramClient } from 'telegram';
import { ACCOUNT_IN_ENV, APP_READY, TELEGRAM } from './config.ts';
import { fromJson, openFromPanel, seal, unseal } from './secrets.ts';
import { type Row, str, updateRow } from './ucode.ts';

/* The fund's own Telegram account, over MTProto with GramJS: a bot cannot
   create a group (no Bot API method does), a user account can. It makes the
   deal's supergroup, adds the fund's bot and makes it an admin; the bot does
   the rest. The account stays the group's owner, so the fund keeps every
   group whoever leaves the team.

   It is linked from the panel by a QR code, the way Telegram Desktop signs
   in (core.telegram.org/api/qr-login): the panel asks (fund_settings.
   telegram_auth), this server shows a login token as a QR code, and the
   fund's phone scans it in Telegram → Settings → Devices → Link Desktop
   Device. The app's api_id and api_hash are ours, in this server's settings,
   so the fund types none. The session is then kept in
   fund_settings.telegram_account, sealed (src/secrets.ts). The server's
   settings can give a session instead (TELEGRAM_SESSION). */

interface Credentials {
   apiId: number;
   apiHash: string;
   session: string;
}

let credentials: Credentials | null = ACCOUNT_IN_ENV
   ? { apiId: TELEGRAM.apiId, apiHash: TELEGRAM.apiHash, session: TELEGRAM.session }
   : null;
let storedAccount = ''; // the fund_settings value they were read from
let client: TelegramClient | null = null;

const log = (text: string) => console.log(`[account] ${text}`);

// GramJS is CommonJS: its classes, whichever way Node hands them over.
const gramjs = async () => {
   const gram = await import('telegram');
   const sessions = (await import('telegram/sessions/index.js')) as unknown as {
      StringSession?: typeof import('telegram/sessions/index.js').StringSession;
      default?: { StringSession: typeof import('telegram/sessions/index.js').StringSession };
   };
   const base = (gram as unknown as { default?: typeof gram }).default ?? gram;
   return {
      TelegramClient: gram.TelegramClient ?? base.TelegramClient,
      Api: gram.Api ?? base.Api,
      StringSession: sessions.StringSession ?? sessions.default!.StringSession,
   };
};

const newClient = async (session: string) => {
   const { TelegramClient, StringSession } = await gramjs();
   const next = new TelegramClient(
      new StringSession(session),
      TELEGRAM.apiId,
      TELEGRAM.apiHash,
      { connectionRetries: 5, deviceModel: 'SQB Ventures', appVersion: 'deal groups' },
   );
   next.setLogLevel('error' as never);
   await next.connect();
   return next;
};

export const accountWired = () => credentials !== null;

/* The account kept in ucode, read again when it changed: linked or unlinked
   from the panel. */
export const loadAccount = async (settings: Row) => {
   if (ACCOUNT_IN_ENV) return;
   const value = str(settings.telegram_account);
   if (value === storedAccount) return;
   storedAccount = value;
   const stored = fromJson<{ session?: string }>(value, {});
   await client?.disconnect().catch(() => undefined);
   client = null;
   try {
      credentials =
         APP_READY && stored.session
            ? { apiId: TELEGRAM.apiId, apiHash: TELEGRAM.apiHash, session: unseal(stored.session) }
            : null;
   } catch {
      credentials = null;
      log('the stored account was sealed under another TELEGRAM_SECRET: link it again');
   }
   log(credentials ? 'the fund account is linked' : 'no fund account');
};

const connect = async () => {
   if (client) return client;
   if (!credentials) throw new Error('the fund account is not linked');
   const next = await newClient(credentials.session);
   if (!(await next.checkAuthorization())) {
      await next.disconnect();
      throw new Error('the fund account was signed out: link it again');
   }
   client = next;
   return client;
};

// Seconds to wait when Telegram asks to slow down, or 0.
export const floodWaitOf = (error: unknown) =>
   typeof (error as { seconds?: unknown })?.seconds === 'number'
      ? (error as { seconds: number }).seconds
      : 0;

/* Makes the group and returns its id as the Bot API writes it (-100…). The
   bot is added by its username and made an admin with the rights it needs:
   rename, photo, invite links, remove people, pin and delete messages. */
export const createGroup = async (title: string, about: string, botUsername: string) => {
   const tg = await connect();
   const { Api } = await gramjs();
   const created = (await tg.invoke(
      new Api.channels.CreateChannel({ title, about, megagroup: true }),
   )) as { chats?: { id: { toString(): string } }[] };
   const channel = created.chats?.[0];
   if (!channel) throw new Error('Telegram returned no group');
   const peer = await tg.getInputEntity(channel as never);
   await tg.invoke(new Api.channels.InviteToChannel({ channel: peer, users: [botUsername] }));
   await tg.invoke(
      new Api.channels.EditAdmin({
         channel: peer,
         userId: botUsername,
         adminRights: new Api.ChatAdminRights({
            changeInfo: true,
            deleteMessages: true,
            banUsers: true,
            inviteUsers: true,
            pinMessages: true,
            manageCall: true,
            other: true,
         }),
         rank: 'SQB Ventures',
      }),
   );
   return `-100${channel.id.toString()}`;
};

// ---- linking it from the panel

/* The steps, in fund_settings.telegram_auth:
     panel → qr_start                → server: qr {qr (SVG), expires}, a new code every ~30 s
     the phone scans it              → server: done, or password_needed {hint}
     panel → password {password, encrypted with the server's key} → server: done,
                                       or password_needed {error} to try again
     panel → cancel / logout         → server: idle
   A failure answers error {error}; the panel offers to start again. */
interface AuthStep {
   step?: string;
   password?: string;
   qr?: string;
   expires?: string;
   hint?: string;
   error?: string;
}

let linking: { client: TelegramClient; cancelled: boolean } | null = null;
let passwordWaiter: ((password: string) => void) | null = null;

const answer = (settings: Row, step: AuthStep) =>
   updateRow('fund_settings', {
      guid: settings.guid,
      telegram_auth: JSON.stringify({ ...step, at: new Date().toISOString() }),
   });

const masked = (phone: string) =>
   phone ? `+${phone.replace(/^\+/, '').replace(/^(\d{3})\d+(\d{2})$/, '$1•••••$2')}` : '';

const errorCode = (error: unknown) => (error as { errorMessage?: string })?.errorMessage ?? '';

// Why Telegram refused, in the panel's words.
const reasonOf = (error: unknown) => {
   const reasons: Record<string, string> = {
      PASSWORD_HASH_INVALID: 'Пароль двухэтапной проверки неверный.',
      AUTH_TOKEN_EXPIRED: 'QR-код устарел: откройте новый.',
      API_ID_INVALID: 'Ключи приложения Telegram на сервере неверные: их меняет разработчик.',
   };
   const wait = floodWaitOf(error);
   if (wait) return `Telegram просит подождать ${Math.ceil(wait / 60)} мин.`;
   return reasons[errorCode(error)] ?? (errorCode(error) || (error as Error)?.message || 'Не удалось войти.');
};

const stopLinking = async () => {
   if (!linking) return;
   linking.cancelled = true;
   passwordWaiter = null;
   await linking.client.disconnect().catch(() => undefined);
   linking = null;
};

// The account linked: its session kept, sealed, and used from now on.
const finish = async (settings: Row, tg: TelegramClient) => {
   const me = (await tg.getMe()) as { phone?: string };
   const session = (tg.session as unknown as { save: () => string }).save();
   const value = JSON.stringify({
      phone: masked(str(me.phone)),
      session: seal(session),
      connectedAt: new Date().toISOString(),
   });
   await updateRow('fund_settings', { guid: settings.guid, telegram_account: value });
   credentials = { apiId: TELEGRAM.apiId, apiHash: TELEGRAM.apiHash, session };
   storedAccount = value;
   await client?.disconnect().catch(() => undefined);
   client = tg;
   linking = null;
   await answer(settings, { step: 'done' });
   log('the fund account is linked from the panel');
};

const startLinking = async (settings: Row) => {
   await stopLinking();
   if (!APP_READY)
      return answer(settings, {
         step: 'error',
         error: 'На сервере бота не заданы ключи приложения Telegram (TELEGRAM_API_ID, TELEGRAM_API_HASH): их добавляет разработчик.',
      });
   const tg = await newClient('');
   const current = { client: tg, cancelled: false };
   linking = current;
   let hint = '';
   void tg
      .signInUserWithQrCode(
         { apiId: TELEGRAM.apiId, apiHash: TELEGRAM.apiHash },
         {
            qrCode: async ({ token, expires }) => {
               if (current.cancelled) return;
               const link = `tg://login?token=${token.toString('base64url')}`;
               const qr = await QRCode.toString(link, { type: 'svg', margin: 1, width: 240 });
               await answer(settings, {
                  step: 'qr',
                  qr,
                  expires: new Date(expires * 1000).toISOString(),
               });
            },
            password: async (passwordHint) => {
               hint = passwordHint ?? '';
               await answer(settings, { step: 'password_needed', hint });
               return new Promise<string>((resolve) => {
                  passwordWaiter = resolve;
               });
            },
            onError: async (error) => {
               if (current.cancelled) return true;
               if (errorCode(error) === 'PASSWORD_HASH_INVALID') {
                  // the person types it again
                  await answer(settings, { step: 'password_needed', hint, error: reasonOf(error) });
                  return false;
               }
               log(`linking failed: ${reasonOf(error)}`);
               await answer(settings, { step: 'error', error: reasonOf(error) });
               return true;
            },
         },
      )
      .then(() => (current.cancelled ? undefined : finish(settings, tg)))
      .catch(async (error: unknown) => {
         if (current.cancelled) return;
         log(`linking failed: ${reasonOf(error)}`);
         await answer(settings, { step: 'error', error: reasonOf(error) });
         await stopLinking();
      });
   await answer(settings, { step: 'qr_waiting' });
};

export const processAuth = async (settings: Row) => {
   const auth = fromJson<AuthStep>(settings.telegram_auth, {});
   try {
      switch (auth.step) {
         case 'qr_start':
            await startLinking(settings);
            return;
         case 'password': {
            if (!passwordWaiter)
               return answer(settings, { step: 'error', error: 'Сервер бота перезапускался: откройте QR-код заново.' });
            const resolve = passwordWaiter;
            passwordWaiter = null;
            await answer(settings, { step: 'password_checking' });
            resolve(openFromPanel(str(auth.password)));
            return;
         }
         case 'cancel':
            await stopLinking();
            await answer(settings, { step: 'idle' });
            return;
         case 'logout': {
            if (ACCOUNT_IN_ENV)
               return answer(settings, {
                  step: 'error',
                  error: 'Аккаунт задан в настройках сервера: его отключает разработчик.',
               });
            const { Api } = await gramjs();
            await connect()
               .then((tg) => tg.invoke(new Api.auth.LogOut()))
               .catch(() => undefined);
            await client?.disconnect().catch(() => undefined);
            client = null;
            credentials = null;
            storedAccount = '';
            await updateRow('fund_settings', { guid: settings.guid, telegram_account: '' });
            await answer(settings, { step: 'idle' });
            log('the fund account is unlinked from the panel');
            return;
         }
         default:
            return; // idle, or waiting for the phone or the panel
      }
   } catch (error) {
      log(`linking step ${auth.step} failed: ${reasonOf(error)}`);
      await answer(settings, { step: 'error', error: reasonOf(error) });
   }
};
