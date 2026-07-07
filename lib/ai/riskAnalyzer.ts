import type { Stock } from "../types";

export type AnalyzerResult = {
  score: number;
  confidence: number;
  summary: string;
  reasons: string[];
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function analyzeRisk(stock: Stock): AnalyzerResult {
  const volatilityBias =
    stock.baselineTrend === "volatile"
      ? 76
      : stock.baselineTrend === "neutral"
        ? 48
        : stock.baselineTrend === "steady"
          ? 34
          : 28;

  const priceMove = Math.abs(stock.marketData?.changePercent ?? 0);
  const score = clamp(volatilityBias + priceMove * 1.1, 0, 100);
  const confidence = clamp(70 - priceMove * 0.2, 60, 90);

  const summary =
    score >= 70
      ? "リスクは高めで、損切りの設定が重要です。"
      : score >= 45
        ? "適度なリスクを伴う見通しです。"
        : "比較的守りやすい環境です。";

  return {
    score: Math.round(score),
    confidence: Math.round(confidence),
    summary,
    reasons: [
      "ボラティリティの高い環境にあります。",
      "価格の振れ幅が大きくなりやすいです。",
      "損失回避のルール設定が重要です。",
    ],
  };
}
