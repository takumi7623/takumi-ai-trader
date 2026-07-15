import type { Stock, StockCandle, StockTimeframe, TradeSignal } from "../types";

export type BacktestHoldingPeriod = 1 | 3 | 5 | 10 | 20;

export type AiScoreBacktestInput = {
  stock: Stock;
  candles: StockCandle[];
};

export type AiScoreBacktestTradeOutcome = {
  code: string;
  name: string;
  sector: string;
  timeframe: StockTimeframe;
  entryDate: string;
  exitDate: string;
  holdingPeriodDays: BacktestHoldingPeriod;
  score: number;
  signal: TradeSignal;
  entryPrice: number;
  exitPrice: number;
  returnPercent: number;
  pnl: number;
  exitReason: string;
};

export type AiScoreBacktestBucketSummary = {
  label: string;
  totalTrades: number;
  winRate: number;
  averageProfit: number;
  averageLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  averageReturn: number;
};

export type AiScoreBacktestHoldingSummary = {
  holdingPeriodDays: BacktestHoldingPeriod;
  totalTrades: number;
  winRate: number;
  averageProfit: number;
  averageLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  averageReturn: number;
};

export type AiScoreBacktestSectorSummary = {
  sector: string;
  totalTrades: number;
  winRate: number;
  averageProfit: number;
};

export type AiScoreBacktestResult = {
  generatedAt: string;
  trades: AiScoreBacktestTradeOutcome[];
  scoreBuckets: AiScoreBacktestBucketSummary[];
  holdingPeriods: AiScoreBacktestHoldingSummary[];
  sectors: AiScoreBacktestSectorSummary[];
  totals: {
    totalTrades: number;
    winRate: number;
    averageProfit: number;
    averageLoss: number;
    profitFactor: number;
    maxDrawdown: number;
    averageReturn: number;
  };
};
