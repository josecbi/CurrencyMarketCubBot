const { Markup } = require('telegraf');
const {
    MENU_BUTTONS,
    FORM_BUTTONS,
    TRANSFER_TYPE_OPTIONS,
    DEFAULT_SUPPORTED_CURRENCIES,
    MAX_CURRENCY_BUTTONS_PER_ROW,
} = require('./botConfig');

function normalizeMenuText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\uFE0F/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizeCurrency(text) {
    return String(text || '').trim().toUpperCase();
}

function parseSupportedCurrencies(value) {
    const currencies = String(value || '')
        .split(',')
        .map((item) => normalizeCurrency(item))
        .filter(Boolean)
        .filter((item) => /^[A-Z0-9]{2,10}$/.test(item));

    const uniqueCurrencies = [...new Set(currencies)];
    return uniqueCurrencies.length ? uniqueCurrencies : DEFAULT_SUPPORTED_CURRENCIES;
}

function createCurrencyKeyboard(currencies) {
    const rows = [];

    for (let index = 0; index < currencies.length; index += MAX_CURRENCY_BUTTONS_PER_ROW) {
        rows.push(currencies.slice(index, index + MAX_CURRENCY_BUTTONS_PER_ROW));
    }

    rows.push([MENU_BUTTONS.cancel]);

    return Markup.keyboard(rows).resize();
}

const MAIN_MENU_KEYBOARD = Markup.keyboard([
    [MENU_BUTTONS.sell, MENU_BUTTONS.buy],
    [MENU_BUTTONS.market, MENU_BUTTONS.myListings],
    [MENU_BUTTONS.matches, MENU_BUTTONS.help],
    [MENU_BUTTONS.cancel],
]).resize();

const FORM_KEYBOARD = Markup.keyboard([
    [MENU_BUTTONS.cancel],
]).resize();

const NOTE_KEYBOARD = Markup.keyboard([
    [FORM_BUTTONS.skipNote],
    [MENU_BUTTONS.cancel],
]).resize();

const SUPPORTED_CURRENCIES = parseSupportedCurrencies(process.env.SUPPORTED_CURRENCIES);
const CURRENCY_KEYBOARD = createCurrencyKeyboard(SUPPORTED_CURRENCIES);

const TRANSFER_TYPE_KEYBOARD = Markup.keyboard([
    TRANSFER_TYPE_OPTIONS.map((item) => item.label),
    [MENU_BUTTONS.cancel],
]).resize();

const BUTTON_ACTION_MAP = new Map([
    [normalizeMenuText(MENU_BUTTONS.sell), 'sell'],
    [normalizeMenuText(MENU_BUTTONS.buy), 'buy'],
    [normalizeMenuText(MENU_BUTTONS.market), 'market'],
    [normalizeMenuText(MENU_BUTTONS.myListings), 'my_listings'],
    [normalizeMenuText(MENU_BUTTONS.matches), 'matches'],
    [normalizeMenuText(MENU_BUTTONS.help), 'help'],
    [normalizeMenuText(MENU_BUTTONS.cancel), 'cancel'],
]);

const BUTTON_ACTION_ALIASES = new Map([
    ['sell', 'sell'],
    ['buy', 'buy'],
    ['market', 'market'],
    ['browse market', 'market'],
    ['my listings', 'my_listings'],
    ['my listing', 'my_listings'],
    ['matches', 'matches'],
    ['find matches', 'matches'],
    ['help', 'help'],
    ['cancel', 'cancel'],
    ['cancel form', 'cancel'],
]);

const TRANSFER_TYPE_VALUE_BY_INPUT = new Map(
    TRANSFER_TYPE_OPTIONS.flatMap((item) => ([
        [normalizeMenuText(item.label), item.value],
        [normalizeMenuText(item.value), item.value],
    ]))
);

const NOTE_SKIP_INPUTS = new Set([
    normalizeMenuText(FORM_BUTTONS.skipNote),
    'skip',
    'skip note',
    'none',
    'no note',
    'sin nota',
    'ninguna',
    '-',
]);

function resolveMenuAction(rawText) {
    const normalized = normalizeMenuText(rawText);
    return BUTTON_ACTION_MAP.get(normalized) || BUTTON_ACTION_ALIASES.get(normalized) || null;
}

function summarizeIncomingText(text) {
    const trimmed = String(text || '').trim();

    if (!trimmed) {
        return 'empty';
    }

    if (trimmed.startsWith('/')) {
        return trimmed.split(/\s+/, 1)[0];
    }

    const menuAction = resolveMenuAction(trimmed);

    if (menuAction) {
        return `button:${menuAction}`;
    }

    return `text:${trimmed.length}chars`;
}

function getKeyboardForStep(stepKey) {
    if (stepKey === 'currency') {
        return CURRENCY_KEYBOARD;
    }

    if (stepKey === 'preferredTransferType' || stepKey === 'transactionType') {
        return TRANSFER_TYPE_KEYBOARD;
    }

    if (stepKey === 'note') {
        return NOTE_KEYBOARD;
    }

    return FORM_KEYBOARD;
}

function getStepInstruction(stepKey) {
    if (stepKey === 'currency') {
        return '👇 Tap one of the currency buttons below.';
    }

    if (stepKey === 'price') {
        return '💵 Type the price (numbers only, e.g. 39.50).';
    }

    if (stepKey === 'contact') {
        return '📞 Type: person name + phone number, email, or Telegram username (@username).';
    }

    if (stepKey === 'preferredTransferType' || stepKey === 'transactionType') {
        return '👇 Tap your preferred transfer type below.';
    }

    if (stepKey === 'note') {
        return '📝 Type your note, or tap ⏭ Skip note.';
    }

    return '✍️ Reply by typing your answer as a normal message.';
}

function getStepRetryInstruction(stepKey) {
    if (stepKey === 'currency') {
        return '👇 Please choose one of the currency buttons below, or tap ❌ Cancel form.';
    }

    if (stepKey === 'price') {
        return '💵 Please type a valid price, e.g. 39.50';
    }

    if (stepKey === 'contact') {
        return '📞 Please enter: person name + phone number, email, or Telegram username (@username).';
    }

    if (stepKey === 'preferredTransferType' || stepKey === 'transactionType') {
        return '👇 Please choose bank transfer or cash, or tap ❌ Cancel form.';
    }

    if (stepKey === 'note') {
        return '📝 Type your note, or tap ⏭ Skip note.';
    }

    return '✍️ Please type your answer, or tap ❌ Cancel form.';
}

module.exports = {
    MAIN_MENU_KEYBOARD,
    FORM_KEYBOARD,
    SUPPORTED_CURRENCIES,
    TRANSFER_TYPE_VALUE_BY_INPUT,
    NOTE_SKIP_INPUTS,
    resolveMenuAction,
    summarizeIncomingText,
    normalizeMenuText,
    getKeyboardForStep,
    getStepInstruction,
    getStepRetryInstruction,
};
