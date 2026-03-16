const { Telegraf, session } = require('telegraf');
const {
    addListing,
    getActiveListings,
    getUserListings,
    closeListing,
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

const HELP_MESSAGE = [
    '🤖 Currency Exchange Bot',
    '',
    'Available commands:',
    '/sell - Post a sell offer',
    '/buy - Post a buy request',
    '/my_listings - View your active listings',
    '/delete <id> - Close a listing',
    '/market - View recent listings',
    '/cancel - Cancel the current form',
    '/help - Show this help message',
    '',
    `Matching looks for exact and near matches (up to ${NEAR_MATCH_PERCENT}% price difference).`,
].join('\n');

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

function startFlow(ctx, type) {
    const flow = getFlowByType(type);

    ctx.session.form = {
        type,
        step: 0,
        data: {},
    };

    const header = type === 'sell'
        ? '✅ Starting your sell listing.'
        : '✅ Starting your buy request.';

    return ctx.reply(`${header}\n\n${flow[0].prompt}`);
}

async function showMarket(ctx) {
    const [sells, buys] = await Promise.all([
        getActiveListings('sell'),
        getActiveListings('buy'),
    ]);

    if (!sells.length && !buys.length) {
        await ctx.reply('No active listings in the market yet.');
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

    await ctx.reply(chunks.join('\n\n'));
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
    const form = ctx.session?.form;

    if (!form) {
        return;
    }

    const flow = getFlowByType(form.type);
    const current = flow[form.step];

    if (!current) {
        ctx.session.form = null;
        await ctx.reply('Form reset for safety. Use /sell or /buy to start again.');
        return;
    }

    const validation = validateStep(current.key, text);

    if (!validation.ok) {
        await ctx.reply(validation.error);
        return;
    }

    form.data[current.key] = validation.value;
    form.step += 1;

    if (form.step < flow.length) {
        await ctx.reply(flow[form.step].prompt);
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

    ctx.session.form = null;

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
        ].join('\n')
    );

    await runMatching(ctx, listing);
}

function createBot(token) {
    const bot = new Telegraf(token);

    bot.use(session());

    bot.start(async (ctx) => {
        await ctx.reply(HELP_MESSAGE);
    });

    bot.command('help', async (ctx) => {
        await ctx.reply(HELP_MESSAGE);
    });

    bot.command('sell', async (ctx) => {
        await startFlow(ctx, 'sell');
    });

    bot.command('buy', async (ctx) => {
        await startFlow(ctx, 'buy');
    });

    bot.command('cancel', async (ctx) => {
        if (!ctx.session?.form) {
            await ctx.reply('You have no active form.');
            return;
        }

        ctx.session.form = null;
        await ctx.reply('Form cancelled. Use /sell or /buy whenever you are ready.');
    });

    bot.command('market', async (ctx) => {
        await showMarket(ctx);
    });

    bot.command('my_listings', async (ctx) => {
        const listings = await getUserListings(ctx.from.id);

        if (!listings.length) {
            await ctx.reply('You have no active listings.');
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
            ].join('\n')
        );
    });

    bot.command('delete', async (ctx) => {
        const text = ctx.message?.text || '';
        const args = text.trim().split(/\s+/).slice(1);

        if (!args[0]) {
            await ctx.reply('You must provide the ID. Example: /delete abc12345');
            return;
        }

        const id = args[0].replace('#', '');
        const result = await closeListing(id, ctx.from.id);

        if (!result.ok) {
            if (result.reason === 'not_found') {
                await ctx.reply('No listing found with that ID.');
                return;
            }

            if (result.reason === 'forbidden') {
                await ctx.reply('That listing does not belong to you.');
                return;
            }

            if (result.reason === 'already_closed') {
                await ctx.reply('That listing was already closed.');
                return;
            }
        }

        await ctx.reply(`✅ Listing #${id} closed successfully.`);
    });

    bot.on('text', async (ctx) => {
        const text = (ctx.message?.text || '').trim();

        if (!text) {
            return;
        }

        if (text.startsWith('/')) {
            if (ctx.session?.form) {
                await ctx.reply('You are filling out a form. Use /cancel to abort it.');
            }
            return;
        }

        await processFlowText(ctx, text);
    });

    bot.catch((error) => {
        console.error('Bot error:', error);
    });

    return bot;
}

module.exports = {
    createBot,
};
