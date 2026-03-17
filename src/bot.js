const { Telegraf } = require('telegraf');
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
const {
    SELL_STEPS,
    BUY_STEPS,
    START_MESSAGE,
    buildHelpMessage,
    FORM_TTL_MINUTES,
    LOADER_INTERVAL_MS,
    COLD_START_HINT_WINDOW_MS,
    LOADER_MESSAGE_DELAY_MS,
    WARMUP_HINT_REPEAT_MS,
    LISTING_ID_RE,
} = require('./botConfig');
const {
    MAIN_MENU_KEYBOARD,
    resolveMenuAction,
    summarizeIncomingText,
    normalizeMenuText,
    getKeyboardForStep,
    getStepInstruction,
    getStepRetryInstruction,
} = require('./botUi');
const {
    getListingNoteLine,
    formatListingDate,
    formatListingAge,
    getSellListingDetail,
    getBuyListingDetail,
    formatPrice,
    formatPercent,
    getUserDisplayName,
    validateStep,
} = require('./botUtils');

const HELP_MESSAGE = buildHelpMessage(NEAR_MATCH_PERCENT);
const PROCESS_STARTED_AT = Date.now();
const warmupHintedUsers = new Map();

function getContextState(ctx) {
    if (!ctx.state || typeof ctx.state !== 'object') {
        ctx.state = {};
    }

    return ctx.state;
}

function getFlowByType(type) {
    return type === 'sell' ? SELL_STEPS : BUY_STEPS;
}

function getCurrentStepPrompt(form) {
    if (!form) {
        return null;
    }

    const flow = getFlowByType(form.type);
    return flow[form.step]?.prompt || null;
}

function getCurrentStepKey(form) {
    if (!form) {
        return null;
    }

    const flow = getFlowByType(form.type);
    return flow[form.step]?.key || null;
}

async function getActiveForm(ctx) {
    const state = getContextState(ctx);

    if (Object.prototype.hasOwnProperty.call(state, 'activeForm')) {
        return state.activeForm;
    }

    if (!ctx.from?.id) {
        state.activeForm = null;
        return null;
    }

    const persisted = await getUserForm(ctx.from.id);

    if (!persisted) {
        state.activeForm = null;
        return null;
    }

    const updatedAtTimestamp = Date.parse(persisted.updatedAt);
    if (Number.isFinite(updatedAtTimestamp)
        && Date.now() - updatedAtTimestamp > FORM_TTL_MINUTES * 60 * 1000) {
        await deleteUserForm(ctx.from.id);
        state.activeForm = null;
        return null;
    }

    const flow = getFlowByType(persisted.type);
    const safeStep = Number.isInteger(persisted.step) ? persisted.step : 0;

    if (safeStep < 0 || safeStep >= flow.length) {
        await deleteUserForm(ctx.from.id);
        state.activeForm = null;
        return null;
    }

    const hydrated = {
        type: persisted.type,
        step: safeStep,
        data: persisted.data && typeof persisted.data === 'object' ? persisted.data : {},
    };

    state.activeForm = hydrated;
    return hydrated;
}

async function persistForm(ctx, form) {
    const state = getContextState(ctx);
    state.activeForm = form
        ? {
            type: form.type,
            step: form.step,
            data: form.data || {},
        }
        : null;

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

function formatMarketListing(listing, index) {
    const typeLabel = listing.type === 'sell' ? 'Sell' : 'Buy';
    const detail = listing.type === 'sell'
        ? getSellListingDetail(listing)
        : getBuyListingDetail(listing);

    return [
        `${index + 1}) #${listing.id} | ${typeLabel} ${listing.currency} @ ${formatPrice(listing.price)}`,
        detail,
        getListingNoteLine(listing),
        `Contact: ${listing.contact}`,
        `Listed on: ${formatListingDate(listing.createdAt)} (${formatListingAge(listing.createdAt)})`,
    ].join('\n');
}

function formatOwnListing(listing, index) {
    const typeLabel = listing.type === 'sell' ? 'Sell' : 'Buy';
    return [
        `${index + 1}) #${listing.id} | ${typeLabel} ${listing.currency} @ ${formatPrice(listing.price)}`,
        `Listed on: ${formatListingDate(listing.createdAt)} (${formatListingAge(listing.createdAt)})`,
    ].join('\n');
}

function startTypingLoader(ctx) {
    if (!ctx.chat?.id || typeof ctx.sendChatAction !== 'function') {
        return () => { };
    }

    let stopped = false;

    const sendTyping = async () => {
        if (stopped) {
            return;
        }

        try {
            await ctx.sendChatAction('typing');
        } catch (_error) {
            // Ignore loader errors to avoid blocking user flow.
        }
    };

    void sendTyping();
    const intervalId = setInterval(() => {
        void sendTyping();
    }, LOADER_INTERVAL_MS);

    return () => {
        stopped = true;
        clearInterval(intervalId);
    };
}

function startDelayedLoaderMessage(ctx) {
    if (!ctx.chat?.id || typeof ctx.reply !== 'function' || LOADER_MESSAGE_DELAY_MS <= 0) {
        return async () => { };
    }

    let stopped = false;
    let loaderMessageId;

    const timer = setTimeout(async () => {
        if (stopped) {
            return;
        }

        try {
            const sentMessage = await ctx.reply('⏳ Processing your request...');
            loaderMessageId = sentMessage?.message_id;
        } catch (_error) {
            // Ignore loader message errors.
        }
    }, LOADER_MESSAGE_DELAY_MS);

    return async () => {
        stopped = true;
        clearTimeout(timer);

        if (!loaderMessageId || !ctx.telegram || !ctx.chat?.id) {
            return;
        }

        try {
            await ctx.telegram.deleteMessage(ctx.chat.id, loaderMessageId);
        } catch (_error) {
            // Ignore delete errors (message may be already deleted or not deletable).
        }
    };
}

async function maybeReplyColdStartHint(ctx) {
    if (Date.now() - PROCESS_STARTED_AT > COLD_START_HINT_WINDOW_MS) {
        return;
    }

    if (ctx.chat?.type !== 'private' || !ctx.from?.id || !ctx.chat?.id) {
        return;
    }

    const now = Date.now();
    const lastHintAt = warmupHintedUsers.get(ctx.from.id) || 0;

    if (now - lastHintAt < WARMUP_HINT_REPEAT_MS) {
        return;
    }

    warmupHintedUsers.set(ctx.from.id, now);

    try {
        await ctx.reply('⏳ Server is waking up after restart. Processing your request now...');
    } catch (_error) {
        // Ignore hint errors to keep request handling uninterrupted.
    }
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
        `${header}\n\n${flow[0].prompt}\n\n${getStepInstruction(flow[0].key)}`,
        getKeyboardForStep(flow[0].key)
    );
}

async function replyWithActiveFormPrompt(ctx, intro) {
    const activeForm = await getActiveForm(ctx);

    if (!activeForm) {
        return false;
    }

    const currentPrompt = getCurrentStepPrompt(activeForm);
    const currentStepKey = getCurrentStepKey(activeForm);

    await ctx.reply(
        [
            intro,
            '',
            currentPrompt || 'Continue your current form.',
            '',
            getStepRetryInstruction(currentStepKey),
        ].join('\n'),
        getKeyboardForStep(currentStepKey)
    );

    return true;
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
                    getBuyListingDetail(buyListing),
                    getListingNoteLine(buyListing),
                    `Buyer's listing posted: ${formatListingDate(buyListing.createdAt)}`,
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
                    getSellListingDetail(sellListing),
                    getListingNoteLine(sellListing),
                    `Seller's listing posted: ${formatListingDate(sellListing.createdAt)}`,
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
        getSellListingDetail(seller),
        getListingNoteLine(seller),
        `Listed on: ${formatListingDate(seller.createdAt)} (${formatListingAge(seller.createdAt)})`,
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
        getBuyListingDetail(buyer),
        getListingNoteLine(buyer),
        `Listed on: ${formatListingDate(buyer.createdAt)} (${formatListingAge(buyer.createdAt)})`,
    ].join('\n');
}

function findMatchesForListing(listing, sellerListings, buyerListings, limit = 3) {
    if (listing.type === 'buy') {
        return findSellersForBuyer(
            listing,
            sellerListings.filter((item) => item.userId !== listing.userId),
            limit
        );
    }

    return findBuyersForSeller(
        listing,
        buyerListings.filter((item) => item.userId !== listing.userId),
        limit
    );
}

function formatListingReference(listing) {
    const typeLabel = listing.type === 'sell' ? 'Sell' : 'Buy';
    return `🧾 ${typeLabel} #${listing.id} | ${listing.currency} @ ${formatPrice(listing.price)}`;
}

function buildReplyChunks(sections, maxLength = 3500) {
    const chunks = [];
    let currentChunk = '';

    for (const section of sections) {
        const candidate = currentChunk ? `${currentChunk}\n\n${section}` : section;

        if (candidate.length <= maxLength) {
            currentChunk = candidate;
            continue;
        }

        if (currentChunk) {
            chunks.push(currentChunk);
        }

        currentChunk = section;
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks;
}

async function showManualMatches(ctx) {
    const userListings = await getUserListings(ctx.from.id);

    if (!userListings.length) {
        await ctx.reply('You have no active listings to match.', MAIN_MENU_KEYBOARD);
        return;
    }

    const [sellerListings, buyerListings] = await Promise.all([
        getActiveListings('sell'),
        getActiveListings('buy'),
    ]);

    const matchedSections = [];
    let unmatchedListings = 0;

    for (const listing of userListings) {
        const matches = findMatchesForListing(listing, sellerListings, buyerListings, 3);

        if (!matches.length) {
            unmatchedListings += 1;
            continue;
        }

        const formattedMatches = matches.map((match, index) => (
            listing.type === 'buy'
                ? formatSellerMatch(match, index)
                : formatBuyerMatch(match, index)
        ));

        matchedSections.push([
            formatListingReference(listing),
            '',
            ...formattedMatches,
        ].join('\n\n'));
    }

    if (!matchedSections.length) {
        await ctx.reply(
            `🔎 I checked ${userListings.length} active listing(s). No matches found right now.`,
            MAIN_MENU_KEYBOARD
        );
        return;
    }

    const summaryLines = [
        `🔎 I checked ${userListings.length} active listing(s).`,
        `Matches found for ${matchedSections.length} listing(s).`,
    ];

    if (unmatchedListings) {
        summaryLines.push(`${unmatchedListings} listing(s) currently have no matches.`);
    }

    await ctx.reply(summaryLines.join('\n'), MAIN_MENU_KEYBOARD);

    const replyChunks = buildReplyChunks(matchedSections);

    for (const chunk of replyChunks) {
        await ctx.reply(chunk, MAIN_MENU_KEYBOARD);
    }
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

    let stepValue;

    const validation = validateStep(current.key, text);

    if (!validation.ok) {
        await ctx.reply(
            `${validation.error}\n\n${getStepRetryInstruction(current.key)}`,
            getKeyboardForStep(current.key)
        );
        return;
    }

    stepValue = validation.value;

    const isFinalStep = form.step >= flow.length - 1;
    form.data[current.key] = stepValue;

    if (!isFinalStep) {
        form.step += 1;
        await persistForm(ctx, form);
        await ctx.reply(
            `${flow[form.step].prompt}\n\n${getStepInstruction(flow[form.step].key)}`,
            getKeyboardForStep(flow[form.step].key)
        );
        return;
    }

    const listing = await addListing({
        type: form.type,
        currency: form.data.currency,
        price: form.data.price,
        contact: form.data.contact,
        description: form.data.note || null,
        transactionType: form.type === 'buy' ? form.data.transactionType : form.data.preferredTransferType,
        userId: ctx.from.id,
        chatId: ctx.chat.id,
        username: ctx.from.username || null,
        userDisplayName: getUserDisplayName(ctx.from),
    });

    await clearActiveForm(ctx);

    const summaryDetail = listing.type === 'sell'
        ? getSellListingDetail(listing)
        : getBuyListingDetail(listing);

    await ctx.reply(
        [
            `✅ Listing created with ID #${listing.id}`,
            `Currency: ${listing.currency}`,
            `Price: ${formatPrice(listing.price)}`,
            summaryDetail,
            getListingNoteLine(listing),
            `Posted on: ${formatListingDate(listing.createdAt)}`,
            '',
            'You can close your listing anytime with /delete <id>.',
        ].join('\n'),
        MAIN_MENU_KEYBOARD
    );

    await runMatching(ctx, listing);
}

function createBot(token) {
    const bot = new Telegraf(token);

    bot.use(async (ctx, next) => {
        const updateType = ctx.updateType;
        const text = ctx.message?.text || '';
        const chatType = ctx.chat?.type || 'unknown';
        const userId = ctx.from?.id || 'unknown';
        console.log(`[update] type=${updateType} chat=${chatType} user=${userId} input=${summarizeIncomingText(text)}`);

        const stopTypingLoader = startTypingLoader(ctx);
        const stopDelayedLoaderMessage = startDelayedLoaderMessage(ctx);

        try {
            await maybeReplyColdStartHint(ctx);
            await next();
        } catch (err) {
            console.error(`[update-error] type=${updateType} user=${userId}`, err);
            throw err;
        } finally {
            stopTypingLoader();
            await stopDelayedLoaderMessage();
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

    const handleMatches = async (ctx) => {
        if (!(await ensureInteractiveUserContext(ctx))) {
            return;
        }

        await showManualMatches(ctx);
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

        if (action === 'matches') {
            await handleMatches(ctx);
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
        if (await replyWithActiveFormPrompt(ctx, 'You already have an active form.')) {
            return;
        }

        await clearActiveForm(ctx);
        await ctx.reply(START_MESSAGE, MAIN_MENU_KEYBOARD);
        await handleHelp(ctx);
    });

    bot.command('help', async (ctx) => {
        if (await replyWithActiveFormPrompt(ctx, 'You already have an active form.')) {
            return;
        }

        await handleHelp(ctx);
    });

    bot.command('menu', async (ctx) => {
        if (await replyWithActiveFormPrompt(ctx, 'You already have an active form.')) {
            return;
        }

        await showMenu(ctx);
    });

    bot.command('sell', handleSell);
    bot.command('buy', handleBuy);
    bot.command('cancel', handleCancel);

    bot.command('market', async (ctx) => {
        if (await replyWithActiveFormPrompt(ctx, 'You already have an active form.')) {
            return;
        }

        await handleMarket(ctx);
    });

    bot.command('my_listings', async (ctx) => {
        if (await replyWithActiveFormPrompt(ctx, 'You already have an active form.')) {
            return;
        }

        await handleMyListings(ctx);
    });

    bot.command('matches', async (ctx) => {
        if (await replyWithActiveFormPrompt(ctx, 'You already have an active form.')) {
            return;
        }

        await handleMatches(ctx);
    });

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

        if (!LISTING_ID_RE.test(id)) {
            await ctx.reply('Invalid listing ID format. Example: /delete abc12345', MAIN_MENU_KEYBOARD);
            return;
        }

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

        if (text.startsWith('/')) {
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

                const activeStepKey = getCurrentStepKey(activeForm);
                await ctx.reply(
                    'You are filling out a form now. Type your answer, or tap "❌ Cancel form" to exit.',
                    getKeyboardForStep(activeStepKey)
                );
                return;
            }

            await routeMenuAction(ctx, menuAction);
            return;
        }

        const activeForm = await getActiveForm(ctx);

        if (!activeForm) {
            console.log(`[text-unmatched] user=${ctx.from?.id} input=${summarizeIncomingText(text)} normalized=${JSON.stringify(normalizedText)}`);
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
