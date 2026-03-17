const SELL_STEPS = [
    {
        key: 'currency',
        prompt: '💱 Which currency do you want to sell? Tap one of the buttons below.',
    },
    {
        key: 'price',
        prompt: '💵 At what price do you want to sell it? (numbers only, e.g. 39.50)',
    },
    {
        key: 'contact',
        prompt: '📞 Share contact in one line: Name + phone, email, or @username.',
    },
    {
        key: 'preferredTransferType',
        prompt: '🤝 What is your preferred transfer type? Choose bank transfer or cash.',
    },
    {
        key: 'note',
        prompt: '📝 Optional: add a note for your listing (amount, location, schedule, etc.), or tap ⏭ Skip note.',
    },
];

const BUY_STEPS = [
    {
        key: 'currency',
        prompt: '💱 Which currency do you want to buy? Tap one of the buttons below.',
    },
    {
        key: 'price',
        prompt: '💵 What is the maximum price you are willing to pay?',
    },
    {
        key: 'contact',
        prompt: '📞 Share contact in one line: Name + phone, email, or @username.',
    },
    {
        key: 'transactionType',
        prompt: '🤝 What type of transaction do you accept? Choose bank transfer or cash.',
    },
    {
        key: 'note',
        prompt: '📝 Optional: add a note for your listing (amount, location, schedule, etc.), or tap ⏭ Skip note.',
    },
];

const MENU_BUTTONS = {
    sell: '🟢 Sell currency',
    buy: '🔵 Buy currency',
    market: '📊 Browse market',
    myListings: '🗂 My listings',
    matches: '🔎 Find matches',
    help: '❓ Help',
    cancel: '❌ Cancel form',
};

const FORM_BUTTONS = {
    skipNote: '⏭ Skip note',
};

const TRANSFER_TYPE_OPTIONS = [
    {
        label: '🏦 Bank transfer',
        value: 'Bank transfer',
    },
    {
        label: '💵 Cash',
        value: 'Cash',
    },
];

const DEFAULT_SUPPORTED_CURRENCIES = ['USD', 'EUR', 'USDT'];
const MAX_CURRENCY_BUTTONS_PER_ROW = 3;

const START_MESSAGE = [
    '👋 Welcome to Currency Exchange Bot!',
    '',
    'Quick start:',
    '1) Tap 🟢 Sell currency to publish a sell offer.',
    '2) Tap 🔵 Buy currency to publish a buy request.',
    '3) Tap 📊 Browse market to see current listings.',
    '4) Tap 🗂 My listings to manage your active posts.',
    '5) Tap 🔎 Find matches to re-check your active listings.',
    '',
    'Use the buttons below (you do not need to memorize commands).',
].join('\n');

function buildHelpMessage(nearMatchPercent) {
    return [
        '🤖 Currency Exchange Bot',
        '',
        'Main actions (buttons):',
        '• 🟢 Sell currency',
        '• 🔵 Buy currency',
        '• 📊 Browse market',
        '• 🗂 My listings',
        '• 🔎 Find matches',
        '',
        'Commands (optional):',
        '/sell - Post a sell offer',
        '/buy - Post a buy request',
        '/my_listings - View your active listings',
        '/matches - Re-check matches for your active listings',
        '/delete <id> - Close a listing',
        '/market - View recent listings',
        '/cancel - Cancel current form',
        '/menu - Show menu buttons',
        '/help - Show this help message',
        '',
        `Matching looks for exact and near matches (up to ${nearMatchPercent}% price difference).`,
    ].join('\n');
}

const parsedFormTtlMinutes = Number(process.env.FORM_TTL_MINUTES);
const FORM_TTL_MINUTES = Number.isFinite(parsedFormTtlMinutes) && parsedFormTtlMinutes > 0
    ? parsedFormTtlMinutes
    : 60;

const parsedColdStartHintWindowSeconds = Number(process.env.COLD_START_HINT_WINDOW_SECONDS);
const COLD_START_HINT_WINDOW_MS = Number.isFinite(parsedColdStartHintWindowSeconds) && parsedColdStartHintWindowSeconds > 0
    ? parsedColdStartHintWindowSeconds * 1000
    : 180000;

const parsedMaxNoteLength = Number(process.env.MAX_NOTE_LENGTH);
const MAX_NOTE_LENGTH = Number.isFinite(parsedMaxNoteLength) && parsedMaxNoteLength >= 20
    ? parsedMaxNoteLength
    : 300;

const WARMUP_HINT_REPEAT_MS = 30000;
const MAX_PRICE = 99999999999999.9999;
const LISTING_ID_RE = /^[a-z0-9]{6,16}$/i;

module.exports = {
    SELL_STEPS,
    BUY_STEPS,
    MENU_BUTTONS,
    FORM_BUTTONS,
    TRANSFER_TYPE_OPTIONS,
    DEFAULT_SUPPORTED_CURRENCIES,
    MAX_CURRENCY_BUTTONS_PER_ROW,
    START_MESSAGE,
    buildHelpMessage,
    FORM_TTL_MINUTES,
    COLD_START_HINT_WINDOW_MS,
    MAX_NOTE_LENGTH,
    WARMUP_HINT_REPEAT_MS,
    MAX_PRICE,
    LISTING_ID_RE,
};
