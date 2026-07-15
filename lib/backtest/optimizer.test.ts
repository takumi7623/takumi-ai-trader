import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyAiScoreWeightProfile,
  deriveMarketRegimeWeightStoresFromBacktest,
  loadAiScoreWeightProfile,
  loadAiScoreWeightStore,
  saveAiScoreWeightProfile,
  saveAiScoreWeightStore,
  saveAiScoreWeightsFromBacktest,
} from "./index";
import type { AiScoreWeights } from "../types";
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

test("saveAiScoreWeightsFromBacktest persists and reloads the optimized profile", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ai-score-weights-"));
  const filePath = path.join(tempDir, "weights.json");
  try {
    const result = buildBacktestResult();
    const optimized = await saveAiScoreWeightsFromBacktest(result, baseWeights, filePath);
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { Trend: number; Momentum: number; Volume: number; PriceAction: number; Risk: number };

    assert.ok(parsed.Trend > 0);
    assert.ok(parsed.Momentum > 0);
    assert.ok(parsed.Volume > 0);
    assert.ok(parsed.PriceAction > 0);
    assert.ok(parsed.Risk > 0);
    assert.ok(optimized.profile.Trend >= 1);
    assert.ok(optimized.profile.Risk >= 0.7);
    assert.ok(optimized.weights.trendStrength !== 1 || optimized.weights.lossRisk !== 1);

    const loaded = loadAiScoreWeightProfile(filePath);
    const applied = applyAiScoreWeightProfile(baseWeights, loaded);
    assert.notDeepEqual(applied, baseWeights);
    assert.equal(loaded.Trend, parsed.Trend);
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
