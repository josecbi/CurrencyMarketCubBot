const DEFAULT_NEAR_PERCENT = 10;

const nearPercentFromEnv = Number(process.env.NEAR_MATCH_PERCENT);
const NEAR_MATCH_PERCENT = Number.isFinite(nearPercentFromEnv) && nearPercentFromEnv >= 0
    ? nearPercentFromEnv
    : DEFAULT_NEAR_PERCENT;

const NEAR_MATCH_RATIO = NEAR_MATCH_PERCENT / 100;

function sameCurrency(left, right) {
    return String(left || '').trim().toUpperCase() === String(right || '').trim().toUpperCase();
}

function sortMatches(matches) {
    return [...matches].sort((left, right) => {
        if (left.matchType !== right.matchType) {
            return left.matchType === 'exact' ? -1 : 1;
        }

        const leftDistance = Math.abs(left.gapPercent);
        const rightDistance = Math.abs(right.gapPercent);

        if (leftDistance !== rightDistance) {
            return leftDistance - rightDistance;
        }

        return new Date(right.listing.createdAt) - new Date(left.listing.createdAt);
    });
}

function findSellersForBuyer(buyListing, sellerListings, limit = 5) {
    const candidates = [];

    for (const seller of sellerListings) {
        if (!seller.isActive || !sameCurrency(seller.currency, buyListing.currency)) {
            continue;
        }

        const gapRatio = (seller.price - buyListing.price) / buyListing.price;

        if (gapRatio <= 0) {
            candidates.push({
                listing: seller,
                matchType: 'exact',
                gapPercent: gapRatio * 100,
            });
            continue;
        }

        if (gapRatio <= NEAR_MATCH_RATIO) {
            candidates.push({
                listing: seller,
                matchType: 'near',
                gapPercent: gapRatio * 100,
            });
        }
    }

    return sortMatches(candidates).slice(0, limit);
}

function findBuyersForSeller(sellListing, buyerListings, limit = 5) {
    const candidates = [];

    for (const buyer of buyerListings) {
        if (!buyer.isActive || !sameCurrency(buyer.currency, sellListing.currency)) {
            continue;
        }

        const gapRatio = (buyer.price - sellListing.price) / sellListing.price;

        if (gapRatio >= 0) {
            candidates.push({
                listing: buyer,
                matchType: 'exact',
                gapPercent: gapRatio * 100,
            });
            continue;
        }

        if (Math.abs(gapRatio) <= NEAR_MATCH_RATIO) {
            candidates.push({
                listing: buyer,
                matchType: 'near',
                gapPercent: gapRatio * 100,
            });
        }
    }

    return sortMatches(candidates).slice(0, limit);
}

module.exports = {
    NEAR_MATCH_PERCENT,
    findSellersForBuyer,
    findBuyersForSeller,
};
