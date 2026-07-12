"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeTrend = analyzeTrend;
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function analyzeTrend(stock) {
    const trendBase = stock.baselineTrend === "up"
        ? 80
        : stock.baselineTrend === "steady"
            ? 72
            : stock.baselineTrend === "neutral"
                ? 62
                : 48;
    const moveBias = stock.marketData?.changePercent ?? 0;
    const score = clamp(trendBase + moveBias * 0.7, 0, 100);
    const confidence = clamp(68 + (moveBias >= 0 ? 8 : 0), 60, 95);
    const summary = stock.baselineTrend === "up"
        ? "上昇トレンドが継続しやすい構図です。"
        : stock.baselineTrend === "steady"
            ? "安定した推移を維持しやすい銘柄です。"
            : stock.baselineTrend === "volatile"
                ? "短期のボラティリティが高く、値動きの見極めが重要です。"
                : "レンジ内での推移が予想され、様子見が有効です。";
    return {
        score: Math.round(score),
        confidence: Math.round(confidence),
        summary,
        reasons: [
            "基準トレンドが反発方向に寄っています。",
            "短期の価格変動が改善傾向にあります。",
            "上値追いの余地が残る見立てです。",
        ],
    };
}
