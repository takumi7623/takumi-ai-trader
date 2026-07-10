import type { MarketContext } from "./types";

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
      };
    }>;
  };
};

type CachedMarketContext = {
  expiresAt: number;
  value: MarketContext;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: CachedMarketContext | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function calcChangePercent(closes: Array<number | null | undefined>) {
  const filtered = closes.filter(isFiniteNumber);
  if (filtered.length < 2) {
    return null;
  }

  const latest = filtered[filtered.length - 1];
  const previous = filtered[filtered.length - 2];

  if (previous === 0) {
    return null;
  }

  return ((latest - previous) / previous) * 100;
}

async function fetchYahooDailyChangePercent(symbol: string): Promise<number | null> {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("range", "7d");

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Yahoo chart API failed: ${response.status}`);
  }

  const json = (await response.json()) as YahooChartResponse;
  const closes = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes)) {
    return null;
  }

  return calcChangePercent(closes);
}

export async function fetchMarketContext(): Promise<MarketContext | null> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }

  try {
    const [nikkeiChangePercent, topixChangePercent, usdJpyChangePercent, vixChangePercent] = await Promise.all([
      fetchYahooDailyChangePercent("^N225"),
      fetchYahooDailyChangePercent("^TOPX"),
      fetchYahooDailyChangePercent("JPY=X"),
      fetchYahooDailyChangePercent("^VIX"),
    ]);

    if (nikkeiChangePercent === null && topixChangePercent === null && usdJpyChangePercent === null && vixChangePercent === null) {
      return null;
    }

    const value: MarketContext = {
      nikkeiChangePercent,
      topixChangePercent,
      usdJpyChangePercent,
      vixChangePercent,
      source: "yahoo-finance",
      updatedAt: new Date().toISOString(),
    };

    cache = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value,
    };

    return value;
  } catch {
    return null;
  }
}
