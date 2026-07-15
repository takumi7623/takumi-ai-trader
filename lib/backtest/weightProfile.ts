import type { AiScoreWeights, Stock } from "../types";
import type { AiScoreBacktestResult } from "./types";

export type MarketRegime = "uptrend" | "downtrend" | "range" | "highVolatility" | "lowVolatility";

export type MarketRegimeLabel =
  | "上昇トレンド"
  | "下降トレンド"
  | "レンジ相場"
  | "高ボラティリティ"
  | "低ボラティリティ";

export const MARKET_REGIMES: MarketRegime[] = [
  "uptrend",
  "downtrend",
  "range",
  "highVolatility",
  "lowVolatility",
];

const MARKET_REGIME_LABELS: Record<MarketRegime, MarketRegimeLabel> = {
  uptrend: "上昇トレンド",
  downtrend: "下降トレンド",
  range: "レンジ相場",
  highVolatility: "高ボラティリティ",
  lowVolatility: "低ボラティリティ",
};

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

export type MarketRegimeWeightProfiles = Record<MarketRegime, AiScoreWeightProfile>;

export type AiScoreWeightStore = {
  version: 2;
  updatedAt: string;
  defaultProfile: AiScoreWeightProfile;
  regimes: MarketRegimeWeightProfiles;
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

export const DEFAULT_MARKET_REGIME_WEIGHT_PROFILES: MarketRegimeWeightProfiles = {
  uptrend: DEFAULT_AI_SCORE_WEIGHT_PROFILE,
  downtrend: DEFAULT_AI_SCORE_WEIGHT_PROFILE,
  range: DEFAULT_AI_SCORE_WEIGHT_PROFILE,
  highVolatility: DEFAULT_AI_SCORE_WEIGHT_PROFILE,
  lowVolatility: DEFAULT_AI_SCORE_WEIGHT_PROFILE,
};

export const DEFAULT_AI_SCORE_WEIGHT_STORE: AiScoreWeightStore = {
  version: 2,
  updatedAt: new Date(0).toISOString(),
  defaultProfile: DEFAULT_AI_SCORE_WEIGHT_PROFILE,
  regimes: DEFAULT_MARKET_REGIME_WEIGHT_PROFILES,
};

export function resolveAiScoreWeightProfilePath() {
  return `${process.cwd()}\\.cache\\weights.json`;
}

export function getMarketRegimeLabel(regime: MarketRegime) {
  return MARKET_REGIME_LABELS[regime];
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

function normalizeStore(store?: Partial<AiScoreWeightStore> | null): AiScoreWeightStore {
  const defaultProfile = normalizeProfile(store?.defaultProfile ?? null);
  const regimes = MARKET_REGIMES.reduce((accumulator, regime) => {
    accumulator[regime] = normalizeProfile(store?.regimes?.[regime] ?? null);
    return accumulator;
  }, {} as MarketRegimeWeightProfiles);

  return {
    version: 2,
    updatedAt: store?.updatedAt ?? new Date(0).toISOString(),
    defaultProfile,
    regimes,
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
  const mediumHolding = holdingPerformance(result, 5).averageReturn;
  const longHolding = average([holdingPerformance(result, 10), holdingPerformance(result, 20)], (item) => item.averageReturn);

  const overallSignal = performanceSignal(result);
  const bucketSpread = clamp(
    ((highBucket.winRate + highMidBucket.winRate) / 2 - lowerBucket.winRate) / 100
      + (highBucket.profitFactor - lowerBucket.profitFactor) * 0.08
      + (highBucket.averageReturn - lowerBucket.averageReturn) * 0.04,
    -0.18,
    0.18,
  );
  const shortTermSignal = clamp(
    (shortHolding - longHolding) / 20
      + ((holdingPerformance(result, 1).winRate - holdingPerformance(result, 10).winRate) / 100) * 0.12
      + (mediumHolding - longHolding) / 30,
    -0.14,
    0.14,
  );
  const midBandSignal = clamp(
    ((midBucket.winRate + highMidBucket.winRate) / 200) - 0.25
      + (midBucket.averageReturn - lowerBucket.averageReturn) * 0.03,
    -0.12,
    0.12,
  );
  const riskSignal = clamp(-(total.maxDrawdown / 100) * 0.55 - Math.min(0.1, Math.max(0, 1 - total.profitFactor) * 0.08), -0.16, 0.06);

  return {
    overallSignal,
    bucketEdge: bucketSpread,
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

function calcChangePercent(base: number, latest: number) {
  if (base <= 0) {
    return 0;
  }

  return ((latest - base) / base) * 100;
}

function calculateRegimeMetrics(stock: Pick<Stock, "baselineTrend" | "chartData" | "marketData" | "marketContext">) {
  const candles = stock.chartData?.candles ?? [];
  const closes = candles.map((candle) => candle.close);
  const latestClose = closes[closes.length - 1] ?? stock.marketData?.price ?? 0;
  const shortBase = closes[Math.max(0, closes.length - 6)] ?? latestClose;
  const midBase = closes[Math.max(0, closes.length - 18)] ?? latestClose;
  const longBase = closes[Math.max(0, closes.length - 60)] ?? latestClose;
  const shortTrend = calcChangePercent(shortBase, latestClose);
  const midTrend = calcChangePercent(midBase, latestClose);
  const longTrend = calcChangePercent(longBase, latestClose);
  const latestRange = candles[candles.length - 1]
    ? ((candles[candles.length - 1].high - candles[candles.length - 1].low) / Math.max(latestClose, 1)) * 100
    : 0;
  const recentRanges = candles.slice(-20).map((candle) => ((candle.high - candle.low) / Math.max(candle.close, 1)) * 100);
  const averageRange = average(recentRanges, (value) => value);

  return {
    shortTrend,
    midTrend,
    longTrend,
    latestRange,
    volatilityBlend: averageRange * 0.7 + latestRange * 0.3,
    trendBlend: shortTrend * 0.34 + midTrend * 0.33 + longTrend * 0.33,
    flatness: Math.abs(shortTrend) + Math.abs(midTrend) + Math.abs(longTrend),
    baselineTrend: stock.baselineTrend,
  };
}

export function inferMarketRegimeFromStock(stock: Pick<Stock, "baselineTrend" | "chartData" | "marketData" | "marketContext">): MarketRegime {
  const metrics = calculateRegimeMetrics(stock);

  if (metrics.baselineTrend === "volatile" || metrics.volatilityBlend >= 5.2 || metrics.latestRange >= 4.5) {
    return "highVolatility";
  }

  if (metrics.volatilityBlend <= 2.3 && metrics.flatness <= 8.5) {
    return "lowVolatility";
  }

  if (metrics.trendBlend >= 4.5) {
    return "uptrend";
  }

  if (metrics.trendBlend <= -4.5) {
    return "downtrend";
  }

  return "range";
}

function mixProfile(
  profile: AiScoreWeightProfile,
  factors: Partial<Record<"Trend" | "Momentum" | "Volume" | "PriceAction" | "Risk", number>>,
) {
  return normalizeProfile({
    ...profile,
    Trend: profile.Trend * (factors.Trend ?? 1),
    Momentum: profile.Momentum * (factors.Momentum ?? 1),
    Volume: profile.Volume * (factors.Volume ?? 1),
    PriceAction: profile.PriceAction * (factors.PriceAction ?? 1),
    Risk: profile.Risk * (factors.Risk ?? 1),
  });
}

function deriveRegimeProfile(
  baseProfile: AiScoreWeightProfile,
  regime: MarketRegime,
  assessment: ReturnType<typeof evaluateBacktestResult>,
) {
  const trendBias = clamp(1 + assessment.overallSignal * 0.32 + assessment.bucketEdge * 0.18, 0.9, 1.12);
  const momentumBias = clamp(1 + assessment.shortTermSignal * 0.42 + assessment.midBandSignal * 0.12, 0.9, 1.12);
  const volumeBias = clamp(1 + assessment.midBandSignal * 0.32 + assessment.bucketEdge * 0.08, 0.9, 1.12);
  const priceActionBias = clamp(1 + assessment.bucketEdge * 0.36 + assessment.shortTermSignal * 0.1, 0.9, 1.12);
  const riskBias = clamp(1 + (-assessment.riskSignal) * 0.5, 0.9, 1.12);

  switch (regime) {
    case "uptrend":
      return mixProfile(baseProfile, {
        Trend: trendBias * 1.08,
        Momentum: momentumBias * 1.05,
        Volume: volumeBias * 0.98,
        PriceAction: priceActionBias * 1.06,
        Risk: riskBias * 0.95,
      });
    case "downtrend":
      return mixProfile(baseProfile, {
        Trend: trendBias * 0.94,
        Momentum: momentumBias * 0.96,
        Volume: volumeBias * 1.02,
        PriceAction: priceActionBias * 0.95,
        Risk: riskBias * 1.08,
      });
    case "range":
      return mixProfile(baseProfile, {
        Trend: trendBias * 0.9,
        Momentum: momentumBias * 1.1,
        Volume: volumeBias * 1.08,
        PriceAction: priceActionBias * 1.04,
        Risk: riskBias * 1.02,
      });
    case "highVolatility":
      return mixProfile(baseProfile, {
        Trend: trendBias * 0.88,
        Momentum: momentumBias * 1.02,
        Volume: volumeBias * 1.05,
        PriceAction: priceActionBias * 0.9,
        Risk: riskBias * 1.12,
      });
    case "lowVolatility":
      return mixProfile(baseProfile, {
        Trend: trendBias * 1.1,
        Momentum: momentumBias * 0.95,
        Volume: volumeBias * 0.94,
        PriceAction: priceActionBias * 1.1,
        Risk: riskBias * 0.92,
      });
    default:
      return normalizeProfile(baseProfile);
  }
}

export function selectAiScoreWeightProfileForStock(
  stock: Pick<Stock, "baselineTrend" | "chartData" | "marketData" | "marketContext">,
  store?: Partial<AiScoreWeightStore> | null,
) {
  const normalizedStore = normalizeStore(store);
  const regime = inferMarketRegimeFromStock(stock);

  return {
    regime,
    profile: normalizedStore.regimes[regime] ?? normalizedStore.defaultProfile,
    store: normalizedStore,
  };
}

export function deriveAiScoreWeightProfileFromBacktest(
  result: AiScoreBacktestResult,
  currentProfile?: Partial<AiScoreWeightProfile> | null,
): AiScoreWeightProfile {
  const assessment = evaluateBacktestResult(result);
  const current = normalizeProfile(currentProfile);
  const shortHoldingReturn = average([holdingPerformance(result, 1), holdingPerformance(result, 3)], (item) => item.averageReturn);
  const longHoldingReturn = average([holdingPerformance(result, 10), holdingPerformance(result, 20)], (item) => item.averageReturn);
  const holdingBias = clamp((shortHoldingReturn - longHoldingReturn) / 40, -0.08, 0.08);
  const longBias = -holdingBias;
  const confidenceFactor = clamp(Math.log10(Math.max(assessment.metrics.totalTrades, 1) + 1) / 2, 0.45, 1);
  const trendSignal = assessment.overallSignal * 0.42 + assessment.bucketEdge * 0.48 + assessment.midBandSignal * 0.1 + longBias * 0.55;
  const momentumSignal = assessment.overallSignal * 0.38 + assessment.shortTermSignal * 0.76 + assessment.midBandSignal * 0.06 + holdingBias * 0.65;
  const volumeSignal = assessment.overallSignal * 0.26 + assessment.midBandSignal * 0.44 + assessment.bucketEdge * 0.1 + holdingBias * 0.4;
  const priceActionSignal = assessment.bucketEdge * 0.78 + assessment.overallSignal * 0.24 + assessment.shortTermSignal * 0.08 + longBias * 0.45;
  const riskSignal = (-assessment.riskSignal) + (assessment.metrics.maxDrawdown / 100) * 0.45 + Math.max(0, 1.25 - assessment.metrics.profitFactor) * 0.06;

  const trend = roundWeight(current.Trend * (1 + clamp(trendSignal * confidenceFactor, -0.14, 0.14)));
  const momentum = roundWeight(current.Momentum * (1 + clamp(momentumSignal * confidenceFactor, -0.14, 0.14)));
  const volume = roundWeight(current.Volume * (1 + clamp(volumeSignal * confidenceFactor, -0.1, 0.1)));
  const priceAction = roundWeight(current.PriceAction * (1 + clamp(priceActionSignal * confidenceFactor, -0.14, 0.14)));
  const risk = roundWeight(current.Risk * (1 + clamp(riskSignal * confidenceFactor, -0.12, 0.12)));

  const notes = [
    `winRate=${assessment.metrics.winRate.toFixed(2)}%`,
    `averageProfit=${assessment.metrics.averageProfit.toFixed(2)}%`,
    `profitFactor=${assessment.metrics.profitFactor.toFixed(2)}`,
    `maxDrawdown=${assessment.metrics.maxDrawdown.toFixed(2)}%`,
    `bucketSpread=${assessment.bucketEdge.toFixed(4)}`,
    `shortTerm=${assessment.shortTermSignal.toFixed(4)}`,
    `midBand=${assessment.midBandSignal.toFixed(4)}`,
    `holdingBias=${holdingBias.toFixed(4)}`,
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

export function deriveMarketRegimeWeightStoresFromBacktest(result: AiScoreBacktestResult, currentStore?: Partial<AiScoreWeightStore> | null) {
  const baseStore = normalizeStore(currentStore);
  const baseProfile = baseStore.defaultProfile;
  const derivedDefaultProfile = deriveAiScoreWeightProfileFromBacktest(result, baseProfile);
  const assessment = evaluateBacktestResult(result);
  const derivedRegimes = MARKET_REGIMES.reduce((accumulator, regime) => {
    const label = getMarketRegimeLabel(regime);
    const regimeProfile = deriveRegimeProfile(derivedDefaultProfile, regime, assessment);
    const regimeNotes = [`regime=${label}`, ...(derivedDefaultProfile.notes ?? [])];

    accumulator[regime] = normalizeProfile({
      ...regimeProfile,
      updatedAt: new Date().toISOString(),
      notes: regimeNotes,
    });
    return accumulator;
  }, {} as MarketRegimeWeightProfiles);

  return normalizeStore({
    version: 2,
    updatedAt: new Date().toISOString(),
    defaultProfile: derivedDefaultProfile,
    regimes: derivedRegimes,
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
  return loadAiScoreWeightStore(filePath).defaultProfile;
}

export function saveAiScoreWeightProfile(profile: AiScoreWeightProfile, filePath = resolveAiScoreWeightProfilePath()) {
  const fs = getFs();
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf8");
  return filePath;
}

export function loadAiScoreWeightStore(filePath = resolveAiScoreWeightProfilePath()) {
  const fs = getFs();

  if (!fs.existsSync(filePath)) {
    return DEFAULT_AI_SCORE_WEIGHT_STORE;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AiScoreWeightStore> & Partial<AiScoreWeightProfile>;
    if (parsed.version === 2 || parsed.regimes || parsed.defaultProfile) {
      return normalizeStore(parsed as Partial<AiScoreWeightStore>);
    }

    const legacyProfile = normalizeProfile(parsed as Partial<AiScoreWeightProfile>);
    return normalizeStore({
      version: 2,
      updatedAt: legacyProfile.updatedAt,
      defaultProfile: legacyProfile,
      regimes: MARKET_REGIMES.reduce((accumulator, regime) => {
        accumulator[regime] = legacyProfile;
        return accumulator;
      }, {} as MarketRegimeWeightProfiles),
    });
  } catch {
    return DEFAULT_AI_SCORE_WEIGHT_STORE;
  }
}

export function saveAiScoreWeightStore(store: AiScoreWeightStore, filePath = resolveAiScoreWeightProfilePath()) {
  const fs = getFs();
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalizeStore(store), null, 2), "utf8");
  return filePath;
}
