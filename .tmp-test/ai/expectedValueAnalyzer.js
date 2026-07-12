"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateRiskScore = calculateRiskScore;
exports.calculateRewardScore = calculateRewardScore;
exports.calculateExpectedValue = calculateExpectedValue;
exports.calculateEntryPriority = calculateEntryPriority;
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function normalize(value, min, max) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    if (max <= min) {
        return 0;
    }
    return clamp((value - min) / (max - min), 0, 1);
}
function calculateRiskScore(params) {
    const atrRisk = normalize(params.atr, 1.5, 7.5);
    const volatilityRisk = normalize(params.volatility, 1.6, 5.8);
    const trendProtection = normalize(params.adx, 12, 40);
    const rrProtection = normalize(params.riskRewardRatio, 1, 3.5);
    const winProtection = normalize(params.backtestWinRate, 40, 70);
    const riskScore = clamp(atrRisk * 34
        + volatilityRisk * 34
        + (1 - trendProtection) * 14
        + (1 - rrProtection) * 10
        + (1 - winProtection) * 8, 0, 100);
    return Number(riskScore.toFixed(2));
}
function calculateRewardScore(params) {
    const ai = normalize(params.aiScore, 35, 85);
    const win = normalize(params.backtestWinRate, 42, 72);
    const pf = normalize(params.profitFactor, 0.7, 2.4);
    const rr = normalize(params.riskRewardRatio, 0.9, 3.2);
    const news = normalize(params.newsScore, 38, 72);
    const volume = normalize(params.volumeScore, 35, 78);
    const trend = normalize(params.trendScore, 35, 78);
    const adxStrength = normalize(params.adx, 12, 38);
    const rewardScore = clamp(ai * 16
        + win * 20
        + pf * 18
        + rr * 20
        + news * 6
        + volume * 6
        + trend * 10
        + adxStrength * 4, 0, 100);
    return Number(rewardScore.toFixed(2));
}
function calculateExpectedValue(input) {
    const riskScore = calculateRiskScore({
        atr: input.atr,
        adx: input.adx,
        volatility: input.volatility,
        riskRewardRatio: input.riskRewardRatio,
        backtestWinRate: input.backtestWinRate,
    });
    const rewardScore = calculateRewardScore({
        aiScore: input.aiScore,
        backtestWinRate: input.backtestWinRate,
        profitFactor: input.profitFactor,
        riskRewardRatio: input.riskRewardRatio,
        newsScore: input.newsScore,
        volumeScore: input.volumeScore,
        trendScore: input.trendScore,
        adx: input.adx,
    });
    const winRate = clamp(input.backtestWinRate, 5, 98) / 100;
    const rewardPercent = clamp((input.riskRewardRatio * (1 + rewardScore / 170)) * 2.35, 0.2, 16);
    const riskPercent = clamp((1 + riskScore / 42) * 1.7, 0.3, 12);
    const modelExpectedValue = (winRate * rewardPercent) - ((1 - winRate) * riskPercent);
    const blendedExpectedValue = Number(((input.baseExpectedValue ?? modelExpectedValue) * 0.45 + modelExpectedValue * 0.55).toFixed(2));
    const entryPriority = calculateEntryPriority({
        expectedValue: blendedExpectedValue,
        riskScore,
        rewardScore,
        aiScore: input.aiScore,
        trendScore: input.trendScore,
    });
    const riskLevel = riskScore >= 68 ? "高" : riskScore >= 40 ? "中" : "低";
    const rewardLevel = rewardScore >= 68 ? "高" : rewardScore >= 40 ? "中" : "低";
    return {
        expectedValue: blendedExpectedValue,
        entryPriority,
        riskLevel,
        rewardLevel,
    };
}
function calculateEntryPriority(params) {
    const evComponent = normalize(params.expectedValue, -1.5, 4.5) * 44;
    const rewardComponent = normalize(params.rewardScore, 20, 90) * 26;
    const aiComponent = normalize(params.aiScore, 35, 85) * 14;
    const trendComponent = normalize(params.trendScore, 35, 85) * 10;
    const riskPenalty = normalize(params.riskScore, 20, 88) * 18;
    const priority = clamp(evComponent + rewardComponent + aiComponent + trendComponent - riskPenalty, 0, 100);
    return Number(priority.toFixed(2));
}
