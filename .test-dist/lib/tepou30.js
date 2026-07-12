"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTepou30 = getTepou30;
exports.getTepou30LearningProfile = getTepou30LearningProfile;
const scoreCalculator_1 = require("./ai/scoreCalculator");
const backtestLearning_1 = require("./ai/backtestLearning");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const indicators_1 = require("./indicators");
const jquantsClient_1 = require("./jquantsClient");
const marketContext_1 = require("./marketContext");
const newsAnalyzer_1 = require("./newsAnalyzer");
const CACHE_TTL_MS = 15 * 60 * 1000;
const TARGET_UNIVERSE_SIZE = 4000;
const TARGET_CANDLE_DAYS = 30;
const MIN_CANDLES_FOR_ANALYSIS = 1;
const BACKTEST_PERIOD_DAYS = 756;
const MAX_STORED_CANDLES = 320;
const MAX_DATE_CALLS = 5;
const OPTIMIZATION_CANDIDATE_LIMIT = 700;
const FINAL_SCORING_CANDIDATE_LIMIT = TARGET_UNIVERSE_SIZE;
const JQUANTS_BASE = "https://api.jquants.com/v2";
const JQUANTS_BACKOFF_MS = 800;
const RATE_LIMIT_COOLDOWN_MS = 20 * 60 * 1000;
const BUILD_STALE_MS = 20_000;
const MAX_PAGINATION_PAGES = 20;
const CACHE_DIR = node_path_1.default.join(process.cwd(), ".cache");
const MASTER_CACHE_PATH = node_path_1.default.join(CACHE_DIR, "jquants-master.json");
const BARS_CACHE_DIR = node_path_1.default.join(CACHE_DIR, "jquants-bars");
const LEARNING_STORE_PATH = node_path_1.default.join(CACHE_DIR, "tepou30-weights.json");
const HORIZONS = ["5m", "15m", "1d"];
const WEIGHT_HISTORY_LIMIT = 30;
const JPX_META_OVERRIDES = {
    "7203": { name: "トヨタ自動車", sector: "輸送用機器" },
    "6758": { name: "ソニーグループ", sector: "電気機器" },
    "7974": { name: "任天堂", sector: "その他製品" },
};
const DEFAULT_OPTIMIZED_WEIGHTS = {
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
const DEFAULT_LEARNING_PROFILE = {
    technicalWeight: 1,
    newsWeight: 1,
    volumeWeight: 1,
    gapWeight: 1,
};
const EMPTY_BACKTEST = {
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
    sortinoRatio: 0,
    calmarRatio: 0,
};
function getBacktestConfig(horizon) {
    if (horizon === "5m") {
        return { periodDays: BACKTEST_PERIOD_DAYS, holdDays: 1, step: 1 };
    }
    if (horizon === "15m") {
        return { periodDays: BACKTEST_PERIOD_DAYS, holdDays: 2, step: 1 };
    }
    return { periodDays: BACKTEST_PERIOD_DAYS, holdDays: 2, step: 1 };
}
function getDefaultLearningStore() {
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
const stateByTimeframe = new Map();
class RateLimitError extends Error {
    retryAfterMs;
    constructor(message, retryAfterMs) {
        super(message);
        this.name = "RateLimitError";
        this.retryAfterMs = retryAfterMs;
    }
}
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function round2(value) {
    return Math.round(value * 100) / 100;
}
function normalizeWeights(weights) {
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
function normalizeLearningProfile(profile) {
    return {
        technicalWeight: clamp(profile?.technicalWeight ?? DEFAULT_LEARNING_PROFILE.technicalWeight, 0.6, 1.8),
        newsWeight: clamp(profile?.newsWeight ?? DEFAULT_LEARNING_PROFILE.newsWeight, 0.6, 2),
        volumeWeight: clamp(profile?.volumeWeight ?? DEFAULT_LEARNING_PROFILE.volumeWeight, 0.6, 1.8),
        gapWeight: clamp(profile?.gapWeight ?? DEFAULT_LEARNING_PROFILE.gapWeight, 0.6, 1.8),
    };
}
function trendStrengthScore(trendStrength) {
    if (trendStrength === "非常に強い") {
        return 100;
    }
    if (trendStrength === "強い") {
        return 80;
    }
    if (trendStrength === "標準") {
        return 60;
    }
    if (trendStrength === "弱い") {
        return 35;
    }
    return 50;
}
function newsScore(item) {
    const sentimentScore = item.newsSentiment === "bullish" ? 100 : item.newsSentiment === "bearish" ? 0 : 50;
    const importanceScore = clamp((item.newsImportanceStars ?? 1) * 20, 0, 100);
    return clamp(sentimentScore * 0.7 + importanceScore * 0.3, 0, 100);
}
function volumeScore(volumeRatio) {
    if (!volumeRatio || !Number.isFinite(volumeRatio)) {
        return 50;
    }
    if (volumeRatio >= 2) {
        return 92;
    }
    if (volumeRatio >= 1.4) {
        return 78;
    }
    if (volumeRatio >= 1) {
        return 62;
    }
    return 42;
}
function volatilityScore(volatilityPercent, riskLevel) {
    if (riskLevel === "高") {
        return 42;
    }
    if (riskLevel === "低") {
        return 78;
    }
    if (!volatilityPercent || !Number.isFinite(volatilityPercent)) {
        return 55;
    }
    if (volatilityPercent >= 6) {
        return 38;
    }
    if (volatilityPercent >= 3) {
        return 68;
    }
    return 58;
}
function riskScore(item) {
    return clamp(100 - item.lossRiskPercent * 11, 0, 100);
}
function buildSelectionReason(item) {
    const segments = [
        `トレンド:${item.trendStrength ?? "不明"}`,
        `ニュース:${item.newsSentiment ?? "neutral"}`,
        `出来高:${item.volumeRatio ? item.volumeRatio.toFixed(2) : "1.00"}x`,
        `ボラ:${item.volatilityPercent ? item.volatilityPercent.toFixed(2) : "0.00"}%`,
        `リスク:${item.riskLevel ?? "中"}`,
        `期待値:${(item.expectedValue ?? item.expectedValuePercent).toFixed(2)}%`,
        `勝率:${item.winRate.toFixed(2)}%`,
        `RR:${(item.riskRewardRatio ?? itemRiskReward(item)).toFixed(2)}x`,
    ];
    return segments.join(" / ");
}
function dedupeTepou30Items(items) {
    const unique = new Map();
    for (const item of items) {
        const current = unique.get(item.code);
        if (!current) {
            unique.set(item.code, item);
            continue;
        }
        if (rankingCompositeScore(item) > rankingCompositeScore(current)) {
            unique.set(item.code, item);
        }
    }
    return [...unique.values()];
}
function rankingCompositeScore(item) {
    const rr = item.riskRewardRatio ?? itemRiskReward(item);
    const expectedValue = item.expectedValue ?? item.expectedValuePercent;
    const trendComponent = trendStrengthScore(item.trendStrength);
    const newsComponent = newsScore(item);
    const volumeComponent = volumeScore(item.volumeRatio);
    const volatilityComponent = volatilityScore(item.volatilityPercent, item.riskLevel);
    const riskComponent = riskScore(item);
    const winRateComponent = item.winRate;
    const scoreComponent = item.score;
    const confidenceComponent = item.confidence;
    const expectancyComponent = clamp(expectedValue * 14 + rr * 9 + 48, 0, 100);
    const downsidePenalty = item.lossRiskPercent >= 5.5 ? 8 : item.lossRiskPercent >= 4.5 ? 4 : 0;
    const qualityBonus = expectedValue >= 1.2 && item.winRate >= 60 ? 4 : 0;
    const rrComponent = clamp(rr * 30, 0, 100);
    const probabilityBlend = clamp(item.probability5m * 0.2 + item.probability15m * 0.35 + item.probability1d * 0.45, 0, 100);
    const probabilityConsistency = clamp(100 - Math.abs(item.probability5m - item.probability1d) * 1.4, 0, 100);
    const riskAdjustedExpectancy = clamp(expectedValue * 14 - item.lossRiskPercent * 3 + 60, 0, 100);
    const edgeScore = clamp((item.winRate - 50) * 2 + expectedValue * 8 + rr * 10 + 50, 0, 100);
    const p15Component = item.probability15m;
    const p5Component = item.probability5m;
    const p1dComponent = item.probability1d;
    return expectancyComponent * 0.22
        + riskAdjustedExpectancy * 0.17
        + winRateComponent * 0.17
        + probabilityBlend * 0.12
        + edgeScore * 0.11
        + rrComponent * 0.08
        + probabilityConsistency * 0.06
        + scoreComponent * 0.05
        + confidenceComponent * 0.06
        + riskComponent * 0.04
        + p1dComponent * 0.01
        + p15Component * 0.005
        + p5Component * 0.005
        + trendComponent * 0.12
        + newsComponent * 0.1
        + volumeComponent * 0.1
        + volatilityComponent * 0.08
        + qualityBonus
        - downsidePenalty;
}
function dayTraderCompositeScore(item) {
    const riskBuffer = clamp(100 - item.lossRiskPercent * 11, 0, 100);
    const probabilityEdge = clamp(item.probability5m * 0.46 + item.probability15m * 0.28, 0, 100);
    return clamp(probabilityEdge * 0.58
        + item.winRate * 0.16
        + riskBuffer * 0.12
        + item.expectedValuePercent * 8
        + item.score * 0.04, 0, 100);
}
function itemRiskReward(item) {
    const expectedLoss = ((item.entryPrice - item.stopLossPrice) / Math.max(item.entryPrice, 1)) * 100;
    const expectedReturn = ((item.takeProfitPrice - item.entryPrice) / Math.max(item.entryPrice, 1)) * 100;
    return expectedLoss > 0 ? expectedReturn / expectedLoss : 0;
}
function itemProfitFactor(item) {
    const rr = itemRiskReward(item);
    const p = clamp(item.winRate / 100, 0.01, 0.99);
    return (p * rr) / (1 - p);
}
function swingTraderCompositeScore(item) {
    const rr = itemRiskReward(item);
    const pf = itemProfitFactor(item);
    return clamp(item.probability1d * 0.42
        + item.winRate * 0.24
        + clamp(item.expectedValuePercent * 12 + 50, 0, 100) * 0.2
        + clamp(rr * 30, 0, 100) * 0.08
        + clamp(pf * 20, 0, 100) * 0.06, 0, 100);
}
function judgmentByScore(score) {
    if (score >= 80) {
        return "強い買い";
    }
    if (score >= 65) {
        return "買い";
    }
    if (score >= 45) {
        return "様子見";
    }
    if (score >= 25) {
        return "売り";
    }
    return "強い売り";
}
function withNewsDefaults(item) {
    return {
        ...item,
        newsSentiment: item.newsSentiment ?? "neutral",
        newsImportanceStars: typeof item.newsImportanceStars === "number" ? item.newsImportanceStars : 1,
        newsSummary: item.newsSummary ?? "直近ニュースが少ないため、中立評価です。",
        newsPositiveCount: typeof item.newsPositiveCount === "number" ? item.newsPositiveCount : 0,
        newsNegativeCount: typeof item.newsNegativeCount === "number" ? item.newsNegativeCount : 0,
    };
}
function recalibrateUniverseScores(items) {
    if (items.length <= 1) {
        return items.map((item) => ({
            ...withNewsDefaults(item),
            score: clamp(item.score, 0, 100),
            judgment: judgmentByScore(clamp(item.score, 0, 100)),
        }));
    }
    const rankedByEdge = [...items].sort((left, right) => {
        const edgeRight = rankingCompositeScore(right);
        const edgeLeft = rankingCompositeScore(left);
        return edgeRight - edgeLeft;
    });
    const maxIndex = Math.max(1, rankedByEdge.length - 1);
    const scoreMap = new Map();
    rankedByEdge.forEach((item, index) => {
        const percentile = (maxIndex - index) / maxIndex;
        const rr = itemRiskReward(item);
        const edge = clamp(50
            + item.expectedValuePercent * 11.5
            + (item.winRate - 50) * 1.15
            + (rr - 1) * 12
            - item.lossRiskPercent * 1.9, 0, 100);
        const blended = clamp(percentile * 100 * 0.52
            + edge * 0.36
            + item.confidence * 0.12, 0, 100);
        scoreMap.set(item.code, Math.round(blended));
    });
    return items.map((item) => {
        const calibratedScore = scoreMap.get(item.code) ?? item.score;
        return {
            ...withNewsDefaults(item),
            score: calibratedScore,
            judgment: judgmentByScore(calibratedScore),
        };
    });
}
function rankTepou30Items(items, sortMode = "ai-total") {
    return dedupeTepou30Items(items)
        .sort((left, right) => {
        if (sortMode === "ai-total") {
            const rightComposite = rankingCompositeScore(right);
            const leftComposite = rankingCompositeScore(left);
            if (rightComposite !== leftComposite) {
                return rightComposite - leftComposite;
            }
            if (right.score !== left.score) {
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
            if (sortMode === "risk-reward") {
                const rightRr = itemRiskReward(right);
                const leftRr = itemRiskReward(left);
                if (rightRr !== leftRr) {
                    return rightRr - leftRr;
                }
                const rightPf = itemProfitFactor(right);
                const leftPf = itemProfitFactor(left);
                if (rightPf !== leftPf) {
                    return rightPf - leftPf;
                }
            }
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
        if (sortMode === "profit-factor") {
            const rightPf = itemProfitFactor(right);
            const leftPf = itemProfitFactor(left);
            if (rightPf !== leftPf) {
                return rightPf - leftPf;
            }
            if (right.winRate !== left.winRate) {
                return right.winRate - left.winRate;
            }
            return right.expectedValuePercent - left.expectedValuePercent;
        }
        if (sortMode === "swing-trader") {
            const rightSwing = swingTraderCompositeScore(right);
            const leftSwing = swingTraderCompositeScore(left);
            if (rightSwing !== leftSwing) {
                return rightSwing - leftSwing;
            }
            if (right.probability1d !== left.probability1d) {
                return right.probability1d - left.probability1d;
            }
            return right.expectedValuePercent - left.expectedValuePercent;
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
function buildTradeReturn(candles, entryIndex, takeProfit, stopLoss, holdDays) {
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
function calculateBacktestMetrics(returns, periodDays, step) {
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
    const downside = returns.filter((value) => value < 0);
    const downsideVariance = downside.reduce((sum, value) => sum + (value ** 2), 0) / Math.max(1, downside.length);
    const downsideDeviation = Math.sqrt(downsideVariance);
    const sortino = downsideDeviation > 0 ? (average / downsideDeviation) * Math.sqrt(252 / step) : 0;
    const years = Math.max(periodDays, 1) / 252;
    const cagr = years > 0 && equity > 0 ? (Math.pow(equity, 1 / years) - 1) * 100 : 0;
    const calmar = maxDrawdown > 0 ? cagr / (maxDrawdown * 100) : cagr > 0 ? 9.99 : 0;
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
        sortinoRatio: round2(sortino),
        calmarRatio: round2(calmar),
    };
}
function runBacktest(ranked, candidateMap, timeframe, weights, learningProfile, horizon) {
    const config = getBacktestConfig(horizon);
    const top = ranked.slice(0, 30);
    const returns = [];
    const estimatedReturns = [];
    let longestSeries = 0;
    for (const item of top) {
        const entry = item.entryPrice;
        const takeProfit = item.takeProfitPrice;
        const stopLoss = item.stopLossPrice;
        if (entry <= 0 || takeProfit <= entry || stopLoss <= 0 || stopLoss >= entry) {
            continue;
        }
        const gain = (takeProfit - entry) / entry;
        const loss = (entry - stopLoss) / entry;
        const winRate = clamp(item.winRate / 100, 0, 1);
        const simulatedTrades = 5;
        const wins = clamp(Math.round(winRate * simulatedTrades), 0, simulatedTrades);
        const losses = simulatedTrades - wins;
        for (let i = 0; i < wins; i += 1) {
            estimatedReturns.push(gain);
        }
        for (let i = 0; i < losses; i += 1) {
            estimatedReturns.push(-loss);
        }
    }
    for (const item of top) {
        const candidate = candidateMap.get(item.code);
        if (!candidate || candidate.candles.length < config.holdDays + 3) {
            continue;
        }
        longestSeries = Math.max(longestSeries, candidate.candles.length);
        const windowSize = Math.max(3, Math.min(TARGET_CANDLE_DAYS, candidate.candles.length - 1));
        const effectivePeriodDays = Math.min(config.periodDays, candidate.candles.length - config.holdDays - 1);
        if (effectivePeriodDays <= 1) {
            continue;
        }
        const minStart = Math.max(2, candidate.candles.length - effectivePeriodDays);
        const maxStart = Math.max(2, candidate.candles.length - config.holdDays - 1);
        const start = Math.min(Math.max(windowSize, minStart), maxStart);
        for (let index = start; index < candidate.candles.length - config.holdDays; index += config.step) {
            const sliceStart = Math.max(0, index - windowSize + 1);
            const window = candidate.candles.slice(sliceStart, index + 1);
            const stock = buildStockFromCandles(item.code, window, candidate.meta, timeframe);
            if (!stock) {
                continue;
            }
            const analysis = (0, scoreCalculator_1.analyzeStock)({ query: item.code, stock }, { weights, learningProfile });
            if (analysis.entryPrice <= 0 || analysis.takeProfitPrice <= 0 || analysis.stopLossPrice <= 0) {
                continue;
            }
            const tradeReturn = buildTradeReturn(candidate.candles, index, analysis.takeProfitPrice, analysis.stopLossPrice, config.holdDays);
            if (tradeReturn === null) {
                continue;
            }
            returns.push(tradeReturn);
        }
    }
    const effectivePeriod = Math.min(config.periodDays, Math.max(config.holdDays + 2, longestSeries));
    const insufficientHistory = longestSeries < TARGET_CANDLE_DAYS;
    if ((returns.length === 0 || insufficientHistory) && estimatedReturns.length > 0) {
        const fallbackPeriod = Math.min(config.periodDays, Math.max(5, estimatedReturns.length));
        return calculateBacktestMetrics(estimatedReturns, fallbackPeriod, 1);
    }
    return calculateBacktestMetrics(returns, effectivePeriod, config.step);
}
function buildWeightProfiles(seedWeights = []) {
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
    const unique = new Map();
    for (const weights of mergedWithMutation) {
        const key = JSON.stringify(weights);
        if (!unique.has(key)) {
            unique.set(key, weights);
        }
    }
    return [...unique.values()];
}
function buildLearningProfiles(seedProfiles = []) {
    const profiles = [
        normalizeLearningProfile(DEFAULT_LEARNING_PROFILE),
        normalizeLearningProfile({ technicalWeight: 1.05, newsWeight: 1.2, volumeWeight: 1.1, gapWeight: 1.05 }),
        normalizeLearningProfile({ technicalWeight: 0.95, newsWeight: 1.35, volumeWeight: 1.15, gapWeight: 1.1 }),
        normalizeLearningProfile({ technicalWeight: 1.1, newsWeight: 1.05, volumeWeight: 1.25, gapWeight: 1.15 }),
        normalizeLearningProfile({ technicalWeight: 1.08, newsWeight: 1.1, volumeWeight: 1.2, gapWeight: 1.2 }),
    ];
    const merged = [...seedProfiles.map((profile) => normalizeLearningProfile(profile)), ...profiles];
    const unique = new Map();
    for (const profile of merged) {
        const key = JSON.stringify(profile);
        if (!unique.has(key)) {
            unique.set(key, profile);
        }
    }
    return [...unique.values()];
}
function optimizeWeights(candidates, timeframe, horizon, preferredWeights, preferredLearningProfiles) {
    const weightProfiles = buildWeightProfiles(preferredWeights);
    const learningProfiles = buildLearningProfiles(preferredLearningProfiles);
    const candidateMap = new Map(candidates.map((candidate) => [candidate.code, candidate]));
    let bestWeights = weightProfiles[0];
    let bestLearningProfile = learningProfiles[0];
    let bestBacktest = { ...EMPTY_BACKTEST };
    let bestObjective = -Infinity;
    for (const weights of weightProfiles) {
        for (const learningProfile of learningProfiles) {
            const scoredItems = candidates
                .map((candidate) => {
                const stock = buildStockFromCandles(candidate.code, candidate.candles, candidate.meta, timeframe);
                if (!stock) {
                    return null;
                }
                const result = (0, scoreCalculator_1.analyzeStock)({ query: candidate.code, stock }, { weights, learningProfile });
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
                    winRate: result.winRate,
                    confidence: result.confidence,
                };
            })
                .filter((item) => Boolean(item));
            const ranked = rankTepou30Items(scoredItems);
            const backtest = runBacktest(ranked, candidateMap, timeframe, weights, learningProfile, horizon);
            const objective = backtestObjective(backtest);
            const learnedWeights = (0, backtestLearning_1.learnWeightsFromBacktest)({ currentWeights: weights, backtest }).weights;
            if (objective > bestObjective) {
                bestObjective = objective;
                bestWeights = learnedWeights;
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
function cacheFilePath(timeframe) {
    return node_path_1.default.join(CACHE_DIR, `tepou30-${timeframe}.json`);
}
function normalizeCachedItems(items) {
    return items
        .filter((item) => Boolean(item && typeof item === "object"))
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
            judgment: (typeof item.judgment === "string" ? item.judgment : "様子見"),
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
function normalizeBacktest(backtest) {
    if (!backtest || typeof backtest !== "object") {
        return undefined;
    }
    const record = backtest;
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
        sortinoRatio: parseNumber(record.sortinoRatio) ?? 0,
        calmarRatio: parseNumber(record.calmarRatio) ?? 0,
    };
}
function normalizeHistoryEntry(entry) {
    if (!entry || typeof entry !== "object") {
        return null;
    }
    const record = entry;
    const learnedAt = typeof record.learnedAt === "string" ? record.learnedAt : new Date().toISOString();
    const objective = parseNumber(record.objective) ?? Number.NEGATIVE_INFINITY;
    const weights = normalizeWeights(record.weights);
    const learningProfile = normalizeLearningProfile(record.learningProfile);
    const backtest = normalizeBacktest(record.backtest) ?? { ...EMPTY_BACKTEST };
    return {
        learnedAt,
        objective,
        weights,
        learningProfile,
        backtest,
    };
}
async function loadLearningStore() {
    try {
        const raw = await (0, promises_1.readFile)(LEARNING_STORE_PATH, "utf-8");
        const json = JSON.parse(raw.replace(/^\uFEFF/, ""));
        const defaults = getDefaultLearningStore();
        for (const horizon of HORIZONS) {
            const source = json.byHorizon?.[horizon];
            if (!source) {
                continue;
            }
            const history = Array.isArray(source.history)
                ? source.history
                    .map((entry) => normalizeHistoryEntry(entry))
                    .filter((entry) => Boolean(entry))
                    .sort((left, right) => right.objective - left.objective)
                    .slice(0, WEIGHT_HISTORY_LIMIT)
                : [];
            defaults.byHorizon[horizon] = {
                bestObjective: parseNumber(source.bestObjective) ?? history[0]?.objective ?? Number.NEGATIVE_INFINITY,
                bestWeights: normalizeWeights(source.bestWeights),
                bestLearningProfile: normalizeLearningProfile(source.bestLearningProfile),
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
    }
    catch {
        return getDefaultLearningStore();
    }
}
async function saveLearningStore(store) {
    if (process.env.VERCEL) {
        return;
    }
    await (0, promises_1.mkdir)(CACHE_DIR, { recursive: true });
    await (0, promises_1.writeFile)(LEARNING_STORE_PATH, JSON.stringify(store), "utf-8");
}
function getPreferredHistoricalWeights(store, horizon) {
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
function getPreferredHistoricalLearningProfiles(store, horizon) {
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
function registerLearningResult(store, horizon, weights, learningProfile, backtest, objective) {
    const state = store.byHorizon[horizon];
    const entry = {
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
function backtestObjective(backtest) {
    return backtest.winRate * 0.92
        + backtest.expectedValuePercent * 1.35
        + backtest.averageProfit * 0.24
        - backtest.averageLoss * 0.42
        + backtest.sharpeRatio * 4.8
        + backtest.sortinoRatio * 5.1
        + backtest.calmarRatio * 4.4
        + backtest.profitFactor * 2.5
        - backtest.maxDrawdown * 0.7;
}
async function persistStateLearningSnapshot(timeframe, state) {
    const store = await loadLearningStore();
    const horizon = timeframe === "5m" ? "5m" : timeframe === "15m" ? "15m" : "1d";
    const backtest = state.backtest ?? { ...EMPTY_BACKTEST };
    registerLearningResult(store, horizon, state.optimizedWeights, state.optimizedLearningProfile, backtest, backtestObjective(backtest));
    if (timeframe !== "15m" && store.byHorizon["15m"].history.length === 0) {
        registerLearningResult(store, "15m", state.optimizedWeights, state.optimizedLearningProfile, backtest, backtestObjective(backtest));
    }
    await saveLearningStore(store);
}
async function loadCacheFromDisk(timeframe) {
    try {
        const raw = await (0, promises_1.readFile)(cacheFilePath(timeframe), "utf-8");
        const json = JSON.parse(raw.replace(/^\uFEFF/, ""));
        const items = Array.isArray(json.data) ? normalizeCachedItems(json.data) : [];
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
            optimizedLearningProfile: normalizeLearningProfile(json.optimizedLearningProfile),
            backtest: normalizeBacktest(json.backtest) ?? { ...EMPTY_BACKTEST },
            total: json.progress?.total ?? TARGET_UNIVERSE_SIZE,
            analyzed: json.progress?.analyzed ?? items.length,
        };
    }
    catch {
        return null;
    }
}
async function saveCacheToDisk(timeframe, state) {
    await (0, promises_1.mkdir)(CACHE_DIR, { recursive: true });
    const payload = {
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
    await (0, promises_1.writeFile)(cacheFilePath(timeframe), JSON.stringify(payload), "utf-8");
}
function hydrateStateFromCache(state, cached) {
    state.status = "ready";
    state.data = cached.data;
    state.updatedAt = cached.updatedAt;
    state.expiresAt = cached.expiresAt;
    state.total = cached.total;
    state.analyzed = cached.analyzed;
    state.optimizedWeights = cached.optimizedWeights;
    state.optimizedLearningProfile = cached.optimizedLearningProfile;
    state.backtest = cached.backtest;
    finalizeReadyProgress(state);
}
function getInitialState() {
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
function finalizeReadyProgress(state) {
    if (state.status !== "ready" || state.data.length === 0) {
        return;
    }
    state.total = state.total > 0 ? state.total : TARGET_UNIVERSE_SIZE;
    state.analyzed = state.total;
}
function parseNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value !== "string") {
        return null;
    }
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
}
function readString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return "";
}
function normalizeCode(value) {
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
function computeFastCandidateScore(candles) {
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
function preselectCandidates(candidates, limit) {
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
    const map = new Map();
    for (const state of stateByTimeframe.values()) {
        for (const item of state.data) {
            map.set(item.code, {
                name: item.name || item.code,
                sector: item.sector || "未分類",
            });
        }
    }
    return map;
}
function parseMasterRows(rows) {
    const map = new Map();
    for (const row of rows) {
        if (!row || typeof row !== "object") {
            continue;
        }
        const record = row;
        const code = normalizeCode(record.Code ?? record.code ?? record.LocalCode);
        if (!code) {
            continue;
        }
        const name = readString(record, ["CompanyName", "CoName", "CompanyNameEnglish", "CoNameEn", "Name", "name", "IssueName"]);
        const sector = readString(record, [
            "Sector17CodeName",
            "Sector33CodeName",
            "S17Nm",
            "S33Nm",
            "Sector17Code",
            "Sector33Code",
            "MktNm",
            "MarketCodeName",
            "Section",
        ]) || "未分類";
        const override = JPX_META_OVERRIDES[code];
        map.set(code, {
            name: override?.name || name || code,
            sector: override?.sector || sector,
        });
    }
    return map;
}
async function loadMasterCache() {
    try {
        const raw = await (0, promises_1.readFile)(MASTER_CACHE_PATH, "utf-8");
        const json = JSON.parse(raw.replace(/^\uFEFF/, ""));
        if (!Array.isArray(json.data)) {
            return new Map();
        }
        return parseMasterRows(json.data);
    }
    catch {
        return new Map();
    }
}
async function saveMasterCache(rows) {
    try {
        await (0, promises_1.mkdir)(CACHE_DIR, { recursive: true });
        await (0, promises_1.writeFile)(MASTER_CACHE_PATH, JSON.stringify({ savedAt: new Date().toISOString(), data: rows }), "utf-8");
    }
    catch {
        // Ignore cache write failures.
    }
}
async function fetchJquantsJson(url) {
    try {
        return await (0, jquantsClient_1.fetchJQuantsJson)(url);
    }
    catch (error) {
        if (error instanceof jquantsClient_1.JQuantsHttpError && error.status === 429) {
            throw new RateLimitError(error.message, JQUANTS_BACKOFF_MS);
        }
        throw error;
    }
}
async function fetchUniverseMaster() {
    const endpoint = "https://api.jquants.com/v2/equities/master";
    const cachedMaster = await loadMasterCache();
    if (cachedMaster.size >= 1000) {
        return cachedMaster;
    }
    try {
        const rows = [];
        let paginationKey = "";
        for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
            const url = new URL(endpoint);
            if (paginationKey) {
                url.searchParams.set("pagination_key", paginationKey);
            }
            const json = await fetchJquantsJson(url);
            if (!json || typeof json !== "object" || !("data" in json) || !Array.isArray(json.data)) {
                break;
            }
            rows.push(...json.data);
            const nextKey = readString(json, ["pagination_key"]);
            if (!nextKey) {
                break;
            }
            paginationKey = nextKey;
        }
        const parsed = parseMasterRows(rows);
        if (parsed.size > 0) {
            await saveMasterCache(rows);
            return parsed;
        }
    }
    catch (error) {
        if (error instanceof RateLimitError) {
            if (cachedMaster.size > 0) {
                return cachedMaster;
            }
            throw error;
        }
        if (error instanceof jquantsClient_1.JQuantsHttpError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 410 || error.status === 429)) {
            if (cachedMaster.size > 0) {
                return cachedMaster;
            }
            return buildMasterFallbackFromCache();
        }
        throw error;
    }
    return buildMasterFallbackFromCache();
}
function barsCachePath(date) {
    return node_path_1.default.join(BARS_CACHE_DIR, `${date}.json`);
}
async function loadBarsCache(date) {
    try {
        const raw = await (0, promises_1.readFile)(barsCachePath(date), "utf-8");
        const json = JSON.parse(raw.replace(/^\uFEFF/, ""));
        if (!Array.isArray(json.data)) {
            return [];
        }
        return json.data.filter((row) => Boolean(row && typeof row === "object"));
    }
    catch {
        return [];
    }
}
async function saveBarsCache(date, rows) {
    try {
        await (0, promises_1.mkdir)(BARS_CACHE_DIR, { recursive: true });
        await (0, promises_1.writeFile)(barsCachePath(date), JSON.stringify({ savedAt: new Date().toISOString(), data: rows }), "utf-8");
    }
    catch {
        // Ignore cache write failures.
    }
}
async function loadAnyBarsCache() {
    try {
        const files = await (0, promises_1.readdir)(BARS_CACHE_DIR);
        const dated = files
            .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
            .sort((left, right) => right.localeCompare(left));
        for (const file of dated) {
            const date = file.replace(/\.json$/, "");
            const rows = await loadBarsCache(date);
            if (rows.length > 0) {
                return rows;
            }
        }
    }
    catch {
        // Ignore read failures.
    }
    return [];
}
async function fetchRecentDates() {
    const generated = [];
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
async function fetchDailyBarsByDate(date) {
    const cached = await loadBarsCache(date);
    if (cached.length > 0) {
        return cached;
    }
    const compactDate = date.replace(/-/g, "");
    const rows = [];
    let paginationKey = "";
    for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
        const url = new URL(`${JQUANTS_BASE}/equities/bars/daily`);
        url.searchParams.set("date", compactDate);
        if (paginationKey) {
            url.searchParams.set("pagination_key", paginationKey);
        }
        const json = await fetchJquantsJson(url);
        if (!json || typeof json !== "object" || !("data" in json) || !Array.isArray(json.data)) {
            break;
        }
        rows.push(...json.data.filter((row) => {
            return Boolean(row && typeof row === "object");
        }));
        const nextKey = readString(json, ["pagination_key"]);
        if (!nextKey) {
            break;
        }
        paginationKey = nextKey;
    }
    if (rows.length > 0) {
        await saveBarsCache(date, rows);
    }
    return rows;
}
function toCandle(row) {
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
function buildStockFromCandles(code, candles, meta, timeframe, marketContext, analysisBacktest) {
    if (candles.length < MIN_CANDLES_FOR_ANALYSIS) {
        return null;
    }
    const sorted = [...candles].sort((left, right) => left.time.localeCompare(right.time)).slice(-MAX_STORED_CANDLES);
    const latest = sorted[sorted.length - 1];
    const previous = sorted[sorted.length - 2] ?? latest;
    const change = latest.close - previous.close;
    const previousClose = previous.close;
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : null;
    const marketData = {
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
        marketContext,
        analysisBacktest,
        dataStatus: "real",
        dataReason: null,
        timeframe,
    };
}
async function buildTepou30(timeframe, sortMode) {
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
    let masterMap;
    try {
        masterMap = await fetchUniverseMaster();
    }
    catch (error) {
        if (error instanceof RateLimitError) {
            state.error = "J-Quants API制限に到達したため、前回の実データランキングを表示しています。";
            state.status = previousData.length > 0 ? "ready" : "error";
            state.expiresAt = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            state.data = previousData;
            state.updatedAt = previousUpdatedAt;
            state.total = Math.max(previousData.length, state.total);
            state.analyzed = Math.max(previousData.length, state.analyzed);
            finalizeReadyProgress(state);
            return;
        }
        throw error;
    }
    if (masterMap.size === 0) {
        throw new Error("J-Quants銘柄マスタを取得できませんでした。後でもう一度お試しください。");
    }
    const universeCodes = [...masterMap.keys()].sort((left, right) => Number(left) - Number(right)).slice(0, TARGET_UNIVERSE_SIZE);
    const universeSet = new Set(universeCodes);
    const recentDates = await fetchRecentDates();
    const targetDates = recentDates.slice(0, MAX_DATE_CALLS);
    state.total = universeCodes.length;
    const candleMap = new Map();
    for (const date of targetDates) {
        let dailyRows = [];
        try {
            dailyRows = await fetchDailyBarsByDate(date);
        }
        catch (error) {
            if (error instanceof RateLimitError) {
                const cachedRows = candleMap.size === 0 ? await loadAnyBarsCache() : [];
                if (cachedRows.length > 0) {
                    dailyRows = cachedRows;
                    state.error = "J-Quants API制限に到達したため、キャッシュ済みの実データでランキングを生成しています。";
                    state.expiresAt = Date.now() + RATE_LIMIT_COOLDOWN_MS;
                }
                else {
                    state.error = "J-Quants API制限に到達したため、取得済みデータでランキングを生成しました。";
                    state.expiresAt = Date.now() + RATE_LIMIT_COOLDOWN_MS;
                    break;
                }
            }
            else {
                throw error;
            }
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
        state.analyzed = [...candleMap.values()].filter((candles) => candles.length >= MIN_CANDLES_FOR_ANALYSIS).length;
    }
    const candidates = [];
    for (const code of universeCodes) {
        const meta = masterMap.get(code);
        if (!meta) {
            continue;
        }
        const candles = (candleMap.get(code) ?? [])
            .sort((left, right) => left.time.localeCompare(right.time))
            .slice(-MAX_STORED_CANDLES);
        if (candles.length < MIN_CANDLES_FOR_ANALYSIS) {
            continue;
        }
        candidates.push({
            code,
            meta,
            candles,
        });
    }
    state.analyzed = candidates.length;
    const optimizationCandidates = preselectCandidates(candidates.filter((candidate) => candidate.candles.length >= TARGET_CANDLE_DAYS), OPTIMIZATION_CANDIDATE_LIMIT);
    const finalScoringCandidates = preselectCandidates(candidates, FINAL_SCORING_CANDIDATE_LIMIT);
    const learningStore = await loadLearningStore();
    const selectedHorizon = timeframe === "5m" ? "5m" : timeframe === "15m" ? "15m" : "1d";
    const preferred = getPreferredHistoricalWeights(learningStore, selectedHorizon);
    const preferredLearningProfiles = getPreferredHistoricalLearningProfiles(learningStore, selectedHorizon);
    if (optimizationCandidates.length > 0) {
        const optimization = optimizeWeights(optimizationCandidates, timeframe, selectedHorizon, preferred, preferredLearningProfiles);
        registerLearningResult(learningStore, selectedHorizon, optimization.weights, optimization.learningProfile, optimization.backtest, optimization.objective);
        await saveLearningStore(learningStore);
    }
    const selectedLearning = learningStore.byHorizon[selectedHorizon];
    state.optimizedWeights = selectedLearning.bestWeights;
    state.optimizedLearningProfile = selectedLearning.bestLearningProfile;
    state.backtest = selectedLearning.latestBacktest;
    const marketContext = await (0, marketContext_1.fetchMarketContext)();
    const scored = [];
    const candidateByCode = new Map(finalScoringCandidates.map((candidate) => [candidate.code, candidate]));
    for (const candidate of finalScoringCandidates) {
        const stock = buildStockFromCandles(candidate.code, candidate.candles, candidate.meta, timeframe, marketContext ?? undefined, state.backtest);
        if (!stock) {
            continue;
        }
        const result = (0, scoreCalculator_1.analyzeStock)({ query: candidate.code, stock }, { weights: state.optimizedWeights, learningProfile: state.optimizedLearningProfile });
        const winRate = result.winRate;
        const latestClose = candidate.candles[candidate.candles.length - 1]?.close ?? result.entryPrice;
        const latestVolume = candidate.candles[candidate.candles.length - 1]?.volume ?? 0;
        const volumeAverage = (0, indicators_1.calculateVolumeAverage)(candidate.candles, 20);
        const volumeRatio = volumeAverage > 0 ? latestVolume / volumeAverage : 1;
        const atrSeries = (0, indicators_1.calculateAtr)(candidate.candles, 14);
        const latestAtr = atrSeries[atrSeries.length - 1]?.value ?? 0;
        const volatilityPercent = latestClose > 0 ? (latestAtr / latestClose) * 100 : 0;
        const trendStrength = result.trendStrength;
        const riskLevel = result.riskLevel;
        const expectedValue = result.expectedValue;
        const riskRewardRatio = result.riskRewardRatio;
        const entryPriority = result.entryPriority;
        const selectionReason = buildSelectionReason({
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
            trendStrength,
            riskLevel,
            expectedValue,
            riskRewardRatio,
            entryPriority,
            volumeRatio,
            volatilityPercent,
            newsSentiment: stock.newsAnalysis?.sentiment,
            newsImportanceStars: stock.newsAnalysis?.starRating,
            newsSummary: stock.newsAnalysis?.summary,
            newsPositiveCount: stock.newsAnalysis?.positiveCount,
            newsNegativeCount: stock.newsAnalysis?.negativeCount,
        });
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
            trendStrength,
            riskLevel,
            expectedValue,
            riskRewardRatio,
            entryPriority,
            volumeRatio,
            volatilityPercent,
            newsSentiment: stock.newsAnalysis?.sentiment,
            newsImportanceStars: stock.newsAnalysis?.starRating,
            newsSummary: stock.newsAnalysis?.summary,
            newsPositiveCount: stock.newsAnalysis?.positiveCount,
            newsNegativeCount: stock.newsAnalysis?.negativeCount,
            selectionReason,
        });
    }
    if (scored.length > 0) {
        const previewRanked = rankTepou30Items(scored, sortMode);
        const newsTargetCodes = previewRanked.slice(0, 120).map((item) => item.code);
        const newsByCode = new Map();
        await Promise.all(newsTargetCodes.map(async (code) => {
            try {
                const news = await (0, newsAnalyzer_1.fetchJpxNewsAnalysis)(code);
                newsByCode.set(code, news);
            }
            catch {
                // Keep running with technical-only score when news endpoint is unavailable.
            }
        }));
        for (const item of scored) {
            const news = newsByCode.get(item.code);
            if (!news) {
                continue;
            }
            const candidate = candidateByCode.get(item.code);
            if (!candidate) {
                continue;
            }
            const stock = buildStockFromCandles(candidate.code, candidate.candles, candidate.meta, timeframe, marketContext ?? undefined, state.backtest);
            if (!stock) {
                continue;
            }
            stock.newsAnalysis = news;
            const rescored = (0, scoreCalculator_1.analyzeStock)({ query: candidate.code, stock }, { weights: state.optimizedWeights, learningProfile: state.optimizedLearningProfile });
            item.score = rescored.score;
            item.judgment = rescored.judgment;
            item.probability5m = rescored.probability5m;
            item.probability15m = rescored.probability15m;
            item.probability1d = rescored.probability1d;
            item.entryPrice = rescored.entryPrice;
            item.takeProfitPrice = rescored.takeProfitPrice;
            item.stopLossPrice = rescored.stopLossPrice;
            item.lossRiskPercent = rescored.lossRiskPercent;
            item.expectedValuePercent = rescored.expectedValuePercent;
            item.winRate = rescored.winRate;
            item.confidence = rescored.confidence;
            item.newsSentiment = news.sentiment;
            item.newsImportanceStars = news.starRating;
            item.newsSummary = news.summary;
            item.newsPositiveCount = news.positiveCount;
            item.newsNegativeCount = news.negativeCount;
        }
    }
    const calibratedScored = recalibrateUniverseScores(scored);
    const ranked = rankTepou30Items(calibratedScored, sortMode).slice(0, 30);
    if (calibratedScored.length > 0) {
        const scoredRanked = rankTepou30Items(calibratedScored, sortMode);
        const scoredCandidateMap = new Map(finalScoringCandidates.map((candidate) => [candidate.code, candidate]));
        const refreshedBacktest = runBacktest(scoredRanked, scoredCandidateMap, timeframe, state.optimizedWeights, state.optimizedLearningProfile, selectedHorizon);
        if (refreshedBacktest.totalTrades > 0) {
            state.backtest = refreshedBacktest;
        }
    }
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
            finalizeReadyProgress(state);
            return;
        }
        throw new Error("J-Quants実データからランキングを生成できませんでした。時間をおいて再実行してください。");
    }
    state.data = ranked;
    state.status = "ready";
    state.updatedAt = Date.now();
    state.expiresAt = Date.now() + CACHE_TTL_MS;
    state.analyzed = candidates.length;
    finalizeReadyProgress(state);
    await saveCacheToDisk(timeframe, state);
}
function toResponse(state, sortMode) {
    const total = state.total > 0 ? state.total : (state.status === "ready" && state.data.length > 0 ? TARGET_UNIVERSE_SIZE : state.total);
    const analyzed = state.status === "ready" && state.data.length > 0 ? total : state.analyzed;
    const calibratedData = recalibrateUniverseScores(state.data);
    return {
        success: state.status !== "error",
        status: state.status,
        sortMode,
        data: rankTepou30Items(calibratedData, sortMode),
        optimizedWeights: state.optimizedWeights,
        optimizedLearningProfile: state.optimizedLearningProfile,
        backtest: state.backtest,
        updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : undefined,
        progress: {
            total,
            analyzed,
        },
        error: state.error,
    };
}
async function getTepou30(timeframe, refresh, sortMode = "ai-total") {
    const state = stateByTimeframe.get(timeframe) ?? getInitialState();
    stateByTimeframe.set(timeframe, state);
    if (state.running && state.startedAt > 0 && Date.now() - state.startedAt > BUILD_STALE_MS) {
        state.running = undefined;
        if (state.data.length > 0) {
            state.status = "ready";
            state.error = "ランキング更新がタイムアウトしたため、直近の実データを表示しています。";
            state.expiresAt = Math.max(state.expiresAt, Date.now() + RATE_LIMIT_COOLDOWN_MS);
            finalizeReadyProgress(state);
        }
        else {
            state.status = "error";
            state.error = "ランキング更新がタイムアウトしました。";
        }
    }
    if (state.data.length === 0) {
        const cached = await loadCacheFromDisk(timeframe);
        if (cached) {
            hydrateStateFromCache(state, cached);
        }
    }
    if ((state.total <= 0 || state.analyzed <= 0) && state.data.length > 0 && !state.running) {
        const cached = await loadCacheFromDisk(timeframe);
        if (cached && cached.data.length >= state.data.length) {
            hydrateStateFromCache(state, cached);
        }
    }
    const isFresh = state.status === "ready" && state.expiresAt > Date.now();
    if ((refresh || !isFresh) && !state.running) {
        state.status = "building";
        if (!state.running) {
            state.running = buildTepou30(timeframe, sortMode)
                .catch((error) => {
                if (state.data.length > 0) {
                    state.status = "ready";
                    state.error = error instanceof Error ? error.message : "Failed to refresh Tepou30.";
                    state.expiresAt = Math.max(state.expiresAt, Date.now() + RATE_LIMIT_COOLDOWN_MS);
                    finalizeReadyProgress(state);
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
async function getTepou30LearningProfile(timeframe) {
    const state = stateByTimeframe.get(timeframe);
    if (state) {
        return {
            weights: state.optimizedWeights,
            learningProfile: state.optimizedLearningProfile,
            backtest: state.backtest ?? { ...EMPTY_BACKTEST },
        };
    }
    const store = await loadLearningStore();
    const horizon = timeframe === "5m" ? "5m" : timeframe === "15m" ? "15m" : "1d";
    const learning = store.byHorizon[horizon];
    return {
        weights: learning.bestWeights,
        learningProfile: learning.bestLearningProfile,
        backtest: learning.latestBacktest,
    };
}
