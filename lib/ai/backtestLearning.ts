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

const LEARNING_CAP = 0.05;

const TREND_WEIGHTS: (keyof AiScoreWeights)[] = [
  "rsi",
  "macd",
  "ma5",
  "ma25",
  "ma75",
  "adx",
  "bollinger",
  "supportResistance",
  "volumeRatio",
  "volumeSpike",
  "trendStrength",
  "probabilityUp",
];

const RISK_WEIGHTS: (keyof AiScoreWeights)[] = ["atr", "lossRisk"];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function adjustWeight(base: number, factor: number) {
  return Number((base * factor).toFixed(4));
}

function buildLearningSignal(backtest?: Tepou30BacktestMetrics) {
  if (!backtest || backtest.totalTrades <= 0) {
    return 0;
  }

  const winRateSignal = (backtest.winRate - 50) / 100;
  const expectancySignal = backtest.expectedValuePercent / 100;
  const profitFactorSignal = (backtest.profitFactor - 1) / 2;
  const drawdownSignal = -backtest.maxDrawdown / 100;

  return clamp(winRateSignal * 0.45 + expectancySignal * 0.3 + profitFactorSignal * 0.2 + drawdownSignal * 0.25, -LEARNING_CAP, LEARNING_CAP);
}

function applyLearning(weights: AiScoreWeights, signal: number): AiScoreWeights {
  const trendFactor = clamp(1 + signal, 1 - LEARNING_CAP, 1 + LEARNING_CAP);
  const riskFactor = clamp(1 - signal * 0.6, 1 - LEARNING_CAP, 1 + LEARNING_CAP);

  const learned = { ...weights };

  for (const key of TREND_WEIGHTS) {
    learned[key] = adjustWeight(weights[key], trendFactor);
  }

  for (const key of RISK_WEIGHTS) {
    learned[key] = adjustWeight(weights[key], riskFactor);
  }

  return learned;
}

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
  const signal = buildLearningSignal(input.backtest);

  return {
    weights: signal === 0 ? cloneWeights(input.currentWeights) : applyLearning(input.currentWeights, signal),
    changed: signal !== 0,
    learningRate: Math.abs(signal),
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
