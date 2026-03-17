const {
    MAX_PRICE,
    MAX_NOTE_LENGTH,
} = require('./botConfig');
const {
    normalizeMenuText,
    SUPPORTED_CURRENCIES,
    TRANSFER_TYPE_VALUE_BY_INPUT,
    NOTE_SKIP_INPUTS,
} = require('./botUi');

function normalizeContact(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function getListingNoteLine(listing) {
    return `Note: ${listing.description || 'No note'}`;
}

function formatListingDate(value) {
    const parsedDate = new Date(value);

    if (Number.isNaN(parsedDate.getTime())) {
        return 'Unknown date';
    }

    return parsedDate.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

function formatListingAge(value) {
    const timestamp = Date.parse(value);

    if (!Number.isFinite(timestamp)) {
        return 'unknown age';
    }

    const elapsedMs = Math.max(0, Date.now() - timestamp);
    const elapsedMinutes = Math.floor(elapsedMs / 60000);

    if (elapsedMinutes < 1) {
        return 'just now';
    }

    if (elapsedMinutes < 60) {
        return `${elapsedMinutes}m ago`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);

    if (elapsedHours < 24) {
        return `${elapsedHours}h ago`;
    }

    const elapsedDays = Math.floor(elapsedHours / 24);

    if (elapsedDays < 7) {
        return `${elapsedDays}d ago`;
    }

    const elapsedWeeks = Math.floor(elapsedDays / 7);

    if (elapsedWeeks < 5) {
        return `${elapsedWeeks}w ago`;
    }

    const elapsedMonths = Math.floor(elapsedDays / 30);

    if (elapsedMonths < 12) {
        return `${elapsedMonths}mo ago`;
    }

    const elapsedYears = Math.floor(elapsedDays / 365);
    return `${elapsedYears}y ago`;
}

function getSellListingDetail(listing) {
    return `Preferred transfer: ${listing.transactionType || 'Not specified'}`;
}

function getBuyListingDetail(listing) {
    return `Accepted transfer: ${listing.transactionType || 'Not specified'}`;
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
    const normalized = String(text || '').trim().replace(/\s+/g, '').replace(',', '.');

    if (!/^\d+(\.\d{1,4})?$/.test(normalized)) {
        return null;
    }

    const value = Number(normalized);

    if (!Number.isFinite(value) || value <= 0 || value > MAX_PRICE) {
        return null;
    }

    return Number(value.toFixed(4));
}

function normalizeCurrency(text) {
    return String(text || '').trim().toUpperCase();
}

function validateStep(key, value) {
    const text = String(value || '').trim();

    if (!text) {
        return { ok: false, error: 'This field cannot be empty. Please try again.' };
    }

    if (key === 'currency') {
        const currency = normalizeCurrency(text);
        if (!SUPPORTED_CURRENCIES.includes(currency)) {
            return {
                ok: false,
                error: 'Invalid currency. Please choose one of the available buttons below.',
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
        const contact = normalizeContact(text);

        if (contact.length < 4 || contact.length > 200) {
            return {
                ok: false,
                error: 'Contact must be between 4 and 200 characters.',
            };
        }

        if (!/[A-Za-z0-9@+]/.test(contact)) {
            return {
                ok: false,
                error: 'Contact must include letters/numbers (or @ / +).',
            };
        }

        if (/https?:\/\//i.test(contact)) {
            return {
                ok: false,
                error: 'Please share direct contact info, not a URL.',
            };
        }

        return { ok: true, value: contact };
    }

    if (key === 'preferredTransferType' || key === 'transactionType') {
        const transferType = TRANSFER_TYPE_VALUE_BY_INPUT.get(normalizeMenuText(text));

        if (!transferType) {
            return {
                ok: false,
                error: 'Invalid transfer type. Please choose bank transfer or cash.',
            };
        }

        return { ok: true, value: transferType };
    }

    if (key === 'note' || key === 'description') {
        if (NOTE_SKIP_INPUTS.has(normalizeMenuText(text))) {
            return { ok: true, value: null };
        }

        const note = normalizeContact(text);

        if (note.length < 2 || note.length > MAX_NOTE_LENGTH) {
            return {
                ok: false,
                error: `Note must be between 2 and ${MAX_NOTE_LENGTH} characters, or tap ⏭ Skip note.`,
            };
        }

        if (!/[A-Za-z0-9]/.test(note)) {
            return {
                ok: false,
                error: 'Note must contain at least one letter or number.',
            };
        }

        return { ok: true, value: note };
    }

    return { ok: true, value: text };
}

module.exports = {
    normalizeContact,
    getListingNoteLine,
    formatListingDate,
    formatListingAge,
    getSellListingDetail,
    getBuyListingDetail,
    formatPrice,
    formatPercent,
    getUserDisplayName,
    parsePrice,
    normalizeCurrency,
    validateStep,
};
