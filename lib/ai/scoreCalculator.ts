import type { AiJudgment, AiLearningProfile, AiScoreInput, AiScoreResult, AiScoreWeights, Stock, TradeSignal } from "../types";
import {
  calculateAdx,
  calculateAtr,
  calculateBollingerBands,
  calculateMacd,
  calculateRsi,
  calculateSma,
  calculateSupportResistance,
  calculateVolumeAverage,
  calculateVolumeSurgeRate,
} from "../indicators";
import { calculateExpectedValue } from "./expectedValueAnalyzer";

const trendLabels: Record<Stock["baselineTrend"], string> = {
  up: "上昇基調",
  neutral: "中立",
  volatile: "変動大",
  steady: "堅調",
};

const DEFAULT_WEIGHTS: AiScoreWeights = {
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

type AnalyzeStockOptions = {
  weights?: Partial<AiScoreWeights>;
  learningProfile?: Partial<AiLearningProfile>;
};

type BacktestSummary = {
  periodDays: number;
  totalTrades: number;
  winRate: number;
  averageProfit: number;
  averageLoss: number;
  expectedValuePercent: number;
  averageReturn: number;
  riskRewardRatio: number;
  maxDrawdown: number;
  profitFactor: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
};

function normalizeWeights(weights?: Partial<AiScoreWeights>): AiScoreWeights {
  return {
    rsi: weights?.rsi ?? DEFAULT_WEIGHTS.rsi,
    macd: weights?.macd ?? DEFAULT_WEIGHTS.macd,
    ma5: weights?.ma5 ?? DEFAULT_WEIGHTS.ma5,
    ma25: weights?.ma25 ?? DEFAULT_WEIGHTS.ma25,
    ma75: weights?.ma75 ?? DEFAULT_WEIGHTS.ma75,
    adx: weights?.adx ?? DEFAULT_WEIGHTS.adx,
    atr: weights?.atr ?? DEFAULT_WEIGHTS.atr,
    bollinger: weights?.bollinger ?? DEFAULT_WEIGHTS.bollinger,
    supportResistance: weights?.supportResistance ?? DEFAULT_WEIGHTS.supportResistance,
    volumeRatio: weights?.volumeRatio ?? DEFAULT_WEIGHTS.volumeRatio,
    volumeSpike: weights?.volumeSpike ?? DEFAULT_WEIGHTS.volumeSpike,
    trendStrength: weights?.trendStrength ?? DEFAULT_WEIGHTS.trendStrength,
    lossRisk: weights?.lossRisk ?? DEFAULT_WEIGHTS.lossRisk,
    probabilityUp: weights?.probabilityUp ?? DEFAULT_WEIGHTS.probabilityUp,
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function mergeRiskLevels(base: "低" | "中" | "高", expectedValueRisk: "低" | "中" | "高") {
  const rank = { "低": 0, "中": 1, "高": 2 } as const;
  return rank[expectedValueRisk] > rank[base] ? expectedValueRisk : base;
}

function calcChangePercent(base: number, latest: number) {
  if (base <= 0) {
    return 0;
  }

  return ((latest - base) / base) * 100;
}

function calcSlopePercent(values: number[], window = 5) {
  if (values.length < window + 1) {
    return 0;
  }

  const latest = values[values.length - 1];
  const past = values[values.length - 1 - window];
  if (past <= 0) {
    return 0;
  }

  return ((latest - past) / past) * 100;
}

function calculateRealizedVolatilityPercent(candles: NonNullable<Stock["chartData"]>["candles"], period = 20) {
  if (candles.length < period + 1) {
    return 0;
  }

  const closes = candles.map((candle) => candle.close);
  const returns: number[] = [];

  for (let index = Math.max(1, closes.length - period); index < closes.length; index += 1) {
    const previous = closes[index - 1];
    const current = closes[index];
    if (previous <= 0 || current <= 0) {
      continue;
    }

    returns.push(Math.log(current / previous));
  }

  if (returns.length < 2) {
    return 0;
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

function intradayCalibration(params: {
  timeframe: Stock["timeframe"];
  volatilityPercent: number;
  volumeSurgeRate: number;
  momentumConsistency: number;
  trendAlignment: number;
  lossRiskPercent: number;
}) {
  const {
    timeframe,
    volatilityPercent,
    volumeSurgeRate,
    momentumConsistency,
    trendAlignment,
    lossRiskPercent,
  } = params;

  const noisePenalty = volatilityPercent >= 3.2 ? -5 : volatilityPercent >= 2.6 ? -3 : 0;
  const volumeBoost = volumeSurgeRate >= 1.8 ? 4 : volumeSurgeRate >= 1.3 ? 2 : 0;
  const consistencyBoost = momentumConsistency >= 0.45 ? 3 : momentumConsistency <= -0.45 ? -3 : 0;
  const alignmentBoost = trendAlignment >= 2 ? 3 : trendAlignment <= -2 ? -3 : 0;
  const riskPenalty = lossRiskPercent >= 5.5 ? -4 : lossRiskPercent >= 4.5 ? -2 : 0;
  const base = noisePenalty + volumeBoost + consistencyBoost + alignmentBoost + riskPenalty;

  if (timeframe === "5m") {
    return base;
  }

  if (timeframe === "15m") {
    return Math.round(base * 0.85);
  }

  return 0;
}

function adaptiveTradeFactor(params: {
  timeframe: Stock["timeframe"];
  trendAlignment: number;
  maSlopeBlend: number;
  volatilityPercent: number;
}) {
  const { timeframe, trendAlignment, maSlopeBlend, volatilityPercent } = params;

  const trendBias = clamp((trendAlignment * 0.7) + (maSlopeBlend * 0.35), -6, 6);
  const volatilityBias = volatilityPercent >= 6 ? -1.15 : volatilityPercent >= 4 ? -0.85 : volatilityPercent >= 2.5 ? -0.35 : 0.1;
  const timeframeBias = timeframe === "5m" ? 0.72 : timeframe === "15m" ? 0.88 : 1;

  return {
    stopMultiplier: clamp((1.22 - trendBias * 0.04) + volatilityBias * 0.05, 0.82, 1.38) * timeframeBias,
    targetMultiplier: clamp((1.78 + trendBias * 0.09) - volatilityBias * 0.08, 1.15, 2.9) * timeframeBias,
    confidenceBonus: clamp(Math.round(trendBias * 1.8 - volatilityPercent * 0.25), -7, 8),
    winRateBonus: clamp(Math.round(trendBias * 1.5 - volatilityPercent * 0.2), -8, 10),
  };
}

function buildTrendStack(closes: number[], latestClose: number) {
  const dailyBase = closes.slice(-20)[0] ?? latestClose;
  const weeklyBase = closes.slice(-60)[0] ?? dailyBase;
  const monthlyBase = closes.slice(-120)[0] ?? weeklyBase;

  const dailyTrend = calcChangePercent(dailyBase, latestClose);
  const weeklyTrend = calcChangePercent(weeklyBase, latestClose);
  const monthlyTrend = calcChangePercent(monthlyBase, latestClose);

  return {
    dailyTrend,
    weeklyTrend,
    monthlyTrend,
    alignment: (dailyTrend > 0 ? 1 : -1) + (weeklyTrend > 0 ? 1 : -1) + (monthlyTrend > 0 ? 1 : -1),
    strength: (Math.abs(dailyTrend) * 0.35) + (Math.abs(weeklyTrend) * 0.4) + (Math.abs(monthlyTrend) * 0.25),
  };
}

function classifyTrendDirection(changePercent: number) {
  if (changePercent >= 2.5) {
    return "上昇";
  }

  if (changePercent <= -2.5) {
    return "下降";
  }

  return "横ばい";
}

function buildTrendAssessment(trendStack: { dailyTrend: number; weeklyTrend: number; monthlyTrend: number }) {
  const dailyDirection = classifyTrendDirection(trendStack.dailyTrend);
  const weeklyDirection = classifyTrendDirection(trendStack.weeklyTrend);
  const monthlyDirection = classifyTrendDirection(trendStack.monthlyTrend);

  const dailyScore = dailyDirection === "上昇" ? 3 : dailyDirection === "下降" ? -3 : 0;
  const weeklyScore = weeklyDirection === "上昇" ? 4 : weeklyDirection === "下降" ? -4 : 0;
  const monthlyScore = monthlyDirection === "上昇" ? 5 : monthlyDirection === "下降" ? -5 : 0;

  const alignedUp = dailyDirection === "上昇" && weeklyDirection === "上昇" && monthlyDirection === "上昇";
  const alignedDown = dailyDirection === "下降" && weeklyDirection === "下降" && monthlyDirection === "下降";
  const totalScore = dailyScore + weeklyScore + monthlyScore + (alignedUp ? 4 : 0) + (alignedDown ? -4 : 0);
  const direction = totalScore >= 4 ? "上昇" : totalScore <= -4 ? "下降" : "横ばい";

  return {
    direction,
    totalScore,
    daily: { value: trendStack.dailyTrend, direction: dailyDirection, score: dailyScore },
    weekly: { value: trendStack.weeklyTrend, direction: weeklyDirection, score: weeklyScore },
    monthly: { value: trendStack.monthlyTrend, direction: monthlyDirection, score: monthlyScore },
  };
}

function buildGapScore(candles: Stock["chartData"] extends infer T ? T extends { candles: infer C } ? C extends Array<infer Candle> ? Candle[] : never : never : never, latestClose: number) {
  if (candles.length < 2) {
    return { score: 0, reason: "", bullish: false, bearish: false };
  }

  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const gapPercent = previous.close > 0 ? ((latest.open - previous.close) / previous.close) * 100 : 0;
  const intradayGapStrength = latestClose > 0 ? ((latest.high - latest.low) / latestClose) * 100 : 0;
  const baseGapScore = clamp(Math.round(gapPercent * 3), -9, 9);
  const volatilityBonus = intradayGapStrength >= 5 ? (gapPercent > 0 ? 2 : gapPercent < 0 ? -2 : 1) : 0;
  const score = clamp(baseGapScore + volatilityBonus, -10, 10);

  if (Math.abs(gapPercent) < 0.4 && intradayGapStrength < 4.5) {
    return { score: 0, reason: "", bullish: false, bearish: false };
  }

  if (score > 0) {
    return {
      score,
      reason: `ギャップアップを${gapPercent.toFixed(2)}%（評価:+${score}）で判定し、寄り付き優位と見ています。`,
      bullish: true,
      bearish: false,
    };
  }

  if (score < 0) {
    return {
      score,
      reason: `ギャップダウンを${Math.abs(gapPercent).toFixed(2)}%（評価:${score}）で判定し、売り圧力を警戒しています。`,
      bullish: false,
      bearish: true,
    };
  }

  return {
    score: 1,
    reason: "寄り付きギャップは小さいものの、当日値幅が大きく短期の値動き余地があります。",
    bullish: true,
    bearish: false,
  };
}

function buildVolumeProfile(candles: Stock["chartData"] extends infer T ? T extends { candles: infer C } ? C extends Array<infer Candle> ? Candle[] : never : never : never, latestVolume: number) {
  if (candles.length < 10) {
    return { score: 0, reason: "", bullish: false, bearish: false, surgeRatio: 1, trendPercent: 0 };
  }

  const recentWindow = candles.slice(-5);
  const priorWindow = candles.slice(-15, -5).length > 0 ? candles.slice(-15, -5) : candles.slice(0, Math.max(0, candles.length - 5));
  const recentAverage = recentWindow.reduce((sum, candle) => sum + candle.volume, 0) / Math.max(1, recentWindow.length);
  const priorAverage = priorWindow.reduce((sum, candle) => sum + candle.volume, 0) / Math.max(1, priorWindow.length);
  const surgeRatio = recentAverage > 0 ? latestVolume / recentAverage : 1;
  const trendPercent = priorAverage > 0 ? ((recentAverage - priorAverage) / priorAverage) * 100 : 0;

  if (surgeRatio >= 2.2 && trendPercent >= 20) {
    return {
      score: 9,
      reason: `出来高が直近平均の${surgeRatio.toFixed(2)}倍で、前週比${trendPercent.toFixed(1)}%増と強く加速しています。`,
      bullish: true,
      bearish: false,
      surgeRatio,
      trendPercent,
    };
  }

  if (surgeRatio >= 1.6 && trendPercent >= 10) {
    return {
      score: 6,
      reason: `出来高が直近平均の${surgeRatio.toFixed(2)}倍で、じわじわ増加しています。`,
      bullish: true,
      bearish: false,
      surgeRatio,
      trendPercent,
    };
  }

  if (surgeRatio <= 0.8 && trendPercent <= -10) {
    return {
      score: -5,
      reason: `出来高が直近平均の${surgeRatio.toFixed(2)}倍まで低下しており、参加者が減っています。`,
      bullish: false,
      bearish: true,
      surgeRatio,
      trendPercent,
    };
  }

  if (surgeRatio <= 1.05 && trendPercent >= 18) {
    return {
      score: 2,
      reason: `出来高は急増していませんが、平均比では増加傾向です。`,
      bullish: true,
      bearish: false,
      surgeRatio,
      trendPercent,
    };
  }

  return { score: 0, reason: "", bullish: false, bearish: false, surgeRatio, trendPercent };
}

function classifyReason(text: string) {
  if (/下回|下落|弱い|売り|過熱|高すぎ|反落|鈍化|注意|マイナス|荒い|割れ|戻り売り|方向感の弱|リスク/.test(text)) {
    return -1;
  }

  return 1;
}

function estimateReasonImpact(text: string) {
  const patterns: Array<[RegExp, number]> = [
    [/短期・中期・長期トレンド/, 9],
    [/ニュース重要度/, 9],
    [/5MAが25MAを上回|25MAが75MAを上回|移動平均線の傾き/, 8],
    [/MACDヒストグラム/, 8],
    [/レジスタンスラインを明確に突破/, 8],
    [/出来高が平均の/, 7],
    [/RSI\(14\)/, 6],
    [/ボリンジャーバンド/, 6],
    [/サポートライン/, 5],
    [/ADX/, 5],
    [/短中期モメンタム/, 6],
    [/ニュース分析/, 4],
    [/株価が5MAを上回/, 5],
    [/株価が5MAを下回/, 5],
    [/株価がボリンジャーバンド下限/, 7],
    [/株価がボリンジャーバンド上限/, 7],
    [/方向感の弱い相場/, 5],
    [/反発より戻り売り/, 6],
    [/下押し圧力/, 6],
    [/過熱感/, 6],
    [/値動きが荒い/, 5],
    [/出来高が平均を下回/, 5],
  ];

  for (const [pattern, impact] of patterns) {
    if (pattern.test(text)) {
      return classifyReason(text) * impact;
    }
  }

  return classifyReason(text) * 3;
}

function buildReasonInsights(reasons: string[], score: number, signal: TradeSignal) {
  const ranked = reasons
    .map((label) => ({
      label,
      impact: estimateReasonImpact(label),
    }))
    .sort((left, right) => Math.abs(right.impact) - Math.abs(left.impact));

  const positiveFactors = ranked.filter((item) => item.impact > 0).slice(0, 4).map((item) => item.label);
  const negativeFactors = ranked.filter((item) => item.impact < 0).slice(0, 4).map((item) => item.label);
  const decisionReason = signal === "BUY"
    ? `買い基準を上回るスコアで、上向き要因が十分に積み上がっています。スコアは${score}点です。`
    : signal === "SELL"
      ? `買い基準に届かないため、慎重判断が妥当です。スコアは${score}点です。`
      : `上向き要因と下向き要因が拮抗しており、様子見が妥当です。スコアは${score}点です。`;

  return {
    positiveFactors,
    negativeFactors,
    reasonRanking: ranked.slice(0, 6),
    decisionReason,
  };
}

function rankReasons(reasons: string[]) {
  return reasons
    .map((label) => ({
      label,
      impact: estimateReasonImpact(label),
    }))
    .sort((left, right) => Math.abs(right.impact) - Math.abs(left.impact));
}

function buildNewsImpact(score: number, confidence: number, importance: "重要" | "普通" | "軽微") {
  const importanceMultiplier = importance === "重要" ? 1.45 : importance === "普通" ? 1 : 0.6;

  if (confidence < 50 || Math.abs(score) < 8) {
    return {
      score: 0,
      reason: `ニュース重要度は${importance}で、ニュース分析は中立寄りです。テクニカル主導の判断です。`,
      bullish: false,
      bearish: false,
    };
  }

  if (score >= 24 && confidence >= 65) {
    const impact = Math.round(8 * importanceMultiplier);
    return {
      score: impact,
      reason: `ニュース重要度は${importance}です。重要な好材料が含まれる強気ニュース（スコア${score}）として加点します。`,
      bullish: true,
      bearish: false,
    };
  }

  if (score >= 12 && confidence >= 55) {
    const impact = Math.round(4 * importanceMultiplier);
    return {
      score: impact,
      reason: `ニュース重要度は${importance}です。ニュース分析が強気（スコア${score}）で、上方向の確率を補強しています。`,
      bullish: true,
      bearish: false,
    };
  }

  if (score <= -24 && confidence >= 65) {
    const impact = Math.round(-8 * importanceMultiplier);
    return {
      score: impact,
      reason: `ニュース重要度は${importance}です。重要な悪材料が含まれる弱気ニュース（スコア${score}）として減点します。`,
      bullish: false,
      bearish: true,
    };
  }

  if (score <= -12 && confidence >= 55) {
    const impact = Math.round(-4 * importanceMultiplier);
    return {
      score: impact,
      reason: `ニュース重要度は${importance}です。ニュース分析が弱気（スコア${score}）で、下方向リスクを示しています。`,
      bullish: false,
      bearish: true,
    };
  }

  return {
    score: 0,
    reason: `ニュース重要度は${importance}で、ニュース分析は中立寄り（スコア${score}）です。テクニカル主導の判断です。`,
    bullish: false,
    bearish: false,
  };
}

function buildAdaptiveWeights(
  weights: AiScoreWeights,
  timeframe: AiScoreResult["timeframe"],
  candlesLength: number,
): AiScoreWeights {
  if (!timeframe) {
    return { ...weights };
  }

  const w = { ...weights };
  if (timeframe === "5m") {
    w.macd *= 1.08;
    w.volumeSpike *= 1.12;
    w.rsi *= 1.05;
    w.probabilityUp *= 1.08;
  } else if (timeframe === "15m") {
    w.macd *= 1.06;
    w.adx *= 1.08;
    w.trendStrength *= 1.08;
    w.probabilityUp *= 1.06;
  } else {
    w.ma25 *= 1.08;
    w.ma75 *= 1.12;
    w.supportResistance *= 1.08;
  }

  if (candlesLength >= 100) {
    w.trendStrength *= 1.05;
    w.lossRisk *= 1.04;
  }

  return w;
}

function decideSignal(score: number): TradeSignal {
  if (score >= 80) {
    return "BUY";
  }

  if (score >= 60) {
    return "HOLD";
  }

  return "SELL";
}

function decideJudgment(score: number): AiJudgment {
  if (score >= 78) {
    return "強い買い";
  }

  if (score >= 62) {
    return "買い";
  }

  if (score >= 42) {
    return "様子見";
  }

  if (score >= 28) {
    return "売り";
  }

  return "強い売り";
}

function decideSignalEnhanced(params: {
  score: number;
  winRate: number;
  expectedValuePercent: number;
  riskRewardRatio: number;
  marketRegimeScore: number;
  trendConsensusScore: number;
}) {
  const {
    score,
    winRate,
    expectedValuePercent,
    riskRewardRatio,
    marketRegimeScore,
    trendConsensusScore,
  } = params;
  if (expectedValuePercent <= 0) {
    if (expectedValuePercent <= -0.6 && score < 44 && marketRegimeScore < 48) {
      return "SELL";
    }

    return "HOLD";
  }

  const strictMode = marketRegimeScore < 45;
  const minExpected = strictMode ? 0.9 : 0.25;
  const minWinRate = strictMode ? 58 : 50;
  const minRr = strictMode ? 1.4 : 1.12;
  const minScore = strictMode ? 58 : 48;
  const minTrendConsensus = strictMode ? 58 : 52;

  if (
    expectedValuePercent >= minExpected
    && riskRewardRatio >= minRr
    && winRate >= minWinRate
    && score >= minScore
    && trendConsensusScore >= minTrendConsensus
  ) {
    return "BUY";
  }

  const sellStrict =
    expectedValuePercent <= -0.45
    && winRate <= 47
    && riskRewardRatio <= 1.0
    && trendConsensusScore <= 46
    && score <= 44;
  const sellLoose =
    expectedValuePercent <= -0.8
    && (winRate <= 45 || riskRewardRatio <= 0.9)
    && (trendConsensusScore <= 44 || marketRegimeScore <= 40)
    && score <= 46;

  if (sellStrict || sellLoose) {
    return "SELL";
  }

  return "HOLD";
}

function decideJudgmentEnhanced(params: {
  score: number;
  signal: TradeSignal;
  winRate: number;
  expectedValuePercent: number;
}) {
  const { score, signal, winRate, expectedValuePercent } = params;

  if (signal === "BUY" && score >= 80 && winRate >= 58 && expectedValuePercent >= 1) {
    return "強い買い";
  }

  if (signal === "BUY" && score >= 65) {
    return "買い";
  }

  if (signal === "SELL" && score <= 24 && (winRate <= 42 || expectedValuePercent <= -1)) {
    return "強い売り";
  }

  if (signal === "SELL" && score <= 44) {
    return "売り";
  }

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

function deriveTradeLevels(params: {
  entryPrice: number;
  atr: number;
  realizedVolatilityPercent: number;
  support: number;
  resistance: number;
}) {
  const { entryPrice, atr, realizedVolatilityPercent, support, resistance } = params;
  const atrBase = atr > 0 ? atr : entryPrice * 0.02;
  const volatilityMultiplier = clamp(1 + realizedVolatilityPercent / 12, 1, 2.4);
  const stopDistance = Math.max(atrBase * 0.95 * volatilityMultiplier, entryPrice * 0.011 * volatilityMultiplier);
  const takeDistance = Math.max(atrBase * 2.85 * volatilityMultiplier, entryPrice * 0.028 * volatilityMultiplier);
  const rawStop = entryPrice - stopDistance;
  const supportStop = support > 0 ? support - atrBase * 0.1 : rawStop;
  const boundedStop = Math.max(entryPrice - stopDistance * 1.15, Math.min(rawStop, supportStop));
  const rawTarget = entryPrice + takeDistance;
  const resistanceTarget = resistance > 0 ? resistance + atrBase * 0.25 : rawTarget;
  const minRrTarget = entryPrice + (entryPrice - boundedStop) * 1.35;
  const stopLossPrice = Math.max(1, boundedStop);
  const takeProfitPrice = Math.max(rawTarget, resistanceTarget, minRrTarget);

  return {
    stopLossPrice,
    takeProfitPrice,
  };
}

function simulateRollingBacktest(candles: NonNullable<Stock["chartData"]>["candles"], targetPeriodDays = 756): BacktestSummary {
  const lookback = candles.slice(-targetPeriodDays);
  if (lookback.length < 90) {
    return {
      periodDays: lookback.length,
      totalTrades: 0,
      winRate: 0,
      averageProfit: 0,
      averageLoss: 0,
      expectedValuePercent: 0,
      averageReturn: 0,
      riskRewardRatio: 0,
      maxDrawdown: 0,
      profitFactor: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
    };
  }

  const returns: number[] = [];
  const profits: number[] = [];
  const losses: number[] = [];

  for (let index = 60; index < lookback.length - 6; index += 1) {
    const history = lookback.slice(0, index + 1);
    const latest = history[history.length - 1];
    const sma5 = calculateSma(history, 5).at(-1)?.value ?? latest.close;
    const sma25 = calculateSma(history, 25).at(-1)?.value ?? latest.close;
    const sma75 = calculateSma(history, 75).at(-1)?.value ?? latest.close;
    const rsi = calculateRsi(history, 14).at(-1)?.value ?? 50;
    const macd = calculateMacd(history).at(-1)?.histogram ?? 0;
    const atr = calculateAtr(history, 14).at(-1)?.value ?? 0;
    const sr = calculateSupportResistance(history, 20);
    const realizedVolatilityPercent = calculateRealizedVolatilityPercent(history, 20);

    const setupScore =
      (latest.close > sma5 ? 16 : -10)
      + (sma5 > sma25 ? 14 : -8)
      + (sma25 > sma75 ? 10 : -8)
      + (rsi >= 45 && rsi <= 68 ? 8 : rsi > 78 ? -10 : rsi < 35 ? -9 : 0)
      + (macd > 0 ? 10 : -9);

    if (setupScore < 20) {
      continue;
    }

    const entryPrice = latest.close;
    const levels = deriveTradeLevels({
      entryPrice,
      atr,
      realizedVolatilityPercent,
      support: sr.support,
      resistance: sr.resistance,
    });

    const horizon = lookback.slice(index + 1, Math.min(index + 6, lookback.length));
    if (horizon.length === 0) {
      continue;
    }

    let exitPrice = horizon[horizon.length - 1].close;
    let closed = false;

    for (const candle of horizon) {
      if (candle.low <= levels.stopLossPrice) {
        exitPrice = levels.stopLossPrice;
        closed = true;
        break;
      }

      if (candle.high >= levels.takeProfitPrice) {
        exitPrice = levels.takeProfitPrice;
        closed = true;
        break;
      }
    }

    if (!closed) {
      exitPrice = horizon[horizon.length - 1].close;
    }

    const ret = ((exitPrice - entryPrice) / Math.max(entryPrice, 1)) * 100;
    returns.push(ret);
    if (ret >= 0) {
      profits.push(ret);
    } else {
      losses.push(Math.abs(ret));
    }
  }

  if (returns.length === 0) {
    return {
      periodDays: lookback.length,
      totalTrades: 0,
      winRate: 0,
      averageProfit: 0,
      averageLoss: 0,
      expectedValuePercent: 0,
      averageReturn: 0,
      riskRewardRatio: 0,
      maxDrawdown: 0,
      profitFactor: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
    };
  }

  const totalTrades = returns.length;
  const winRate = (profits.length / totalTrades) * 100;
  const averageProfit = profits.length > 0 ? profits.reduce((sum, value) => sum + value, 0) / profits.length : 0;
  const averageLoss = losses.length > 0 ? losses.reduce((sum, value) => sum + value, 0) / losses.length : 0;
  const averageReturn = returns.reduce((sum, value) => sum + value, 0) / totalTrades;
  const expectedValuePercent = (winRate / 100) * averageProfit - (1 - winRate / 100) * averageLoss;
  const riskRewardRatio = averageLoss > 0 ? averageProfit / averageLoss : averageProfit > 0 ? 3 : 0;
  const equityCurve: number[] = [];
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const ret of returns) {
    equity *= 1 + ret / 100;
    equityCurve.push(equity);
    peak = Math.max(peak, equity);
    const drawdown = (peak - equity) / Math.max(peak, 1e-9);
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const positiveSum = profits.reduce((sum, value) => sum + value, 0);
  const negativeSum = losses.reduce((sum, value) => sum + value, 0);
  const profitFactor = negativeSum > 0 ? positiveSum / negativeSum : positiveSum > 0 ? 9.99 : 0;
  const mean = averageReturn;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(1, totalTrades - 1);
  const deviation = Math.sqrt(variance);
  const downside = returns.filter((value) => value < 0);
  const downsideVariance = downside.reduce((sum, value) => sum + (value ** 2), 0) / Math.max(1, downside.length);
  const downsideDeviation = Math.sqrt(downsideVariance);
  const effectiveDays = Math.max(lookback.length, 1);
  const annualFactor = Math.sqrt(252 / Math.max(1, Math.min(5, effectiveDays / Math.max(1, totalTrades))));
  const sharpeRatio = deviation > 0 ? (mean / deviation) * annualFactor : 0;
  const sortinoRatio = downsideDeviation > 0 ? (mean / downsideDeviation) * annualFactor : 0;
  const years = effectiveDays / 252;
  const cagr = years > 0 && equity > 0 ? (Math.pow(equity, 1 / years) - 1) * 100 : 0;
  const calmarRatio = maxDrawdown > 0 ? cagr / (maxDrawdown * 100) : cagr > 0 ? 9.99 : 0;

  return {
    periodDays: lookback.length,
    totalTrades,
    winRate,
    averageProfit,
    averageLoss,
    expectedValuePercent,
    averageReturn,
    riskRewardRatio,
    maxDrawdown: maxDrawdown * 100,
    profitFactor,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
  };
}

function buildFallbackStock(query: string): Stock {
  return {
    code: query,
    name: "検索銘柄",
    sector: "未分類",
    baselineTrend: "neutral",
    description:
      "銘柄マスターにない入力です。実データAPI連携後は検索結果から正式な銘柄情報を取得します。",
  };
}

export function analyzeStock(input: AiScoreInput, options?: AnalyzeStockOptions): AiScoreResult {
  const query = input.query.trim();
  const stock = input.stock ?? buildFallbackStock(query);
  const candles = stock.chartData?.candles ?? [];
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const latestPrice = stock.marketData?.price ?? latest?.close ?? 1000;
  const baseWeights = normalizeWeights(options?.weights);
  const learningProfile = normalizeLearningProfile(options?.learningProfile ?? stock.analysisLearningProfile);
  const weights = buildAdaptiveWeights(baseWeights, stock.timeframe, candles.length);

  let score = 50;
  const reasons: string[] = [];
  let bullishVotes = 0;
  let bearishVotes = 0;
  let latestRsi = 50;
  let latestAtr = 0;
  let support = 0;
  let resistance = 0;
  let latestClose = latest?.close ?? latestPrice;
  let latestSma5 = latestClose;
  let latestSma25 = latestClose;
  let latestSma75 = latestClose;
  let latestAdx = 0;
  let latestMacdHistogram = 0;
  let macdHistogramDelta = 0;
  let momentumPersistence = 0;
  let momentumConsistency = 0;
  let shortTrendPercent = 0;
  let midTrendPercent = 0;
  let longTrendPercent = 0;
  let trendAlignment = 0;
  let maSlopeBlend = 0;
  let regimeAdjustment = 0;
  let volatilityPercent = 0;
  let pricePosition = 0.5;
  let volumeSurgeRate = 1;
  let volumeRatio = 1;
  const newsSentimentScore = stock.newsAnalysis?.score ?? 0;
  const newsSentimentConfidence = stock.newsAnalysis?.confidence ?? 35;
  const newsImportance = stock.newsAnalysis?.importance ?? "軽微";
  const newsImpact = buildNewsImpact(newsSentimentScore, newsSentimentConfidence, newsImportance);
  let trendStack = { dailyTrend: 0, weeklyTrend: 0, monthlyTrend: 0, alignment: 0, strength: 0 };
  let trendAssessment = {
    direction: "横ばい",
    totalScore: 0,
    daily: { value: 0, direction: "横ばい", score: 0 },
    weekly: { value: 0, direction: "横ばい", score: 0 },
    monthly: { value: 0, direction: "横ばい", score: 0 },
  };

  if (candles.length >= 30) {
    const sma5 = calculateSma(candles, 5);
    const sma25 = calculateSma(candles, 25);
    const sma75 = calculateSma(candles, 75);
    const rsiSeries = calculateRsi(candles, 14);
    const macdSeries = calculateMacd(candles);
    const volumeAverage = calculateVolumeAverage(candles, 20);
    const bollingerSeries = calculateBollingerBands(candles, 20, 2);
    const atrSeries = calculateAtr(candles, 14);
    const adxSeries = calculateAdx(candles, 14);
    const supportResistance = calculateSupportResistance(candles, 20);
    const computedVolumeSurgeRate = calculateVolumeSurgeRate(candles, 20);

    latestSma5 = sma5[sma5.length - 1]?.value ?? latest?.close ?? 0;
    latestSma25 = sma25[sma25.length - 1]?.value ?? latest?.close ?? 0;
    latestSma75 = sma75[sma75.length - 1]?.value ?? latest?.close ?? 0;
    const ma5Values = sma5.map((point) => point.value);
    const ma25Values = sma25.map((point) => point.value);
    const ma75Values = sma75.map((point) => point.value);
    const ma5Slope = calcSlopePercent(ma5Values, 4);
    const ma25Slope = calcSlopePercent(ma25Values, 6);
    const ma75Slope = calcSlopePercent(ma75Values, 8);
    maSlopeBlend = ma5Slope * 0.45 + ma25Slope * 0.35 + ma75Slope * 0.2;
    latestRsi = rsiSeries[rsiSeries.length - 1]?.value ?? 50;
    const latestMacd = macdSeries[macdSeries.length - 1];
    const previousMacd = macdSeries[macdSeries.length - 2];
    const latestBollinger = bollingerSeries[bollingerSeries.length - 1];
    latestAtr = atrSeries[atrSeries.length - 1]?.value ?? 0;
    latestAdx = adxSeries[adxSeries.length - 1]?.value ?? 0;
    const latestVolume = latest?.volume ?? 0;
    latestClose = latest?.close ?? latestPrice;
    pricePosition = latestBollinger
      ? (latestClose - latestBollinger.lower) / Math.max(latestBollinger.upper - latestBollinger.lower, 1)
      : 0.5;
    const atrPercent = latestClose > 0 ? (latestAtr / latestClose) * 100 : 0;
    volatilityPercent = atrPercent;
    support = supportResistance.support;
    resistance = supportResistance.resistance;
    const nearSupport = support > 0 && latestClose <= support * 1.02;
    const nearResistance = resistance > 0 && latestClose >= resistance * 0.98;
    const breakout = resistance > 0 && latestClose >= resistance * 1.005;
    volumeRatio = volumeAverage > 0 ? latestVolume / volumeAverage : 1;
    volumeSurgeRate = computedVolumeSurgeRate;
    const volumeSpike = volumeSurgeRate >= 1.6;
    const strongVolumeSpike = volumeSurgeRate >= 2;
    const volumeProfile = buildVolumeProfile(candles, latestVolume);
    latestMacdHistogram = latestMacd?.histogram ?? 0;
    macdHistogramDelta = latestMacd && previousMacd ? latestMacd.histogram - previousMacd.histogram : 0;

    const closes = candles.map((candle) => candle.close);
    const shortWindow = closes.slice(-6);
    const midWindow = closes.slice(-18);
    const longWindow = closes.slice(-60);
    const shortBase = shortWindow[0] ?? latestClose;
    const midBase = midWindow[0] ?? latestClose;
    const longBase = longWindow[0] ?? latestClose;
    const shortMomentum = calcChangePercent(shortBase, latestClose);
    const midMomentum = calcChangePercent(midBase, latestClose);
    shortTrendPercent = shortMomentum;
    midTrendPercent = midMomentum;
    longTrendPercent = calcChangePercent(longBase, latestClose);
    momentumPersistence = shortMomentum - midMomentum;
    const upMoves = shortWindow.filter((value, index) => index > 0 && value >= shortWindow[index - 1]).length;
    const downMoves = Math.max(0, shortWindow.length - 1 - upMoves);
    momentumConsistency = shortWindow.length > 2 ? (upMoves - downMoves) / (shortWindow.length - 1) : 0;
    trendAlignment =
      (shortTrendPercent > 0 ? 1 : -1)
      + (midTrendPercent > 0 ? 1 : -1)
      + (longTrendPercent > 0 ? 1 : -1);
    trendStack = buildTrendStack(closes, latestClose);
    trendAssessment = buildTrendAssessment(trendStack);
    if (trendAssessment.totalScore > 0) {
      score += trendAssessment.totalScore;
      bullishVotes += 1;
      reasons.push(`日足は${trendAssessment.daily.direction}（${trendAssessment.daily.value.toFixed(2)}%）、週足は${trendAssessment.weekly.direction}（${trendAssessment.weekly.value.toFixed(2)}%）、月足は${trendAssessment.monthly.direction}（${trendAssessment.monthly.value.toFixed(2)}%）で、総合トレンドは${trendAssessment.direction}です。`);
    } else if (trendAssessment.totalScore < 0) {
      score += trendAssessment.totalScore;
      bearishVotes += 1;
      reasons.push(`日足は${trendAssessment.daily.direction}（${trendAssessment.daily.value.toFixed(2)}%）、週足は${trendAssessment.weekly.direction}（${trendAssessment.weekly.value.toFixed(2)}%）、月足は${trendAssessment.monthly.direction}（${trendAssessment.monthly.value.toFixed(2)}%）で、総合トレンドは${trendAssessment.direction}です。`);
    } else {
      reasons.push(`日足は${trendAssessment.daily.direction}（${trendAssessment.daily.value.toFixed(2)}%）、週足は${trendAssessment.weekly.direction}（${trendAssessment.weekly.value.toFixed(2)}%）、月足は${trendAssessment.monthly.direction}（${trendAssessment.monthly.value.toFixed(2)}%）で、総合トレンドは横ばいです。`);
    }
    const gapInsight = buildGapScore(candles, latestClose);
    if (gapInsight.reason) {
      reasons.push(gapInsight.reason);
      const weightedGapScore = Math.round(Math.abs(gapInsight.score) * learningProfile.gapWeight);
      if (gapInsight.bullish) {
        score += weightedGapScore;
        bullishVotes += 1;
      } else if (gapInsight.bearish) {
        score -= weightedGapScore;
        bearishVotes += 1;
      }
    }

    if (latestClose > latestSma5) {
      score += 8;
      bullishVotes += 1;
      reasons.push("株価が5MAを上回っており、短期トレンドは上向きです。");
    } else {
      score -= 7;
      bearishVotes += 1;
      reasons.push("株価が5MAを下回っており、短期の勢いは弱いです。");
    }

    if (latestSma5 > latestSma25) {
      score += 9;
      bullishVotes += 1;
      reasons.push("5MAが25MAを上回っており、短中期の基調は上向きです。");
    } else {
      score -= 5;
      bearishVotes += 1;
    }

    if (latestSma25 > latestSma75) {
      score += 8;
      bullishVotes += 1;
      reasons.push("25MAが75MAを上回っており、中長期トレンドも改善しています。");
    } else {
      score -= 6;
      bearishVotes += 1;
    }

    if (latest && previous && latest.close > previous.close) {
      score += 5;
      bullishVotes += 1;
      reasons.push("直近の終値が前日比で上昇しています。");
    } else if (latest && previous) {
      score -= 4;
      bearishVotes += 1;
    }

    if (latestRsi >= 50 && latestRsi <= 68) {
      score += 6;
      bullishVotes += 1;
      reasons.push("RSI(14)が適温圏にあり、上昇継続の余地があります。");
    } else if (latestRsi > 68 && latestRsi <= 78) {
      score += 3;
      reasons.push("RSI(14)がやや高めですが、勢いは維持されています。");
    } else if (latestRsi > 78) {
      score -= 4;
      bearishVotes += 1;
      reasons.push("RSI(14)が高すぎるため、過熱感に注意が必要です。");
    } else if (latestRsi <= 40) {
      score -= 7;
      bearishVotes += 1;
      reasons.push("RSI(14)が低く、下押し圧力が優勢です。");
    }

    if (latestMacd && latestMacd.histogram > 0) {
      score += 7;
      bullishVotes += 1;
      reasons.push("MACDヒストグラムがプラスで、モメンタムは上向きです。");
    } else if (latestMacd && latestMacd.histogram < 0) {
      score -= 7;
      bearishVotes += 1;
      reasons.push("MACDヒストグラムがマイナスで、モメンタムは弱いです。");
    }

    if (latestMacd && previousMacd && latestMacd.histogram > previousMacd.histogram) {
      score += 3;
      bullishVotes += 1;
    }

    if (momentumPersistence >= 0.45) {
      score += 5;
      bullishVotes += 1;
      reasons.push("短中期モメンタムの加速が確認でき、上昇継続シナリオが優勢です。");
    } else if (momentumPersistence <= -0.45) {
      score -= 5;
      bearishVotes += 1;
      reasons.push("短期モメンタムが鈍化しており、反落リスクに注意が必要です。");
    }

    if (momentumConsistency >= 0.55) {
      score += 4;
      bullishVotes += 1;
    } else if (momentumConsistency <= -0.45) {
      score -= 4;
      bearishVotes += 1;
    }

    if (trendAlignment >= 3) {
      score += 7;
      bullishVotes += 1;
      reasons.push("短期・中期・長期トレンドが同方向で、上昇シグナルの整合性が高いです。");
    } else if (trendAlignment <= -3) {
      score -= 7;
      bearishVotes += 1;
      reasons.push("短期・中期・長期トレンドが下向きで、戻り売り優位の地合いです。");
    }

    if (maSlopeBlend >= 0.55) {
      score += 6;
      bullishVotes += 1;
      reasons.push("移動平均線の傾きが上向きで、トレンドの持続性が確認できます。");
    } else if (maSlopeBlend <= -0.45) {
      score -= 6;
      bearishVotes += 1;
      reasons.push("移動平均線の傾きが下向きで、反発より戻り売りが優勢です。");
    }

    if (trendStack.alignment >= 3) {
      score += 6;
      bullishVotes += 1;
      reasons.push("日足・週足・月足のトレンドが揃っており、中期の追随に向いています。");
    } else if (trendStack.alignment <= -3) {
      score -= 6;
      bearishVotes += 1;
      reasons.push("日足・週足・月足のトレンドが下向きで、逆張りは慎重判断です。");
    }

    if (trendStack.strength >= 12 && trendStack.dailyTrend > 0) {
      score += 4;
      bullishVotes += 1;
      reasons.push("上位足のトレンド強度が高く、押し目買いの継続性があります。\n");
    }

    if (latestAdx >= 35) {
      score += 6;
      bullishVotes += 1;
      reasons.push("ADXが高く、トレンドの強さが十分にあります。");
    } else if (latestAdx >= 25) {
      score += 3;
      bullishVotes += 1;
      reasons.push("ADXがトレンド成立の目安を上回っています。");
    } else if (latestAdx > 0 && latestAdx < 15) {
      score -= 4;
      bearishVotes += 1;
      reasons.push("ADXが低く、方向感の弱い相場です。");
    }

    if (latestBollinger) {
      if (latestClose > latestBollinger.upper) {
        score += 5;
        bullishVotes += 1;
        reasons.push("株価がボリンジャーバンド上限を上抜けており、強いトレンド継続の可能性があります。");
      } else if (latestClose < latestBollinger.lower) {
        score -= 6;
        bearishVotes += 1;
        reasons.push("株価がボリンジャーバンド下限を割れており、下落圧力が強いです。");
      } else if (pricePosition >= 0.35 && pricePosition <= 0.7) {
        score += 3;
        bullishVotes += 1;
        reasons.push("株価がボリンジャーバンドの中段より上にあり、需給は比較的良好です。");
      }
    }

    const prior20Candles = candles.length > 1 ? candles.slice(Math.max(0, candles.length - 21), -1) : candles;
    const recent20High = prior20Candles.reduce((max, candle) => Math.max(max, candle.high), Number.NEGATIVE_INFINITY);
    const recent20Low = prior20Candles.reduce((min, candle) => Math.min(min, candle.low), Number.POSITIVE_INFINITY);
    const highBreakout = Number.isFinite(recent20High) && latestClose >= recent20High;
    const lowBreakdown = Number.isFinite(recent20Low) && latestClose <= recent20Low;

    if (breakout) {
      score += 8;
      bullishVotes += 1;
      reasons.push("レジスタンスラインを明確に突破しており、上昇継続の余地があります。");
    } else if (nearResistance) {
      score -= 4;
      bearishVotes += 1;
      reasons.push("レジスタンスラインに接近しており、上値の重さが意識されます。");
    } else if (nearSupport) {
      score += 4;
      bullishVotes += 1;
      reasons.push("サポートライン近辺で推移しており、下値は限定的です。");
    }

    if (highBreakout) {
      score += 6;
      bullishVotes += 1;
      reasons.push("直近高値（20本）を更新しており、トレンド加速を示しています。");
    }

    if (lowBreakdown) {
      score -= 8;
      bearishVotes += 1;
      reasons.push("直近20本の安値を更新しており、下落継続に警戒が必要です。");
    }

    if (volumeAverage > 0 && volumeSpike) {
      score += strongVolumeSpike ? 9 : 6;
      bullishVotes += 1;
      reasons.push(`出来高が平均の${volumeSurgeRate.toFixed(2)}倍で、資金流入が強まっています。`);
    } else if (latestVolume < volumeAverage * 0.85) {
      score -= 5;
      bearishVotes += 1;
      reasons.push("出来高が平均を下回っており、値動きの信頼性は高くありません。");
    }

    if (volumeProfile.reason) {
      reasons.push(volumeProfile.reason);
      const weightedVolumeScore = Math.round(Math.abs(volumeProfile.score) * learningProfile.volumeWeight);
      if (volumeProfile.bullish) {
        score += Math.max(0, weightedVolumeScore);
        bullishVotes += 1;
      } else if (volumeProfile.bearish) {
        score -= Math.abs(weightedVolumeScore);
        bearishVotes += 1;
      }
    }

    if (volumeProfile.surgeRatio >= 1.8 || volumeProfile.trendPercent >= 15) {
      score += Math.max(1, Math.round(2 * learningProfile.volumeWeight));
      bullishVotes += 1;
      reasons.push("直近の出来高が平均より増えており、ブレイクの信頼度が高まっています。");
    }

    if (latestAtr > 0) {
      if (atrPercent >= 6) {
        score -= 4;
        bearishVotes += 1;
        reasons.push("ATRが高く、値動きが荒いためエントリーの難易度が上がっています。");
      } else if (atrPercent <= 2.5) {
        score += 2;
      }
    }
  } else {
    const dayReturn = latest && latest.open > 0 ? ((latest.close - latest.open) / latest.open) * 100 : (stock.marketData?.changePercent ?? 0);
    const dayRange = latest && latest.close > 0 ? ((latest.high - latest.low) / latest.close) * 100 : 0;
    const sparseNewsBias = newsSentimentScore * (newsSentimentConfidence / 100) * 0.45;
    score = clamp(50 + dayReturn * 6.2 - dayRange * 1.25 + sparseNewsBias, 12, 88);
    if (dayReturn >= 0) {
      bullishVotes += 1;
    } else {
      bearishVotes += 1;
    }
    reasons.push("ローソク足が十分でないため、当日値動き・日中ボラティリティ・ニュースを中心に暫定評価しています。");
  }

  const baseScore = clamp(score, 0, 100);
  const consensus = Math.abs(bullishVotes - bearishVotes);
  const voteBias = bullishVotes - bearishVotes;
  const provisionalTrendStrength = baseScore >= 80 ? "非常に強い" : baseScore >= 65 ? "強い" : baseScore >= 48 ? "標準" : "弱い";
  const entryPrice = Number(latestPrice.toFixed(2));
  const atrForTrade = latestAtr > 0 ? latestAtr : entryPrice * 0.02;
  const realizedVolatilityPercent = calculateRealizedVolatilityPercent(candles, 20);
  const tradeLevels = deriveTradeLevels({
    entryPrice,
    atr: atrForTrade,
    realizedVolatilityPercent,
    support,
    resistance,
  });
  const stopLossPrice = Number(tradeLevels.stopLossPrice.toFixed(2));
  const takeProfitPrice = Number(tradeLevels.takeProfitPrice.toFixed(2));
  const riskRewardRatio = Number(((takeProfitPrice - entryPrice) / Math.max(entryPrice - stopLossPrice, 1)).toFixed(2));
  const lossRiskPercent = Number((((entryPrice - stopLossPrice) / Math.max(entryPrice, 1)) * 100).toFixed(2));
  const rewardPercent = ((takeProfitPrice - entryPrice) / Math.max(entryPrice, 1)) * 100;
  const ma5Score = clamp(50 + ((latestClose - latestSma5) / Math.max(latestSma5, 1)) * 2000, 0, 100);
  const ma25Score = clamp(50 + ((latestSma5 - latestSma25) / Math.max(latestSma25, 1)) * 2000, 0, 100);
  const ma75Score = clamp(50 + ((latestSma25 - latestSma75) / Math.max(latestSma75, 1)) * 1800, 0, 100);
  const rsiScore = latestRsi >= 52 && latestRsi <= 68 ? 76 : latestRsi > 75 ? 35 : latestRsi < 35 ? 30 : 56;
  const macdScore = clamp(52 + latestMacdHistogram * 900 + macdHistogramDelta * 500, 0, 100);
  const adxScore = clamp(latestAdx * 2.2, 0, 100);
  const atrScore = clamp(95 - lossRiskPercent * 9, 0, 100);
  const bollingerScore = clamp(100 - Math.abs(pricePosition - 0.62) * 140, 0, 100);
  const srDistance = resistance > 0 && support > 0 ? (resistance - support) / Math.max(entryPrice, 1) : 0;
  const supportResistanceScore = clamp(58 + srDistance * 900 - (latestClose >= resistance * 0.99 ? 15 : 0), 0, 100);
  const volumeRatioScore = clamp(40 + volumeRatio * 28, 0, 100);
  const volumeSpikeScore = clamp(35 + volumeSurgeRate * 24, 0, 100);
  const trendStrengthScore = clamp(baseScore, 0, 100);
  const lossRiskScore = clamp(100 - lossRiskPercent * 11, 0, 100);
  const maCompositeScore = clamp((ma5Score * 0.35) + (ma25Score * 0.35) + (ma75Score * 0.3), 0, 100);
  const volumeCompositeScore = clamp((volumeRatioScore * 0.55) + (volumeSpikeScore * 0.45), 0, 100);
  const atrComponentScore = clamp(95 - ((atrForTrade / Math.max(entryPrice, 1)) * 100 * 10), 0, 100);
  const volatilityScore = clamp(100 - realizedVolatilityPercent * 18, 0, 100);
  const lookback52 = candles.slice(-252);
  const high52 = lookback52.length > 0 ? Math.max(...lookback52.map((candle) => candle.high)) : latestClose;
  const low52 = lookback52.length > 0 ? Math.min(...lookback52.map((candle) => candle.low)) : latestClose;
  const positionIn52w = high52 > low52 ? (latestClose - low52) / (high52 - low52) : 0.5;
  const week52Score = clamp(100 - Math.abs(positionIn52w - 0.62) * 160, 0, 100);
  const nikkeiChangePercent = stock.marketContext?.nikkeiChangePercent ?? null;
  const topixChangePercent = stock.marketContext?.topixChangePercent ?? null;
  const usdJpyChangePercent = stock.marketContext?.usdJpyChangePercent ?? null;
  const vixChangePercent = stock.marketContext?.vixChangePercent ?? null;
  const nikkeiScore = nikkeiChangePercent === null ? 50 : clamp(50 + nikkeiChangePercent * 10, 0, 100);
  const topixScore = topixChangePercent === null ? 50 : clamp(50 + topixChangePercent * 9, 0, 100);
  const usdJpyScore = usdJpyChangePercent === null ? 50 : clamp(50 + usdJpyChangePercent * 8, 0, 100);
  const vixScore = vixChangePercent === null ? 50 : clamp(55 - vixChangePercent * 8, 0, 100);
  const marketRegimeScore = clamp((nikkeiScore * 0.33) + (topixScore * 0.34) + (usdJpyScore * 0.2) + (vixScore * 0.13), 0, 100);
  const newsComponentScore = clamp(50 + (newsSentimentScore * (newsSentimentConfidence / 100) * 0.8), 0, 100);
  const oneYearBacktest = simulateRollingBacktest(candles, 756);
  const externalBacktest = stock.analysisBacktest;
  const backtestWinRateRaw = oneYearBacktest.totalTrades >= 12
    ? oneYearBacktest.winRate
    : (externalBacktest?.winRate ?? 50);
  const backtestExpectedRaw = oneYearBacktest.totalTrades >= 12
    ? oneYearBacktest.expectedValuePercent
    : (externalBacktest?.expectedValuePercent ?? 0);
  const backtestDrawdownRaw = oneYearBacktest.totalTrades >= 12
    ? oneYearBacktest.maxDrawdown
    : (externalBacktest?.maxDrawdown ?? clamp(oneYearBacktest.averageLoss * 5, 0, 30));
  const backtestProfitFactorRaw = oneYearBacktest.totalTrades >= 12
    ? oneYearBacktest.profitFactor
    : (externalBacktest?.profitFactor ?? 1);
  const backtestSharpeRaw = oneYearBacktest.totalTrades >= 12
    ? oneYearBacktest.sharpeRatio
    : (externalBacktest?.sharpeRatio ?? 0);
  const backtestSortinoRaw = oneYearBacktest.totalTrades >= 12
    ? oneYearBacktest.sortinoRatio
    : (externalBacktest?.sortinoRatio ?? 0);
  const backtestCalmarRaw = oneYearBacktest.totalTrades >= 12
    ? oneYearBacktest.calmarRatio
    : (externalBacktest?.calmarRatio ?? 0);
  const backtestRrRaw = oneYearBacktest.totalTrades >= 12
    ? oneYearBacktest.riskRewardRatio
    : riskRewardRatio;
  const backtestScore = clamp(
    backtestWinRateRaw * 0.34
      + (backtestExpectedRaw + 3) * 8.5
      + backtestProfitFactorRaw * 9.5
      + backtestRrRaw * 5.5
      + backtestSharpeRaw * 4.4
      + backtestSortinoRaw * 4.9
      + backtestCalmarRaw * 4.4
      - backtestDrawdownRaw * 1.75,
    0,
    100,
  );
  const riskPenalty =
    lossRiskPercent >= 6 ? 10
      : lossRiskPercent >= 5 ? 7
      : lossRiskPercent >= 4 ? 4
      : lossRiskPercent >= 3 ? 2
      : 0;
  const rewardBonus = rewardPercent >= 8 ? 5 : rewardPercent >= 6 ? 3 : rewardPercent >= 4 ? 1 : 0;
  const rrBonus = riskRewardRatio >= 2.4 ? 6 : riskRewardRatio >= 2 ? 4 : riskRewardRatio >= 1.6 ? 2 : 0;
  const expectancyPercent = (rewardPercent * (backtestWinRateRaw / 100)) - (lossRiskPercent * (1 - backtestWinRateRaw / 100));
  const expectancyBonus = expectancyPercent >= 2.2 ? 7 : expectancyPercent >= 1.5 ? 5 : expectancyPercent >= 0.8 ? 3 : expectancyPercent >= 0 ? 1 : -3;
  const consistencyBonus = momentumConsistency >= 0.4 ? 3 : momentumConsistency <= -0.4 ? -4 : 0;
  const horizonBonus = trendAlignment >= 2 ? 4 : trendAlignment <= -2 ? -5 : 0;
  if (stock.baselineTrend === "up") {
    regimeAdjustment += 3;
  } else if (stock.baselineTrend === "steady") {
    regimeAdjustment += 1;
  } else if (stock.baselineTrend === "volatile") {
    regimeAdjustment -= 4;
  }

  if (lossRiskPercent >= 5.5 && stock.baselineTrend === "volatile") {
    regimeAdjustment -= 3;
  }

  if (newsSentimentScore >= 18 && newsSentimentConfidence >= 60) {
    regimeAdjustment += 2;
  } else if (newsSentimentScore <= -18 && newsSentimentConfidence >= 60) {
    regimeAdjustment -= 2;
  }

  const downsidePenalty = lossRiskPercent >= 7 ? 11 : lossRiskPercent >= 6 ? 8 : lossRiskPercent >= 5 ? 5 : 0;
  const newsRegimeBias = newsSentimentScore >= 15 && newsSentimentConfidence >= 60 ? 4 : newsSentimentScore <= -15 && newsSentimentConfidence >= 60 ? -4 : 0;
  const technicalWeighted = (
    rsiScore * weights.rsi
    + macdScore * weights.macd
    + ma5Score * weights.ma5
    + ma25Score * weights.ma25
    + ma75Score * weights.ma75
    + adxScore * weights.adx
    + atrScore * weights.atr
    + bollingerScore * weights.bollinger
    + supportResistanceScore * weights.supportResistance
    + volumeRatioScore * weights.volumeRatio
    + volumeSpikeScore * weights.volumeSpike
    + trendStrengthScore * weights.trendStrength
    + lossRiskScore * weights.lossRisk
  ) / (
    weights.rsi
    + weights.macd
    + weights.ma5
    + weights.ma25
    + weights.ma75
    + weights.adx
    + weights.atr
    + weights.bollinger
    + weights.supportResistance
    + weights.volumeRatio
    + weights.volumeSpike
    + weights.trendStrength
    + weights.lossRisk
  );
  const newsAdjustmentBase = clamp((newsSentimentScore / 100) * (newsSentimentConfidence / 100) * 12, -10, 10) + newsRegimeBias + newsImpact.score;
  const newsAdjustment = newsAdjustmentBase * learningProfile.newsWeight;
  const tradeFactor = adaptiveTradeFactor({
    timeframe: stock.timeframe,
    trendAlignment,
    maSlopeBlend,
    volatilityPercent,
  });
  if (stock.newsAnalysis) {
    reasons.push(newsImpact.reason);
  }

  reasons.push(`52週レンジは高値${high52.toFixed(2)}円・安値${low52.toFixed(2)}円で、現在位置は${(positionIn52w * 100).toFixed(1)}%です。`);
  if (nikkeiChangePercent !== null) {
    reasons.push(`日経平均の前日比は${nikkeiChangePercent.toFixed(2)}%で、市場地合いをスコアに反映しています。`);
  }
  if (topixChangePercent !== null) {
    reasons.push(`TOPIXの前日比は${topixChangePercent.toFixed(2)}%で、市場全体の広がりをスコアに反映しています。`);
  }
  if (usdJpyChangePercent !== null) {
    reasons.push(`ドル円の前日比は${usdJpyChangePercent.toFixed(2)}%で、為替感応度をスコアに反映しています。`);
  }
  if (vixChangePercent !== null) {
    reasons.push(`VIXの前日比は${vixChangePercent.toFixed(2)}%で、リスクオフ圧力をスコアに反映しています。`);
  }
  if (stock.analysisBacktest) {
    reasons.push(`バックテスト（${stock.analysisBacktest.periodDays}日）の勝率${stock.analysisBacktest.winRate.toFixed(2)}%・期待値${stock.analysisBacktest.expectedValuePercent.toFixed(2)}%・PF${stock.analysisBacktest.profitFactor.toFixed(2)}・最大DD${stock.analysisBacktest.maxDrawdown.toFixed(2)}%を採点に反映しています。`);
  }
  if (oneYearBacktest.totalTrades > 0) {
    reasons.push(`過去${oneYearBacktest.periodDays}日（最大3年）の実データ検証では${oneYearBacktest.totalTrades}トレード、勝率${oneYearBacktest.winRate.toFixed(2)}%、期待値${oneYearBacktest.expectedValuePercent.toFixed(2)}%、PF${oneYearBacktest.profitFactor.toFixed(2)}でした。`);
  }

  const technicalBlend = clamp(0.6 * learningProfile.technicalWeight, 0.4, 0.78);
  const baseBlend = clamp(0.34 * learningProfile.technicalWeight, 0.2, 0.45);
  const adjustedScore = clamp(
    baseScore * baseBlend
      + technicalWeighted * technicalBlend
      + newsAdjustment
      - riskPenalty
      - downsidePenalty
      + rewardBonus
      + rrBonus
      + expectancyBonus
      + consistencyBonus
      + horizonBonus
      + regimeAdjustment
      + Math.max(voteBias, -3),
    0,
    100,
  );

  const productionAiScore = clamp(
    (
      backtestWinRateRaw * 0.42
      + maCompositeScore * 0.1
      + macdScore * 0.06
      + rsiScore * 0.06
      + volumeCompositeScore * 0.06
      + atrComponentScore * 0.05
      + volatilityScore * 0.05
      + bollingerScore * 0.05
      + week52Score * 0.04
      + nikkeiScore * 0.03
      + topixScore * 0.03
      + usdJpyScore * 0.03
      + vixScore * 0.03
      + newsComponentScore * 0.06
      + supportResistanceScore * 0.06
    )
      + newsAdjustment * 0.35
      + rewardBonus
      + rrBonus
      + regimeAdjustment
      + (marketRegimeScore - 50) * 0.18
      - riskPenalty
      - downsidePenalty,
    0,
    100,
  );

  const backtestReliability = clamp(oneYearBacktest.totalTrades / 80, 0, 1);
  const backtestBlend = 0.5 + backtestReliability * 0.35;
  const productionBlend = 0.3 - backtestReliability * 0.12;
  const adjustedBlend = 1 - backtestBlend - productionBlend;
  const blendedRawScore = (
    productionAiScore * productionBlend
    + adjustedScore * adjustedBlend
    + backtestScore * backtestBlend
  );
  // Shrink extreme tails so score behavior is more consistent across the full universe.
  const stabilizedScore = 50 + (blendedRawScore - 50) * 1.02 + (marketRegimeScore - 50) * 0.14;
  const bearishFloor = voteBias <= -5 || (lossRiskPercent >= 6 && backtestExpectedRaw <= 0) ? 28 : 34;
  const expectancyFloorBoost = backtestExpectedRaw > 0 && backtestRrRaw >= 1.4 && marketRegimeScore >= 42
    ? clamp(backtestExpectedRaw * 2 + Math.max(0, backtestWinRateRaw - 50) * 0.08, 0, 6)
    : 0;
  let finalScore = clamp(stabilizedScore, bearishFloor + expectancyFloorBoost, 92);
  const weakDowntrendSetup =
    stock.baselineTrend === "volatile"
    && trendAssessment.direction === "下降"
    && latestSma25 > 0
    && latestClose < latestSma25
    && volumeRatio <= 0.9;
  if (weakDowntrendSetup) {
    finalScore = Math.min(finalScore, 55);
  }
  let confidence = clamp(
    32
      + Math.round(finalScore * 0.36)
      + consensus * 4
      + (candles.length >= 60 ? 6 : 0)
      - (lossRiskPercent >= 5 ? 8 : 0)
      + (riskRewardRatio >= 2 ? 4 : 0),
    22,
    95,
  ) + tradeFactor.confidenceBonus;
  if (weakDowntrendSetup) {
    confidence = Math.min(confidence, 69);
  }
  const intrinsicRiskLevel = finalScore >= 72 && lossRiskPercent < 4 ? "低" : finalScore >= 48 && lossRiskPercent < 5 ? "中" : "高";
  const trendStrength = finalScore >= 80 ? "非常に強い" : finalScore >= 65 ? "強い" : finalScore >= 48 ? "標準" : "弱い";
  const momentumBias = latest && previous && latest.close > previous.close ? 4 : -3;
  const intradayTrendBias = clamp(trendStack.dailyTrend * 0.5 + trendStack.weeklyTrend * 0.25 + trendStack.monthlyTrend * 0.12, -8, 8);
  const intradayNewsBias = clamp(newsSentimentScore * (newsSentimentConfidence / 100) * 0.04, -4, 4);
  const baseBacktestWinRate = clamp(backtestWinRateRaw, 15, 95);
  const impliedWinRateFromEdge = clamp(
    ((backtestExpectedRaw + lossRiskPercent) / Math.max(rewardPercent + lossRiskPercent, 0.0001)) * 100,
    10,
    96,
  );
  const winRateEdge = clamp(
    (finalScore - 50) * 0.18
      + trendAlignment * 1.1
      + momentumConsistency * 6
      + rrBonus * 0.7
      - lossRiskPercent * 0.75,
    -12,
    12,
  );
  const winRate = clamp(
    Math.round(baseBacktestWinRate * 0.68 + impliedWinRateFromEdge * 0.32 + winRateEdge),
    10,
    96,
  );
  const empiricalRiskReward = oneYearBacktest.totalTrades >= 10 ? oneYearBacktest.riskRewardRatio : riskRewardRatio;
  const effectiveRiskRewardRatio = Number(
    clamp(Math.max(riskRewardRatio, empiricalRiskReward * 0.85), 0.2, 6).toFixed(2),
  );
  let probability5m = clamp(
    Math.round(
      winRate * 0.84
        + momentumBias
        + intradayTrendBias * 0.5
        + intradayNewsBias * 0.5
        + Math.round(momentumPersistence * 0.8)
        + Math.round(momentumConsistency * 3)
        + Math.round(trendAlignment * 1.3)
        + Math.round(maSlopeBlend * 2.5)
        + (latestRsi >= 55 && latestRsi <= 70 ? 4 : 0)
        + (provisionalTrendStrength === "非常に強い" || provisionalTrendStrength === "強い" ? 3 : 0)
        - (lossRiskPercent >= 5 ? 6 : 0),
    ),
    15,
    86,
  );
  let probability15m = clamp(
    Math.round(
      winRate * 0.9
        + intradayTrendBias * 0.7
        + intradayNewsBias * 0.8
        + Math.round(momentumPersistence * 1.2)
        + Math.round(momentumConsistency * 4)
        + Math.round(trendAlignment * 1.7)
        + Math.round(maSlopeBlend * 3.1)
        + (trendStrength === "非常に強い" || trendStrength === "強い" ? 6 : 0)
        + (effectiveRiskRewardRatio >= 2 ? 3 : 0)
        - (lossRiskPercent >= 5 ? 5 : 0),
    ),
    16,
    88,
  );
  const probabilityComposite = (probability5m * 0.4 + probability15m * 0.6) * weights.probabilityUp;
  probability15m = clamp(Math.round(probability15m * 0.8 + probabilityComposite * 0.2), 16, 90);
  probability5m = clamp(Math.round(probability5m * 0.82 + probabilityComposite * 0.18), 15, 88);
  const p5Calibration = intradayCalibration({
    timeframe: "5m",
    volatilityPercent,
    volumeSurgeRate,
    momentumConsistency,
    trendAlignment,
    lossRiskPercent,
  });
  const p15Calibration = intradayCalibration({
    timeframe: "15m",
    volatilityPercent,
    volumeSurgeRate,
    momentumConsistency,
    trendAlignment,
    lossRiskPercent,
  });
  probability5m = clamp(probability5m + p5Calibration, 15, 88);
  probability15m = clamp(probability15m + p15Calibration, 16, 90);
  const probabilityBalance = clamp(100 - Math.abs(probability5m - probability15m) * 1.25, 0, 100);
  probability5m = clamp(Math.round(probability5m * 0.88 + probabilityBalance * 0.12 + tradeFactor.winRateBonus * 0.4), 15, 88);
  probability15m = clamp(Math.round(probability15m * 0.88 + probabilityBalance * 0.12 + tradeFactor.winRateBonus * 0.45 + trendStack.alignment * 0.6), 16, 90);
  const probability1d = clamp(
    Math.round(
      winRate
        + Math.round(momentumPersistence * 1.6)
        + Math.round(momentumConsistency * 5)
        + Math.round(trendAlignment * 2.2)
        + Math.round(maSlopeBlend * 3.8)
        + (effectiveRiskRewardRatio >= 2 ? 5 : 0)
        + (newsSentimentScore > 10 ? 4 : newsSentimentScore < -10 ? -5 : 0)
        - (lossRiskPercent >= 5 ? 6 : 0),
    ),
    18,
    92,
  );
  const trendConsensusScore = clamp(
    50
      + trendAlignment * 8
      + maSlopeBlend * 6
      + trendAssessment.totalScore * 1.4
      + momentumConsistency * 16
      + (trendStack.dailyTrend > 0 ? 3 : -3),
    0,
    100,
  );
  const baseExpectedValuePercent = Number((
    ((winRate / 100) * rewardPercent) - ((1 - winRate / 100) * lossRiskPercent)
  ).toFixed(2));
  const expectedValueAnalysis = calculateExpectedValue({
    aiScore: finalScore,
    backtestWinRate: backtestWinRateRaw,
    profitFactor: backtestProfitFactorRaw,
    riskRewardRatio: effectiveRiskRewardRatio,
    newsScore: newsComponentScore,
    volumeScore: volumeCompositeScore,
    trendScore: trendConsensusScore,
    atr: volatilityPercent,
    adx: latestAdx,
    volatility: realizedVolatilityPercent,
    baseExpectedValue: baseExpectedValuePercent,
  });
  // Keep Ver1.1 score behavior: expected value analyzer must not alter score inputs.
  const expectedValuePercent = baseExpectedValuePercent;
  const riskLevel = intrinsicRiskLevel;
  const expectedValue = expectedValueAnalysis.expectedValue;
  const entryPriority = expectedValueAnalysis.entryPriority;
  const rewardLevel = expectedValueAnalysis.rewardLevel;
  const breakevenWinRate = riskRewardRatio > 0 ? (100 / (1 + riskRewardRatio)) : 100;
  const edgeToBreakeven = winRate - breakevenWinRate;
  const consistencyBoost = clamp(edgeToBreakeven * 0.18 + expectedValuePercent * 1.4, -4, 6);
  let calibratedFinalScore = finalScore;
  calibratedFinalScore = clamp(calibratedFinalScore + consistencyBoost, 0, 100);
  if (expectedValuePercent > 0 && effectiveRiskRewardRatio >= 1.5 && calibratedFinalScore < 45) {
    const uplift = clamp(expectedValuePercent * 1.2 + Math.max(0, winRate - 50) * 0.06, 0, 8);
    calibratedFinalScore = clamp(calibratedFinalScore + uplift, 0, 100);
  }
  const distributionTargetScore = clamp(
    50
      + (winRate - 50) * 0.92
      + expectedValuePercent * 7.4
      + (effectiveRiskRewardRatio - 1) * 11.5
      + (trendConsensusScore - 50) * 0.34
      + (marketRegimeScore - 50) * 0.18,
    0,
    100,
  );
  calibratedFinalScore = clamp(calibratedFinalScore * 0.58 + distributionTargetScore * 0.42, 0, 100);
  if (weakDowntrendSetup) {
    calibratedFinalScore = Math.min(calibratedFinalScore, 55);
  }
    const rankedReasons = rankReasons(reasons);

  const summary = [
    `13項目評価（移動平均・MACD・RSI・出来高・ATR・ボラ・52週レンジ・日経・TOPIX・ドル円・ニュース・バックテスト等）によるAI評価は${Math.round(calibratedFinalScore)}点です。`,
    trendStack.dailyTrend || trendStack.weeklyTrend || trendStack.monthlyTrend
      ? `日足/週足/月足は${trendStack.dailyTrend.toFixed(2)}% / ${trendStack.weeklyTrend.toFixed(2)}% / ${trendStack.monthlyTrend.toFixed(2)}%で、総合トレンドは${trendAssessment.direction}です。`
      : "",
      rankedReasons.slice(0, 4).map((reason) => reason.label).join(" "),
    `損失リスクは${lossRiskPercent}%、1日期待値は${expectedValuePercent}%、リスク水準は${riskLevel}、報酬水準は${rewardLevel}、エントリー優先度は${entryPriority.toFixed(1)}です。トレンド強度は${trendStrength}です。`,
  ].join(" ");
    const aiReasonLabels = rankedReasons.slice(0, 6).map((reason) => reason.label);
  const trendReason = reasons.find((reason) => reason.includes("総合トレンドは"));
  if (trendReason && !aiReasonLabels.some((reason) => reason.includes("総合トレンドは"))) {
    aiReasonLabels.unshift(trendReason);
  }
  const breakoutReason = reasons.find((reason) => reason.includes("直近高値"));
  if (breakoutReason && !aiReasonLabels.some((reason) => reason.includes("直近高値"))) {
    if (aiReasonLabels.length >= 6) {
      aiReasonLabels[5] = breakoutReason;
    } else {
      aiReasonLabels.push(breakoutReason);
    }
  }
  const aiReason = aiReasonLabels.slice(0, 6).map((reason) => `• ${reason}`);
  const roundedScore = Math.round(calibratedFinalScore);
  const signal = decideSignalEnhanced({
    score: roundedScore,
    winRate,
    expectedValuePercent,
    riskRewardRatio: effectiveRiskRewardRatio,
    marketRegimeScore,
    trendConsensusScore,
  });
  const judgment = decideJudgmentEnhanced({
    score: roundedScore,
    signal,
    winRate,
    expectedValuePercent,
  });
  const reasonInsights = buildReasonInsights(reasons, roundedScore, signal);

  return {
    code: stock.code,
    name: stock.name,
    sector: stock.sector,
    score: roundedScore,
    judgment,
    signal,
    trend: trendLabels[stock.baselineTrend],
    confidence: Math.round(confidence),
    summary,
    reasons,
    riskLevel,
    trendStrength,
    entryPrice,
    takeProfitPrice,
    stopLossPrice,
    riskRewardRatio: effectiveRiskRewardRatio,
    lossRiskPercent,
    probability5m,
    probability15m,
    probability1d,
    winRate,
    backtestWinRate: Number(baseBacktestWinRate.toFixed(2)),
    expectedValuePercent,
    expectedValue,
    entryPriority,
    rewardLevel,
    expectedValueRiskLevel: expectedValueAnalysis.riskLevel,
    aiReason,
    positiveFactors: reasonInsights.positiveFactors,
    negativeFactors: reasonInsights.negativeFactors,
    reasonRanking: reasonInsights.reasonRanking,
    decisionReason: reasonInsights.decisionReason,
    chartData: stock.chartData,
    dataStatus: stock.dataStatus,
    dataReason: stock.dataReason,
    timeframe: stock.timeframe,
  };
}
