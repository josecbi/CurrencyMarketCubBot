if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const express = require('express');
const { createBot } = require('./bot');
const { ensureStore, closePool } = require('./store');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_MODE = (process.env.BOT_MODE || 'polling').toLowerCase();
const PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram/webhook';
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || undefined;

const BOT_COMMANDS = [
    { command: 'start', description: 'Open quick start guide' },
    { command: 'menu', description: 'Show action buttons' },
    { command: 'sell', description: 'Create a sell listing' },
    { command: 'buy', description: 'Create a buy request' },
    { command: 'market', description: 'Browse market listings' },
    { command: 'my_listings', description: 'View your active listings' },
    { command: 'delete', description: 'Close a listing by ID' },
    { command: 'cancel', description: 'Cancel current form' },
    { command: 'help', description: 'Show help' },
];

if (!BOT_TOKEN) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN environment variable.');
}

if (!['polling', 'webhook'].includes(BOT_MODE)) {
    throw new Error('Invalid BOT_MODE. Use "polling" or "webhook".');
}

const bot = createBot(BOT_TOKEN);
const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
    res.status(200).json({
        ok: true,
        mode: BOT_MODE,
        timestamp: new Date().toISOString(),
    });
});

let server;

async function start() {
    await ensureStore();

    await bot.telegram.setMyCommands(BOT_COMMANDS).catch((error) => {
        console.error('Failed to set Telegram commands:', error);
    });

    if (BOT_MODE === 'webhook') {
        if (!WEBHOOK_URL) {
            throw new Error('WEBHOOK_URL must be defined when using webhook mode.');
        }

        app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH, { secretToken: WEBHOOK_SECRET }));

        const baseUrl = WEBHOOK_URL.endsWith('/')
            ? WEBHOOK_URL.slice(0, -1)
            : WEBHOOK_URL;

        await bot.telegram.setWebhook(`${baseUrl}${WEBHOOK_PATH}`, {
            secret_token: WEBHOOK_SECRET,
        });
        console.log(`Bot running in webhook mode on ${WEBHOOK_PATH}`);
    } else {
        await bot.launch({ dropPendingUpdates: false });
        console.log('Bot running in polling mode.');
    }

    server = app.listen(PORT, () => {
        console.log(`Express server listening on port ${PORT}`);
    });
}

async function gracefulShutdown(signal) {
    console.log(`Received signal ${signal}. Shutting down...`);

    if (BOT_MODE === 'polling') {
        bot.stop(signal);
    } else {
        await bot.telegram.deleteWebhook().catch(() => { });
    }

    if (!server) {
        await closePool().catch(() => { });
        process.exit(0);
    }

    server.close(async () => {
        await closePool().catch(() => { });
        process.exit(0);
    });

    setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGINT', () => {
    void gracefulShutdown('SIGINT');
});

process.once('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
});

start().catch((error) => {
    console.error('Failed to start the application:', error);
    process.exit(1);
});
