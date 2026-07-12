"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const scoreCalculator_1 = require("./scoreCalculator");
function buildStock() {
    const candles = Array.from({ length: 40 }, (_, index) => {
        const base = 3000 + index * 5;
        return {
            time: `2025-01-${String(index + 1).padStart(2, "0")}`,
            open: base,
            high: base + 20,
            low: base - 10,
            close: base + 12,
            volume: 1800000 + index * 100000,
        };
    });
    candles[candles.length - 1] = {
        ...candles[candles.length - 1],
        close: 3300,
        high: 3330,
        volume: 3200000,
    };
    return {
        code: "7203",
        name: "トヨタ自動車",
        sector: "自動車",
        baselineTrend: "up",
        description: "テスト用のサンプルデータ",
        marketData: {
            price: 3300,
            open: 3280,
            high: 3330,
            low: 3270,
            previousClose: 3250,
            change: 50,
            changePercent: 1.54,
            currency: "JPY",
            asOf: null,
        },
        chartData: {
            candles,
        },
        dataStatus: "real",
        dataReason: null,
        timeframe: "1d",
    };
}
function withNews(stock, score, confidence, summary, importance = "普通") {
    return {
        ...stock,
        newsAnalysis: {
            sentiment: score >= 0 ? "bullish" : "bearish",
            importance,
            score,
            confidence,
            starRating: importance === "重要" ? 5 : importance === "普通" ? 3 : 1,
            positiveCount: score >= 0 ? 1 : 0,
            negativeCount: score < 0 ? 1 : 0,
            summary,
            headlines: [summary],
            details: [
                {
                    headline: summary,
                    sentiment: score >= 0 ? "positive" : "negative",
                    importanceStars: importance === "重要" ? 5 : importance === "普通" ? 3 : 1,
                    publishedAt: new Date().toISOString(),
                },
            ],
            updatedAt: new Date().toISOString(),
        },
    };
}
(0, node_test_1.default)("analyzeStock rewards a breakout above the recent high", () => {
    const result = (0, scoreCalculator_1.analyzeStock)({ query: "7203", stock: buildStock() });
    strict_1.default.ok(result.score >= 70);
    strict_1.default.match(result.judgment, /買い/);
    strict_1.default.equal(result.signal, "BUY");
    strict_1.default.ok(result.aiReason.some((reason) => reason.includes("直近高値")));
});
(0, node_test_1.default)("analyzeStock lowers the score for a weak trend and low volume", () => {
    const candles = Array.from({ length: 40 }, (_, index) => {
        const base = 3200 - index * 10;
        return {
            time: `2025-02-${String(index + 1).padStart(2, "0")}`,
            open: base,
            high: base + 8,
            low: base - 18,
            close: base - 5,
            volume: 700000 + index * 10000,
        };
    });
    candles[candles.length - 1] = {
        ...candles[candles.length - 1],
        close: 2800,
        low: 2785,
        volume: 620000,
    };
    const result = (0, scoreCalculator_1.analyzeStock)({
        query: "9432",
        stock: {
            code: "9432",
            name: "NTT",
            sector: "通信",
            baselineTrend: "volatile",
            description: "テスト用のサンプルデータ",
            marketData: {
                price: 2800,
                open: 2810,
                high: 2825,
                low: 2785,
                previousClose: 2840,
                change: -40,
                changePercent: -1.41,
                currency: "JPY",
                asOf: null,
            },
            chartData: {
                candles,
            },
            dataStatus: "real",
            dataReason: null,
            timeframe: "1d",
        },
    });
    strict_1.default.ok(result.score <= 55);
    strict_1.default.match(result.judgment, /売り|様子見/);
    strict_1.default.ok(result.confidence < 70);
});
(0, node_test_1.default)("analyzeStock boosts the score for strong positive news", () => {
    const baseStock = buildStock();
    const baseResult = (0, scoreCalculator_1.analyzeStock)({ query: "7203", stock: baseStock });
    const result = (0, scoreCalculator_1.analyzeStock)({
        query: "7203",
        stock: withNews(baseStock, 32, 74, "業績上方修正と大型受注を発表"),
    });
    strict_1.default.ok(result.score > baseResult.score);
    strict_1.default.ok(result.aiReason.some((reason) => reason.includes("重要な好材料")));
});
(0, node_test_1.default)("analyzeStock penalizes strong negative news", () => {
    const baseStock = buildStock();
    const baseResult = (0, scoreCalculator_1.analyzeStock)({ query: "7203", stock: baseStock });
    const result = (0, scoreCalculator_1.analyzeStock)({
        query: "7203",
        stock: withNews(baseStock, -31, 72, "業績下方修正と不祥事を発表"),
    });
    strict_1.default.ok(result.score < baseResult.score);
    strict_1.default.ok(result.aiReason.some((reason) => reason.includes("重要な悪材料")));
});
(0, node_test_1.default)("analyzeStock applies stronger impact for important news", () => {
    const baseStock = buildStock();
    const normalNews = (0, scoreCalculator_1.analyzeStock)({
        query: "7203",
        stock: withNews(baseStock, 26, 72, "業績上方修正を発表", "普通"),
    });
    const importantNews = (0, scoreCalculator_1.analyzeStock)({
        query: "7203",
        stock: withNews(baseStock, 26, 72, "業績上方修正を発表", "重要"),
    });
    strict_1.default.ok(importantNews.score >= normalNews.score);
    strict_1.default.ok(importantNews.aiReason.some((reason) => reason.includes("ニュース重要度は重要")));
});
(0, node_test_1.default)("analyzeStock reflects numeric gap evaluation in reasons", () => {
    const stock = buildStock();
    const candles = stock.chartData?.candles ?? [];
    const updatedCandles = candles.map((candle) => ({ ...candle }));
    const last = updatedCandles.length - 1;
    const prev = updatedCandles.length - 2;
    updatedCandles[last].open = updatedCandles[prev].close * 1.035;
    updatedCandles[last].high = updatedCandles[last].open * 1.02;
    updatedCandles[last].close = updatedCandles[last].open * 1.01;
    const result = (0, scoreCalculator_1.analyzeStock)({
        query: stock.code,
        stock: {
            ...stock,
            chartData: { candles: updatedCandles },
        },
    });
    strict_1.default.ok(result.reasons.some((reason) => reason.includes("評価:+")));
});
(0, node_test_1.default)("analyzeStock explains multi-timeframe bullish trend direction", () => {
    const result = (0, scoreCalculator_1.analyzeStock)({ query: "7203", stock: buildStock() });
    strict_1.default.ok(result.aiReason.some((reason) => reason.includes("総合トレンドは上昇")));
});
(0, node_test_1.default)("analyzeStock explains multi-timeframe bearish trend direction", () => {
    const candles = Array.from({ length: 120 }, (_, index) => {
        const base = 3600 - index * 8;
        return {
            time: `2025-03-${String((index % 30) + 1).padStart(2, "0")}`,
            open: base,
            high: base + 10,
            low: base - 18,
            close: base - 6,
            volume: 2400000 - index * 5000,
        };
    });
    candles[candles.length - 1] = {
        ...candles[candles.length - 1],
        close: 2600,
        low: 2580,
        volume: 900000,
    };
    const result = (0, scoreCalculator_1.analyzeStock)({
        query: "9432",
        stock: {
            code: "9432",
            name: "NTT",
            sector: "通信",
            baselineTrend: "volatile",
            description: "テスト用のサンプルデータ",
            marketData: {
                price: 2600,
                open: 2620,
                high: 2640,
                low: 2580,
                previousClose: 2625,
                change: -25,
                changePercent: -0.95,
                currency: "JPY",
                asOf: null,
            },
            chartData: {
                candles,
            },
            dataStatus: "real",
            dataReason: null,
            timeframe: "1d",
        },
    });
    strict_1.default.ok(result.aiReason.some((reason) => reason.includes("総合トレンドは下降")));
});
