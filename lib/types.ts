export type TradeSignal = "BUY" | "HOLD" | "SELL";
export type AiJudgment = "強い買い" | "買い" | "様子見" | "売り" | "強い売り";
export type StockTimeframe = "5m" | "15m" | "1d";
export type StockDataStatus = "real" | "mock" | "error";
export type Tepou30SortMode =
  | "ai-total"
  | "expected-value"
  | "win-rate"
  | "profit-factor"
  | "risk-reward"
  | "day-trader"
  | "swing-trader";

export type NewsSentiment = {
  sentiment: "bullish" | "neutral" | "bearish";
  importance: "重要" | "普通" | "軽微";
  score: number;
  confidence: number;
  starRating: number;
  positiveCount: number;
  negativeCount: number;
  summary: string;
  headlines: string[];
  details: Array<{
    headline: string;
    sentiment: "positive" | "neutral" | "negative";
    importanceStars: number;
    publishedAt?: string;
  }>;
  updatedAt: string;
};

export type MarketContext = {
  nikkeiChangePercent: number | null;
  topixChangePercent: number | null;
  usdJpyChangePercent: number | null;
  vixChangePercent: number | null;
  source: string;
  updatedAt: string;
};

export type AiLearningProfile = {
  technicalWeight: number;
  newsWeight: number;
  volumeWeight: number;
  gapWeight: number;
};

export type Stock = {
  code: string;
  name: string;
  sector: string;
  baselineTrend: "up" | "neutral" | "volatile" | "steady";
  description: string;
  marketData?: StockMarketData;
  chartData?: StockChartData;
  newsAnalysis?: NewsSentiment;
  marketContext?: MarketContext;
  dataStatus?: StockDataStatus;
  dataReason?: string | null;
  timeframe?: StockTimeframe;
  analysisWeights?: Partial<AiScoreWeights>;
  analysisLearningProfile?: Partial<AiLearningProfile>;
  analysisBacktest?: Tepou30BacktestMetrics;
};

export type StockApiSource = "mock" | "alpha-vantage" | "finnhub" | "jpx";

export type StockMarketData = {
  price: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string;
  asOf: string | null;
};

export type StockCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StockChartData = {
  candles: StockCandle[];
};

export type StockApiResponse = {
  success: boolean;
  data: Stock | null;
  source: StockApiSource;
  error?: string;
};

export type AiScoreInput = {
  query: string;
  stock?: Stock | null;
};

export type AiScoreWeights = {
  rsi: number;
  macd: number;
  ma5: number;
  ma25: number;
  ma75: number;
  adx: number;
  atr: number;
  bollinger: number;
  supportResistance: number;
  volumeRatio: number;
  volumeSpike: number;
  trendStrength: number;
  lossRisk: number;
  probabilityUp: number;
};

export type AiScoreResult = {
  code: string;
  name: string;
  sector: string;
  score: number;
  judgment: AiJudgment;
  signal: TradeSignal;
  trend: string;
  confidence: number;
  summary: string;
  reasons: string[];
  riskLevel: "低" | "中" | "高";
  trendStrength: string;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  riskRewardRatio: number;
  lossRiskPercent: number;
  probability5m: number;
  probability15m: number;
  probability1d: number;
  winRate: number;
  backtestWinRate: number;
  expectedValuePercent: number;
  expectedValue: number;
  entryPriority: number;
  rewardLevel: "低" | "中" | "高";
  expectedValueRiskLevel: "低" | "中" | "高";
  aiReason: string[];
  positiveFactors: string[];
  negativeFactors: string[];
  reasonRanking: Array<{
    label: string;
    impact: number;
  }>;
  decisionReason: string;
  chartData?: StockChartData;
  dataStatus?: StockDataStatus;
  dataReason?: string | null;
  timeframe?: StockTimeframe;
};

export type Tepou30Item = {
  rank: number;
  code: string;
  name: string;
  sector: string;
  score: number;
  judgment: AiJudgment;
  probability5m: number;
  probability15m: number;
  probability1d: number;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  lossRiskPercent: number;
  expectedValuePercent: number;
  winRate: number;
  confidence: number;
  newsSentiment?: NewsSentiment["sentiment"];
  newsImportanceStars?: number;
  newsSummary?: string;
  newsPositiveCount?: number;
  newsNegativeCount?: number;
};

export type Tepou30Status = "idle" | "building" | "ready" | "error";

export type Tepou30BacktestMetrics = {
  periodDays: number;
  totalTrades: number;
  winRate: number;
  averageProfit: number;
  averageLoss: number;
  expectedValuePercent: number;
  averageReturn: number;
  maxDrawdown: number;
  profitFactor: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
};

export type Tepou30Response = {
  success: boolean;
  status: Tepou30Status;
  sortMode?: Tepou30SortMode;
  data: Tepou30Item[];
  optimizedWeights?: AiScoreWeights;
  optimizedLearningProfile?: AiLearningProfile;
  backtest?: Tepou30BacktestMetrics;
  updatedAt?: string;
  progress?: {
    total: number;
    analyzed: number;
  };
  error?: string;
};
