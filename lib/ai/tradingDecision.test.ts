import assert from "node:assert/strict";
import test from "node:test";
import { decideTradingAction } from "./tradingDecision";
import type { TradingDecisionInput } from "./tradingDecision";

function buildInput(overrides: Partial<TradingDecisionInput> = {}): TradingDecisionInput {
  return {
    aiScore: {
      score: 58,
      confidence: 60,
      entryPrice: 100,
      expectedValuePercent: 2.1,
      riskRewardRatio: 1.4,
      trendStrength: "標準",
      riskLevel: "中",
      signal: "HOLD",
      judgment: "様子見",
    },
    backtest: {
      winRate: 52,
      averageProfit: 1.2,
      averageLoss: -1.0,
      expectedValuePercent: 0.8,
      averageReturn: 0.4,
      maxDrawdown: 12,
      profitFactor: 1.2,
      totalTrades: 40,
    },
    trend: 55,
    momentum: 54,
    volume: 53,
    priceAction: 52,
    risk: 55,
    sectorStrength: 52,
    volatility: 45,
    expectedRiskReward: 1.4,
    currentPrice: 100,
    ...overrides,
  } as TradingDecisionInput;
}

function expectDecision(decision: string, overrides: Partial<TradingDecisionInput> = {}) {
  const result = decideTradingAction(buildInput(overrides));
  assert.equal(result.decision, decision);
  assert.ok(result.confidence >= 0 && result.confidence <= 100);
  assert.ok(result.reasons.length >= 5);
  assert.ok(Number.isFinite(result.targetPrice));
  assert.ok(Number.isFinite(result.stopLoss));
  assert.ok(Number.isFinite(result.takeProfit));
  assert.ok(Number.isFinite(result.expectedReturn));
  assert.ok(Number.isFinite(result.expectedRisk));
}

test("decideTradingAction returns 強い買い", () => {
  expectDecision("強い買い", {
    aiScore: {
      score: 90,
      confidence: 88,
      entryPrice: 100,
      expectedValuePercent: 8.1,
      riskRewardRatio: 2.5,
      trendStrength: "非常に強い",
      riskLevel: "低",
      signal: "BUY",
      judgment: "強い買い",
    },
    backtest: {
      winRate: 70,
      averageProfit: 3.2,
      averageLoss: -1.0,
      expectedValuePercent: 3.0,
      averageReturn: 2.1,
      maxDrawdown: 6,
      profitFactor: 2.3,
      totalTrades: 80,
    },
    trend: 91,
    momentum: 88,
    volume: 85,
    priceAction: 90,
    risk: 84,
    sectorStrength: 82,
    volatility: 22,
    expectedRiskReward: 2.4,
  });
});

test("decideTradingAction returns 買い", () => {
  expectDecision("買い", {
    aiScore: {
      score: 78,
      confidence: 76,
      entryPrice: 100,
      expectedValuePercent: 5.1,
      riskRewardRatio: 1.9,
      trendStrength: "強い",
      riskLevel: "中",
      signal: "BUY",
      judgment: "買い",
    },
    backtest: {
      winRate: 58,
      averageProfit: 2.0,
      averageLoss: -1.1,
      expectedValuePercent: 1.7,
      averageReturn: 1.0,
      maxDrawdown: 10,
      profitFactor: 1.35,
      totalTrades: 60,
    },
    trend: 74,
    momentum: 70,
    volume: 66,
    priceAction: 69,
    risk: 62,
    sectorStrength: 63,
    volatility: 35,
    expectedRiskReward: 1.6,
  });
});

test("decideTradingAction returns 押し目待ち", () => {
  expectDecision("押し目待ち", {
    aiScore: {
      score: 75,
      confidence: 72,
      entryPrice: 100,
      expectedValuePercent: 4.0,
      riskRewardRatio: 1.7,
      trendStrength: "強い",
      riskLevel: "中",
      signal: "BUY",
      judgment: "買い",
    },
    backtest: {
      winRate: 56,
      averageProfit: 1.8,
      averageLoss: -1.0,
      expectedValuePercent: 1.2,
      averageReturn: 0.9,
      maxDrawdown: 9,
      profitFactor: 1.28,
      totalTrades: 58,
    },
    trend: 75,
    momentum: 72,
    volume: 56,
    priceAction: 71,
    risk: 61,
    sectorStrength: 58,
    volatility: 48,
    expectedRiskReward: 1.3,
  });
});

test("decideTradingAction returns 様子見", () => {
  expectDecision("様子見", {
    aiScore: {
      score: 58,
      confidence: 60,
      entryPrice: 100,
      expectedValuePercent: 2.0,
      riskRewardRatio: 1.4,
      trendStrength: "標準",
      riskLevel: "中",
      signal: "HOLD",
      judgment: "様子見",
    },
    backtest: {
      winRate: 52,
      averageProfit: 1.2,
      averageLoss: -1.0,
      expectedValuePercent: 0.8,
      averageReturn: 0.4,
      maxDrawdown: 12,
      profitFactor: 1.3,
      totalTrades: 40,
    },
    trend: 55,
    momentum: 54,
    volume: 53,
    priceAction: 52,
    risk: 55,
    sectorStrength: 52,
    volatility: 45,
    expectedRiskReward: 1.4,
  });
});

test("decideTradingAction returns 一部利確", () => {
  expectDecision("一部利確", {
    aiScore: {
      score: 60,
      confidence: 58,
      entryPrice: 100,
      expectedValuePercent: 2.4,
      riskRewardRatio: 1.3,
      trendStrength: "標準",
      riskLevel: "中",
      signal: "HOLD",
      judgment: "様子見",
    },
    backtest: {
      winRate: 54,
      averageProfit: 1.6,
      averageLoss: -1.2,
      expectedValuePercent: 0.7,
      averageReturn: 0.5,
      maxDrawdown: 18,
      profitFactor: 1.15,
      totalTrades: 44,
    },
    trend: 58,
    momentum: 57,
    volume: 56,
    priceAction: 59,
    risk: 44,
    sectorStrength: 50,
    volatility: 72,
    expectedRiskReward: 1.5,
  });
});

test("decideTradingAction returns 利確", () => {
  expectDecision("利確", {
    aiScore: {
      score: 45,
      confidence: 48,
      entryPrice: 100,
      expectedValuePercent: 0.8,
      riskRewardRatio: 1.0,
      trendStrength: "弱い",
      riskLevel: "高",
      signal: "SELL",
      judgment: "売り",
    },
    backtest: {
      winRate: 46,
      averageProfit: 0.9,
      averageLoss: -1.5,
      expectedValuePercent: -0.2,
      averageReturn: -0.1,
      maxDrawdown: 22,
      profitFactor: 1.02,
      totalTrades: 38,
    },
    trend: 42,
    momentum: 40,
    volume: 41,
    priceAction: 44,
    risk: 46,
    sectorStrength: 40,
    volatility: 58,
    expectedRiskReward: 1.1,
  });
});

test("decideTradingAction returns 損切り", () => {
  expectDecision("損切り", {
    aiScore: {
      score: 30,
      confidence: 35,
      entryPrice: 100,
      expectedValuePercent: -1.5,
      riskRewardRatio: 0.8,
      trendStrength: "弱い",
      riskLevel: "高",
      signal: "SELL",
      judgment: "強い売り",
    },
    backtest: {
      winRate: 40,
      averageProfit: 0.6,
      averageLoss: -2.2,
      expectedValuePercent: -1.2,
      averageReturn: -1.0,
      maxDrawdown: 30,
      profitFactor: 0.8,
      totalTrades: 30,
    },
    trend: 30,
    momentum: 28,
    volume: 32,
    priceAction: 29,
    risk: 30,
    sectorStrength: 25,
    volatility: 80,
    expectedRiskReward: 0.8,
  });
});
