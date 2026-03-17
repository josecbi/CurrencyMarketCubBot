# Currency Exchange Telegram Bot

A Telegram bot powered by **Node.js + Express + PostgreSQL** that lets users post currency sell offers and buy requests, and automatically matches them by currency and price.

---

## Features

- **Sell listing** — currency, price, contact info, preferred transfer type, optional note
- **Buy request** — desired currency, max price, contact info, accepted transaction type, optional note
- **Automatic matching** — finds exact matches (price is met) and near matches (within a configurable % tolerance)
- **Manual match lookup** — re-check active listings on demand with a menu button or command
- **Market timestamps** — market listings show when they were published and how old they are
- **Push notifications** — counterparties are notified when a compatible listing appears
- **Cold-start hint** — users are informed when the bot is waking up after a restart/idle period
- **Webhook security** — Telegram updates are validated with a secret token
- **PostgreSQL persistence** — listings survive restarts; table and indexes are created automatically

---

## Bot commands

The bot is button-driven: after `/start`, users can tap the bottom keyboard buttons instead of typing commands manually.

| Command | Description |
|---|---|
| `/start` or `/help` | Show quick start + available commands |
| `/menu` | Re-open the action buttons keyboard |
| `/sell` | Start a sell listing wizard |
| `/buy` | Start a buy request wizard |
| `/market` | Browse the 5 most recent sell and buy listings |
| `/my_listings` | View your active listings |
| `/matches` | Re-check matches for your active listings |
| `/delete <id>` | Close one of your listings |
| `/cancel` | Abort the current form |

---

## Environment variables

Copy `.env.example` to `.env` and fill in real values.

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | Set to `production` on a real server. Skips loading the `.env` file (the platform injects vars directly). |
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | The token BotFather gives you when you create the bot (`/newbot`). Identifies your bot to the Telegram API. |
| `BOT_MODE` | No | `polling` | `polling` → the bot calls Telegram every few seconds asking for new messages (good for local dev, no public URL needed). `webhook` → Telegram calls your server whenever a message arrives (required for production). |
| `WEBHOOK_URL` | Only in webhook mode | — | Your server's public HTTPS base URL, e.g. `https://myapp.onrender.com`. Telegram will POST updates to `WEBHOOK_URL + WEBHOOK_PATH`. |
| `WEBHOOK_PATH` | No | `/telegram/webhook` | The URL path registered with Telegram. You can keep the default. |
| `WEBHOOK_SECRET` | Recommended in webhook mode | — | A random string (≥16 chars) that Telegram includes in every update request header. Your server rejects requests that don't carry it, blocking spoofed traffic. Generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` | No | `3000` | The TCP port Express listens on. Platforms like Render set this automatically. |
| `DATABASE_URL` | **Yes** | — | Full PostgreSQL connection string: `postgres://user:password@host:port/database`. The bot creates the `listings` table on first start. |
| `DATABASE_SSL` | No | `false` | Set to `true` when the DB host requires an encrypted connection (Render, Railway, Supabase, etc.). |
| `DB_POOL_MAX` | No | `10` | Maximum number of simultaneous PostgreSQL connections. Increase if you have many concurrent users. |
| `SUPPORTED_CURRENCIES` | No | `USD,EUR,USDT` | Comma-separated list of currency codes shown as buttons in the buy/sell wizard. |
| `MAX_NOTE_LENGTH` | No | `300` | Maximum length allowed for optional listing notes. |
| `NEAR_MATCH_PERCENT` | No | `10` | Percentage tolerance for the matching engine. A buyer targeting 100 will also see sellers up to `100 * (1 + 0.10) = 110`. |
| `COLD_START_HINT_WINDOW_SECONDS` | No | `180` | Time window after process start where users get a one-time “server waking up” hint (useful on Render cold starts). |

---

## How the matching works

```
New BUY listing (USD, max $100)
        │
        ▼
Query active SELL listings for USD
        │
        ├── seller.price ≤ 100  →  ✅ exact match  (sorted first)
        └── seller.price ≤ 110  →  🟡 near match   (sorted by closeness)
                │
                ▼
        Top 5 shown to buyer
        Top 3 sellers notified about the new buyer
```

The same logic applies in reverse when a new SELL listing arrives.

---

## Local development (no Docker)

**Requirements**: Node.js 18+, PostgreSQL 14+

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# → edit .env with your token and local DB URL

# 3. Create the database (first time only)
createdb telegram_bot

# 4. Start with auto-reload
npm run dev
```

---

## Local development with Docker

Docker Compose starts both PostgreSQL and the app:

```bash
# Copy and fill in your .env
cp .env.example .env

# Build and start all services
docker compose up --build

# Stop everything
docker compose down

# Wipe the database volume too
docker compose down -v
```

---

## Production deployment (Render / Railway / VPS)

### Step 1 — Create a Telegram bot

1. Open Telegram and search for **@BotFather**.
2. Send `/newbot`, choose a name and username.
3. Copy the token — this is your `TELEGRAM_BOT_TOKEN`.

### Step 2 — Deploy the app

The app is a standard Node.js HTTP server. Any platform that can run Docker or Node works.

**Render (recommended for beginners)**

1. Push this repo to GitHub.
2. On Render, create a **New Web Service** → connect your repo.
3. Set **Runtime**: Docker, or Node with start command `npm start`.
4. Set all environment variables (see table above).
5. Set `BOT_MODE=webhook` and `WEBHOOK_URL=https://<your-render-url>`.

**Railway**

1. Push to GitHub → connect repo in Railway.
2. Add a **PostgreSQL** plugin — Railway sets `DATABASE_URL` automatically.
3. Set remaining env vars.

**VPS (manual)**

```bash
# On the server
git clone <your-repo>
cd telegram-bot
npm install --omit=dev
cp .env.example .env   # fill in production values
npm start
```

Use **PM2** or **systemd** to keep the process alive:

```bash
npm install -g pm2
pm2 start src/index.js --name telegram-bot
pm2 save && pm2 startup
```

### Step 3 — Verify

After deploying, call the health endpoint:

```
GET https://your-domain.com/health
```

Expected response:
```json
{ "ok": true, "mode": "webhook", "timestamp": "..." }
```

### Step 4 — Set the webhook (automatic)

The app sets the webhook automatically on startup when `BOT_MODE=webhook`. No manual step needed.

To verify it is registered:
```
https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo
```

---

## Project structure

```
src/
  index.js     — Express server, lifecycle management, webhook/polling setup
  bot.js       — Bot orchestrator: commands, routing, conversation state, matching triggers
  botConfig.js — Bot constants, step definitions, and env-driven runtime settings
  botUi.js     — Keyboards, button/action mapping, and per-step UI hints
  botUtils.js  — Formatting, parsing, and validation helpers
  store.js     — PostgreSQL queries (listings CRUD)
  matcher.js   — Price/currency matching engine (pure functions, no DB calls)
```

