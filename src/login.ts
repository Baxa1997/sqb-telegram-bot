import { createInterface } from 'node:readline/promises';
import { TELEGRAM } from './config.ts';

/* Signs the fund's Telegram account in, once, and prints its session for the
   server's settings (TELEGRAM_SESSION). Needs TELEGRAM_API_ID and
   TELEGRAM_API_HASH from my.telegram.org. The session is the whole account:
   put it in Vault, never in the repository or a chat. */

if (!TELEGRAM.apiId || !TELEGRAM.apiHash) {
   console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH first (my.telegram.org).');
   process.exit(1);
}

const gram = await import('telegram');
const sessions = (await import('telegram/sessions/index.js')) as unknown as {
   StringSession?: typeof import('telegram/sessions/index.js').StringSession;
   default?: { StringSession: typeof import('telegram/sessions/index.js').StringSession };
};
const StringSession = sessions.StringSession ?? sessions.default!.StringSession;
const TelegramClient =
   gram.TelegramClient ?? (gram as unknown as { default: typeof gram }).default.TelegramClient;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(''), TELEGRAM.apiId, TELEGRAM.apiHash, {
   connectionRetries: 3,
});
await client.start({
   phoneNumber: () => rl.question('Номер Telegram фонда (+998…): '),
   phoneCode: () => rl.question('Код из Telegram: '),
   password: () => rl.question('Пароль двухэтапной проверки: '),
   onError: (error) => console.error(error.message),
});
const session = (client.session as unknown as { save: () => string }).save();
console.log('\nВход выполнен. Положите это в настройки сервера (Vault), не в чат:\n');
console.log(`TELEGRAM_SESSION=${session}\n`);
rl.close();
await client.disconnect();
process.exit(0);
