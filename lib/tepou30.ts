import { analyzeStock } from "./ai/scoreCalculator";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchJQuantsJson, JQuantsHttpError } from "./jquantsClient";
import { createMockChartData } from "./mockChartData";
import type {
  AiLearningProfile,
  AiScoreWeights,
  Stock,
  StockCandle,
  StockMarketData,
  Tepou30BacktestMetrics,
  StockTimeframe,
  Tepou30Item,
  Tepou30Response,
  Tepou30SortMode,
  Tepou30Status,
} from "./types";

type JpxMasterRow = Record<string, unknown>;
type JpxBarRow = Record<string, unknown>;

type Tepou30State = {
  status: Tepou30Status;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
  data: Tepou30Item[];
  optimizedWeights: AiScoreWeights;
  optimizedLearningProfile: AiLearningProfile;
  backtest?: Tepou30BacktestMetrics;
  total: number;
  analyzed: number;
  error?: string;
  running?: Promise<void>;
};

type UniverseCandidate = {
  code: string;
  meta: { name: string; sector: string };
  candles: StockCandle[];
};

type WeightHorizon = "5m" | "15m" | "1d";

type WeightHistoryEntry = {
  learnedAt: string;
  objective: number;
  weights: AiScoreWeights;
  learningProfile: AiLearningProfile;
  backtest: Tepou30BacktestMetrics;
};

type HorizonLearningState = {
  bestObjective: number;
  bestWeights: AiScoreWeights;
  bestLearningProfile: AiLearningProfile;
  latestBacktest: Tepou30BacktestMetrics;
  history: WeightHistoryEntry[];
};

type WeightLearningStore = {
  byHorizon: Record<WeightHorizon, HorizonLearningState>;
};

const CACHE_TTL_MS = 15 * 60 * 1000;
const TARGET_UNIVERSE_SIZE = 4000;
const TARGET_CANDLE_DAYS = 90;
const BACKTEST_PERIOD_DAYS = 252;
const MAX_STORED_CANDLES = 320;
const MAX_DATE_CALLS = 40;
const OPTIMIZATION_CANDIDATE_LIMIT = 700;
const FINAL_SCORING_CANDIDATE_LIMIT = 1400;
const JQUANTS_BASE = "https://api.jquants.com/v2";
const JQUANTS_BACKOFF_MS = 800;
const RATE_LIMIT_COOLDOWN_MS = 20 * 60 * 1000;
const CACHE_DIR = path.join(process.cwd(), ".cache");
const LEARNING_STORE_PATH = path.join(CACHE_DIR, "tepou30-weights.json");
const HORIZONS: WeightHorizon[] = ["5m", "15m", "1d"];
const WEIGHT_HISTORY_LIMIT = 30;

const DEFAULT_OPTIMIZED_WEIGHTS: AiScoreWeights = {
  rsi: 1,
  macd: 1.05,
  ma5: 0.95,
  ma25: 1,
  ma75: 1,
  adx: 1,
  atr: 0.9,
  bollinger: 0.9,
  supportResistance: 0.95,
  volumeRatio: 0.95,
  volumeSpike: 1,
  trendStrength: 1.05,
  lossRisk: 1.15,
  probabilityUp: 1.1,
};

const DEFAULT_LEARNING_PROFILE: AiLearningProfile = {
  technicalWeight: 1,
  newsWeight: 1,
  volumeWeight: 1,
  gapWeight: 1,
};

const EMPTY_BACKTEST: Tepou30BacktestMetrics = {
  periodDays: BACKTEST_PERIOD_DAYS,
  totalTrades: 0,
  winRate: 0,
  averageProfit: 0,
  averageLoss: 0,
  expectedValuePercent: 0,
  averageReturn: 0,
  maxDrawdown: 0,
  profitFactor: 0,
  sharpeRatio: 0,
};

function getBacktestConfig(horizon: WeightHorizon) {
  if (horizon === "5m") {
    return { periodDays: 252, holdDays: 1, step: 1 };
  }

  if (horizon === "15m") {
    return { periodDays: 252, holdDays: 3, step: 2 };
  }

  return { periodDays: 252, holdDays: 5, step: 5 };
}

function getDefaultLearningStore(): WeightLearningStore {
  return {
    byHorizon: {
      "5m": {
        bestObjective: Number.NEGATIVE_INFINITY,
        bestWeights: { ...DEFAULT_OPTIMIZED_WEIGHTS },
        bestLearningProfile: { ...DEFAULT_LEARNING_PROFILE },
        latestBacktest: { ...EMPTY_BACKTEST },
        history: [],
      },
      "15m": {
        bestObjective: Number.NEGATIVE_INFINITY,
        bestWeights: { ...DEFAULT_OPTIMIZED_WEIGHTS },
        bestLearningProfile: { ...DEFAULT_LEARNING_PROFILE },
        latestBacktest: { ...EMPTY_BACKTEST },
        history: [],
      },
      "1d": {
        bestObjective: Number.NEGATIVE_INFINITY,
        bestWeights: { ...DEFAULT_OPTIMIZED_WEIGHTS },
        bestLearningProfile: { ...DEFAULT_LEARNING_PROFILE },
        latestBacktest: { ...EMPTY_BACKTEST },
        history: [],
      },
    },
  };
}

const stateByTimeframe = new Map<StockTimeframe, Tepou30State>();

class RateLimitError extends Error {
  retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizeWeights(weights?: Partial<AiScoreWeights>): AiScoreWeights {
  return {
    rsi: weights?.rsi ?? DEFAULT_OPTIMIZED_WEIGHTS.rsi,
    macd: weights?.macd ?? DEFAULT_OPTIMIZED_WEIGHTS.macd,
    ma5: weights?.ma5 ?? DEFAULT_OPTIMIZED_WEIGHTS.ma5,
    ma25: weights?.ma25 ?? DEFAULT_OPTIMIZED_WEIGHTS.ma25,
    ma75: weights?.ma75 ?? DEFAULT_OPTIMIZED_WEIGHTS.ma75,
    adx: weights?.adx ?? DEFAULT_OPTIMIZED_WEIGHTS.adx,
    atr: weights?.atr ?? DEFAULT_OPTIMIZED_WEIGHTS.atr,
    bollinger: weights?.bollinger ?? DEFAULT_OPTIMIZED_WEIGHTS.bollinger,
    supportResistance: weights?.supportResistance ?? DEFAULT_OPTIMIZED_WEIGHTS.supportResistance,
    volumeRatio: weights?.volumeRatio ?? DEFAULT_OPTIMIZED_WEIGHTS.volumeRatio,
    volumeSpike: weights?.volumeSpike ?? DEFAULT_OPTIMIZED_WEIGHTS.volumeSpike,
    trendStrength: weights?.trendStrength ?? DEFAULT_OPTIMIZED_WEIGHTS.trendStrength,
    lossRisk: weights?.lossRisk ?? DEFAULT_OPTIMIZED_WEIGHTS.lossRisk,
    probabilityUp: weights?.probabilityUp ?? DEFAULT_OPTIMIZED_WEIGHTS.probabilityUp,
  };
}

function normalizeLearningProfile(profile?: Partial<AiLearningProfile>): AiLearningProfile {
  return {
    technicalWeight: clamp(profile?.technicalWeight ?? DEFAULT_LEARNING_PROFILE.technicalWeight, 0.6, 1.8),
    newsWeight: clamp(profile?.newsWeight ?? DEFAULT_LEARNING_PROFILE.newsWeight, 0.6, 2),
    volumeWeight: clamp(profile?.volumeWeight ?? DEFAULT_LEARNING_PROFILE.volumeWeight, 0.6, 1.8),
    gapWeight: clamp(profile?.gapWeight ?? DEFAULT_LEARNING_PROFILE.gapWeight, 0.6, 1.8),
  };
}

function rankingCompositeScore(item: Tepou30Item) {
  const expectedReturn = ((item.takeProfitPrice - item.entryPrice) / Math.max(item.entryPrice, 1)) * 100;
  const expectedLoss = ((item.entryPrice - item.stopLossPrice) / Math.max(item.entryPrice, 1)) * 100;
  const rr = expectedLoss > 0 ? expectedReturn / expectedLoss : 0;
  const expectancy = item.expectedValuePercent;
  const winRateComponent = item.winRate;
  const scoreComponent = item.score;
  const confidenceComponent = item.confidence;
  const lossRiskComponent = clamp(100 - item.lossRiskPercent * 10, 0, 100);
  const expectancyComponent = clamp(expectancy * 14 + rr * 9 + 48, 0, 100);
  const downsidePenalty = item.lossRiskPercent >= 5.5 ? 8 : item.lossRiskPercent >= 4.5 ? 4 : 0;
  const qualityBonus = item.expectedValuePercent >= 1.2 && item.winRate >= 60 ? 4 : 0;
  const rrComponent = clamp(rr * 30, 0, 100);
  const probabilityBlend = clamp(item.probability5m * 0.2 + item.probability15m * 0.35 + item.probability1d * 0.45, 0, 100);
  const probabilityConsistency = clamp(100 - Math.abs(item.probability5m - item.probability1d) * 1.4, 0, 100);
  const riskAdjustedExpectancy = clamp(item.expectedValuePercent * 14 - item.lossRiskPercent * 3 + 60, 0, 100);
  const edgeScore = clamp((item.winRate - 50) * 2 + item.expectedValuePercent * 8 + rr * 10 + 50, 0, 100);
  const p15Component = item.probability15m;
  const p5Component = item.probability5m;
  const p1dComponent = item.probability1d;

  return (
    expectancyComponent * 0.24
    + riskAdjustedExpectancy * 0.17
    + winRateComponent * 0.17
    + probabilityBlend * 0.12
    + edgeScore * 0.11
    + rrComponent * 0.08
    + probabilityConsistency * 0.06
    + scoreComponent * 0.05
    + confidenceComponent * 0.06
    + lossRiskComponent * 0.04
    + p1dComponent * 0.01
    + p15Component * 0.005
    + p5Component * 0.005
    + qualityBonus
    - downsidePenalty
  );
}

function dayTraderCompositeScore(item: Tepou30Item) {
  const riskBuffer = clamp(100 - item.lossRiskPercent * 11, 0, 100);
  const probabilityEdge = clamp(item.probability5m * 0.46 + item.probability15m * 0.28, 0, 100);

  return clamp(
    probabilityEdge * 0.58
    + item.winRate * 0.16
    + riskBuffer * 0.12
    + item.expectedValuePercent * 8
    + item.score * 0.04,
    0,
    100,
  );
}

function rankTepou30Items(items: Tepou30Item[], sortMode: Tepou30SortMode = "ai-total") {
  return [...items]
    .sort((left, right) => {
      if (sortMode === "ai-total") {
        const rightComposite = rankingCompositeScore(right);
        const leftComposite = rankingCompositeScore(left);

        if (rightComposite !== leftComposite) {
          return rightComposite - leftComposite;
        }

        if (right.expectedValuePercent !== left.expectedValuePercent) {
          return right.expectedValuePercent - left.expectedValuePercent;
        }

        if (right.winRate !== left.winRate) {
          return right.winRate - left.winRate;
        }

        if (right.confidence !== left.confidence) {
          return right.confidence - left.confidence;
        }

        if (right.score !== left.score) {
          return right.score - left.score;
        }

        if (left.lossRiskPercent !== right.lossRiskPercent) {
          return left.lossRiskPercent - right.lossRiskPercent;
        }

        return dayTraderCompositeScore(right) - dayTraderCompositeScore(left);
      }

      if (sortMode === "win-rate") {
        if (right.winRate !== left.winRate) {
          return right.winRate - left.winRate;
        }

        if (right.expectedValuePercent !== left.expectedValuePercent) {
          return right.expectedValuePercent - left.expectedValuePercent;
        }

        if (right.confidence !== left.confidence) {
          return right.confidence - left.confidence;
        }

        if (right.score !== left.score) {
          return right.score - left.score;
        }

        if (left.lossRiskPercent !== right.lossRiskPercent) {
          return left.lossRiskPercent - right.lossRiskPercent;
        }

        return dayTraderCompositeScore(right) - dayTraderCompositeScore(left);
      }

      if (sortMode === "risk-reward" || sortMode === "day-trader") {
        const rightComposite = dayTraderCompositeScore(right);
        const leftComposite = dayTraderCompositeScore(left);

        if (rightComposite !== leftComposite) {
          return rightComposite - leftComposite;
        }

        if (right.probability5m !== left.probability5m) {
          return right.probability5m - left.probability5m;
        }

        if (right.probability15m !== left.probability15m) {
          return right.probability15m - left.probability15m;
        }

        if (right.winRate !== left.winRate) {
          return right.winRate - left.winRate;
        }

        if (right.expectedValuePercent !== left.expectedValuePercent) {
          return right.expectedValuePercent - left.expectedValuePercent;
        }

        if (left.lossRiskPercent !== right.lossRiskPercent) {
          return left.lossRiskPercent - right.lossRiskPercent;
        }

        return right.score - left.score;
      }

      if (right.expectedValuePercent !== left.expectedValuePercent) {
        return right.expectedValuePercent - left.expectedValuePercent;
      }

      if (right.winRate !== left.winRate) {
        return right.winRate - left.winRate;
      }

      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }

      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (left.lossRiskPercent !== right.lossRiskPercent) {
        return left.lossRiskPercent - right.lossRiskPercent;
      }

      const rightComposite = rankingCompositeScore(right);
      const leftComposite = rankingCompositeScore(left);

      if (rightComposite !== leftComposite) {
        return rightComposite - leftComposite;
      }

      return dayTraderCompositeScore(right) - dayTraderCompositeScore(left);
    })
    .map((item, index) => ({
      ...item,
      rank: index + 1,
    }));
}

function buildTradeReturn(
  candles: StockCandle[],
  entryIndex: number,
  takeProfit: number,
  stopLoss: number,
  holdDays: number,
) {
  const entry = candles[entryIndex]?.close;
  if (!entry || entry <= 0) {
    return null;
  }

  const lastIndex = Math.min(candles.length - 1, entryIndex + holdDays);
  let exit = candles[lastIndex].close;

  for (let index = entryIndex + 1; index <= lastIndex; index += 1) {
    const candle = candles[index];

    if (candle.low <= stopLoss) {
      exit = stopLoss;
      break;
    }

    if (candle.high >= takeProfit) {
      exit = takeProfit;
      break;
    }
  }

  return (exit - entry) / entry;
}

function calculateBacktestMetrics(returns: number[], periodDays: number, step: number): Tepou30BacktestMetrics {
  if (returns.length === 0) {
    return {
      ...EMPTY_BACKTEST,
      periodDays,
    };
  }

  const wins = returns.filter((value) => value > 0).length;
  const winsList = returns.filter((value) => value > 0);
  const lossesList = returns.filter((value) => value < 0);
  const average = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const positive = winsList.reduce((sum, value) => sum + value, 0);
  const negative = Math.abs(lossesList.reduce((sum, value) => sum + value, 0));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    const drawdown = (peak - equity) / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const variance = returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, returns.length - 1);
  const deviation = Math.sqrt(variance);
  const sharpe = deviation > 0 ? (average / deviation) * Math.sqrt(252 / step) : 0;

  return {
    periodDays,
    totalTrades: returns.length,
    winRate: round2((wins / returns.length) * 100),
    averageProfit: round2(winsList.length > 0 ? (positive / winsList.length) * 100 : 0),
    averageLoss: round2(lossesList.length > 0 ? Math.abs(lossesList.reduce((sum, value) => sum + value, 0) / lossesList.length) * 100 : 0),
    expectedValuePercent: round2(((wins / returns.length) * (winsList.length > 0 ? (positive / winsList.length) * 100 : 0)) - (((returns.length - wins) / returns.length) * (lossesList.length > 0 ? Math.abs(lossesList.reduce((sum, value) => sum + value, 0) / lossesList.length) * 100 : 0))),
    averageReturn: round2(average * 100),
    maxDrawdown: round2(maxDrawdown * 100),
    profitFactor: round2(negative > 0 ? positive / negative : positive > 0 ? 9.99 : 0),
    sharpeRatio: round2(sharpe),
  };
}

function runBacktest(
  ranked: Tepou30Item[],
  candidateMap: Map<string, UniverseCandidate>,
  timeframe: StockTimeframe,
  weights: AiScoreWeights,
  learningProfile: AiLearningProfile,
  horizon: WeightHorizon,
) {
  const config = getBacktestConfig(horizon);
  const top = ranked.slice(0, 30);
  const returns: number[] = [];

  for (const item of top) {
    const candidate = candidateMap.get(item.code);
    if (!candidate || candidate.candles.length < TARGET_CANDLE_DAYS + config.holdDays + 1) {
      continue;
    }

    const start = Math.max(TARGET_CANDLE_DAYS, candidate.candles.length - config.periodDays);

    for (let index = start; index < candidate.candles.length - config.holdDays; index += config.step) {
      const sliceStart = Math.max(0, index - TARGET_CANDLE_DAYS + 1);
      const window = candidate.candles.slice(sliceStart, index + 1);
      const stock = buildStockFromCandles(item.code, window, candidate.meta, timeframe);

      if (!stock) {
        continue;
      }

      const analysis = analyzeStock({ query: item.code, stock }, { weights, learningProfile });
      if (analysis.score < 56 || analysis.signal === "SELL") {
        continue;
      }

      const tradeReturn = buildTradeReturn(
        candidate.candles,
        index,
        analysis.takeProfitPrice,
        analysis.stopLossPrice,
        config.holdDays,
      );
      if (tradeReturn === null) {
        continue;
      }

      returns.push(tradeReturn);
    }
  }

  return calculateBacktestMetrics(returns, config.periodDays, config.step);
}

function buildWeightProfiles(seedWeights: AiScoreWeights[] = []): AiScoreWeights[] {
  const profiles = [
    normalizeWeights(DEFAULT_OPTIMIZED_WEIGHTS),
    normalizeWeights({ ...DEFAULT_OPTIMIZED_WEIGHTS, probabilityUp: 1.25, lossRisk: 1.3, trendStrength: 1.15, atr: 1.05 }),
    normalizeWeights({ ...DEFAULT_OPTIMIZED_WEIGHTS, rsi: 1.2, macd: 1.2, ma5: 1.05, ma25: 1.1, ma75: 1.1 }),
    normalizeWeights({ ...DEFAULT_OPTIMIZED_WEIGHTS, adx: 1.2, bollinger: 1.1, supportResistance: 1.15, probabilityUp: 1.2 }),
    normalizeWeights({ ...DEFAULT_OPTIMIZED_WEIGHTS, volumeRatio: 1.2, volumeSpike: 1.25, macd: 1.1, probabilityUp: 1.15 }),
    normalizeWeights({ ...DEFAULT_OPTIMIZED_WEIGHTS, lossRisk: 1.4, atr: 1.2, probabilityUp: 1.2, trendStrength: 1.2 }),
  ];

  const merged = [...seedWeights.map((weights) => normalizeWeights(weights)), ...profiles];

  const mutated = seedWeights.flatMap((weights, index) => {
    const factor = index < 3 ? 1.1 : 1.06;
    return [
      normalizeWeights({
        ...weights,
        probabilityUp: weights.probabilityUp * factor,
        lossRisk: weights.lossRisk * factor,
        macd: weights.macd * (1 + (factor - 1) * 0.6),
        rsi: weights.rsi * (1 + (factor - 1) * 0.5),
      }),
      normalizeWeights({
        ...weights,
        trendStrength: weights.trendStrength * factor,
        adx: weights.adx * (1 + (factor - 1) * 0.7),
        ma25: weights.ma25 * (1 + (factor - 1) * 0.45),
        ma75: weights.ma75 * (1 + (factor - 1) * 0.45),
      }),
      normalizeWeights({
        ...weights,
        volumeRatio: weights.volumeRatio * factor,
        volumeSpike: weights.volumeSpike * (1 + (factor - 1) * 0.8),
        bollinger: weights.bollinger * (1 + (factor - 1) * 0.5),
        supportResistance: weights.supportResistance * (1 + (factor - 1) * 0.55),
      }),
    ];
  });

  const mergedWithMutation = [...merged, ...mutated];
  const unique = new Map<string, AiScoreWeights>();

  for (const weights of mergedWithMutation) {
    const key = JSON.stringify(weights);
    if (!unique.has(key)) {
      unique.set(key, weights);
    }
  }

  return [...unique.values()];
}

function buildLearningProfiles(seedProfiles: AiLearningProfile[] = []): AiLearningProfile[] {
  const profiles = [
    normalizeLearningProfile(DEFAULT_LEARNING_PROFILE),
    normalizeLearningProfile({ technicalWeight: 1.05, newsWeight: 1.2, volumeWeight: 1.1, gapWeight: 1.05 }),
    normalizeLearningProfile({ technicalWeight: 0.95, newsWeight: 1.35, volumeWeight: 1.15, gapWeight: 1.1 }),
    normalizeLearningProfile({ technicalWeight: 1.1, newsWeight: 1.05, volumeWeight: 1.25, gapWeight: 1.15 }),
    normalizeLearningProfile({ technicalWeight: 1.08, newsWeight: 1.1, volumeWeight: 1.2, gapWeight: 1.2 }),
  ];

  const merged = [...seedProfiles.map((profile) => normalizeLearningProfile(profile)), ...profiles];
  const unique = new Map<string, AiLearningProfile>();

  for (const profile of merged) {
    const key = JSON.stringify(profile);
    if (!unique.has(key)) {
      unique.set(key, profile);
    }
  }

  return [...unique.values()];
}

function optimizeWeights(
  candidates: UniverseCandidate[],
  timeframe: StockTimeframe,
  horizon: WeightHorizon,
  preferredWeights: AiScoreWeights[],
  preferredLearningProfiles: AiLearningProfile[],
) {
  const weightProfiles = buildWeightProfiles(preferredWeights);
  const learningProfiles = buildLearningProfiles(preferredLearningProfiles);
  const candidateMap = new Map(candidates.map((candidate) => [candidate.code, candidate]));

  let bestWeights = weightProfiles[0];
  let bestLearningProfile = learningProfiles[0];
  let bestBacktest: Tepou30BacktestMetrics = { ...EMPTY_BACKTEST };
  let bestObjective = -Infinity;

  for (const weights of weightProfiles) {
    for (const learningProfile of learningProfiles) {
      const scoredItems = candidates
      .map((candidate) => {
        const stock = buildStockFromCandles(candidate.code, candidate.candles, candidate.meta, timeframe);
        if (!stock) {
          return null;
        }

        const result = analyzeStock({ query: candidate.code, stock }, { weights, learningProfile });
        return {
          rank: 0,
          code: candidate.code,
          name: result.name,
          sector: result.sector,
          score: result.score,
          judgment: result.judgment,
          probability5m: result.probability5m,
          probability15m: result.probability15m,
          probability1d: result.probability1d,
          entryPrice: result.entryPrice,
          takeProfitPrice: result.takeProfitPrice,
          stopLossPrice: result.stopLossPrice,
          lossRiskPercent: result.lossRiskPercent,
          expectedValuePercent: result.expectedValuePercent,
          winRate: Math.round(result.probability5m * 0.2 + result.probability15m * 0.35 + result.probability1d * 0.45),
          confidence: result.confidence,
        } satisfies Tepou30Item;
      })
      .filter((item): item is Tepou30Item => Boolean(item));

      const ranked = rankTepou30Items(scoredItems);
      const backtest = runBacktest(ranked, candidateMap, timeframe, weights, learningProfile, horizon);
      const objective = backtestObjective(backtest);

      if (objective > bestObjective) {
        bestObjective = objective;
        bestWeights = weights;
        bestLearningProfile = learningProfile;
        bestBacktest = backtest;
      }
    }
  }

  return {
    weights: bestWeights,
    learningProfile: bestLearningProfile,
    backtest: bestBacktest,
    objective: bestObjective,
  };
}

function cacheFilePath(timeframe: StockTimeframe) {
  return path.join(CACHE_DIR, `tepou30-${timeframe}.json`);
}

function normalizeCachedItems(items: unknown[]): Tepou30Item[] {
  return items
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item, index) => {
      const entryPrice = parseNumber(item.entryPrice) ?? 0;
      const stopLossPrice = parseNumber(item.stopLossPrice) ?? Math.max(1, entryPrice * 0.97);
      const inferredLossRisk = entryPrice > 0 ? ((entryPrice - stopLossPrice) / entryPrice) * 100 : 0;

      return {
        rank: parseNumber(item.rank) ?? index + 1,
        code: typeof item.code === "string" ? item.code : "",
        name: typeof item.name === "string" ? item.name : "",
        sector: typeof item.sector === "string" ? item.sector : "未分類",
        score: parseNumber(item.score) ?? 0,
        judgment: (typeof item.judgment === "string" ? item.judgment : "様子見") as Tepou30Item["judgment"],
        probability5m: parseNumber(item.probability5m) ?? 0,
        probability15m: parseNumber(item.probability15m) ?? 0,
        probability1d: parseNumber(item.probability1d) ?? parseNumber(item.probability15m) ?? 0,
        entryPrice,
        takeProfitPrice: parseNumber(item.takeProfitPrice) ?? entryPrice,
        stopLossPrice,
        lossRiskPercent: parseNumber(item.lossRiskPercent) ?? Number(inferredLossRisk.toFixed(2)),
        expectedValuePercent: parseNumber(item.expectedValuePercent) ?? 0,
        winRate: parseNumber(item.winRate) ?? 0,
        confidence: parseNumber(item.confidence) ?? 0,
      };
    })
    .filter((item) => item.code.length > 0 && item.entryPrice > 0);
}

function normalizeBacktest(backtest: unknown): Tepou30BacktestMetrics | undefined {
  if (!backtest || typeof backtest !== "object") {
    return undefined;
  }

  const record = backtest as Record<string, unknown>;
  const averageProfit = parseNumber(record.averageProfit) ?? 0;
  const averageLoss = parseNumber(record.averageLoss) ?? 0;
  const expectedValuePercent = parseNumber(record.expectedValuePercent) ?? parseNumber(record.averageReturn) ?? 0;
  return {
    periodDays: parseNumber(record.periodDays) ?? BACKTEST_PERIOD_DAYS,
    totalTrades: parseNumber(record.totalTrades) ?? 0,
    winRate: parseNumber(record.winRate) ?? 0,
    averageProfit,
    averageLoss,
    expectedValuePercent,
    averageReturn: parseNumber(record.averageReturn) ?? expectedValuePercent,
    maxDrawdown: parseNumber(record.maxDrawdown) ?? 0,
    profitFactor: parseNumber(record.profitFactor) ?? 0,
    sharpeRatio: parseNumber(record.sharpeRatio) ?? 0,
  };
}

function normalizeHistoryEntry(entry: unknown): WeightHistoryEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const learnedAt = typeof record.learnedAt === "string" ? record.learnedAt : new Date().toISOString();
  const objective = parseNumber(record.objective) ?? Number.NEGATIVE_INFINITY;
  const weights = normalizeWeights(record.weights as Partial<AiScoreWeights> | undefined);
  const learningProfile = normalizeLearningProfile(record.learningProfile as Partial<AiLearningProfile> | undefined);
  const backtest = normalizeBacktest(record.backtest) ?? { ...EMPTY_BACKTEST };

  return {
    learnedAt,
    objective,
    weights,
    learningProfile,
    backtest,
  };
}

async function loadLearningStore(): Promise<WeightLearningStore> {
  try {
    const raw = await readFile(LEARNING_STORE_PATH, "utf-8");
    const json = JSON.parse(raw.replace(/^\uFEFF/, "")) as Partial<WeightLearningStore>;
    const defaults = getDefaultLearningStore();

    for (const horizon of HORIZONS) {
      const source = json.byHorizon?.[horizon] as Partial<HorizonLearningState> | undefined;
      if (!source) {
        continue;
      }

      const history = Array.isArray(source.history)
        ? source.history
          .map((entry) => normalizeHistoryEntry(entry))
          .filter((entry): entry is WeightHistoryEntry => Boolean(entry))
          .sort((left, right) => right.objective - left.objective)
          .slice(0, WEIGHT_HISTORY_LIMIT)
        : [];

      defaults.byHorizon[horizon] = {
        bestObjective: parseNumber(source.bestObjective) ?? history[0]?.objective ?? Number.NEGATIVE_INFINITY,
        bestWeights: normalizeWeights(source.bestWeights as Partial<AiScoreWeights> | undefined),
        bestLearningProfile: normalizeLearningProfile(source.bestLearningProfile as Partial<AiLearningProfile> | undefined),
        latestBacktest: normalizeBacktest(source.latestBacktest) ?? history[0]?.backtest ?? { ...EMPTY_BACKTEST },
        history,
      };

      if (history[0] && history[0].objective > defaults.byHorizon[horizon].bestObjective) {
        defaults.byHorizon[horizon].bestObjective = history[0].objective;
        defaults.byHorizon[horizon].bestWeights = history[0].weights;
        defaults.byHorizon[horizon].bestLearningProfile = history[0].learningProfile;
        defaults.byHorizon[horizon].latestBacktest = history[0].backtest;
      }
    }

    return defaults;
  } catch {
    return getDefaultLearningStore();
  }
}

async function saveLearningStore(store: WeightLearningStore) {
  if (process.env.VERCEL) {
    return;
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(
    LEARNING_STORE_PATH,
    JSON.stringify(store),
    "utf-8"
  );
}

function getPreferredHistoricalWeights(store: WeightLearningStore, horizon: WeightHorizon) {
  const state = store.byHorizon[horizon];
  return state.history.slice(0, 8).map((entry) => {
    const winRateBoost = entry.backtest.winRate >= 58 ? 1.05 : entry.backtest.winRate <= 46 ? 0.96 : 1;
    const expectancyBoost = entry.backtest.expectedValuePercent >= 0.8 ? 1.07 : entry.backtest.expectedValuePercent <= 0 ? 0.94 : 1;
    const ddPenalty = entry.backtest.maxDrawdown >= 12 ? 1.1 : entry.backtest.maxDrawdown >= 8 ? 1.05 : 1;

    return normalizeWeights({
      ...entry.weights,
      probabilityUp: entry.weights.probabilityUp * winRateBoost * expectancyBoost,
      trendStrength: entry.weights.trendStrength * expectancyBoost,
      lossRisk: entry.weights.lossRisk * ddPenalty,
      atr: entry.weights.atr * ddPenalty,
      supportResistance: entry.weights.supportResistance * (ddPenalty > 1 ? 1.03 : 1),
    });
  });
}

function getPreferredHistoricalLearningProfiles(store: WeightLearningStore, horizon: WeightHorizon) {
  const state = store.byHorizon[horizon];
  return state.history.slice(0, 8).map((entry) => {
    const winRateBias = entry.backtest.winRate >= 58 ? 1.08 : entry.backtest.winRate <= 46 ? 0.94 : 1;
    const expectancyBias = entry.backtest.expectedValuePercent >= 0.8 ? 1.1 : entry.backtest.expectedValuePercent <= 0 ? 0.92 : 1;
    const drawdownBias = entry.backtest.maxDrawdown >= 12 ? 1.15 : entry.backtest.maxDrawdown >= 8 ? 1.08 : 1;

    return normalizeLearningProfile({
      ...entry.learningProfile,
      technicalWeight: entry.learningProfile.technicalWeight * (drawdownBias > 1 ? 0.98 : 1.02),
      newsWeight: entry.learningProfile.newsWeight * expectancyBias,
      volumeWeight: entry.learningProfile.volumeWeight * winRateBias,
      gapWeight: entry.learningProfile.gapWeight * (expectancyBias * 0.5 + drawdownBias * 0.5),
    });
  });
}

function registerLearningResult(
  store: WeightLearningStore,
  horizon: WeightHorizon,
  weights: AiScoreWeights,
  learningProfile: AiLearningProfile,
  backtest: Tepou30BacktestMetrics,
  objective: number,
) {
  const state = store.byHorizon[horizon];
  const entry: WeightHistoryEntry = {
    learnedAt: new Date().toISOString(),
    objective,
    weights,
    learningProfile,
    backtest,
  };

  const history = [entry, ...state.history]
    .sort((left, right) => right.objective - left.objective)
    .slice(0, WEIGHT_HISTORY_LIMIT);

  state.history = history;
  state.latestBacktest = backtest;

  if (objective > state.bestObjective) {
    state.bestObjective = objective;
    state.bestWeights = weights;
    state.bestLearningProfile = learningProfile;
  }
}

function backtestObjective(backtest: Tepou30BacktestMetrics) {
  return backtest.winRate * 0.92
    + backtest.expectedValuePercent * 1.35
    + backtest.averageProfit * 0.24
    - backtest.averageLoss * 0.42
    + backtest.sharpeRatio * 4.8
    + backtest.profitFactor * 2.5
    - backtest.maxDrawdown * 0.7;
}

async function persistStateLearningSnapshot(timeframe: StockTimeframe, state: Tepou30State) {
  const store = await loadLearningStore();
  const horizon: WeightHorizon = timeframe === "5m" ? "5m" : timeframe === "15m" ? "15m" : "1d";
  const backtest = state.backtest ?? { ...EMPTY_BACKTEST };

  registerLearningResult(
    store,
    horizon,
    state.optimizedWeights,
    state.optimizedLearningProfile,
    backtest,
    backtestObjective(backtest),
  );

  if (timeframe !== "15m" && store.byHorizon["15m"].history.length === 0) {
    registerLearningResult(
      store,
      "15m",
      state.optimizedWeights,
      state.optimizedLearningProfile,
      backtest,
      backtestObjective(backtest),
    );
  }

  await saveLearningStore(store);
}

async function loadCacheFromDisk(timeframe: StockTimeframe): Promise<Tepou30State | null> {
  try {
    const raw = await readFile(cacheFilePath(timeframe), "utf-8");
    const json = JSON.parse(raw.replace(/^\uFEFF/, "")) as Partial<Tepou30Response>;
    const items = Array.isArray(json.data) ? normalizeCachedItems(json.data as unknown[]) : [];
    const updatedAt = typeof json.updatedAt === "string" ? Date.parse(json.updatedAt) : NaN;

    if (!items.length || !Number.isFinite(updatedAt)) {
      return null;
    }

    return {
      status: "ready",
      startedAt: 0,
      updatedAt,
      expiresAt: updatedAt + CACHE_TTL_MS,
      data: items,
      optimizedWeights: normalizeWeights(json.optimizedWeights),
      optimizedLearningProfile: normalizeLearningProfile(json.optimizedLearningProfile as Partial<AiLearningProfile> | undefined),
      backtest: normalizeBacktest(json.backtest) ?? { ...EMPTY_BACKTEST },
      total: json.progress?.total ?? TARGET_UNIVERSE_SIZE,
      analyzed: json.progress?.analyzed ?? items.length,
    };
  } catch {
    return null;
  }
}

async function saveCacheToDisk(timeframe: StockTimeframe, state: Tepou30State) {
  await mkdir(CACHE_DIR, { recursive: true });

  const payload: Tepou30Response = {
    success: true,
    status: "ready",
    data: state.data,
    optimizedWeights: state.optimizedWeights,
    optimizedLearningProfile: state.optimizedLearningProfile,
    backtest: state.backtest,
    updatedAt: new Date(state.updatedAt).toISOString(),
    progress: {
      total: state.total,
      analyzed: state.analyzed,
    },
    error: undefined,
  };

  await writeFile(cacheFilePath(timeframe), JSON.stringify(payload), "utf-8");
}

function hydrateStateFromCache(state: Tepou30State, cached: Tepou30State) {
  state.status = "ready";
  state.data = cached.data;
  state.updatedAt = cached.updatedAt;
  state.expiresAt = cached.expiresAt;
  state.total = cached.total;
  state.analyzed = cached.analyzed;
  state.optimizedWeights = cached.optimizedWeights;
  state.optimizedLearningProfile = cached.optimizedLearningProfile;
  state.backtest = cached.backtest;
}

function getInitialState(): Tepou30State {
  return {
    status: "idle",
    startedAt: 0,
    updatedAt: 0,
    expiresAt: 0,
    data: [],
    optimizedWeights: { ...DEFAULT_OPTIMIZED_WEIGHTS },
    optimizedLearningProfile: { ...DEFAULT_LEARNING_PROFILE },
    backtest: { ...EMPTY_BACKTEST },
    total: 0,
    analyzed: 0,
  };
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const text = String(value).replace(/\D/g, "");

  if (/^\d{4}$/.test(text)) {
    return text;
  }

  if (/^\d{5}$/.test(text)) {
    return text.slice(0, 4);
  }

  return null;
}

function computeFastCandidateScore(candles: StockCandle[]) {
  if (candles.length < 30) {
    return Number.NEGATIVE_INFINITY;
  }

  const sorted = [...candles].sort((left, right) => left.time.localeCompare(right.time));
  const recent = sorted.slice(-25);
  const latest = recent[recent.length - 1];
  const shortBase = recent[Math.max(0, recent.length - 6)]?.close ?? latest.close;
  const midBase = recent[0]?.close ?? latest.close;
  const shortTrend = shortBase > 0 ? ((latest.close - shortBase) / shortBase) * 100 : 0;
  const midTrend = midBase > 0 ? ((latest.close - midBase) / midBase) * 100 : 0;
  const avgVolume = recent.reduce((sum, candle) => sum + candle.volume, 0) / Math.max(1, recent.length);
  const volumeRatio = avgVolume > 0 ? latest.volume / avgVolume : 1;
  const volatility = latest.close > 0 ? ((latest.high - latest.low) / latest.close) * 100 : 0;

  return shortTrend * 0.6 + midTrend * 0.3 + volumeRatio * 6 - volatility * 0.4;
}

function preselectCandidates(candidates: UniverseCandidate[], limit: number) {
  if (candidates.length <= limit) {
    return candidates;
  }

  return [...candidates]
    .map((candidate) => ({
      candidate,
      score: computeFastCandidateScore(candidate.candles),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function buildMasterFallbackFromCache() {
  const map = new Map<string, { name: string; sector: string }>();

  for (const state of stateByTimeframe.values()) {
    for (const item of state.data) {
      map.set(item.code, {
        name: item.name || item.code,
        sector: item.sector || "未分類",
      });
    }
  }

  const defaults = ["1306", "1570", "1605", "2914", "3382", "4063", "4502", "6501", "6758", "7203", "8058", "9432", "9984"];
  for (const code of defaults) {
    if (!map.has(code)) {
      map.set(code, { name: code, sector: "未分類" });
    }
  }

  return map;
}

function parseMasterRows(rows: unknown[]) {
  const map = new Map<string, { name: string; sector: string }>();

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }

    const record = row as JpxMasterRow;
    const code = normalizeCode(record.Code ?? record.code ?? record.LocalCode);
    if (!code) {
      continue;
    }

    const name = readString(record, ["CompanyName", "CompanyNameEnglish", "Name", "name", "IssueName"]);
    const sector = readString(record, [
      "Sector17CodeName",
      "Sector33CodeName",
      "Sector17Code",
      "Sector33Code",
      "MarketCodeName",
      "Section",
    ]) || "未分類";

    map.set(code, {
      name: name || code,
      sector,
    });
  }

  return map;
}

async function fetchJquantsJson(url: URL): Promise<unknown> {
  try {
    return await fetchJQuantsJson(url);
  } catch (error) {
    if (error instanceof JQuantsHttpError && error.status === 429) {
      throw new RateLimitError(error.message, JQUANTS_BACKOFF_MS);
    }

    throw error;
  }
}

async function fetchUniverseMaster() {
  const endpoint = "https://api.jquants.com/v1/listed/info";

  try {
    const json = await fetchJquantsJson(new URL(endpoint));
    if (!json || typeof json !== "object" || !("data" in json) || !Array.isArray((json as { data?: unknown }).data)) {
      return buildMasterFallbackFromCache();
    }

    const rows = (json as { data: unknown[] }).data;
    const parsed = parseMasterRows(rows);
    if (parsed.size > 0) {
      return parsed;
    }
  } catch (error) {
    if (error instanceof JQuantsHttpError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 429)) {
      return buildMasterFallbackFromCache();
    }

    throw error;
  }

  return buildMasterFallbackFromCache();
}

function buildMockTepou30Items(
  timeframe: StockTimeframe,
  weights: AiScoreWeights,
  learningProfile: AiLearningProfile,
  sortMode: Tepou30SortMode = "ai-total",
): Tepou30Item[] {
  const fallback = buildMasterFallbackFromCache();
  const codes = [...fallback.keys()].slice(0, 30);

  const items = codes
    .map((code) => {
      const meta = fallback.get(code) ?? { name: code, sector: "未分類" };
      const candles = createMockChartData(code).candles;
      const stock = buildStockFromCandles(code, candles, meta, timeframe);

      if (!stock) {
        return null;
      }

      const result = analyzeStock({ query: code, stock }, { weights, learningProfile });
      const winRate = Math.round(result.probability5m * 0.2 + result.probability15m * 0.35 + result.probability1d * 0.45);

      return {
        rank: 0,
        code,
        name: result.name,
        sector: result.sector,
        score: result.score,
        judgment: result.judgment,
        probability5m: result.probability5m,
        probability15m: result.probability15m,
        probability1d: result.probability1d,
        entryPrice: result.entryPrice,
        takeProfitPrice: result.takeProfitPrice,
        stopLossPrice: result.stopLossPrice,
        lossRiskPercent: result.lossRiskPercent,
        expectedValuePercent: result.expectedValuePercent,
        winRate,
        confidence: result.confidence,
      } satisfies Tepou30Item;
    })
    .filter((item): item is Tepou30Item => Boolean(item));

  return rankTepou30Items(items, sortMode).slice(0, 30);
}

async function fetchRecentDates() {
  try {
    const url = new URL(`${JQUANTS_BASE}/equities/bars/daily`);
    url.searchParams.set("code", "7203");
    const json = await fetchJquantsJson(url);

    if (!json || typeof json !== "object" || !("data" in json) || !Array.isArray((json as { data?: unknown }).data)) {
      throw new Error("J-Quants bars daily response is invalid while reading recent dates.");
    }

    const rows = (json as { data: unknown[] }).data;
    const dates = rows
      .map((row) => (row && typeof row === "object" ? readString(row as JpxBarRow, ["Date", "date", "time"]) : ""))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));

    return [...new Set(dates)].sort((a, b) => b.localeCompare(a)).slice(0, MAX_DATE_CALLS);
  } catch {
    const generated: string[] = [];
    const cursor = new Date();

    while (generated.length < MAX_DATE_CALLS) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) {
        generated.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`);
      }
      cursor.setDate(cursor.getDate() - 1);
    }

    return generated;
  }
}

async function fetchDailyBarsByDate(date: string): Promise<JpxBarRow[]> {
  const compactDate = date.replace(/-/g, "");
  const url = new URL(`${JQUANTS_BASE}/equities/bars/daily`);
  url.searchParams.set("date", compactDate);
  const json = await fetchJquantsJson(url);

  if (!json || typeof json !== "object" || !("data" in json) || !Array.isArray((json as { data?: unknown }).data)) {
    return [];
  }

  return (json as { data: unknown[] }).data.filter((row): row is JpxBarRow => {
    return Boolean(row && typeof row === "object");
  });
}

function toCandle(row: JpxBarRow): StockCandle | null {
  const date = readString(row, ["Date", "date", "time", "timestamp"]);
  const open = parseNumber(row.O ?? row.Open ?? row.open ?? row.AdjO);
  const high = parseNumber(row.H ?? row.High ?? row.high ?? row.AdjH);
  const low = parseNumber(row.L ?? row.Low ?? row.low ?? row.AdjL);
  const close = parseNumber(row.C ?? row.Close ?? row.close ?? row.AdjC);
  const volume = parseNumber(row.Vo ?? row.Volume ?? row.volume ?? row.AdjVo) ?? 0;

  if (!date || open === null || high === null || low === null || close === null) {
    return null;
  }

  return {
    time: date.slice(0, 10),
    open,
    high,
    low,
    close,
    volume,
  };
}

function buildStockFromCandles(
  code: string,
  candles: StockCandle[],
  meta: { name: string; sector: string },
  timeframe: StockTimeframe,
): Stock | null {
  if (candles.length < 30) {
    return null;
  }

  const sorted = [...candles].sort((left, right) => left.time.localeCompare(right.time)).slice(-TARGET_CANDLE_DAYS);
  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2] ?? latest;
  const change = latest.close - previous.close;
  const previousClose = previous.close;
  const changePercent = previousClose > 0 ? (change / previousClose) * 100 : null;
  const marketData: StockMarketData = {
    price: latest.close,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    previousClose,
    change,
    changePercent,
    currency: "JPY",
    asOf: `${latest.time}T00:00:00.000Z`,
  };

  return {
    code,
    name: meta.name,
    sector: meta.sector,
    baselineTrend: changePercent !== null && changePercent > 1 ? "up" : changePercent !== null && changePercent < -1 ? "volatile" : "neutral",
    description: "J-Quants API V2の全銘柄データをもとにAIスコアを算出しています。",
    marketData,
    chartData: { candles: sorted },
    dataStatus: "real",
    dataReason: null,
    timeframe,
  };
}

async function buildTepou30(timeframe: StockTimeframe, sortMode: Tepou30SortMode) {
  const apiKey = process.env.JPX_API_KEY;
  const hasTokenAuth = Boolean(process.env.JPX_ID_TOKEN || (process.env.JPX_MAIL_ADDRESS && process.env.JPX_PASSWORD));
  if (!apiKey && !hasTokenAuth) {
    throw new Error("J-Quants認証情報が未設定です。JPX_API_KEY または JPX_MAIL_ADDRESS/JPX_PASSWORD を設定してください。");
  }

  const state = stateByTimeframe.get(timeframe) ?? getInitialState();
  const previousData = [...state.data];
  const previousUpdatedAt = state.updatedAt;
  const previousExpiresAt = state.expiresAt;
  const previousWeights = { ...state.optimizedWeights };
  const previousLearningProfile = { ...state.optimizedLearningProfile };
  const previousBacktest = state.backtest ? { ...state.backtest } : undefined;
  state.status = "building";
  state.startedAt = Date.now();
  state.error = undefined;
  state.total = 0;
  state.analyzed = 0;
  stateByTimeframe.set(timeframe, state);

  const masterMap = await fetchUniverseMaster();
  const universeCodes = [...masterMap.keys()].sort((left, right) => Number(left) - Number(right)).slice(0, TARGET_UNIVERSE_SIZE);
  const universeSet = new Set(universeCodes);
  const recentDates = await fetchRecentDates();
  const targetDates = recentDates.slice(0, MAX_DATE_CALLS);

  state.total = universeCodes.length;

  const candleMap = new Map<string, StockCandle[]>();

  for (const date of targetDates) {
    let dailyRows: JpxBarRow[] = [];
    try {
      dailyRows = await fetchDailyBarsByDate(date);
    } catch (error) {
      if (error instanceof RateLimitError) {
        state.error = "J-Quants API制限に到達したため、取得済みデータでランキングを生成しました。";
        state.expiresAt = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        break;
      }

      throw error;
    }

    for (const row of dailyRows) {
      const code = normalizeCode(row.Code);
      if (!code || !universeSet.has(code)) {
        continue;
      }

      const list = candleMap.get(code) ?? [];
      if (list.length >= MAX_STORED_CANDLES) {
        continue;
      }

      const candle = toCandle(row);
      if (!candle) {
        continue;
      }

      if (!list.some((item) => item.time === candle.time)) {
        list.push(candle);
        candleMap.set(code, list);
      }
    }

    state.analyzed = [...candleMap.values()].filter((candles) => candles.length >= 30).length;
  }

  const candidates: UniverseCandidate[] = [];

  for (const code of universeCodes) {
    const meta = masterMap.get(code);
    if (!meta) {
      continue;
    }

    const candles = (candleMap.get(code) ?? [])
      .sort((left, right) => left.time.localeCompare(right.time))
      .slice(-MAX_STORED_CANDLES);

    if (candles.length < TARGET_CANDLE_DAYS) {
      continue;
    }

    candidates.push({
      code,
      meta,
      candles,
    });
  }

  state.analyzed = candidates.length;

  const optimizationCandidates = preselectCandidates(candidates, OPTIMIZATION_CANDIDATE_LIMIT);
  const finalScoringCandidates = preselectCandidates(candidates, FINAL_SCORING_CANDIDATE_LIMIT);

  const learningStore = await loadLearningStore();
  const selectedHorizon: WeightHorizon = timeframe === "5m" ? "5m" : timeframe === "15m" ? "15m" : "1d";
  const preferred = getPreferredHistoricalWeights(learningStore, selectedHorizon);
  const preferredLearningProfiles = getPreferredHistoricalLearningProfiles(learningStore, selectedHorizon);
  const optimization = optimizeWeights(optimizationCandidates, timeframe, selectedHorizon, preferred, preferredLearningProfiles);
  registerLearningResult(
    learningStore,
    selectedHorizon,
    optimization.weights,
    optimization.learningProfile,
    optimization.backtest,
    optimization.objective,
  );
  await saveLearningStore(learningStore);

  const selectedLearning = learningStore.byHorizon[selectedHorizon];
  state.optimizedWeights = selectedLearning.bestWeights;
  state.optimizedLearningProfile = selectedLearning.bestLearningProfile;
  state.backtest = selectedLearning.latestBacktest;

  const scored: Tepou30Item[] = [];

  for (const candidate of finalScoringCandidates) {
    const stock = buildStockFromCandles(candidate.code, candidate.candles, candidate.meta, timeframe);
    if (!stock) {
      continue;
    }

    const result = analyzeStock({ query: candidate.code, stock }, { weights: state.optimizedWeights, learningProfile: state.optimizedLearningProfile });
    const winRate = Math.round(result.probability5m * 0.2 + result.probability15m * 0.35 + result.probability1d * 0.45);

    scored.push({
      rank: 0,
      code: candidate.code,
      name: result.name,
      sector: result.sector,
      score: result.score,
      judgment: result.judgment,
      probability5m: result.probability5m,
      probability15m: result.probability15m,
      probability1d: result.probability1d,
      entryPrice: result.entryPrice,
      takeProfitPrice: result.takeProfitPrice,
      stopLossPrice: result.stopLossPrice,
      lossRiskPercent: result.lossRiskPercent,
      expectedValuePercent: result.expectedValuePercent,
      winRate,
      confidence: result.confidence,
    });
  }

  const ranked = rankTepou30Items(scored, sortMode).slice(0, 30);

  if (ranked.length === 0) {
    if (previousData.length > 0) {
      state.data = previousData;
      state.status = "ready";
      state.updatedAt = previousUpdatedAt;
      state.expiresAt = Math.max(previousExpiresAt, Date.now() + RATE_LIMIT_COOLDOWN_MS);
      state.optimizedWeights = previousWeights;
      state.optimizedLearningProfile = previousLearningProfile;
      state.backtest = previousBacktest ?? { ...EMPTY_BACKTEST };
      state.error = state.error ?? "J-Quants API制限により最新更新ができなかったため、前回結果を表示しています。";
      return;
    }

    const mockItems = buildMockTepou30Items(timeframe, state.optimizedWeights, state.optimizedLearningProfile, sortMode);
    if (mockItems.length > 0) {
      state.data = mockItems;
      state.status = "ready";
      state.updatedAt = Date.now();
      state.expiresAt = Date.now() + CACHE_TTL_MS;
      state.error = "J-Quants APIが利用制限中のため、モックデータを表示しています。";
      await saveCacheToDisk(timeframe, state);
      return;
    }

    throw new Error("J-Quants API制限により、テッポウ30を生成できませんでした。時間をおいて再実行してください。");
  }

  state.data = ranked;
  state.status = "ready";
  state.updatedAt = Date.now();
  state.expiresAt = Date.now() + CACHE_TTL_MS;
  state.analyzed = candidates.length;
  await saveCacheToDisk(timeframe, state);
}

function toResponse(state: Tepou30State, sortMode: Tepou30SortMode): Tepou30Response {
  return {
    success: state.status !== "error",
    status: state.status,
    sortMode,
    data: rankTepou30Items(state.data, sortMode),
    optimizedWeights: state.optimizedWeights,
    optimizedLearningProfile: state.optimizedLearningProfile,
    backtest: state.backtest,
    updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : undefined,
    progress: {
      total: state.total,
      analyzed: state.analyzed,
    },
    error: state.error,
  };
}

export async function getTepou30(
  timeframe: StockTimeframe,
  refresh: boolean,
  sortMode: Tepou30SortMode = "ai-total",
): Promise<Tepou30Response> {
  const state = stateByTimeframe.get(timeframe) ?? getInitialState();
  stateByTimeframe.set(timeframe, state);

  if (state.data.length === 0) {
    const cached = await loadCacheFromDisk(timeframe);
    if (cached) {
      hydrateStateFromCache(state, cached);
    }
  }

  const isFresh = state.status === "ready" && state.expiresAt > Date.now();

  if ((refresh || !isFresh) && !state.running) {
    if (state.data.length > 0) {
      state.status = "building";
    }

    if (!state.running) {
      state.running = buildTepou30(timeframe, sortMode)
        .catch((error) => {
          if (state.data.length > 0) {
            state.status = "ready";
            state.error = error instanceof Error ? error.message : "Failed to refresh Tepou30.";
            state.expiresAt = Math.max(state.expiresAt, Date.now() + RATE_LIMIT_COOLDOWN_MS);
            return;
          }

          state.status = "error";
          state.error = error instanceof Error ? error.message : "Failed to build Tepou30.";
        })
        .finally(() => {
          state.running = undefined;
        });
    }
  }

  if (state.status !== "error") {
    await persistStateLearningSnapshot(timeframe, state);
  }

  return toResponse(state, sortMode);
}

export async function getTepou30LearningProfile(timeframe: StockTimeframe) {
  const state = stateByTimeframe.get(timeframe);

  if (state) {
    return {
      weights: state.optimizedWeights,
      learningProfile: state.optimizedLearningProfile,
      backtest: state.backtest ?? { ...EMPTY_BACKTEST },
    };
  }

  const store = await loadLearningStore();
  const horizon: WeightHorizon = timeframe === "5m" ? "5m" : timeframe === "15m" ? "15m" : "1d";
  const learning = store.byHorizon[horizon];

  return {
    weights: learning.bestWeights,
    learningProfile: learning.bestLearningProfile,
    backtest: learning.latestBacktest,
  };
}
