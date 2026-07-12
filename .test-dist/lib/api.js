"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchJapaneseStock = fetchJapaneseStock;
exports.fetchTepou30 = fetchTepou30;
const stockApiCache = new Map();
const inFlightStockApi = new Map();
const tepou30ApiCache = new Map();
const inFlightTepou30Api = new Map();
function stockApiTtlMs(timeframe) {
    if (timeframe === "5m") {
        return 45_000;
    }
    if (timeframe === "15m") {
        return 90_000;
    }
    return 180_000;
}
async function fetchJapaneseStock(query, timeframe = "1d") {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
        return {
            stock: null,
            response: { success: false, data: null, source: "mock", error: "Query is required." },
        };
    }
    const key = `${timeframe}:${normalizedQuery.toLowerCase()}`;
    const cached = stockApiCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
    }
    const inFlight = inFlightStockApi.get(key);
    if (inFlight) {
        return inFlight;
    }
    const request = (async () => {
        const response = await fetch(`/api/stocks/${encodeURIComponent(normalizedQuery)}?timeframe=${timeframe}`, {
            cache: "no-store",
        });
        if (!response.ok) {
            throw new Error("Failed to fetch stock data.");
        }
        const payload = (await response.json());
        if (!payload.success) {
            throw new Error(payload.error ?? "Failed to fetch stock data.");
        }
        const value = { stock: payload.data, response: payload };
        stockApiCache.set(key, {
            expiresAt: Date.now() + stockApiTtlMs(timeframe),
            value,
        });
        return value;
    })()
        .finally(() => {
        inFlightStockApi.delete(key);
    });
    inFlightStockApi.set(key, request);
    return request;
}
async function fetchTepou30(timeframe = "1d", refresh = false, sortMode = "ai-total") {
    const key = `${timeframe}:${sortMode}`;
    const cached = tepou30ApiCache.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now() && cached.value.status !== "building") {
        return cached.value;
    }
    const inFlight = inFlightTepou30Api.get(key);
    if (inFlight) {
        return inFlight;
    }
    const params = new URLSearchParams({ timeframe, sortMode });
    if (refresh) {
        params.set("refresh", "1");
    }
    const request = (async () => {
        const response = await fetch(`/api/tepou30?${params.toString()}`, {
            cache: "no-store",
        });
        if (!response.ok) {
            throw new Error("Failed to fetch Tepou30.");
        }
        const payload = (await response.json());
        if (payload.status !== "building") {
            tepou30ApiCache.set(key, {
                expiresAt: Date.now() + 45_000,
                value: payload,
            });
        }
        return payload;
    })()
        .finally(() => {
        inFlightTepou30Api.delete(key);
    });
    inFlightTepou30Api.set(key, request);
    return request;
}
