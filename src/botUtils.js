const {
    FORM_BUTTONS,
    MAX_PRICE,
    MAX_PRICE_INTEGER_DIGITS,
    PRICE_KEY_INPUT_RE,
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

function getPriceDraft(form) {
    if (!form?.data || typeof form.data !== 'object') {
        return '';
    }

    return String(form.data.priceDraft || '');
}

function formatPriceDraft(draft) {
    return draft || '—';
}

function appendPriceDraftValue(draft, rawValue) {
    const value = rawValue === ',' ? '.' : rawValue;
    let nextDraft = draft;

    if (/^[0-9]$/.test(value)) {
        nextDraft += value;
    } else if (value === '.') {
        if (nextDraft.includes('.')) {
            return {
                ok: false,
                error: 'Only one decimal point is allowed.',
            };
        }

        nextDraft = nextDraft ? `${nextDraft}.` : '0.';
    } else {
        return {
            ok: false,
            error: 'Invalid key for price input.',
        };
    }

    const [integerPart, decimalPart = ''] = nextDraft.split('.');

    if (integerPart.length > MAX_PRICE_INTEGER_DIGITS) {
        return {
            ok: false,
            error: `Price is too large (max ${MAX_PRICE_INTEGER_DIGITS} digits before decimal).`,
        };
    }

    if (decimalPart.length > 4) {
        return {
            ok: false,
            error: 'Price supports up to 4 decimal places.',
        };
    }

    return {
        ok: true,
        draft: nextDraft,
    };
}

function handlePriceStepInput(form, inputText) {
    const trimmed = String(inputText || '').trim();
    const normalized = normalizeMenuText(trimmed);
    const currentDraft = getPriceDraft(form);

    if (normalized === normalizeMenuText(FORM_BUTTONS.priceConfirm)) {
        const amount = parsePrice(currentDraft);

        if (!amount) {
            return {
                kind: 'error',
                message: `Invalid price draft (${formatPriceDraft(currentDraft)}).\n\nUse the numeric keypad and tap ✅ Confirm price.`,
                draft: currentDraft,
            };
        }

        return {
            kind: 'confirmed',
            value: amount,
        };
    }

    if (normalized === normalizeMenuText(FORM_BUTTONS.priceClear)) {
        return {
            kind: 'draft',
            draft: '',
            message: '💵 Price draft cleared.\n\nUse the numeric keypad and tap ✅ Confirm price.',
        };
    }

    if (normalized === normalizeMenuText(FORM_BUTTONS.priceBackspace)) {
        const nextDraft = currentDraft.slice(0, -1);
        return {
            kind: 'draft',
            draft: nextDraft,
            message: `💵 Price draft: ${formatPriceDraft(nextDraft)}\n\nTap ✅ Confirm price when ready.`,
        };
    }

    if (PRICE_KEY_INPUT_RE.test(trimmed)) {
        const appendResult = appendPriceDraftValue(currentDraft, trimmed);

        if (!appendResult.ok) {
            return {
                kind: 'error',
                message: `${appendResult.error}\n\nCurrent draft: ${formatPriceDraft(currentDraft)}`,
                draft: currentDraft,
            };
        }

        return {
            kind: 'draft',
            draft: appendResult.draft,
            message: `💵 Price draft: ${formatPriceDraft(appendResult.draft)}\n\nTap ✅ Confirm price when ready.`,
        };
    }

    const normalizedTypedValue = trimmed.replace(/\s+/g, '').replace(',', '.');

    if (/^\d+(\.\d{0,4})?$/.test(normalizedTypedValue)) {
        const [integerPart, decimalPart = ''] = normalizedTypedValue.split('.');

        if (integerPart.length > MAX_PRICE_INTEGER_DIGITS) {
            return {
                kind: 'error',
                message: `Price is too large (max ${MAX_PRICE_INTEGER_DIGITS} digits before decimal).`,
                draft: currentDraft,
            };
        }

        if (decimalPart.length > 4) {
            return {
                kind: 'error',
                message: 'Price supports up to 4 decimal places.',
                draft: currentDraft,
            };
        }

        return {
            kind: 'draft',
            draft: normalizedTypedValue,
            message: `💵 Price draft: ${formatPriceDraft(normalizedTypedValue)}\n\nTap ✅ Confirm price to continue.`,
        };
    }

    return {
        kind: 'error',
        message: 'Invalid price input. Use only numeric keys and tap ✅ Confirm price.',
        draft: currentDraft,
    };
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
    getPriceDraft,
    formatPriceDraft,
    handlePriceStepInput,
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
