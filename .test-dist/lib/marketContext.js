"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchMarketContext = fetchMarketContext;
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null;
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function calcChangePercent(closes) {
    const filtered = closes.filter(isFiniteNumber);
    if (filtered.length < 2) {
        return null;
    }
    const latest = filtered[filtered.length - 1];
    const previous = filtered[filtered.length - 2];
    if (previous === 0) {
        return null;
    }
    return ((latest - previous) / previous) * 100;
}
async function fetchYahooDailyChangePercent(symbol) {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set("interval", "1d");
    url.searchParams.set("range", "7d");
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(`Yahoo chart API failed: ${response.status}`);
    }
    const json = (await response.json());
    const closes = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) {
        return null;
    }
    return calcChangePercent(closes);
}
async function fetchMarketContext() {
    if (cache && cache.expiresAt > Date.now()) {
        return cache.value;
    }
    try {
        const [nikkeiChangePercent, topixChangePercent, usdJpyChangePercent, vixChangePercent] = await Promise.all([
            fetchYahooDailyChangePercent("^N225"),
            fetchYahooDailyChangePercent("^TOPX"),
            fetchYahooDailyChangePercent("JPY=X"),
            fetchYahooDailyChangePercent("^VIX"),
        ]);
        if (nikkeiChangePercent === null && topixChangePercent === null && usdJpyChangePercent === null && vixChangePercent === null) {
            return null;
        }
        const value = {
            nikkeiChangePercent,
            topixChangePercent,
            usdJpyChangePercent,
            vixChangePercent,
            source: "yahoo-finance",
            updatedAt: new Date().toISOString(),
        };
        cache = {
            expiresAt: Date.now() + CACHE_TTL_MS,
            value,
        };
        return value;
    }
    catch {
        return null;
    }
}
