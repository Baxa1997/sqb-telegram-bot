# SQB Ventures — Telegram bot server

Every new deal gets its own Telegram group, «Сделка: …», with the fund's bot in it. Every message of the group comes into the deal's journal and shows in the panel's «Чат и письма». What the team writes there goes to the group, signed with the employee's name.

The plan and the decisions are in the dashboard's `docs/telegram.md`, and the tables are batch 26 of its `docs/ucode-migration.md`.

## How it connects

```
Telegram ── getUpdates (long polling) ──►  this server  ── project API key ──►  ucode (the panel's tables)
             ◄── sendMessage, setChatTitle… ──┘    ▲
                                                   └── the panel's requests, as rows: tg_chats `requested`, deal_events `tg_state` pending
```

- **No public address.** The server reads Telegram by long polling and the panel's requests from ucode every 3 s, so it needs no ingress, DNS or webhook. Nothing can call it.
- **Run exactly one copy per bot.** Telegram gives a bot's updates to one reader only; a second copy logs «another copy of this bot is running». So use one bot for testing and one for the real work.
- **The groups.** Every deal made after the server first ran (`fund_settings.telegram_since`) gets a `tg_chats` row:
  - **With the fund's account wired in** (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`): that account creates the supergroup, adds the bot and makes it an admin. The account stays the group's owner, and groups are made one at a time.
  - **Without it:** the deal waits as `waiting_bot` with a link, which the panel shows as «Подключить группу». A person creates an empty group in Telegram and opens the link, which adds the bot as an admin. The bot gets `/start <token>`, links the group to the deal and renames it. A wrong or old link makes it leave.

  In both cases the bot then sets the description and the deal's logo, makes the invite link, writes a first message, and adds «Открыта группа сделки в Telegram» to the deal's history. An older deal gets a group when someone presses «Открыть группу в Telegram» in «Чат и письма».
- **Messages.**
  - **From Telegram:** each message becomes a `deal_events` row (`kind` message, `source` telegram, `author`, `tg_message_id`), with a guid derived from the message so it is never kept twice. Its file, up to the Bot API's 20 MB, goes to ucode Files (folder `Telegram`) as an `attachments` row in section `chat`. Edits update the text.
  - **From the panel:** a message for a deal with an open group is written with `tg_state` pending. The bot sends it as **Name · SQB Ventures** with its files, up to 50 MB, and sets `sent` or `failed`.
- **The bot's state** goes to `fund_settings` every minute: `telegram_bot`, `telegram_mode` (`account` or `link`) and `telegram_seen_at`. The panel counts Telegram as connected while that is under three minutes old.
- **Renames.** A deal renamed in the panel renames its group. If the bot is removed from a group, its state becomes `lost`, and the panel offers «Подключить заново».

## The website's news

The same server collects news for sqbvc.uz (`src/news`; the plan is the dashboard's `docs/news.md`, the tables batch 28). The fund lists sources in the panel's Настройки → Сбор новостей:
- an RSS feed;
- a site, whose feed is found;
- a public Telegram channel, read from `t.me/s/<name>`;
- a Google News search.

Every minute the server checks the sources that are due and leaves each new article that fits as a draft in Сайт → Новости:
- an article that names the fund goes to «Пресса о нас», up to a year back;
- an article of the week with a source's keyword goes to «Рынок».

It writes the title, a short lead, the outlet's picture as the cover, the link to the original, and the article's own text and pictures as the news item's text (the fund has the outlets' permission). A Google News link gives the title and link only. With `ANTHROPIC_API_KEY`, Claude (`claude-haiku-5-5`, or `ANTHROPIC_MODEL`) also checks each candidate against the fund's focus and writes the title and summary in Russian, Uzbek and English. The news part runs even without `TELEGRAM_BOT_TOKEN`.

```bash
yarn news:try rss https://www.spot.uz/ru/rss/ "стартап, венчур"   # what a source would give, nothing written
yarn news:try telegram @spotuz
yarn news:try google '"SQB Ventures"'
```

## Commands

```bash
yarn install
cp .env.example .env.local   # the test bot's token and the ucode project's key
yarn dev                     # runs with .env.local
yarn type-check
yarn login                   # signs the fund's account in once and prints TELEGRAM_SESSION
```

Node 22: it runs the TypeScript source directly (`--experimental-strip-types`), so there is no build step.

## The fund's account

The account is linked from the panel by a QR code, the way Telegram Desktop signs in (core.telegram.org/api/qr-login). In Настройки → Интеграции, the director presses «Подключить аккаунт фонда»:

1. The window asks this server for a QR code (`fund_settings.telegram_auth` → `qr_start`).
2. The server shows a login token as a QR code, renewed about every 30 s.
3. On the phone with the fund's Telegram open: Settings → Devices → Link Desktop Device, then scan it.
4. If the account has two-step verification, the window asks for its password. It is encrypted in the browser with this server's public key (`fund_settings.telegram_keys`).
5. The session is then kept in `fund_settings.telegram_account`, sealed with AES-GCM under `TELEGRAM_SECRET`.

Nobody types a number, a code or the app's keys. **Keep `TELEGRAM_SECRET` the same**: a new one means linking the account again. «Отключить аккаунт» signs the server out.

**Our app's keys, once:** `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` come from my.telegram.org → «API development tools». The developer makes them with any number, since an app's keys can sign in any account. Until they are set, the panel says so instead of showing the QR.

The account must not be anyone's personal one, since the server can read everything it can. One account can be in at most 500 supergroups (1000 with Premium), and it must not leave old groups: another member would become their owner. `TELEGRAM_SESSION` (from `yarn login`) in the server's settings is the other way; the panel then cannot unlink it.

The account is driven by GramJS (`telegram` 2.26.22, `signInUserWithQrCode`). That package is archived; its maintained fork is `teleproto`, to switch to if Telegram stops accepting the old version. Neither has been tried with a real account here yet.

## Deploy (not done yet)

The repository is `Ucode-io/sqb-telegram-bot`. Its pipeline (`.github/workflows/ci-cd.yaml`, the shared `Ucode-io/ci-cd`, as the cabinet's) builds `ghcr.io/ucode-io/sqb-telegram-bot` and writes the tag to `Ucode-io/deployments`. It starts **by hand** for now, because the bot is not yet in Ucode-io/deployments. To go live:

1. Whoever has access to Ucode-io/deployments adds `clusters/cluster-prod/ucode-prod/sqb-telegram-bot/values.yaml`, like the cabinet's, with **one replica and no ingress**, plus the Vault annotation for `secret/k8s/ucode-prod/sqb-telegram-bot`.
2. Vault gets the settings: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SECRET`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `UCODE_API_KEY` and `UCODE_PROJECT_ID`. Use new values for real use, not the test ones.
3. Stop any copy running on a developer's computer (one copy per bot), then run the pipeline (Actions → CI/CD → Run workflow), and switch its trigger to `push` to `main` like the other apps.
4. If `TELEGRAM_SECRET` differs from the one used before, link the fund's account again by QR in Настройки → Интеграции.

