import assert from "node:assert/strict";
import test from "node:test";
import { analyzeStock } from "./scoreCalculator";
import type { Stock } from "../types";

function buildStock(): Stock {
  const candles = Array.from({ length: 40 }, (_, index) => {
    const base = 3000 + index * 5;
    return {
      time: `2025-01-${String(index + 1).padStart(2, "0")}`,
      open: base,
      high: base + 20,
      low: base - 10,
      close: base + 12,
      volume: 1800000 + index * 100000,
    };
  });

  candles[candles.length - 1] = {
    ...candles[candles.length - 1],
    close: 3300,
    high: 3330,
    volume: 3200000,
  };

  return {
    code: "7203",
    name: "トヨタ自動車",
    sector: "自動車",
    baselineTrend: "up",
    description: "テスト用のサンプルデータ",
    marketData: {
      price: 3300,
      open: 3280,
      high: 3330,
      low: 3270,
      previousClose: 3250,
      change: 50,
      changePercent: 1.54,
      currency: "JPY",
      asOf: null,
    },
    chartData: {
      candles,
    },
    dataStatus: "real",
    dataReason: null,
    timeframe: "1d",
  };
}

function withNews(
  stock: Stock,
  score: number,
  confidence: number,
  summary: string,
  importance: "重要" | "普通" | "軽微" = "普通",
): Stock {
  return {
    ...stock,
    newsAnalysis: {
      sentiment: score >= 0 ? "bullish" : "bearish",
      importance,
      score,
      confidence,
      starRating: importance === "重要" ? 5 : importance === "普通" ? 3 : 1,
      positiveCount: score >= 0 ? 1 : 0,
      negativeCount: score < 0 ? 1 : 0,
      summary,
      headlines: [summary],
      details: [
        {
          headline: summary,
          sentiment: score >= 0 ? "positive" : "negative",
          importanceStars: importance === "重要" ? 5 : importance === "普通" ? 3 : 1,
          publishedAt: new Date().toISOString(),
        },
      ],
      updatedAt: new Date().toISOString(),
    },
  };
}

function buildTrendingStock(candles: NonNullable<Stock["chartData"]>["candles"], marketData: NonNullable<Stock["marketData"]>): Stock {
  return {
    code: "7203",
    name: "トヨタ自動車",
    sector: "自動車",
    baselineTrend: "up",
    description: "テスト用のサンプルデータ",
    marketData,
    chartData: { candles },
    dataStatus: "real",
    dataReason: null,
    timeframe: "1d",
  };
}

test("analyzeStock rewards a breakout above the recent high", () => {
  const result = analyzeStock({ query: "7203", stock: buildStock() });

  assert.ok(result.score >= 70);
  assert.match(result.judgment, /買い/);
  assert.equal(result.signal, "BUY");
  assert.ok(result.aiReason.some((reason) => reason.includes("直近高値")));
});

test("analyzeStock rewards aligned signals with a consensus bonus", () => {
  const candles = Array.from({ length: 120 }, (_, index) => {
    const base = 2200 + index * 22;

    return {
      time: `2025-04-${String((index % 30) + 1).padStart(2, "0")}`,
      open: base,
      high: base + 28,
      low: base - 8,
      close: base + 18,
      volume: 1400000 + index * 45000,
    };
  });

  candles[candles.length - 1] = {
    ...candles[candles.length - 1],
    close: 5100,
    high: 5150,
    volume: 6200000,
  };

  const result = analyzeStock({
    query: "7203",
    stock: {
      ...buildStock(),
      chartData: { candles },
      marketData: {
        price: 5100,
        open: 5075,
        high: 5150,
        low: 5050,
        previousClose: 4980,
        change: 120,
        changePercent: 2.41,
        currency: "JPY",
        asOf: null,
      },
    },
  });

  assert.ok(result.reasons.some((reason) => reason.includes("複数シグナル一致")));
  assert.ok(result.aiReason.some((reason) => reason.includes("複数シグナル一致")));
});

test("analyzeStock lowers the score for a weak trend and low volume", () => {
  const candles = Array.from({ length: 40 }, (_, index) => {
    const base = 3200 - index * 10;

    return {
      time: `2025-02-${String(index + 1).padStart(2, "0")}`,
      open: base,
      high: base + 8,
      low: base - 18,
      close: base - 5,
      volume: 700000 + index * 10000,
    };
  });

  candles[candles.length - 1] = {
    ...candles[candles.length - 1],
    close: 2800,
    low: 2785,
    volume: 620000,
  };

  const result = analyzeStock({
    query: "9432",
    stock: {
      code: "9432",
      name: "NTT",
      sector: "通信",
      baselineTrend: "volatile",
      description: "テスト用のサンプルデータ",
      marketData: {
        price: 2800,
        open: 2810,
        high: 2825,
        low: 2785,
        previousClose: 2840,
        change: -40,
        changePercent: -1.41,
        currency: "JPY",
        asOf: null,
      },
      chartData: {
        candles,
      },
      dataStatus: "real",
      dataReason: null,
      timeframe: "1d",
    },
  });

  assert.ok(result.score <= 55);
  assert.match(result.judgment, /売り|様子見/);
  assert.ok(result.confidence < 70);
});

test("analyzeStock boosts the score for strong positive news", () => {
  const baseStock = buildStock();
  const baseResult = analyzeStock({ query: "7203", stock: baseStock });
  const result = analyzeStock({
    query: "7203",
    stock: withNews(baseStock, 32, 74, "業績上方修正と大型受注を発表"),
  });

  assert.ok(result.score > baseResult.score);
  assert.ok(result.aiReason.some((reason) => reason.includes("重要な好材料")));
});

test("analyzeStock penalizes strong negative news", () => {
  const baseStock = buildStock();
  const baseResult = analyzeStock({ query: "7203", stock: baseStock });
  const result = analyzeStock({
    query: "7203",
    stock: withNews(baseStock, -31, 72, "業績下方修正と不祥事を発表"),
  });

  assert.ok(result.score < baseResult.score);
  assert.ok(result.aiReason.some((reason) => reason.includes("重要な悪材料")));
});

test("analyzeStock applies stronger impact for important news", () => {
  const baseStock = buildStock();
  const normalNews = analyzeStock({
    query: "7203",
    stock: withNews(baseStock, 26, 72, "業績上方修正を発表", "普通"),
  });
  const importantNews = analyzeStock({
    query: "7203",
    stock: withNews(baseStock, 26, 72, "業績上方修正を発表", "重要"),
  });

  assert.ok(importantNews.score >= normalNews.score);
  assert.ok(importantNews.aiReason.some((reason) => reason.includes("ニュース重要度は重要")));
});

test("analyzeStock reflects numeric gap evaluation in reasons", () => {
  const stock = buildStock();
  const candles = stock.chartData?.candles ?? [];
  const updatedCandles = candles.map((candle) => ({ ...candle }));
  const last = updatedCandles.length - 1;
  const prev = updatedCandles.length - 2;

  updatedCandles[last].open = updatedCandles[prev].close * 1.035;
  updatedCandles[last].high = updatedCandles[last].open * 1.02;
  updatedCandles[last].close = updatedCandles[last].open * 1.01;

  const result = analyzeStock({
    query: stock.code,
    stock: {
      ...stock,
      chartData: { candles: updatedCandles },
    },
  });

  assert.ok(result.reasons.some((reason) => reason.includes("評価:+")));
});

test("analyzeStock explains multi-timeframe bullish trend direction", () => {
  const result = analyzeStock({ query: "7203", stock: buildStock() });

  assert.ok(result.aiReason.some((reason) => reason.includes("総合トレンドは上昇")));
});

test("analyzeStock explains multi-timeframe bearish trend direction", () => {
  const candles = Array.from({ length: 120 }, (_, index) => {
    const base = 3600 - index * 8;
    return {
      time: `2025-03-${String((index % 30) + 1).padStart(2, "0")}`,
      open: base,
      high: base + 10,
      low: base - 18,
      close: base - 6,
      volume: 2400000 - index * 5000,
    };
  });

  candles[candles.length - 1] = {
    ...candles[candles.length - 1],
    close: 2600,
    low: 2580,
    volume: 900000,
  };

  const result = analyzeStock({
    query: "9432",
    stock: {
      code: "9432",
      name: "NTT",
      sector: "通信",
      baselineTrend: "volatile",
      description: "テスト用のサンプルデータ",
      marketData: {
        price: 2600,
        open: 2620,
        high: 2640,
        low: 2580,
        previousClose: 2625,
        change: -25,
        changePercent: -0.95,
        currency: "JPY",
        asOf: null,
      },
      chartData: {
        candles,
      },
      dataStatus: "real",
      dataReason: null,
      timeframe: "1d",
    },
  });

  assert.ok(result.aiReason.some((reason) => reason.includes("総合トレンドは下降")));
});

test("analyzeStock explains v1.4 bullish candlestick and 200-day alignment", () => {
  const candles = Array.from({ length: 220 }, (_, index) => {
    const base = 1800 + index * 6;
    return {
      time: `2025-05-${String((index % 30) + 1).padStart(2, "0")}`,
      open: base,
      high: base + 18,
      low: base - 12,
      close: base + 9,
      volume: 1400000 + index * 12000,
    };
  });

  candles[candles.length - 2] = {
    ...candles[candles.length - 2],
    open: 3180,
    high: 3195,
    low: 3060,
    close: 3070,
    volume: 1800000,
  };

  candles[candles.length - 1] = {
    ...candles[candles.length - 1],
    open: 3065,
    high: 3215,
    low: 3055,
    close: 3205,
    volume: 4200000,
  };

  const result = analyzeStock({
    query: "7203",
    stock: buildTrendingStock(candles, {
      price: 3205,
      open: 3065,
      high: 3215,
      low: 3055,
      previousClose: 3070,
      change: 135,
      changePercent: 4.39,
      currency: "JPY",
      asOf: null,
    }),
  });

  assert.ok(result.reasons.some((reason) => reason.includes("Bullish Engulfing") || reason.includes("Hammer") || reason.includes("Morning Star")));
  assert.ok(result.aiReason.some((reason) => reason.includes("200日線") || reason.includes("5/25/75/200日トレンド整合性")));
});

test("analyzeStock explains v1.4 bearish divergence and false breakout", () => {
  const candles = Array.from({ length: 60 }, (_, index) => {
    const base = 2400 - index * 8;
    return {
      time: `2025-06-${String((index % 30) + 1).padStart(2, "0")}`,
      open: base,
      high: base + 14,
      low: base - 16,
      close: base - 6,
      volume: 2200000 - index * 15000,
    };
  });

  for (let index = 20; index < 34; index += 1) {
    const base = 2060 + (index - 20) * 18;
    candles[index] = {
      ...candles[index],
      open: base,
      high: base + 26,
      low: base - 10,
      close: base + 14,
      volume: 2600000 + (index - 20) * 40000,
    };
  }

  candles[candles.length - 2] = {
    ...candles[candles.length - 2],
    open: 2120,
    high: 2210,
    low: 2110,
    close: 2195,
    volume: 2100000,
  };

  candles[candles.length - 1] = {
    ...candles[candles.length - 1],
    open: 2200,
    high: 2225,
    low: 2135,
    close: 2145,
    volume: 100000,
  };

  const result = analyzeStock({
    query: "9432",
    stock: {
      code: "9432",
      name: "NTT",
      sector: "通信",
      baselineTrend: "volatile",
      description: "テスト用のサンプルデータ",
      marketData: {
        price: 2145,
        open: 2200,
        high: 2225,
        low: 2135,
        previousClose: 2195,
        change: -50,
        changePercent: -2.28,
        currency: "JPY",
        asOf: null,
      },
      chartData: {
        candles,
      },
      dataStatus: "real",
      dataReason: null,
      timeframe: "1d",
    },
  });

  assert.ok(result.reasons.some((reason) => reason.includes("出来高減少による減点") || reason.includes("参加者が減っています")));
  assert.ok(result.aiReason.some((reason) => reason.includes("Trend整合") || reason.includes("200日線")));
});
