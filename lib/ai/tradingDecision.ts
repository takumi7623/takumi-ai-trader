import type { AiScoreResult, Tepou30BacktestMetrics } from "../types";

export type TradingDecision =
  | "強い買い"
  | "買い"
  | "押し目待ち"
  | "様子見"
  | "一部利確"
  | "利確"
  | "損切り";

export type TradingDecisionInput = {
  aiScore: Pick<
    AiScoreResult,
    | "score"
    | "confidence"
    | "entryPrice"
    | "expectedValuePercent"
    | "riskRewardRatio"
    | "trendStrength"
    | "riskLevel"
    | "signal"
    | "judgment"
  >;
  backtest: Pick<
    Tepou30BacktestMetrics,
    | "winRate"
    | "averageProfit"
    | "averageLoss"
    | "expectedValuePercent"
    | "averageReturn"
    | "maxDrawdown"
    | "profitFactor"
    | "totalTrades"
  >;
  trend: number;
  momentum: number;
  volume: number;
  priceAction: number;
  risk: number;
  sectorStrength: number;
  volatility: number;
  expectedRiskReward: number;
  currentPrice?: number;
};

export type TradingDecisionResult = {
  decision: TradingDecision;
  confidence: number;
  reasons: string[];
  targetPrice: number;
  stopLoss: number;
  takeProfit: number;
  expectedReturn: number;
  expectedRisk: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number) {
  return Number(value.toFixed(2));
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mapPfToScore(profitFactor: number) {
  return clamp(((profitFactor - 0.8) / 1.8) * 100, 0, 100);
}

function mapDrawdownToScore(maxDrawdown: number) {
  return clamp(100 - maxDrawdown * 3.5, 0, 100);
}

function mapExpectedRiskRewardToScore(expectedRiskReward: number) {
  return clamp(((expectedRiskReward - 0.8) / 2.2) * 100, 0, 100);
}

function deriveCompositeScore(input: TradingDecisionInput) {
  const aiScore = clamp(input.aiScore.score, 0, 100);
  const backtestWinRate = clamp(input.backtest.winRate, 0, 100);
  const backtestProfitFactor = mapPfToScore(input.backtest.profitFactor);
  const backtestDrawdown = mapDrawdownToScore(input.backtest.maxDrawdown);
  const expectedRiskReward = mapExpectedRiskRewardToScore(input.expectedRiskReward);
  const technicalComposite = average([input.trend, input.momentum, input.volume, input.priceAction, input.risk]);
  const stabilityComposite = average([input.risk, clamp(100 - input.volatility, 0, 100), backtestDrawdown]);

  return {
    aiScore,
    backtestWinRate,
    backtestProfitFactor,
    backtestDrawdown,
    expectedRiskReward,
    technicalComposite,
    stabilityComposite,
    composite: clamp(
      aiScore * 0.31
        + backtestWinRate * 0.19
        + backtestProfitFactor * 0.14
        + backtestDrawdown * 0.1
        + technicalComposite * 0.18
        + input.sectorStrength * 0.04
        + expectedRiskReward * 0.04
        + stabilityComposite * 0.0,
      0,
      100,
    ),
  };
}

function buildBaseReasons(input: TradingDecisionInput, composite: ReturnType<typeof deriveCompositeScore>) {
  return [
    `AIスコア ${composite.aiScore.toFixed(1)}点`,
    `バックテスト勝率 ${input.backtest.winRate.toFixed(1)}% / 平均利益 ${input.backtest.averageProfit.toFixed(2)}% / 平均損失 ${input.backtest.averageLoss.toFixed(2)}% / PF ${input.backtest.profitFactor.toFixed(2)} / 最大DD ${input.backtest.maxDrawdown.toFixed(2)}%`,
    `Trend ${input.trend.toFixed(1)} / Momentum ${input.momentum.toFixed(1)} / Volume ${input.volume.toFixed(1)} / Price Action ${input.priceAction.toFixed(1)} / Risk ${input.risk.toFixed(1)}`,
    `セクター強度 ${input.sectorStrength.toFixed(1)} / ボラティリティ ${input.volatility.toFixed(1)} / 期待リスクリワード ${input.expectedRiskReward.toFixed(2)}x`,
    `総合評価スコア ${composite.composite.toFixed(1)}点`,
  ];
}

function determineDecision(input: TradingDecisionInput, composite: ReturnType<typeof deriveCompositeScore>): TradingDecision {
  const strongBacktest =
    input.backtest.winRate >= 62
    && input.backtest.profitFactor >= 1.5
    && input.backtest.maxDrawdown <= 12;
  const healthyBacktest =
    input.backtest.winRate >= 54
    && input.backtest.profitFactor >= 1.2
    && input.backtest.maxDrawdown <= 18;
  const weakBacktest =
    input.backtest.winRate < 50
    || input.backtest.profitFactor < 1.1;

  const strongTechnical = composite.technicalComposite >= 76;
  const goodTechnical = composite.technicalComposite >= 62;
  const cautiousTechnical = composite.technicalComposite >= 66;
  const weakTechnical = composite.technicalComposite < 48;

  if (input.aiScore.score <= 35 || input.backtest.profitFactor <= 0.9 || input.backtest.maxDrawdown >= 28 || composite.composite <= 28) {
    return "損切り";
  }

  if (composite.composite <= 50 && input.aiScore.score <= 52 && weakBacktest && weakTechnical) {
    return "利確";
  }

  if (
    composite.composite <= 65
    && input.aiScore.score >= 55
    && (input.backtest.profitFactor < 1.25 || input.backtest.maxDrawdown >= 16 || input.volatility >= 70 || input.risk <= 45)
  ) {
    return "一部利確";
  }

  if (
    input.aiScore.score >= 68
    && cautiousTechnical
    && input.expectedRiskReward < 1.7
    && (input.volume <= 60 || input.sectorStrength <= 60 || input.volatility >= 55)
  ) {
    return "押し目待ち";
  }

  if (
    input.aiScore.score >= 86
    && strongBacktest
    && strongTechnical
    && input.expectedRiskReward >= 1.8
    && input.sectorStrength >= 70
    && input.volatility <= 55
  ) {
    return "強い買い";
  }

  if (input.aiScore.score >= 72 && healthyBacktest && goodTechnical && input.expectedRiskReward >= 1.4 && input.risk >= 52) {
    return "買い";
  }

  return "様子見";
}

function buildPricePlan(decision: TradingDecision, currentPrice: number, expectedRiskReward: number, volatility: number) {
  const baseMove = clamp(expectedRiskReward * 1.6 + (100 - volatility) * 0.015, 1.2, 9);
  const riskMove = clamp(1.6 + volatility * 0.03, 1.5, 8);

  switch (decision) {
    case "強い買い":
      return {
        targetPrice: round(currentPrice * (1 + baseMove / 100)),
        stopLoss: round(currentPrice * (1 - riskMove / 100)),
        takeProfit: round(currentPrice * (1 + baseMove * 1.55 / 100)),
        expectedReturn: round(baseMove * 1.55),
        expectedRisk: round(riskMove),
      };
    case "買い":
      return {
        targetPrice: round(currentPrice * (1 + baseMove * 0.8 / 100)),
        stopLoss: round(currentPrice * (1 - (riskMove + 0.4) / 100)),
        takeProfit: round(currentPrice * (1 + baseMove * 1.25 / 100)),
        expectedReturn: round(baseMove * 1.25),
        expectedRisk: round(riskMove + 0.4),
      };
    case "押し目待ち":
      return {
        targetPrice: round(currentPrice * (1 - Math.min(2.2, riskMove * 0.35) / 100)),
        stopLoss: round(currentPrice * (1 - (riskMove + 0.6) / 100)),
        takeProfit: round(currentPrice * (1 + baseMove / 100)),
        expectedReturn: round(baseMove),
        expectedRisk: round(riskMove + 0.6),
      };
    case "一部利確":
      return {
        targetPrice: round(currentPrice * (1 - Math.min(1.8, riskMove * 0.25) / 100)),
        stopLoss: round(currentPrice * (1 - (riskMove + 0.2) / 100)),
        takeProfit: round(currentPrice * (1 - Math.max(0.9, baseMove * 0.3) / 100)),
        expectedReturn: round(-Math.max(0.9, baseMove * 0.3)),
        expectedRisk: round(riskMove + 0.2),
      };
    case "利確":
      return {
        targetPrice: round(currentPrice * (1 - Math.max(1.2, baseMove * 0.45) / 100)),
        stopLoss: round(currentPrice * (1 - (riskMove - 0.1) / 100)),
        takeProfit: round(currentPrice * (1 - Math.max(1.6, baseMove * 0.6) / 100)),
        expectedReturn: round(-Math.max(1.6, baseMove * 0.6)),
        expectedRisk: round(Math.max(0.8, riskMove - 0.1)),
      };
    case "損切り":
      return {
        targetPrice: round(currentPrice * (1 - Math.max(2.0, riskMove * 0.7) / 100)),
        stopLoss: round(currentPrice * (1 - Math.max(3.0, riskMove * 1.15) / 100)),
        takeProfit: round(currentPrice * (1 - Math.max(2.5, riskMove * 0.9) / 100)),
        expectedReturn: round(-Math.max(2.5, riskMove * 0.9)),
        expectedRisk: round(Math.max(3.0, riskMove * 1.15)),
      };
    default:
      return {
        targetPrice: round(currentPrice * 1.005),
        stopLoss: round(currentPrice * 0.97),
        takeProfit: round(currentPrice * 1.03),
        expectedReturn: 3,
        expectedRisk: 3,
      };
  }
}

function buildDecisionReasons(input: TradingDecisionInput, decision: TradingDecision, composite: ReturnType<typeof deriveCompositeScore>) {
  const reasons = buildBaseReasons(input, composite);

  switch (decision) {
    case "強い買い":
      reasons.push("AIスコアとバックテストが高水準で一致しており、積極エントリーを優先します。");
      reasons.push("勝率・Profit Factor・最大DDがともに良好で、期待値の再現性が高いです。");
      break;
    case "買い":
      reasons.push("AIスコアとバックテストの整合性は良好で、買い優位と判断します。");
      reasons.push("ただし最上位の確信ではないため、強い買いより一段慎重です。");
      break;
    case "押し目待ち":
      reasons.push("総合評価は高いですが、期待リスクリワードがまだ十分でないため押し目を待ちます。");
      reasons.push("セクターやボラティリティも確認しながら、より有利な価格を待つ判断です。");
      break;
    case "一部利確":
      reasons.push("一定の上昇余地はある一方で、バックテスト品質やボラティリティが悪化しています。");
      reasons.push("ポジションを一部縮小して、利益とリスクのバランスを取る局面です。");
      break;
    case "利確":
      reasons.push("AIスコアの優位性が弱まり、バックテスト条件も伸び悩んでいます。");
      reasons.push("上値余地よりも利益確定を優先する局面です。");
      break;
    case "損切り":
      reasons.push("AIスコアとバックテストがともに弱く、下方向の期待値が優勢です。");
      reasons.push("損失拡大を避けるため、早期の撤退を優先します。");
      break;
    case "様子見":
    default:
      reasons.push("評価材料が拮抗しており、明確な優位性が確認できません。");
      reasons.push("現時点ではエントリーよりも監視継続が妥当です。");
      break;
  }

  return reasons;
}

export function decideTradingAction(input: TradingDecisionInput): TradingDecisionResult {
  const composite = deriveCompositeScore(input);
  const decision = determineDecision(input, composite);
  const currentPrice = input.currentPrice ?? input.aiScore.entryPrice ?? 100;
  const pricePlan = buildPricePlan(decision, currentPrice, input.expectedRiskReward, input.volatility);

  const confidence = clamp(
    Math.round(
      34
      + Math.abs(composite.composite - 50) * 0.88
      + Math.min(10, input.backtest.totalTrades / 6)
      + (input.backtest.profitFactor >= 1.35 ? 6 : 0)
      + (input.backtest.maxDrawdown <= 10 ? 4 : 0)
      + (decision === "強い買い" || decision === "損切り" ? 6 : 0)
      - (input.volatility >= 70 ? 7 : input.volatility >= 55 ? 3 : 0),
    ),
    0,
    100,
  );

  return {
    decision,
    confidence,
    reasons: buildDecisionReasons(input, decision, composite),
    targetPrice: pricePlan.targetPrice,
    stopLoss: pricePlan.stopLoss,
    takeProfit: pricePlan.takeProfit,
    expectedReturn: pricePlan.expectedReturn,
    expectedRisk: pricePlan.expectedRisk,
  };
}
