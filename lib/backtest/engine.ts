import { analyzeStock } from "../ai/scoreCalculator";
import type { AiScoreInput, Stock, StockCandle } from "../types";
import type {
  AiScoreBacktestBucketSummary,
  AiScoreBacktestHoldingSummary,
  AiScoreBacktestInput,
  AiScoreBacktestResult,
  AiScoreBacktestSectorSummary,
  AiScoreBacktestTradeOutcome,
  BacktestHoldingPeriod,
} from "./types";

const SCORE_BUCKETS = [
  { label: "90-100", min: 90, max: 100 },
  { label: "80-89", min: 80, max: 89.999 },
  { label: "70-79", min: 70, max: 79.999 },
  { label: "60-69", min: 60, max: 69.999 },
  { label: "59以下", min: 0, max: 59.999 },
] as const;

const HOLDING_PERIODS: BacktestHoldingPeriod[] = [1, 3, 5, 10, 20];
const DEFAULT_ENTRY_SCORE = 70;

type EquityPoint = {
  date: string;
  equity: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeReturns(returns: number[]) {
  const winningReturns = returns.filter((value) => value > 0);
  const losingReturns = returns.filter((value) => value < 0);
  const grossProfit = winningReturns.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losingReturns.reduce((sum, value) => sum + value, 0));
  return {
    totalTrades: returns.length,
    winRate: returns.length > 0 ? (winningReturns.length / returns.length) * 100 : 0,
    averageProfit: winningReturns.length > 0 ? average(winningReturns) : 0,
    averageLoss: losingReturns.length > 0 ? average(losingReturns) : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    averageReturn: returns.length > 0 ? average(returns) : 0,
  };
}

function calculateMaxDrawdown(points: EquityPoint[]) {
  if (points.length === 0) {
    return 0;
  }

  let peak = points[0].equity;
  let maxDrawdown = 0;

  for (const point of points) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      const drawdown = ((peak - point.equity) / peak) * 100;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }
  }

  return maxDrawdown;
}

function calculateAnnualizedStyleRatio(returns: number[]) {
  if (returns.length === 0) {
    return 0;
  }

  const mean = average(returns);
  const variance = average(returns.map((value) => (value - mean) ** 2));
  const stdDev = Math.sqrt(variance);
  return stdDev > 0 ? mean / stdDev : 0;
}

function calculateSortinoRatio(returns: number[]) {
  if (returns.length === 0) {
    return 0;
  }

  const mean = average(returns);
  const downside = returns.filter((value) => value < 0);
  const downsideVariance = downside.length > 0 ? average(downside.map((value) => value ** 2)) : 0;
  const downsideDeviation = Math.sqrt(downsideVariance);
  return downsideDeviation > 0 ? mean / downsideDeviation : 0;
}

function createHistoricalStock(stock: Stock, candles: StockCandle[], endIndex: number): Stock {
  const visibleCandles = candles.slice(0, endIndex + 1);
  const latest = visibleCandles[visibleCandles.length - 1];
  const previous = visibleCandles[visibleCandles.length - 2];

  return {
    ...stock,
    chartData: { candles: visibleCandles },
    marketData: {
      price: latest?.close ?? stock.marketData?.price ?? 0,
      open: latest?.open ?? stock.marketData?.open ?? null,
      high: latest?.high ?? stock.marketData?.high ?? null,
      low: latest?.low ?? stock.marketData?.low ?? null,
      previousClose: previous?.close ?? stock.marketData?.previousClose ?? null,
      change: latest && previous ? latest.close - previous.close : stock.marketData?.change ?? null,
      changePercent: latest && previous && previous.close > 0 ? ((latest.close - previous.close) / previous.close) * 100 : stock.marketData?.changePercent ?? null,
      currency: stock.marketData?.currency ?? "JPY",
      asOf: latest?.time ?? stock.marketData?.asOf ?? null,
    },
    timeframe: stock.timeframe ?? "1d",
  };
}

function chooseExitReason(price: number, stopLoss: number, takeProfit: number, signal: string, holdingPeriodDays: number, exitIndex: number, finalIndex: number) {
  if (price <= stopLoss) {
    return "stop-loss";
  }

  if (price >= takeProfit) {
    return "take-profit";
  }

  if (exitIndex >= finalIndex) {
    return `time-exit-${holdingPeriodDays}d`;
  }

  return signal === "SELL" ? "signal-reversal" : "signal-exit";
}

function buildTrade(
  stock: Stock,
  candles: StockCandle[],
  entryIndex: number,
  holdingPeriodDays: BacktestHoldingPeriod,
): AiScoreBacktestTradeOutcome | null {
  const historicalStock = createHistoricalStock(stock, candles, entryIndex);
  const analysis = analyzeStock({ query: stock.code, stock: historicalStock });

  if (analysis.signal !== "BUY" || analysis.score < DEFAULT_ENTRY_SCORE) {
    return null;
  }

  const entryCandle = candles[entryIndex + 1];
  if (!entryCandle) {
    return null;
  }

  const stopLoss = analysis.stopLossPrice;
  const takeProfit = analysis.takeProfitPrice;
  const exitLimitIndex = Math.min(candles.length - 1, entryIndex + holdingPeriodDays);
  let exitIndex = exitLimitIndex;
  let exitPrice = candles[exitIndex]?.close ?? entryCandle.close;
  let exitReason = `time-exit-${holdingPeriodDays}d`;

  for (let index = entryIndex + 1; index <= exitLimitIndex; index += 1) {
    const candle = candles[index];
    if (!candle) {
      break;
    }

    if (candle.low <= stopLoss) {
      exitIndex = index;
      exitPrice = stopLoss;
      exitReason = "stop-loss";
      break;
    }

    if (candle.high >= takeProfit) {
      exitIndex = index;
      exitPrice = takeProfit;
      exitReason = "take-profit";
      break;
    }

    if (index === exitLimitIndex) {
      exitIndex = index;
      exitPrice = candle.close;
      exitReason = chooseExitReason(candle.close, stopLoss, takeProfit, analysis.signal, holdingPeriodDays, index, exitLimitIndex);
    }
  }

  const entryPrice = entryCandle.open > 0 ? entryCandle.open : entryCandle.close;
  const returnPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
  const pnl = exitPrice - entryPrice;

  return {
    code: stock.code,
    name: stock.name,
    sector: stock.sector,
    timeframe: stock.timeframe ?? "1d",
    entryDate: entryCandle.time,
    exitDate: candles[exitIndex]?.time ?? entryCandle.time,
    holdingPeriodDays,
    score: analysis.score,
    signal: analysis.signal,
    entryPrice,
    exitPrice,
    returnPercent,
    pnl,
    exitReason,
  };
}

function summarizeBucket(trades: AiScoreBacktestTradeOutcome[], label: string): AiScoreBacktestBucketSummary {
  const returns = trades.map((trade) => trade.returnPercent);
  const stats = summarizeReturns(returns);
  const equityPoints: EquityPoint[] = [];
  let equity = 100;
  for (const trade of trades) {
    equity *= 1 + trade.returnPercent / 100;
    equityPoints.push({ date: trade.exitDate, equity });
  }

  return {
    label,
    totalTrades: stats.totalTrades,
    winRate: stats.winRate,
    averageProfit: stats.averageProfit,
    averageLoss: stats.averageLoss,
    profitFactor: stats.profitFactor,
    maxDrawdown: calculateMaxDrawdown(equityPoints),
    averageReturn: stats.averageReturn,
  };
}

function summarizeHoldingPeriod(trades: AiScoreBacktestTradeOutcome[], holdingPeriodDays: BacktestHoldingPeriod): AiScoreBacktestHoldingSummary {
  const returns = trades.map((trade) => trade.returnPercent);
  const stats = summarizeReturns(returns);
  const equityPoints: EquityPoint[] = [];
  let equity = 100;
  for (const trade of trades) {
    equity *= 1 + trade.returnPercent / 100;
    equityPoints.push({ date: trade.exitDate, equity });
  }

  return {
    holdingPeriodDays,
    totalTrades: stats.totalTrades,
    winRate: stats.winRate,
    averageProfit: stats.averageProfit,
    averageLoss: stats.averageLoss,
    profitFactor: stats.profitFactor,
    maxDrawdown: calculateMaxDrawdown(equityPoints),
    averageReturn: stats.averageReturn,
  };
}

function summarizeSector(trades: AiScoreBacktestTradeOutcome[], sector: string): AiScoreBacktestSectorSummary {
  const sectorTrades = trades.filter((trade) => trade.sector === sector);
  const returns = sectorTrades.map((trade) => trade.returnPercent);
  const stats = summarizeReturns(returns);

  return {
    sector,
    totalTrades: stats.totalTrades,
    winRate: stats.winRate,
    averageProfit: stats.averageProfit,
  };
}

export function runAiScoreBacktest(inputs: AiScoreBacktestInput[]): AiScoreBacktestResult {
  const trades: AiScoreBacktestTradeOutcome[] = [];

  for (const input of inputs) {
    const candles = input.candles;
    for (const holdingPeriodDays of HOLDING_PERIODS) {
      for (let entryIndex = 29; entryIndex < candles.length - 1; entryIndex += 1) {
        const trade = buildTrade(input.stock, candles, entryIndex, holdingPeriodDays);
        if (trade) {
          trades.push(trade);
        }
      }
    }
  }

  const scoreBuckets = SCORE_BUCKETS.map((bucket) => {
    const bucketTrades = trades.filter((trade) => trade.score >= bucket.min && trade.score <= bucket.max);
    return summarizeBucket(bucketTrades, bucket.label);
  });

  const holdingPeriods = HOLDING_PERIODS.map((holdingPeriodDays) => {
    const periodTrades = trades.filter((trade) => trade.holdingPeriodDays === holdingPeriodDays);
    return summarizeHoldingPeriod(periodTrades, holdingPeriodDays);
  });

  const sectors = Array.from(new Set(trades.map((trade) => trade.sector))).sort().map((sector) => summarizeSector(trades, sector));

  const totalsStats = summarizeReturns(trades.map((trade) => trade.returnPercent));
  const equityPoints: EquityPoint[] = [];
  let equity = 100;
  for (const trade of trades) {
    equity *= 1 + trade.returnPercent / 100;
    equityPoints.push({ date: trade.exitDate, equity });
  }

  return {
    generatedAt: new Date().toISOString(),
    trades,
    scoreBuckets,
    holdingPeriods,
    sectors,
    totals: {
      totalTrades: totalsStats.totalTrades,
      winRate: totalsStats.winRate,
      averageProfit: totalsStats.averageProfit,
      averageLoss: totalsStats.averageLoss,
      profitFactor: totalsStats.profitFactor,
      maxDrawdown: calculateMaxDrawdown(equityPoints),
      averageReturn: totalsStats.averageReturn,
    },
  };
}
