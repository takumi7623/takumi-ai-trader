import type { AiScoreWeights, Tepou30BacktestMetrics } from "../types";

export type WeightOptimizerBacktestInput = Pick<
  Tepou30BacktestMetrics,
  "winRate" | "expectedValuePercent" | "profitFactor" | "maxDrawdown" | "totalTrades"
> & {
  sharpeRatio?: number;
  sortinoRatio?: number;
  calmarRatio?: number;
};

export type WeightOptimizerInput = {
  currentWeights: AiScoreWeights;
  backtest?: WeightOptimizerBacktestInput;
};

export type WeightOptimizerResult = {
  weights: AiScoreWeights;
  changed: boolean;
  notes: string[];
  backtest?: WeightOptimizerBacktestInput;
};

export type WeightOptimizerPlan = {
  name: string;
  description: string;
  optimize: (input: WeightOptimizerInput) => WeightOptimizerResult;
};

function cloneWeights(weights: AiScoreWeights): AiScoreWeights {
  return { ...weights };
}

function buildNotes(backtest?: WeightOptimizerBacktestInput) {
  const notes: string[] = [];

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

export function optimizeAiScoreWeights(input: WeightOptimizerInput): WeightOptimizerResult {
  return {
    weights: cloneWeights(input.currentWeights),
    changed: false,
    notes: buildNotes(input.backtest),
    backtest: input.backtest,
  };
}

export function createWeightOptimizer(): WeightOptimizerPlan {
  return {
    name: "Phase1 weight optimizer scaffold",
    description: "Accepts current AiScoreWeights and optional backtest metrics, but returns the current weights unchanged for now.",
    optimize: optimizeAiScoreWeights,
  };
}
