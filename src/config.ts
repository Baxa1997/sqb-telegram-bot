/* The bot server's settings, from the environment (.env.example). Read once
   when it starts; nothing here is ever printed. */

const env = (name: string, fallback = '') =>
   process.env[name]?.trim() || fallback;

export const TELEGRAM = {
   botToken: env('TELEGRAM_BOT_TOKEN'),
   // seals what the server keeps in ucode (src/secrets.ts); keep it the same
   secret: env('TELEGRAM_SECRET'),
   apiId: Number(env('TELEGRAM_API_ID')) || 0,
   apiHash: env('TELEGRAM_API_HASH'),
   session: env('TELEGRAM_SESSION'),
};

// Our Telegram app (my.telegram.org): with it the fund's account is linked
// from the panel by a QR code (src/account.ts).
export const APP_READY = Boolean(TELEGRAM.apiId && TELEGRAM.apiHash);

// The fund's account given in the server's settings instead.
export const ACCOUNT_IN_ENV = Boolean(APP_READY && TELEGRAM.session);

export const UCODE = {
   baseUrl: env('UCODE_BASE_URL', 'https://api.client.u-code.io').replace(
      /\/+$/,
      '',
   ),
   apiKey: env('UCODE_API_KEY'),
   projectId: env('UCODE_PROJECT_ID'),
   resourceId: env('UCODE_RESOURCE_ID'),
   environmentId: env('UCODE_ENVIRONMENT_ID'),
   filesUrl: env('UCODE_FILES_URL', 'https://cdn.u-code.io').replace(
      /\/+$/,
      '',
   ),
   timeoutMs: Number(env('UCODE_TIMEOUT_MS')) || 20000,
   folder: 'Telegram', // the ucode Files folder of the groups' files
};

// The rights the bot asks for when a person adds it by the link.
export const BOT_RIGHTS =
   'change_info+delete_messages+restrict_members+invite_users+pin_messages+manage_chat';

export const TIMING = {
   queueMs: 3000, // the panel's requests and messages to send
   dealsMs: 20000, // new deals, and the groups' names
   heartbeatMs: 60000, // fund_settings.telegram_seen_at
   linkDays: 30, // how long a link to add the bot stays good
   betweenGroupsMs: 15000, // the fund's account makes one group at a time
};

/* The news collector (src/news, batch 28). Without ANTHROPIC_API_KEY it picks
   articles by the sources' keywords and the fund's names; with it, Claude reads
   each candidate, keeps those on the fund's focus and writes the title and
   summary in Russian, Uzbek and English. ANTHROPIC_MODEL picks the model:
   claude-haiku-5-5 (the latest Haiku) by default, cheap and quick for this;
   claude-opus-5-5 writes better and costs far more per article. */
export const NEWS = {
   anthropicKey: env('ANTHROPIC_API_KEY'),
   model: env('ANTHROPIC_MODEL', 'claude-haiku-5-5'),
   tickMs: 60000, // which sources are due, and the collector's heartbeat
   everyMin: 30, // a source's checks, unless fund_settings.news_every says
   maxAgeDays: 7, // older market news are not taken
   pressAgeDays: 365, // an article naming the fund is taken up to a year back
   perSource: 30, // the newest articles of a source looked at in one check
   aiPerRound: 40, // Claude reads at most this many articles per round
   seenKept: 500, // the guids a source remembers, so a deleted one stays away
};

export const MAX_DOWNLOAD = 20 * 1024 * 1024; // what the Bot API lets a bot fetch
export const MAX_UPLOAD = 50 * 1024 * 1024; // what it lets a bot send
