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
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET?.trim() || undefined;

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

        const parsedWebhookUrl = new URL(WEBHOOK_URL);
        if (parsedWebhookUrl.pathname && parsedWebhookUrl.pathname !== '/') {
            throw new Error('WEBHOOK_URL must be the base domain only (no path). Example: https://my-service.onrender.com');
        }

        const webhookPath = WEBHOOK_PATH.startsWith('/') ? WEBHOOK_PATH : `/${WEBHOOK_PATH}`;
        const finalWebhookUrl = `${parsedWebhookUrl.origin}${webhookPath}`;
        app.post(webhookPath, async (req, res) => {
            if (WEBHOOK_SECRET) {
                const incomingSecret = req.get('x-telegram-bot-api-secret-token');
                if (incomingSecret !== WEBHOOK_SECRET) {
                    console.warn('Rejected webhook request with invalid secret token.');
                    res.sendStatus(401);
                    return;
                }
            }

            try {
                const updateId = req.body?.update_id;
                const msgType = req.body?.message ? 'message' : (req.body?.callback_query ? 'callback' : 'other');
                console.log(`[webhook] update_id=${updateId} type=${msgType}`);
                await bot.handleUpdate(req.body);
                res.sendStatus(200);
            } catch (error) {
                console.error('Failed to process webhook update:', error);
                if (!res.headersSent) {
                    res.sendStatus(500);
                }
            }
        });

        const webhookOptions = WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : undefined;

        await bot.telegram.setWebhook(finalWebhookUrl, webhookOptions);
        const webhookInfo = await bot.telegram.getWebhookInfo();

        console.log(`Bot running in webhook mode on ${webhookPath}`);
        console.log('Webhook diagnostics:', {
            configuredUrl: webhookInfo.url,
            pendingUpdates: webhookInfo.pending_update_count,
            hasCustomCertificate: webhookInfo.has_custom_certificate,
            lastErrorDate: webhookInfo.last_error_date,
            lastErrorMessage: webhookInfo.last_error_message,
            usingSecretToken: Boolean(WEBHOOK_SECRET),
        });
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
