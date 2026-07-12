"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeMarket = analyzeMarket;
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function analyzeMarket(stock) {
    const sectorBias = stock.sector.includes("金融")
        ? 8
        : stock.sector.includes("情報")
            ? 5
            : stock.sector.includes("医")
                ? 4
                : 2;
    const score = clamp(64 + sectorBias + (stock.baselineTrend === "up" ? 8 : 0), 0, 100);
    const confidence = clamp(70 + sectorBias, 60, 92);
    const summary = stock.baselineTrend === "up"
        ? "市場の雰囲気に連動しやすい銘柄です。"
        : "市場環境の影響を受けやすい構図です。";
    return {
        score: Math.round(score),
        confidence: Math.round(confidence),
        summary,
        reasons: [
            "業種の特性が追随しやすいです。",
            "市場全体のムードと相関しやすいです。",
            "ニュースや材料の反応を見極める価値があります。",
        ],
    };
}
