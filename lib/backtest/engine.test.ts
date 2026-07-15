import assert from "node:assert/strict";
import test from "node:test";
import { runAiScoreBacktest, serializeAiScoreBacktestResult } from "./index";
import type { Stock } from "../types";

function buildStock(code: string, sector: string, basePrice: number): Stock {
  const candles = Array.from({ length: 80 }, (_, index) => {
    const open = basePrice + index * 8;
    return {
      time: `2025-07-${String((index % 28) + 1).padStart(2, "0")}`,
      open,
      high: open + 24,
      low: open - 10,
      close: open + 16,
      volume: 1200000 + index * 45000,
    };
  });

  candles[candles.length - 2] = {
    ...candles[candles.length - 2],
    open: basePrice + 590,
    high: basePrice + 626,
    low: basePrice + 580,
    close: basePrice + 612,
    volume: 2600000,
  };

  candles[candles.length - 1] = {
    ...candles[candles.length - 1],
    open: basePrice + 620,
    high: basePrice + 676,
    low: basePrice + 610,
    close: basePrice + 664,
    volume: 4200000,
  };

  return {
    code,
    name: `Test ${code}`,
    sector,
    baselineTrend: "up",
    description: "backtest fixture",
    marketData: {
      price: basePrice + 664,
      open: basePrice + 620,
      high: basePrice + 676,
      low: basePrice + 610,
      previousClose: basePrice + 612,
      change: 52,
      changePercent: 7.18,
      currency: "JPY",
      asOf: null,
    },
    chartData: { candles },
    dataStatus: "real",
    dataReason: null,
    timeframe: "1d",
  };
}

test("runAiScoreBacktest aggregates score buckets, holding periods, sectors, and JSON output", () => {
  const result = runAiScoreBacktest([
    { stock: buildStock("7203", "輸送用機器", 1800), candles: buildStock("7203", "輸送用機器", 1800).chartData!.candles },
    { stock: buildStock("6758", "電気機器", 2200), candles: buildStock("6758", "電気機器", 2200).chartData!.candles },
  ]);

  assert.ok(result.trades.length > 0);
  assert.equal(result.scoreBuckets.length, 5);
  assert.equal(result.holdingPeriods.length, 5);
  assert.equal(result.sectors.length >= 1, true);
  assert.equal(result.regimes.length >= 1, true);
  assert.equal(result.scoreBuckets.every((bucket) => typeof bucket.winRate === "number"), true);
  assert.equal(result.holdingPeriods.every((period) => [1, 3, 5, 10, 20].includes(period.holdingPeriodDays)), true);
  assert.equal(result.totals.totalTrades, result.trades.length);

  const json = serializeAiScoreBacktestResult(result);
  const parsed = JSON.parse(json) as typeof result;
  assert.equal(parsed.trades.length, result.trades.length);
  assert.ok(typeof parsed.generatedAt === "string");
});
