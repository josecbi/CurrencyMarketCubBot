const { Telegraf, session, Markup } = require('telegraf');
const {
    addListing,
    getActiveListings,
    getUserListings,
    closeListing,
    getUserForm,
    upsertUserForm,
    deleteUserForm,
} = require('./store');
const {
    NEAR_MATCH_PERCENT,
    findSellersForBuyer,
    findBuyersForSeller,
} = require('./matcher');

const SELL_STEPS = [
    {
        key: 'currency',
        prompt: '💱 Which currency do you want to sell? (e.g. USD, EUR, GBP)',
    },
    {
        key: 'price',
        prompt: '💵 At what price do you want to sell it? (numbers only, e.g. 39.50)',
    },
    {
        key: 'contact',
        prompt: '📞 Share your contact information (phone, @username, etc.)',
    },
    {
        key: 'description',
        prompt: '📝 Describe the transaction (amount, conditions, location, schedule, etc.)',
    },
];

const BUY_STEPS = [
    {
        key: 'currency',
        prompt: '💱 Which currency do you want to buy? (e.g. USD, EUR, GBP)',
    },
    {
        key: 'price',
        prompt: '💵 What is the maximum price you are willing to pay?',
    },
    {
        key: 'contact',
        prompt: '📞 Share your contact information (phone, @username, etc.)',
    },
    {
        key: 'transactionType',
        prompt: '🤝 What type of transaction do you accept? (bank transfer, cash, P2P, etc.)',
    },
];

const MENU_BUTTONS = {
    sell: '🟢 Sell currency',
    buy: '🔵 Buy currency',
    market: '📊 Browse market',
    myListings: '🗂 My listings',
    help: '❓ Help',
    cancel: '❌ Cancel form',
};

const MAIN_MENU_KEYBOARD = Markup.keyboard([
    [MENU_BUTTONS.sell, MENU_BUTTONS.buy],
    [MENU_BUTTONS.market, MENU_BUTTONS.myListings],
    [MENU_BUTTONS.help, MENU_BUTTONS.cancel],
]).resize();

const FORM_KEYBOARD = Markup.keyboard([
    [MENU_BUTTONS.cancel],
]).resize();

function normalizeMenuText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\uFE0F/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const BUTTON_ACTION_MAP = new Map([
    [normalizeMenuText(MENU_BUTTONS.sell), 'sell'],
    [normalizeMenuText(MENU_BUTTONS.buy), 'buy'],
    [normalizeMenuText(MENU_BUTTONS.market), 'market'],
    [normalizeMenuText(MENU_BUTTONS.myListings), 'my_listings'],
    [normalizeMenuText(MENU_BUTTONS.help), 'help'],
    [normalizeMenuText(MENU_BUTTONS.cancel), 'cancel'],
    ['sell', 'sell'],
    ['buy', 'buy'],
    ['market', 'market'],
    ['browse market', 'market'],
    ['my listings', 'my_listings'],
    ['my listing', 'my_listings'],
    ['help', 'help'],
    ['cancel', 'cancel'],
    ['cancel form', 'cancel'],
]);

function resolveMenuAction(rawText) {
    const normalized = normalizeMenuText(rawText);
    const direct = BUTTON_ACTION_MAP.get(normalized);

    if (direct) {
        return direct;
    }

    if (normalized.includes('sell')) {
        return 'sell';
    }

    if (normalized.includes('buy')) {
        return 'buy';
    }

    if (normalized.includes('market')) {
        return 'market';
    }

    if (normalized.includes('my listing') || normalized.includes('listings')) {
        return 'my_listings';
    }

    if (normalized.includes('help')) {
        return 'help';
    }

    if (normalized.includes('cancel')) {
        return 'cancel';
    }

    return null;
}

const START_MESSAGE = [
    '👋 Welcome to Currency Exchange Bot!',
    '',
    'Quick start:',
    '1) Tap 🟢 Sell currency to publish a sell offer.',
    '2) Tap 🔵 Buy currency to publish a buy request.',
    '3) Tap 📊 Browse market to see current listings.',
    '4) Tap 🗂 My listings to manage your active posts.',
    '',
    'Use the buttons below (you do not need to memorize commands).',
].join('\n');

const HELP_MESSAGE = [
    '🤖 Currency Exchange Bot',
    '',
    'Main actions (buttons):',
    '• 🟢 Sell currency',
    '• 🔵 Buy currency',
    '• 📊 Browse market',
    '• 🗂 My listings',
    '',
    'Commands (optional):',
    '/sell - Post a sell offer',
    '/buy - Post a buy request',
    '/my_listings - View your active listings',
    '/delete <id> - Close a listing',
    '/market - View recent listings',
    '/cancel - Cancel current form',
    '/menu - Show menu buttons',
    '/help - Show this help message',
    '',
    `Matching looks for exact and near matches (up to ${NEAR_MATCH_PERCENT}% price difference).`,
].join('\n');

function getSessionState(ctx) {
    if (!ctx.session || typeof ctx.session !== 'object') {
        ctx.session = {};
    }

    return ctx.session;
}

async function getActiveForm(ctx) {
    const state = getSessionState(ctx);

    if (state.form && typeof state.form === 'object') {
        return state.form;
    }

    if (!ctx.from?.id) {
        return null;
    }

    const persisted = await getUserForm(ctx.from.id);

    if (!persisted) {
        return null;
    }

    const hydrated = {
        type: persisted.type,
        step: Number.isInteger(persisted.step) ? persisted.step : 0,
        data: persisted.data && typeof persisted.data === 'object' ? persisted.data : {},
    };

    state.form = hydrated;
    return hydrated;
}

async function persistForm(ctx, form) {
    const state = getSessionState(ctx);
    state.form = form || null;

    if (!ctx.from?.id) {
        return;
    }

    if (!form) {
        await deleteUserForm(ctx.from.id);
        return;
    }

    await upsertUserForm({
        userId: ctx.from.id,
        chatId: ctx.chat?.id || ctx.from.id,
        type: form.type,
        step: form.step,
        data: form.data || {},
    });
}

async function clearActiveForm(ctx) {
    await persistForm(ctx, null);
}

async function ensureInteractiveUserContext(ctx) {
    if (ctx.chat?.type === 'private' && ctx.from?.id && ctx.chat?.id) {
        return true;
    }

    if (typeof ctx.reply === 'function') {
        await ctx.reply(
            'Please use this bot in a direct private chat so I can keep track of your form.',
            MAIN_MENU_KEYBOARD
        );
    }

    return false;
}

function getFlowByType(type) {
    return type === 'sell' ? SELL_STEPS : BUY_STEPS;
}

function formatPrice(price) {
    const amount = Number(price);
    return Number.isFinite(amount)
        ? amount.toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 4,
        })
        : String(price);
}

function formatPercent(value) {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
}

function getUserDisplayName(from) {
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
    if (fullName) {
        return fullName;
    }

    if (from.username) {
        return `@${from.username}`;
    }

    return `User ${from.id}`;
}

function parsePrice(text) {
    const normalized = text.trim().replace(',', '.');
    const value = Number(normalized);

    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }

    return Number(value.toFixed(4));
}

function normalizeCurrency(text) {
    return text.trim().toUpperCase();
}

function validateStep(key, value) {
    const text = value.trim();

    if (!text) {
        return { ok: false, error: 'This field cannot be empty. Please try again.' };
    }

    if (key === 'currency') {
        const currency = normalizeCurrency(text);
        if (!/^[A-Z0-9]{2,10}$/.test(currency)) {
            return {
                ok: false,
                error: 'Invalid currency. Use letters/numbers only, e.g. USD, EUR, USDT.',
            };
        }

        return { ok: true, value: currency };
    }

    if (key === 'price') {
        const amount = parsePrice(text);

        if (!amount) {
            return {
                ok: false,
                error: 'Invalid price. Enter a number greater than 0, e.g. 39.50',
            };
        }

        return { ok: true, value: amount };
    }

    if (key === 'contact') {
        if (text.length < 4 || text.length > 200) {
            return {
                ok: false,
                error: 'Contact must be between 4 and 200 characters.',
            };
        }

        return { ok: true, value: text };
    }

    if (key === 'description' || key === 'transactionType') {
        if (text.length < 5 || text.length > 400) {
            return {
                ok: false,
                error: 'This field must be between 5 and 400 characters.',
            };
        }

        return { ok: true, value: text };
    }

    return { ok: true, value: text };
}

function formatMarketListing(listing, index) {
    const typeLabel = listing.type === 'sell' ? 'Sell' : 'Buy';
    const detail = listing.type === 'sell'
        ? `Description: ${listing.description || 'No description'}`
        : `Transaction: ${listing.transactionType || 'Not specified'}`;

    return [
        `${index + 1}) #${listing.id} | ${typeLabel} ${listing.currency} @ ${formatPrice(listing.price)}`,
        detail,
        `Contact: ${listing.contact}`,
    ].join('\n');
}

function formatOwnListing(listing, index) {
    const typeLabel = listing.type === 'sell' ? 'Sell' : 'Buy';
    return `${index + 1}) #${listing.id} | ${typeLabel} ${listing.currency} @ ${formatPrice(listing.price)}`;
}

async function startFlow(ctx, type) {
    if (!(await ensureInteractiveUserContext(ctx))) {
        return;
    }

    const flow = getFlowByType(type);

    const form = {
        type,
        step: 0,
        data: {},
    };

    await persistForm(ctx, form);

    const header = type === 'sell'
        ? '✅ Starting your sell listing.'
        : '✅ Starting your buy request.';

    return ctx.reply(
        `${header}\n\n${flow[0].prompt}\n\n✍️ Reply by typing your answer as a normal message.`,
        FORM_KEYBOARD
    );
}

async function showMarket(ctx) {
    const [sells, buys] = await Promise.all([
        getActiveListings('sell'),
        getActiveListings('buy'),
    ]);

    if (!sells.length && !buys.length) {
        await ctx.reply('No active listings in the market yet.', MAIN_MENU_KEYBOARD);
        return;
    }

    const sellLines = sells.slice(0, 5).map((item, index) => formatMarketListing(item, index));
    const buyLines = buys.slice(0, 5).map((item, index) => formatMarketListing(item, index));

    const chunks = ['📊 Recent listings'];

    if (sellLines.length) {
        chunks.push('', '🟢 Sell offers', '', ...sellLines);
    }

    if (buyLines.length) {
        chunks.push('', '🔵 Buy requests', '', ...buyLines);
    }

    await ctx.reply(chunks.join('\n\n'), MAIN_MENU_KEYBOARD);
}

async function notifyUsersForBuy(ctx, buyListing, matches) {
    for (const match of matches.slice(0, 3)) {
        const seller = match.listing;

        try {
            await ctx.telegram.sendMessage(
                seller.chatId,
                [
                    `🔔 Potential buyer for your listing #${seller.id}`,
                    `Currency: ${buyListing.currency}`,
                    `Buyer's price: ${formatPrice(buyListing.price)}`,
                    `Buyer's contact: ${buyListing.contact}`,
                    `Transaction type: ${buyListing.transactionType}`,
                    `Price gap: ${formatPercent(match.gapPercent)}`,
                ].join('\n')
            );
        } catch (error) {
            console.error('Could not notify seller', error);
        }
    }
}

async function notifyUsersForSell(ctx, sellListing, matches) {
    for (const match of matches.slice(0, 3)) {
        const buyer = match.listing;

        try {
            await ctx.telegram.sendMessage(
                buyer.chatId,
                [
                    `🔔 Potential seller for your listing #${buyer.id}`,
                    `Currency: ${sellListing.currency}`,
                    `Seller's price: ${formatPrice(sellListing.price)}`,
                    `Seller's contact: ${sellListing.contact}`,
                    `Description: ${sellListing.description}`,
                    `Price gap: ${formatPercent(match.gapPercent)}`,
                ].join('\n')
            );
        } catch (error) {
            console.error('Could not notify buyer', error);
        }
    }
}

function formatSellerMatch(match, index) {
    const seller = match.listing;
    const status = match.matchType === 'exact'
        ? '✅ Meets or beats your target price'
        : `🟡 Close to your target (${formatPercent(match.gapPercent)})`;

    return [
        `${index + 1}) ${status}`,
        `Ref: #${seller.id}`,
        `Seller's price: ${formatPrice(seller.price)}`,
        `Contact: ${seller.contact}`,
        `Description: ${seller.description || 'No description'}`,
    ].join('\n');
}

function formatBuyerMatch(match, index) {
    const buyer = match.listing;
    const status = match.matchType === 'exact'
        ? '✅ Meets or exceeds your sell price'
        : `🟡 Close to your price (${formatPercent(match.gapPercent)})`;

    return [
        `${index + 1}) ${status}`,
        `Ref: #${buyer.id}`,
        `Buyer's price: ${formatPrice(buyer.price)}`,
        `Contact: ${buyer.contact}`,
        `Transaction type: ${buyer.transactionType || 'Not specified'}`,
    ].join('\n');
}

async function runMatching(ctx, newListing) {
    if (newListing.type === 'buy') {
        const sellerListings = await getActiveListings('sell');
        const matches = findSellersForBuyer(
            newListing,
            sellerListings.filter((item) => item.userId !== newListing.userId),
            5
        );

        if (!matches.length) {
            await ctx.reply('🔎 Listing saved. No matching sellers found yet.');
            return;
        }

        const lines = matches.map((match, index) => formatSellerMatch(match, index));

        await ctx.reply(
            [
                `🎯 Found ${matches.length} seller(s) for your request:`,
                '',
                ...lines,
            ].join('\n\n')
        );

        await notifyUsersForBuy(ctx, newListing, matches);
        return;
    }

    const buyerListings = await getActiveListings('buy');
    const matches = findBuyersForSeller(
        newListing,
        buyerListings.filter((item) => item.userId !== newListing.userId),
        5
    );

    if (!matches.length) {
        await ctx.reply('🔎 Listing saved. No matching buyers found yet.');
        return;
    }

    const lines = matches.map((match, index) => formatBuyerMatch(match, index));

    await ctx.reply(
        [
            `🎯 Found ${matches.length} buyer(s) for your offer:`,
            '',
            ...lines,
        ].join('\n\n')
    );

    await notifyUsersForSell(ctx, newListing, matches);
}

async function processFlowText(ctx, text) {
    const form = await getActiveForm(ctx);

    if (!form) {
        return;
    }

    const flow = getFlowByType(form.type);
    const current = flow[form.step];

    if (!current) {
        await clearActiveForm(ctx);
        await ctx.reply('Form reset for safety. Use /sell or /buy to start again.', MAIN_MENU_KEYBOARD);
        return;
    }

    const validation = validateStep(current.key, text);

    if (!validation.ok) {
        await ctx.reply(`${validation.error}\n\nPlease type your answer, or tap ❌ Cancel form.`, FORM_KEYBOARD);
        return;
    }

    const isFinalStep = form.step >= flow.length - 1;
    form.data[current.key] = validation.value;

    if (!isFinalStep) {
        form.step += 1;
        await persistForm(ctx, form);
        await ctx.reply(`${flow[form.step].prompt}\n\n✍️ Reply by typing your answer.`, FORM_KEYBOARD);
        return;
    }

    const listing = await addListing({
        type: form.type,
        currency: form.data.currency,
        price: form.data.price,
        contact: form.data.contact,
        description: form.type === 'sell' ? form.data.description : null,
        transactionType: form.type === 'buy' ? form.data.transactionType : null,
        userId: ctx.from.id,
        chatId: ctx.chat.id,
        username: ctx.from.username || null,
        userDisplayName: getUserDisplayName(ctx.from),
    });

    await clearActiveForm(ctx);

    const summaryDetail = listing.type === 'sell'
        ? `Description: ${listing.description}`
        : `Transaction type: ${listing.transactionType}`;

    await ctx.reply(
        [
            `✅ Listing created with ID #${listing.id}`,
            `Currency: ${listing.currency}`,
            `Price: ${formatPrice(listing.price)}`,
            summaryDetail,
            '',
            'You can close your listing anytime with /delete <id>.',
        ].join('\n'),
        MAIN_MENU_KEYBOARD
    );

    await runMatching(ctx, listing);
}

function createBot(token) {
    const bot = new Telegraf(token);

    bot.use(session({ defaultSession: () => ({ form: null }) }));

    // Global diagnostic middleware — logs every incoming update
    bot.use(async (ctx, next) => {
        const updateType = ctx.updateType;
        const text = ctx.message?.text || '';
        const chatType = ctx.chat?.type || 'unknown';
        const userId = ctx.from?.id || 'unknown';
        console.log(`[update] type=${updateType} chat=${chatType} user=${userId} text=${JSON.stringify(text.slice(0, 60))}`);
        try {
            await next();
        } catch (err) {
            console.error(`[update-error] type=${updateType} user=${userId}`, err);
            throw err;
        }
    });

    const showMenu = async (ctx, intro = 'Choose an option below:') => {
        await ctx.reply(intro, MAIN_MENU_KEYBOARD);
    };

    const handleHelp = async (ctx) => {
        await ctx.reply(HELP_MESSAGE, MAIN_MENU_KEYBOARD);
    };

    const handleSell = async (ctx) => {
        if (!(await ensureInteractiveUserContext(ctx))) {
            return;
        }

        await startFlow(ctx, 'sell');
    };

    const handleBuy = async (ctx) => {
        if (!(await ensureInteractiveUserContext(ctx))) {
            return;
        }

        await startFlow(ctx, 'buy');
    };

    const handleCancel = async (ctx) => {
        if (!(await ensureInteractiveUserContext(ctx))) {
            return;
        }

        const activeForm = await getActiveForm(ctx);

        if (!activeForm) {
            await ctx.reply('You have no active form.', MAIN_MENU_KEYBOARD);
            return;
        }

        await clearActiveForm(ctx);
        await ctx.reply('Form cancelled. Use /sell or /buy whenever you are ready.', MAIN_MENU_KEYBOARD);
    };

    const handleMarket = async (ctx) => {
        await showMarket(ctx);
    };

    const handleMyListings = async (ctx) => {
        if (!(await ensureInteractiveUserContext(ctx))) {
            return;
        }

        const listings = await getUserListings(ctx.from.id);

        if (!listings.length) {
            await ctx.reply('You have no active listings.', MAIN_MENU_KEYBOARD);
            return;
        }

        const lines = listings.slice(0, 20).map((item, index) => formatOwnListing(item, index));

        await ctx.reply(
            [
                '🗂️ Your active listings:',
                '',
                ...lines,
                '',
                'To close one use /delete <id>.',
            ].join('\n'),
            MAIN_MENU_KEYBOARD
        );
    };

    const routeMenuAction = async (ctx, action) => {
        if (action === 'sell') {
            await handleSell(ctx);
            return;
        }

        if (action === 'buy') {
            await handleBuy(ctx);
            return;
        }

        if (action === 'market') {
            await handleMarket(ctx);
            return;
        }

        if (action === 'my_listings') {
            await handleMyListings(ctx);
            return;
        }

        if (action === 'help') {
            await handleHelp(ctx);
            return;
        }

        if (action === 'cancel') {
            await handleCancel(ctx);
            return;
        }

        await showMenu(ctx);
    };

    bot.start(async (ctx) => {
        await clearActiveForm(ctx);
        await ctx.reply(START_MESSAGE, MAIN_MENU_KEYBOARD);
        await handleHelp(ctx);
    });

    bot.command('help', handleHelp);

    bot.command('menu', async (ctx) => {
        await showMenu(ctx);
    });

    bot.command('sell', handleSell);

    bot.command('buy', handleBuy);

    bot.command('cancel', handleCancel);

    bot.command('market', handleMarket);

    bot.command('my_listings', handleMyListings);

    bot.command('delete', async (ctx) => {
        if (!(await ensureInteractiveUserContext(ctx))) {
            return;
        }

        const text = ctx.message?.text || '';
        const args = text.trim().split(/\s+/).slice(1);

        if (!args[0]) {
            await ctx.reply('You must provide the ID. Example: /delete abc12345', MAIN_MENU_KEYBOARD);
            return;
        }

        const id = args[0].replace('#', '');
        const result = await closeListing(id, ctx.from.id);

        if (!result.ok) {
            if (result.reason === 'not_found') {
                await ctx.reply('No listing found with that ID.', MAIN_MENU_KEYBOARD);
                return;
            }

            if (result.reason === 'forbidden') {
                await ctx.reply('That listing does not belong to you.', MAIN_MENU_KEYBOARD);
                return;
            }

            if (result.reason === 'already_closed') {
                await ctx.reply('That listing was already closed.', MAIN_MENU_KEYBOARD);
                return;
            }
        }

        await ctx.reply(`✅ Listing #${id} closed successfully.`, MAIN_MENU_KEYBOARD);
    });

    bot.on('text', async (ctx) => {
        const text = (ctx.message?.text || '').trim();

        if (!text) {
            return;
        }

        const normalizedText = normalizeMenuText(text);
        const menuAction = resolveMenuAction(text);

        if (menuAction) {
            console.log(`[menu-action] action=${menuAction} user=${ctx.from?.id}`);
            const activeForm = await getActiveForm(ctx);

            if (activeForm && menuAction !== 'cancel') {
                if (menuAction === 'sell' || menuAction === 'buy') {
                    await startFlow(ctx, menuAction);
                    return;
                }
                await ctx.reply(
                    'You are filling out a form now. Type your answer, or tap "❌ Cancel form" to exit.',
                    FORM_KEYBOARD
                );
                return;
            }

            await routeMenuAction(ctx, menuAction);
            return;
        }

        if (text.startsWith('/')) {
            const activeForm = await getActiveForm(ctx);

            if (activeForm) {
                await ctx.reply('You are filling out a form. Use /cancel to abort it.', MAIN_MENU_KEYBOARD);
            }
            return;
        }

        const activeForm = await getActiveForm(ctx);

        if (!activeForm) {
            console.log(`[text-unmatched] user=${ctx.from?.id} raw=${JSON.stringify(text)} normalized=${JSON.stringify(normalizedText)}`);
            await ctx.reply('Use the menu buttons below or type /help.', MAIN_MENU_KEYBOARD);
            return;
        }

        await processFlowText(ctx, text);
    });

    bot.catch((error) => {
        console.error('Bot error (unhandled):', error?.message || error);
        if (error?.stack) console.error(error.stack);
    });

    return bot;
}

module.exports = {
    createBot,
};
