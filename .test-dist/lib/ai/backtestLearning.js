"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.learnWeightsFromBacktest = learnWeightsFromBacktest;
exports.createBacktestLearningPlan = createBacktestLearningPlan;
function cloneWeights(weights) {
    return { ...weights };
}
function buildNotes(backtest) {
    if (!backtest) {
        return ["No backtest snapshot provided. Returning current weights unchanged."];
    }
    return [
        "Backtest snapshot received, but automatic learning is disabled in Phase1.",
        `Period: ${backtest.periodDays} days`,
        `Trades: ${backtest.totalTrades}`,
        `Win rate: ${backtest.winRate.toFixed(2)}%`,
        `Expected value: ${backtest.expectedValuePercent.toFixed(2)}%`,
        `Profit factor: ${backtest.profitFactor.toFixed(2)}`,
        `Max drawdown: ${backtest.maxDrawdown.toFixed(2)}%`,
    ];
}
function learnWeightsFromBacktest(input) {
    return {
        weights: cloneWeights(input.currentWeights),
        changed: false,
        learningRate: 0,
        notes: buildNotes(input.backtest),
        backtest: input.backtest,
    };
}
function createBacktestLearningPlan() {
    return {
        name: "Phase1 backtest learning scaffold",
        description: "Accepts current AiScoreWeights and optional backtest metrics, but returns the current weights unchanged for now.",
        learn: learnWeightsFromBacktest,
    };
}
