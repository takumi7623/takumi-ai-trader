"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.optimizeAiScoreWeights = optimizeAiScoreWeights;
exports.createWeightOptimizer = createWeightOptimizer;
function cloneWeights(weights) {
    return { ...weights };
}
function buildNotes(backtest) {
    const notes = [];
    if (!backtest) {
        notes.push("No backtest snapshot provided. Returning the current weights unchanged.");
        return notes;
    }
    notes.push("Backtest input received, but weight updates are disabled in Phase1.");
    notes.push(`Samples: ${backtest.totalTrades}`);
    notes.push(`Win rate: ${backtest.winRate.toFixed(2)}%`);
    notes.push(`Expected value: ${backtest.expectedValuePercent.toFixed(2)}%`);
    notes.push(`Profit factor: ${backtest.profitFactor.toFixed(2)}`);
    notes.push(`Max drawdown: ${backtest.maxDrawdown.toFixed(2)}%`);
    return notes;
}
function optimizeAiScoreWeights(input) {
    return {
        weights: cloneWeights(input.currentWeights),
        changed: false,
        notes: buildNotes(input.backtest),
        backtest: input.backtest,
    };
}
function createWeightOptimizer() {
    return {
        name: "Phase1 weight optimizer scaffold",
        description: "Accepts current AiScoreWeights and optional backtest metrics, but returns the current weights unchanged for now.",
        optimize: optimizeAiScoreWeights,
    };
}
