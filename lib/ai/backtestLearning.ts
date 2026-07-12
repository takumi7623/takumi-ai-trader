import type { AiScoreWeights, Tepou30BacktestMetrics } from "../types";

export type BacktestLearningInput = {
  currentWeights: AiScoreWeights;
  backtest?: Tepou30BacktestMetrics;
};

export type BacktestLearningResult = {
  weights: AiScoreWeights;
  changed: boolean;
  learningRate: number;
  notes: string[];
  backtest?: Tepou30BacktestMetrics;
};

export type BacktestLearningPlan = {
  name: string;
  description: string;
  learn: (input: BacktestLearningInput) => BacktestLearningResult;
};

function cloneWeights(weights: AiScoreWeights): AiScoreWeights {
  return { ...weights };
}

function buildNotes(backtest?: Tepou30BacktestMetrics) {
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

export function learnWeightsFromBacktest(input: BacktestLearningInput): BacktestLearningResult {
  return {
    weights: cloneWeights(input.currentWeights),
    changed: false,
    learningRate: 0,
    notes: buildNotes(input.backtest),
    backtest: input.backtest,
  };
}

export function createBacktestLearningPlan(): BacktestLearningPlan {
  return {
    name: "Phase1 backtest learning scaffold",
    description: "Accepts current AiScoreWeights and optional backtest metrics, but returns the current weights unchanged for now.",
    learn: learnWeightsFromBacktest,
  };
}
