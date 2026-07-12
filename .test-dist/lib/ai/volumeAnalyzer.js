"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeVolume = analyzeVolume;
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function analyzeVolume(stock) {
    const candles = stock.chartData?.candles ?? [];
    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];
    const recentVolume = last?.volume ?? 0;
    const priorVolume = previous?.volume ?? recentVolume;
    const volumeDelta = priorVolume > 0 ? ((recentVolume - priorVolume) / priorVolume) * 100 : 0;
    const score = clamp(60 + volumeDelta * 0.4 + (recentVolume > priorVolume ? 8 : 0), 0, 100);
    const confidence = clamp(66 + (recentVolume > priorVolume ? 8 : 0), 60, 95);
    const summary = recentVolume > priorVolume
        ? "出来高が増加しており、参加者の関心が高まっています。"
        : "出来高は平準化しており、材料待ちの状態です。";
    return {
        score: Math.round(score),
        confidence: Math.round(confidence),
        summary,
        reasons: [
            "直近の出来高が前回を上回っています。",
            "需給の変化がトレンドの加速要因になりやすいです。",
            "短期の値動きにボリュームが追随しています。",
        ],
    };
}
