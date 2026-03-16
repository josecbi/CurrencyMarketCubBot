const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_SSL = (process.env.DATABASE_SSL || 'false').toLowerCase() === 'true';
const DB_POOL_MAX = Number(process.env.DB_POOL_MAX) || 10;

if (!DATABASE_URL) {
    throw new Error('Missing DATABASE_URL environment variable to connect to PostgreSQL.');
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    max: DB_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
});

function mapListingRow(row) {
    return {
        id: row.id,
        type: row.type,
        currency: row.currency,
        price: Number(row.price),
        contact: row.contact,
        description: row.description,
        transactionType: row.transaction_type,
        userId: Number(row.user_id),
        chatId: Number(row.chat_id),
        username: row.username,
        userDisplayName: row.user_display_name,
        isActive: row.is_active,
        createdAt: row.created_at instanceof Date
            ? row.created_at.toISOString()
            : new Date(row.created_at).toISOString(),
        closedAt: row.closed_at
            ? (row.closed_at instanceof Date
                ? row.closed_at.toISOString()
                : new Date(row.closed_at).toISOString())
            : null,
    };
}

function mapUserFormRow(row) {
    return {
        userId: Number(row.user_id),
        chatId: Number(row.chat_id),
        type: row.type,
        step: Number(row.step),
        data: row.data && typeof row.data === 'object' ? row.data : {},
        updatedAt: row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : new Date(row.updated_at).toISOString(),
    };
}

async function ensureStore() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS listings (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK (type IN ('sell', 'buy')),
            currency TEXT NOT NULL,
            price NUMERIC(18, 4) NOT NULL CHECK (price > 0),
            contact TEXT NOT NULL,
            description TEXT,
            transaction_type TEXT,
            user_id BIGINT NOT NULL,
            chat_id BIGINT NOT NULL,
            username TEXT,
            user_display_name TEXT NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            closed_at TIMESTAMPTZ
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_listings_active_type_created
        ON listings (is_active, type, created_at DESC);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_listings_user_active_created
        ON listings (user_id, is_active, created_at DESC);
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_forms (
            user_id BIGINT PRIMARY KEY,
            chat_id BIGINT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('sell', 'buy')),
            step INTEGER NOT NULL CHECK (step >= 0),
            data JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_user_forms_updated_at
        ON user_forms (updated_at DESC);
    `);
}

function createListingId() {
    return randomUUID().split('-')[0];
}

async function addListing(payload) {
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const id = createListingId();

        try {
            const result = await pool.query(
                `
                INSERT INTO listings (
                    id,
                    type,
                    currency,
                    price,
                    contact,
                    description,
                    transaction_type,
                    user_id,
                    chat_id,
                    username,
                    user_display_name,
                    is_active,
                    closed_at
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    $10,
                    $11,
                    true,
                    NULL
                )
                RETURNING *;
                `,
                [
                    id,
                    payload.type,
                    payload.currency,
                    payload.price,
                    payload.contact,
                    payload.description || null,
                    payload.transactionType || null,
                    payload.userId,
                    payload.chatId,
                    payload.username || null,
                    payload.userDisplayName,
                ]
            );

            return mapListingRow(result.rows[0]);
        } catch (error) {
            if (error?.code === '23505' && attempt < maxAttempts) {
                continue;
            }

            throw error;
        }
    }

    throw new Error('Could not generate a unique ID for the listing.');
}

async function getActiveListings(type) {
    const values = [];
    let whereClause = 'WHERE is_active = true';

    if (type) {
        values.push(type);
        whereClause += ` AND type = $${values.length}`;
    }

    const result = await pool.query(
        `
        SELECT *
        FROM listings
        ${whereClause}
        ORDER BY created_at DESC;
        `,
        values
    );

    return result.rows.map(mapListingRow);
}

async function getUserListings(userId, options = {}) {
    const { includeClosed = false } = options;
    const values = [userId];
    let whereClause = 'WHERE user_id = $1';

    if (!includeClosed) {
        whereClause += ' AND is_active = true';
    }

    const result = await pool.query(
        `
        SELECT *
        FROM listings
        ${whereClause}
        ORDER BY created_at DESC;
        `,
        values
    );

    return result.rows.map(mapListingRow);
}

async function closeListing(id, userId) {
    const updateResult = await pool.query(
        `
        UPDATE listings
        SET is_active = false,
            closed_at = now()
        WHERE id = $1
          AND user_id = $2
          AND is_active = true
        RETURNING *;
        `,
        [id, userId]
    );

    if (updateResult.rows[0]) {
        return {
            ok: true,
            listing: mapListingRow(updateResult.rows[0]),
        };
    }

    const findResult = await pool.query(
        `
        SELECT *
        FROM listings
        WHERE id = $1;
        `,
        [id]
    );

    const listing = findResult.rows[0];

    if (!listing) {
        return { ok: false, reason: 'not_found' };
    }

    if (Number(listing.user_id) !== Number(userId)) {
        return { ok: false, reason: 'forbidden' };
    }

    if (!listing.is_active) {
        return { ok: false, reason: 'already_closed' };
    }

    return { ok: false, reason: 'not_found' };
}

async function checkStoreHealth() {
    await pool.query('SELECT 1;');
    return true;
}

async function getUserForm(userId) {
    const result = await pool.query(
        `
        SELECT *
        FROM user_forms
        WHERE user_id = $1;
        `,
        [userId]
    );

    const row = result.rows[0];
    return row ? mapUserFormRow(row) : null;
}

async function upsertUserForm(payload) {
    const result = await pool.query(
        `
        INSERT INTO user_forms (
            user_id,
            chat_id,
            type,
            step,
            data,
            updated_at
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5::jsonb,
            now()
        )
        ON CONFLICT (user_id)
        DO UPDATE
        SET chat_id = EXCLUDED.chat_id,
            type = EXCLUDED.type,
            step = EXCLUDED.step,
            data = EXCLUDED.data,
            updated_at = now()
        RETURNING *;
        `,
        [
            payload.userId,
            payload.chatId,
            payload.type,
            payload.step,
            JSON.stringify(payload.data || {}),
        ]
    );

    return mapUserFormRow(result.rows[0]);
}

async function deleteUserForm(userId) {
    await pool.query(
        `
        DELETE FROM user_forms
        WHERE user_id = $1;
        `,
        [userId]
    );
}

async function closePool() {
    await pool.end();
}

module.exports = {
    ensureStore,
    addListing,
    getActiveListings,
    getUserListings,
    closeListing,
    getUserForm,
    upsertUserForm,
    deleteUserForm,
    checkStoreHealth,
    closePool,
};
