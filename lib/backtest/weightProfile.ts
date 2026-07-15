import type { AiScoreWeights } from "../types";
import type { AiScoreBacktestResult } from "./types";

export type AiScoreWeightProfile = {
  version: 1;
  updatedAt: string;
  Trend: number;
  Momentum: number;
  Volume: number;
  PriceAction: number;
  Risk: number;
  metrics?: {
    winRate: number;
    averageProfit: number;
    profitFactor: number;
    maxDrawdown: number;
    totalTrades: number;
  };
  notes?: string[];
};

export const DEFAULT_AI_SCORE_WEIGHT_PROFILE: AiScoreWeightProfile = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  Trend: 1,
  Momentum: 1,
  Volume: 1,
  PriceAction: 1,
  Risk: 1,
};

export function resolveAiScoreWeightProfilePath() {
  return `${process.cwd()}\\.cache\\weights.json`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundWeight(value: number) {
  return Number(clamp(value, 0.7, 1.3).toFixed(4));
}

function normalizeProfile(profile?: Partial<AiScoreWeightProfile> | null): AiScoreWeightProfile {
  return {
    version: 1,
    updatedAt: profile?.updatedAt ?? new Date(0).toISOString(),
    Trend: roundWeight(profile?.Trend ?? DEFAULT_AI_SCORE_WEIGHT_PROFILE.Trend),
    Momentum: roundWeight(profile?.Momentum ?? DEFAULT_AI_SCORE_WEIGHT_PROFILE.Momentum),
    Volume: roundWeight(profile?.Volume ?? DEFAULT_AI_SCORE_WEIGHT_PROFILE.Volume),
    PriceAction: roundWeight(profile?.PriceAction ?? DEFAULT_AI_SCORE_WEIGHT_PROFILE.PriceAction),
    Risk: roundWeight(profile?.Risk ?? DEFAULT_AI_SCORE_WEIGHT_PROFILE.Risk),
    metrics: profile?.metrics,
    notes: profile?.notes,
  };
}

function getFs() {
  const runtimeRequire = typeof require === "function" ? require : (eval("require") as NodeRequire);
  return runtimeRequire("node:fs") as typeof import("node:fs");
}

function dirname(filePath: string) {
  const normalized = filePath.replace(/\//g, "\\");
  const index = normalized.lastIndexOf("\\");
  return index >= 0 ? normalized.slice(0, index) : ".";
}

function bucketPerformance(result: AiScoreBacktestResult, label: string) {
  return result.scoreBuckets.find((bucket) => bucket.label === label) ?? {
    label,
    totalTrades: 0,
    winRate: 50,
    averageProfit: 0,
    averageLoss: 0,
    profitFactor: 1,
    maxDrawdown: 0,
    averageReturn: 0,
  };
}

function holdingPerformance(result: AiScoreBacktestResult, periodDays: number) {
  return result.holdingPeriods.find((period) => period.holdingPeriodDays === periodDays) ?? {
    holdingPeriodDays: periodDays as 1 | 3 | 5 | 10 | 20,
    totalTrades: 0,
    winRate: 50,
    averageProfit: 0,
    averageLoss: 0,
    profitFactor: 1,
    maxDrawdown: 0,
    averageReturn: 0,
  };
}

function performanceSignal(result: AiScoreBacktestResult) {
  const total = result.totals;
  const winRateSignal = (total.winRate - 50) / 50;
  const profitSignal = total.averageProfit / 5;
  const pfSignal = (total.profitFactor - 1) / 2;
  const drawdownSignal = -total.maxDrawdown / 40;

  return clamp(winRateSignal * 0.38 + profitSignal * 0.22 + pfSignal * 0.24 + drawdownSignal * 0.16, -0.18, 0.18);
}

export function evaluateBacktestResult(result: AiScoreBacktestResult) {
  const total = result.totals;
  const highBucket = bucketPerformance(result, "90-100");
  const highMidBucket = bucketPerformance(result, "80-89");
  const midBucket = bucketPerformance(result, "70-79");
  const lowerBucket = bucketPerformance(result, "59以下");
  const shortHolding = average([holdingPerformance(result, 1), holdingPerformance(result, 3)], (item) => item.averageReturn);
  const longHolding = average([holdingPerformance(result, 10), holdingPerformance(result, 20)], (item) => item.averageReturn);

  const overallSignal = performanceSignal(result);
  const bucketEdge = clamp(((highBucket.winRate - lowerBucket.winRate) / 100) + (highBucket.profitFactor - lowerBucket.profitFactor) * 0.06, -0.15, 0.15);
  const shortTermSignal = clamp((shortHolding - longHolding) / 20 + ((holdingPerformance(result, 1).winRate - holdingPerformance(result, 10).winRate) / 100) * 0.1, -0.12, 0.12);
  const midBandSignal = clamp(((midBucket.winRate + highMidBucket.winRate) / 200) - 0.25, -0.1, 0.1);
  const riskSignal = clamp(-(total.maxDrawdown / 100) * 0.55 - Math.min(0.1, Math.max(0, 1 - total.profitFactor) * 0.08), -0.16, 0.06);

  return {
    overallSignal,
    bucketEdge,
    shortTermSignal,
    midBandSignal,
    riskSignal,
    metrics: {
      winRate: total.winRate,
      averageProfit: total.averageProfit,
      profitFactor: total.profitFactor,
      maxDrawdown: total.maxDrawdown,
      totalTrades: total.totalTrades,
    },
    highBucket,
    highMidBucket,
    midBucket,
    lowerBucket,
  };
}

function average<T>(items: T[], selector: (item: T) => number) {
  if (items.length === 0) {
    return 0;
  }

  return items.reduce((sum, item) => sum + selector(item), 0) / items.length;
}

export function deriveAiScoreWeightProfileFromBacktest(
  result: AiScoreBacktestResult,
  currentProfile?: Partial<AiScoreWeightProfile> | null,
): AiScoreWeightProfile {
  const assessment = evaluateBacktestResult(result);
  const current = normalizeProfile(currentProfile);
  const trend = roundWeight(current.Trend * (1 + clamp(assessment.overallSignal * 0.55 + assessment.bucketEdge * 0.45 + assessment.midBandSignal * 0.1, -0.12, 0.12)));
  const momentum = roundWeight(current.Momentum * (1 + clamp(assessment.overallSignal * 0.45 + assessment.shortTermSignal * 0.7, -0.12, 0.12)));
  const volume = roundWeight(current.Volume * (1 + clamp(assessment.overallSignal * 0.3 + assessment.midBandSignal * 0.5, -0.1, 0.1)));
  const priceAction = roundWeight(current.PriceAction * (1 + clamp(assessment.bucketEdge * 0.8 + assessment.overallSignal * 0.35, -0.12, 0.12)));
  const risk = roundWeight(current.Risk * (1 + clamp((-assessment.riskSignal) + (assessment.metrics.maxDrawdown / 100) * 0.55, -0.12, 0.12)));

  const notes = [
    `winRate=${assessment.metrics.winRate.toFixed(2)}%`,
    `averageProfit=${assessment.metrics.averageProfit.toFixed(2)}%`,
    `profitFactor=${assessment.metrics.profitFactor.toFixed(2)}`,
    `maxDrawdown=${assessment.metrics.maxDrawdown.toFixed(2)}%`,
  ];

  return normalizeProfile({
    version: 1,
    updatedAt: new Date().toISOString(),
    Trend: trend,
    Momentum: momentum,
    Volume: volume,
    PriceAction: priceAction,
    Risk: risk,
    metrics: assessment.metrics,
    notes,
  });
}

export function applyAiScoreWeightProfile(baseWeights: AiScoreWeights, profile: AiScoreWeightProfile) {
  const trendMix = profile.Trend;
  const momentumMix = profile.Momentum;
  const volumeMix = profile.Volume;
  const priceActionMix = profile.PriceAction;
  const riskMix = profile.Risk;

  const multiply = (value: number, factor: number) => Number(clamp(value * factor, 0.3, 3).toFixed(4));

  return {
    rsi: multiply(baseWeights.rsi, trendMix * 0.35 + momentumMix * 0.65),
    macd: multiply(baseWeights.macd, trendMix * 0.3 + momentumMix * 0.7),
    ma5: multiply(baseWeights.ma5, trendMix * 0.7 + priceActionMix * 0.3),
    ma25: multiply(baseWeights.ma25, trendMix * 0.82 + priceActionMix * 0.18),
    ma75: multiply(baseWeights.ma75, trendMix),
    adx: multiply(baseWeights.adx, trendMix),
    atr: multiply(baseWeights.atr, riskMix),
    bollinger: multiply(baseWeights.bollinger, momentumMix * 0.5 + priceActionMix * 0.5),
    supportResistance: multiply(baseWeights.supportResistance, priceActionMix),
    volumeRatio: multiply(baseWeights.volumeRatio, volumeMix),
    volumeSpike: multiply(baseWeights.volumeSpike, volumeMix),
    trendStrength: multiply(baseWeights.trendStrength, trendMix * 0.75 + momentumMix * 0.25),
    lossRisk: multiply(baseWeights.lossRisk, riskMix),
    probabilityUp: multiply(baseWeights.probabilityUp, trendMix * 0.4 + momentumMix * 0.3 + priceActionMix * 0.3),
  };
}

export function loadAiScoreWeightProfile(filePath = resolveAiScoreWeightProfilePath()) {
  const fs = getFs();

  if (!fs.existsSync(filePath)) {
    return DEFAULT_AI_SCORE_WEIGHT_PROFILE;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AiScoreWeightProfile>;
    return normalizeProfile(parsed);
  } catch {
    return DEFAULT_AI_SCORE_WEIGHT_PROFILE;
  }
}

export function saveAiScoreWeightProfile(profile: AiScoreWeightProfile, filePath = resolveAiScoreWeightProfilePath()) {
  const fs = getFs();
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf8");
  return filePath;
}
