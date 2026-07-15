import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyAiScoreWeightProfile,
  deriveMarketRegimeWeightStoresFromBacktest,
  inferMarketRegimeFromStock,
  loadAiScoreWeightProfile,
  loadAiScoreWeightStore,
  saveAiScoreWeightProfile,
  saveAiScoreWeightStore,
  saveAiScoreWeightsFromBacktest,
  selectAiScoreWeightProfileForStock,
} from "./index";
import type { AiScoreWeights, Stock } from "../types";
import type { AiScoreBacktestResult } from "./types";

function buildBacktestResult(): AiScoreBacktestResult {
  return {
    generatedAt: new Date().toISOString(),
    trades: [],
    scoreBuckets: [
      { label: "90-100", totalTrades: 8, winRate: 75, averageProfit: 3.2, averageLoss: -0.8, profitFactor: 2.6, maxDrawdown: 4.2, averageReturn: 2.4 },
      { label: "80-89", totalTrades: 10, winRate: 68, averageProfit: 2.4, averageLoss: -1.1, profitFactor: 2.0, maxDrawdown: 5.1, averageReturn: 1.8 },
      { label: "70-79", totalTrades: 12, winRate: 61, averageProfit: 1.8, averageLoss: -1.3, profitFactor: 1.6, maxDrawdown: 6.4, averageReturn: 1.1 },
      { label: "60-69", totalTrades: 9, winRate: 54, averageProfit: 1.1, averageLoss: -1.6, profitFactor: 1.2, maxDrawdown: 8.3, averageReturn: 0.3 },
      { label: "59以下", totalTrades: 7, winRate: 38, averageProfit: 0.7, averageLoss: -2.2, profitFactor: 0.7, maxDrawdown: 12.8, averageReturn: -1.5 },
    ],
    holdingPeriods: [
      { holdingPeriodDays: 1, totalTrades: 10, winRate: 64, averageProfit: 1.1, averageLoss: -0.9, profitFactor: 1.8, maxDrawdown: 3.8, averageReturn: 0.7 },
      { holdingPeriodDays: 3, totalTrades: 10, winRate: 66, averageProfit: 1.4, averageLoss: -1.0, profitFactor: 2.0, maxDrawdown: 4.1, averageReturn: 0.9 },
      { holdingPeriodDays: 5, totalTrades: 10, winRate: 62, averageProfit: 1.6, averageLoss: -1.2, profitFactor: 1.7, maxDrawdown: 5.0, averageReturn: 0.8 },
      { holdingPeriodDays: 10, totalTrades: 10, winRate: 58, averageProfit: 1.9, averageLoss: -1.5, profitFactor: 1.5, maxDrawdown: 6.7, averageReturn: 0.4 },
      { holdingPeriodDays: 20, totalTrades: 10, winRate: 55, averageProfit: 2.1, averageLoss: -1.8, profitFactor: 1.4, maxDrawdown: 8.9, averageReturn: 0.2 },
    ],
    sectors: [
      { sector: "輸送用機器", totalTrades: 10, winRate: 67, averageProfit: 1.8 },
      { sector: "電気機器", totalTrades: 8, winRate: 63, averageProfit: 1.5 },
    ],
    regimes: [
      { regime: "uptrend", totalTrades: 18, winRate: 69, averageProfit: 2.1, averageLoss: -1.0, profitFactor: 2.1, maxDrawdown: 4.8, averageReturn: 1.6 },
      { regime: "downtrend", totalTrades: 10, winRate: 44, averageProfit: 1.0, averageLoss: -1.6, profitFactor: 1.1, maxDrawdown: 9.6, averageReturn: -0.2 },
      { regime: "range", totalTrades: 8, winRate: 56, averageProfit: 1.3, averageLoss: -1.1, profitFactor: 1.3, maxDrawdown: 6.8, averageReturn: 0.5 },
      { regime: "highVolatility", totalTrades: 6, winRate: 48, averageProfit: 1.5, averageLoss: -1.8, profitFactor: 1.0, maxDrawdown: 12.2, averageReturn: -0.1 },
      { regime: "lowVolatility", totalTrades: 6, winRate: 62, averageProfit: 1.4, averageLoss: -0.9, profitFactor: 1.6, maxDrawdown: 3.2, averageReturn: 0.8 },
    ],
    totals: {
      totalTrades: 48,
      winRate: 64.2,
      averageProfit: 1.72,
      averageLoss: -1.24,
      profitFactor: 1.95,
      maxDrawdown: 6.3,
      averageReturn: 0.92,
    },
  };
}

const baseWeights: AiScoreWeights = {
  rsi: 1,
  macd: 1,
  ma5: 1,
  ma25: 1,
  ma75: 1,
  adx: 1,
  atr: 1,
  bollinger: 1,
  supportResistance: 1,
  volumeRatio: 1,
  volumeSpike: 1,
  trendStrength: 1,
  lossRisk: 1,
  probabilityUp: 1,
};

function buildRegimeStock(baselineTrend: Stock["baselineTrend"], candles: NonNullable<Stock["chartData"]>["candles"]): Stock {
  const latest = candles[candles.length - 1];

  return {
    code: baselineTrend === "volatile" ? "9999" : "7203",
    name: baselineTrend === "volatile" ? "テスト高ボラ銘柄" : "テスト上昇銘柄",
    sector: "テスト",
    baselineTrend,
    description: "テスト用のサンプルデータ",
    marketData: {
      price: latest?.close ?? 0,
      open: latest?.open ?? 0,
      high: latest?.high ?? 0,
      low: latest?.low ?? 0,
      previousClose: candles[candles.length - 2]?.close ?? 0,
      change: latest && candles[candles.length - 2] ? latest.close - candles[candles.length - 2].close : 0,
      changePercent: latest && candles[candles.length - 2] && candles[candles.length - 2].close > 0
        ? ((latest.close - candles[candles.length - 2].close) / candles[candles.length - 2].close) * 100
        : 0,
      currency: "JPY",
      asOf: latest?.time ?? null,
    },
    chartData: { candles },
    dataStatus: "real",
    dataReason: null,
    timeframe: "1d",
  };
}

test("saveAiScoreWeightsFromBacktest persists and reloads the optimized profile", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ai-score-weights-"));
  const filePath = path.join(tempDir, "weights.json");
  try {
    const result = buildBacktestResult();
    const optimized = await saveAiScoreWeightsFromBacktest(result, baseWeights, filePath);
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { version: number; defaultProfile: { Trend: number; Momentum: number; Volume: number; PriceAction: number; Risk: number }; regimes: Record<string, { Trend: number; Momentum: number; Volume: number; PriceAction: number; Risk: number }> };

    assert.equal(parsed.version, 2);
    assert.ok(parsed.defaultProfile.Trend > 0);
    assert.ok(parsed.defaultProfile.Momentum > 0);
    assert.ok(parsed.defaultProfile.Volume > 0);
    assert.ok(parsed.defaultProfile.PriceAction > 0);
    assert.ok(parsed.defaultProfile.Risk > 0);
    assert.ok(parsed.regimes.uptrend.Trend > 0);
    assert.ok(parsed.regimes.highVolatility.Risk > 0);
    assert.ok(optimized.profile.Trend >= 1);
    assert.ok(optimized.profile.Risk >= 0.7);
    assert.ok(optimized.weights.trendStrength !== 1 || optimized.weights.lossRisk !== 1);

    const loaded = loadAiScoreWeightProfile(filePath);
    const loadedStore = loadAiScoreWeightStore(filePath);
    const applied = applyAiScoreWeightProfile(baseWeights, loaded);
    assert.notDeepEqual(applied, baseWeights);
    assert.equal(loaded.Trend, parsed.defaultProfile.Trend);
    assert.equal(loadedStore.version, 2);
    assert.ok(loaded.notes?.some((note) => note.includes("bucketSpread")));
    assert.ok(loaded.notes?.some((note) => note.includes("holdingBias")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("saveAiScoreWeightProfile roundtrips a profile with the requested categories", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ai-score-profile-"));
  const filePath = path.join(tempDir, "weights.json");
  try {
    const profile = {
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      Trend: 1.1,
      Momentum: 0.95,
      Volume: 1.05,
      PriceAction: 1.02,
      Risk: 0.9,
    };

    saveAiScoreWeightProfile(profile, filePath);
    const loaded = loadAiScoreWeightProfile(filePath);
    assert.equal(loaded.Trend, 1.1);
    assert.equal(loaded.Momentum, 0.95);
    assert.equal(loaded.Volume, 1.05);
    assert.equal(loaded.PriceAction, 1.02);
    assert.equal(loaded.Risk, 0.9);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("saveAiScoreWeightStore roundtrips a regime-aware store", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ai-score-store-"));
  const filePath = path.join(tempDir, "weights.json");
  try {
    const store = deriveMarketRegimeWeightStoresFromBacktest(buildBacktestResult(), {
      defaultProfile: {
        version: 1,
        updatedAt: new Date().toISOString(),
        Trend: 1,
        Momentum: 1,
        Volume: 1,
        PriceAction: 1,
        Risk: 1,
      },
      regimes: {
        uptrend: { version: 1, updatedAt: new Date().toISOString(), Trend: 1, Momentum: 1, Volume: 1, PriceAction: 1, Risk: 1 },
        downtrend: { version: 1, updatedAt: new Date().toISOString(), Trend: 1, Momentum: 1, Volume: 1, PriceAction: 1, Risk: 1 },
        range: { version: 1, updatedAt: new Date().toISOString(), Trend: 1, Momentum: 1, Volume: 1, PriceAction: 1, Risk: 1 },
        highVolatility: { version: 1, updatedAt: new Date().toISOString(), Trend: 1, Momentum: 1, Volume: 1, PriceAction: 1, Risk: 1 },
        lowVolatility: { version: 1, updatedAt: new Date().toISOString(), Trend: 1, Momentum: 1, Volume: 1, PriceAction: 1, Risk: 1 },
      },
      version: 2,
      updatedAt: new Date().toISOString(),
    });

    saveAiScoreWeightStore(store, filePath);
    const loaded = loadAiScoreWeightStore(filePath);
    assert.equal(loaded.version, 2);
    assert.ok(loaded.regimes.uptrend.Trend > 0);
    assert.ok(loaded.regimes.downtrend.Risk > 0);
    assert.ok(loaded.defaultProfile.Momentum > 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("inferMarketRegimeFromStock and profile selection switch by market environment", () => {
  const uptrendCandles = Array.from({ length: 80 }, (_, index) => {
    const base = 1800 + index * 18;
    return {
      time: `2025-07-${String((index % 30) + 1).padStart(2, "0")}`,
      open: base,
      high: base + 16,
      low: base - 10,
      close: base + 12,
      volume: 1400000 + index * 15000,
    };
  });

  const volatileCandles = Array.from({ length: 80 }, (_, index) => {
    const base = 2500 + (index % 2 === 0 ? index * 10 : -index * 11);
    return {
      time: `2025-08-${String((index % 30) + 1).padStart(2, "0")}`,
      open: base,
      high: base + 90,
      low: base - 95,
      close: base + (index % 2 === 0 ? 40 : -35),
      volume: 3200000 + index * 45000,
    };
  });

  const store = {
    version: 2 as const,
    updatedAt: new Date().toISOString(),
    defaultProfile: { version: 1 as const, updatedAt: new Date().toISOString(), Trend: 1, Momentum: 1, Volume: 1, PriceAction: 1, Risk: 1 },
    regimes: {
      uptrend: { version: 1 as const, updatedAt: new Date().toISOString(), Trend: 1.2, Momentum: 1, Volume: 1, PriceAction: 1, Risk: 1 },
      downtrend: { version: 1 as const, updatedAt: new Date().toISOString(), Trend: 0.9, Momentum: 0.9, Volume: 1, PriceAction: 0.95, Risk: 1.1 },
      range: { version: 1 as const, updatedAt: new Date().toISOString(), Trend: 0.85, Momentum: 1.1, Volume: 1.05, PriceAction: 1.02, Risk: 1 },
      highVolatility: { version: 1 as const, updatedAt: new Date().toISOString(), Trend: 0.8, Momentum: 1.05, Volume: 1.1, PriceAction: 0.9, Risk: 1.15 },
      lowVolatility: { version: 1 as const, updatedAt: new Date().toISOString(), Trend: 1.1, Momentum: 0.95, Volume: 0.95, PriceAction: 1.08, Risk: 0.92 },
    },
  };

  const uptrendStock = buildRegimeStock("up", uptrendCandles);
  const volatileStock = buildRegimeStock("volatile", volatileCandles);

  const uptrendRegime = inferMarketRegimeFromStock(uptrendStock);
  const volatileRegime = inferMarketRegimeFromStock(volatileStock);
  const uptrendProfile = selectAiScoreWeightProfileForStock(uptrendStock, store);
  const volatileProfile = selectAiScoreWeightProfileForStock(volatileStock, store);

  assert.equal(uptrendRegime, "uptrend");
  assert.equal(volatileRegime, "highVolatility");
  assert.equal(uptrendProfile.regime, "uptrend");
  assert.equal(volatileProfile.regime, "highVolatility");
  assert.equal(uptrendProfile.profile.Trend, 1.2);
  assert.equal(volatileProfile.profile.Risk, 1.15);
});
