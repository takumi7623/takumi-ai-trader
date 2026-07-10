"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { analyzeStock } from "@/lib/ai/scoreCalculator";
import { fetchJapaneseStock, fetchTepou30 } from "@/lib/api";
import type { AiScoreResult, NewsSentiment, StockTimeframe, Tepou30BacktestMetrics, Tepou30Response, Tepou30SortMode } from "@/lib/types";
import StockChart from "./StockChart";

const numberFormatter = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 2,
});

function formatPrice(value: number) {
  return `¥${numberFormatter.format(value)}`;
}

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

function formatFixedNumber(value: unknown, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function formatSafePercent(value: unknown, digits = 2) {
  const fixed = formatFixedNumber(value, digits);
  return fixed === "--" ? "--" : `${fixed}%`;
}

function formatSafeSignedLossPercent(value: unknown, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "--";
  }

  return `-${Math.abs(value).toFixed(digits)}%`;
}

function renderStars(count: number) {
  const safeCount = Math.max(0, Math.min(5, Math.round(count)));
  return `${"★".repeat(safeCount)}${"☆".repeat(5 - safeCount)}`;
}

function judgmentTone(judgment: AiScoreResult["judgment"]) {
  if (judgment === "強い買い" || judgment === "買い") {
    return "text-green-400";
  }

  if (judgment === "様子見") {
    return "text-yellow-300";
  }

  return "text-red-400";
}

function scoreTone(score: number) {
  if (score >= 78) {
    return "text-emerald-400";
  }

  if (score >= 62) {
    return "text-cyan-400";
  }

  if (score >= 42) {
    return "text-amber-300";
  }

  return "text-rose-400";
}

export default function SearchBox() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<AiScoreResult | null>(null);
  const [newsAnalysis, setNewsAnalysis] = useState<NewsSentiment | null>(null);
  const [analysisBacktest, setAnalysisBacktest] = useState<Tepou30BacktestMetrics | null>(null);
  const [timeframe, setTimeframe] = useState<StockTimeframe>("1d");
  const [tepou30, setTepou30] = useState<Tepou30Response | null>(null);
  const [tepouSortMode, setTepouSortMode] = useState<Tepou30SortMode>("ai-total");
  const [tepouError, setTepouError] = useState("");
  const [tepouLoading, setTepouLoading] = useState(false);
  const pollingTimerRef = useRef<number | null>(null);

  const clearPolling = useCallback(() => {
    if (pollingTimerRef.current !== null) {
      window.clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }, []);

  const fetchTepouRanking = useCallback(async (refresh: boolean, targetSortMode: Tepou30SortMode = tepouSortMode) => {
    setTepouError("");

    if (refresh) {
      setTepouLoading(true);
    }

    try {
      const payload = await fetchTepou30(timeframe, refresh, targetSortMode);
      setTepou30(payload);

      if (payload.status !== "building") {
        clearPolling();
      }
    } catch {
      setTepouError("テッポウ30の生成に失敗しました。");
      clearPolling();
    } finally {
      setTepouLoading(false);
    }
  }, [clearPolling, tepouSortMode, timeframe]);

  useEffect(() => {
    if (tepou30?.status !== "building") {
      clearPolling();
      return;
    }

    if (pollingTimerRef.current !== null) {
      return;
    }

    pollingTimerRef.current = window.setInterval(() => {
      void fetchTepouRanking(false);
    }, 3000);

    return () => {
      clearPolling();
    };
  }, [clearPolling, fetchTepouRanking, tepou30?.status]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void fetchTepouRanking(true, tepouSortMode);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [fetchTepouRanking, tepouSortMode, timeframe]);

  const handleSearch = async () => {
    const query = code.trim();

    if (!query) {
      setResult(null);
      setError("銘柄コードまたは会社名を入力してください。");
      return;
    }

    setError("");
    setAnalysisBacktest(null);
    setNewsAnalysis(null);

    try {
      const { stock, response } = await fetchJapaneseStock(query, timeframe);

      if (!stock) {
        setResult(null);
        setError(response.error ?? "株価データ取得に失敗しました");
        setAnalysisBacktest(null);
        setNewsAnalysis(null);
        return;
      }

      setAnalysisBacktest(stock.analysisBacktest ?? null);
      setNewsAnalysis(stock.newsAnalysis ?? null);
      setResult(analyzeStock({ query, stock }, {
        weights: stock.analysisWeights,
        learningProfile: stock.analysisLearningProfile,
      }));
      setError(response.error ?? "");
    } catch {
      setResult(null);
      setAnalysisBacktest(null);
      setNewsAnalysis(null);
      setError("株価データ取得に失敗しました");
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handleSearch();
  };

  const winRate = result?.winRate ?? 0;

  function formatMetricPercent(value: unknown) {
    return formatSafePercent(value, 2);
  }

  return (
    <section className="max-w-7xl mx-auto w-full px-4 sm:px-6 mt-8">
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 sm:p-6">
        <h2 className="text-xl font-bold text-cyan-400 mb-4">
          AIスコア検索
        </h2>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            placeholder="例: 7203 または トヨタ自動車"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="flex-1 rounded-lg bg-gray-800 text-white px-4 py-3 border border-gray-600 outline-none focus:border-cyan-400"
            aria-label="銘柄コードまたは会社名"
          />

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setTimeframe("1d");
                setTepou30(null);
                setTepouError("");
                clearPolling();
              }}
              className={`rounded-lg px-4 py-3 font-semibold ${timeframe === "1d" ? "bg-cyan-500 text-white" : "bg-gray-800 text-gray-300"}`}
            >
              日足
            </button>
            <button
              type="button"
              onClick={() => {
                setTimeframe("5m");
                setTepou30(null);
                setTepouError("");
                clearPolling();
              }}
              className={`rounded-lg px-4 py-3 font-semibold ${timeframe === "5m" ? "bg-cyan-500 text-white" : "bg-gray-800 text-gray-300"}`}
            >
              5分足
            </button>
            <button
              type="button"
              onClick={() => {
                setTimeframe("15m");
                setTepou30(null);
                setTepouError("");
                clearPolling();
              }}
              className={`rounded-lg px-4 py-3 font-semibold ${timeframe === "15m" ? "bg-cyan-500 text-white" : "bg-gray-800 text-gray-300"}`}
            >
              15分足
            </button>
          </div>

          <button
            type="button"
            onClick={handleSearch}
            className="bg-cyan-500 hover:bg-cyan-600 px-6 py-3 rounded-lg text-white font-bold"
          >
            検索
          </button>
        </form>

        <p className="text-gray-400 text-sm mt-3">
          銘柄コードまたは会社名を入力すると、AIスコアと売買判定を表示します。必要に応じて時間足を切り替えられます。
        </p>

        {error ? (
          <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </p>
        ) : null}

        {result ? (
          <div className="mt-6 rounded-lg border border-gray-700 bg-gray-950 p-5">
            {result.dataStatus !== "real" ? (
              <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                実データ取得に失敗したため、{result.dataStatus === "mock" ? "モックデータ" : "代替データ"}を表示しています。
                {result.dataReason ? <> 理由: {result.dataReason}</> : null}
              </div>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm text-gray-400">{result.code}</p>
                <h3 className="text-2xl font-bold text-white">{result.name}</h3>
                <p className="mt-1 text-sm text-gray-400">{result.sector}</p>
              </div>

              <div className="text-left sm:text-right">
                <p className="text-sm text-gray-400">AIスコア</p>
                <p className={`text-4xl font-bold ${scoreTone(result.score)}`}>{result.score}</p>
              </div>
            </div>

            <div className="mt-4 grid gap-2 rounded-lg border border-gray-800 bg-gray-900/60 p-3 text-xs text-gray-300 sm:grid-cols-4">
              <p>勝率: <span className="font-semibold text-white">{formatPercent(winRate)}</span></p>
              <p>信頼度: <span className="font-semibold text-white">{formatPercent(result.confidence)}</span></p>
              <p>1日確率: <span className="font-semibold text-white">{formatPercent(result.probability1d)}</span></p>
              <p>期待値: <span className={`font-semibold ${result.expectedValuePercent >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{formatSafePercent(result.expectedValuePercent, 2)}</span></p>
            </div>

            {analysisBacktest ? (
              <div className="mt-4 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
                過去1年の検証結果を反映した重みで判定しています。勝率 {formatMetricPercent(analysisBacktest.winRate)} / 期待値 {formatMetricPercent(analysisBacktest.expectedValuePercent)}
              </div>
            ) : null}

            <p className="mt-4 text-sm leading-6 text-gray-300">
              {result.summary}
            </p>

            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 md:col-span-2 xl:col-span-1">
                <p className="text-xs text-gray-400">AIスコア</p>
                <p className="mt-2 text-4xl font-bold text-cyan-400">
                  {result.score}
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 md:col-span-2 xl:col-span-2">
                <p className="text-xs text-gray-400">総合判定</p>
                <p className={`mt-2 text-3xl font-bold ${judgmentTone(result.judgment)}`}>
                  {result.judgment}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  トレンド: {result.signal === "BUY" ? "上向き" : result.signal === "SELL" ? "下向き" : "中立"}
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <p className="text-xs text-gray-400">5分後上昇確率</p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {formatPercent(result.probability5m)}
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <p className="text-xs text-gray-400">15分後上昇確率</p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {formatPercent(result.probability15m)}
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <p className="text-xs text-gray-400">1日後上昇確率</p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {formatPercent(result.probability1d)}
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <p className="text-xs text-gray-400">推奨エントリー価格</p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {formatPrice(result.entryPrice)}
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <p className="text-xs text-gray-400">推奨利確価格</p>
                <p className="mt-2 text-2xl font-semibold text-green-400">
                  {formatPrice(result.takeProfitPrice)}
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <p className="text-xs text-gray-400">推奨損切り価格</p>
                <p className="mt-2 text-2xl font-semibold text-red-400">
                  {formatPrice(result.stopLossPrice)}
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <p className="text-xs text-gray-400">リスクリワード</p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {result.riskRewardRatio}x
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <p className="text-xs text-gray-400">勝率</p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {formatPercent(winRate)}
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <p className="text-xs text-gray-400">信頼度</p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {formatPercent(result.confidence)}
                </p>
              </div>

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                <p className="text-xs text-gray-400">1日期待値</p>
                <p className={`mt-2 text-2xl font-semibold ${result.expectedValuePercent >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {formatSafePercent(result.expectedValuePercent, 2)}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-gray-700 bg-gray-900 p-4">
              <p className="text-xs text-gray-400">AIがそう判断した理由</p>
              <p className="mt-2 text-sm leading-6 text-gray-300">
                {result.decisionReason}
              </p>
              <div className="mt-4 grid gap-3 lg:grid-cols-3">
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3">
                  <p className="text-xs text-emerald-200">プラス要因</p>
                  <ul className="mt-2 space-y-1 text-sm text-emerald-50 break-words">
                    {result.positiveFactors.length ? result.positiveFactors.map((factor) => (
                      <li key={factor} className="leading-6">
                        {factor}
                      </li>
                    )) : <li className="leading-6 text-emerald-100/70">目立つプラス要因はありません。</li>}
                  </ul>
                </div>
                <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3">
                  <p className="text-xs text-rose-200">マイナス要因</p>
                  <ul className="mt-2 space-y-1 text-sm text-rose-50 break-words">
                    {result.negativeFactors.length ? result.negativeFactors.map((factor) => (
                      <li key={factor} className="leading-6">
                        {factor}
                      </li>
                    )) : <li className="leading-6 text-rose-100/70">目立つマイナス要因はありません。</li>}
                  </ul>
                </div>
                <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 p-3">
                  <p className="text-xs text-cyan-200">重要度ランキング</p>
                  <ul className="mt-2 space-y-1 text-sm text-cyan-50 break-words">
                    {result.reasonRanking.map((item, index) => (
                      <li key={`${item.label}-${index}`} className="leading-6">
                        {index + 1}. {item.label} ({item.impact > 0 ? "+" : ""}{item.impact})
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            {newsAnalysis ? (
              <div className="mt-4 rounded-lg border border-gray-700 bg-gray-900 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-gray-400">ニュースAI評価</p>
                  <p className="text-sm font-semibold text-amber-300">重要度 {renderStars(newsAnalysis.starRating)}</p>
                </div>
                <p className="mt-2 text-sm leading-6 text-gray-300">{newsAnalysis.summary}</p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-emerald-300">好材料 {newsAnalysis.positiveCount}</span>
                  <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-rose-300">悪材料 {newsAnalysis.negativeCount}</span>
                  <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-cyan-300">信頼度 {formatPercent(newsAnalysis.confidence)}</span>
                </div>
                {newsAnalysis.details.length > 0 ? (
                  <ul className="mt-3 space-y-2 text-sm text-gray-300">
                    {newsAnalysis.details.slice(0, 5).map((item, index) => (
                      <li key={`${item.headline}-${index}`} className="rounded-md border border-gray-800 bg-gray-950 px-3 py-2">
                        <p className="leading-6">{item.headline}</p>
                        <p className="mt-1 text-xs text-gray-500">
                          {item.sentiment === "positive" ? "好材料" : item.sentiment === "negative" ? "悪材料" : "中立"} / 重要度 {renderStars(item.importanceStars)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full border border-gray-700 bg-gray-950 px-3 py-1 text-xs text-gray-400">
                判定: {result.signal}
              </span>
              <span className="rounded-full border border-gray-700 bg-gray-950 px-3 py-1 text-xs text-gray-400">
                リスク: {result.riskLevel}
              </span>
              <span className="rounded-full border border-gray-700 bg-gray-950 px-3 py-1 text-xs text-gray-400">
                トレンド: {result.trendStrength}
              </span>
              <span className="rounded-full border border-gray-700 bg-gray-950 px-3 py-1 text-xs text-gray-400">
                時間足: {result.timeframe === "5m" ? "5分足" : result.timeframe === "15m" ? "15分足" : "日足"}
              </span>
              <span className="rounded-full border border-gray-700 bg-gray-950 px-3 py-1 text-xs text-gray-400">
                データ: {result.dataStatus === "real" ? "実データ" : "モック/代替"}
              </span>
            </div>

            {result.chartData ? (
              <StockChart
                key={`${result.code}-${result.timeframe ?? timeframe}`}
                data={result.chartData}
                label={`${result.code} ${result.name} (${result.timeframe === "5m" ? "5分足" : result.timeframe === "15m" ? "15分足" : "日足"})`}
                code={result.code}
                timeframe={result.timeframe ?? timeframe}
                realtime
                signal={result.signal}
              />
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 rounded-lg border border-gray-700 bg-gray-950 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm text-gray-400">ランキング</p>
              <h3 className="text-2xl font-bold text-cyan-400">テッポウ30</h3>
              <p className="mt-1 text-xs text-gray-500">
                J-Quants API v2の上場銘柄約4000件を分析し、AIスコア上位30件を表示します。
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:items-end">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setTepouSortMode("ai-total");
                    void fetchTepouRanking(false, "ai-total");
                  }}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold ${tepouSortMode === "ai-total" ? "bg-cyan-500 text-white" : "bg-gray-800 text-gray-300"}`}
                >
                  AI総合順
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTepouSortMode("expected-value");
                    void fetchTepouRanking(false, "expected-value");
                  }}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold ${tepouSortMode === "expected-value" ? "bg-cyan-500 text-white" : "bg-gray-800 text-gray-300"}`}
                >
                  期待値順
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTepouSortMode("win-rate");
                    void fetchTepouRanking(false, "win-rate");
                  }}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold ${tepouSortMode === "win-rate" ? "bg-cyan-500 text-white" : "bg-gray-800 text-gray-300"}`}
                >
                  勝率順
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTepouSortMode("profit-factor");
                    void fetchTepouRanking(false, "profit-factor");
                  }}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold ${tepouSortMode === "profit-factor" ? "bg-cyan-500 text-white" : "bg-gray-800 text-gray-300"}`}
                >
                  PF順
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTepouSortMode("risk-reward");
                    void fetchTepouRanking(false, "risk-reward");
                  }}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold ${tepouSortMode === "risk-reward" ? "bg-cyan-500 text-white" : "bg-gray-800 text-gray-300"}`}
                >
                  リスクリワード順
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTepouSortMode("day-trader");
                    void fetchTepouRanking(false, "day-trader");
                  }}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold ${tepouSortMode === "day-trader" ? "bg-cyan-500 text-white" : "bg-gray-800 text-gray-300"}`}
                >
                  デイトレ向き
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTepouSortMode("swing-trader");
                    void fetchTepouRanking(false, "swing-trader");
                  }}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold ${tepouSortMode === "swing-trader" ? "bg-cyan-500 text-white" : "bg-gray-800 text-gray-300"}`}
                >
                  スイング向き
                </button>
              </div>

              <button
                type="button"
                onClick={() => void fetchTepouRanking(true, tepouSortMode)}
                className="rounded-lg bg-cyan-500 px-5 py-3 font-bold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={tepouLoading || tepou30?.status === "building"}
              >
                {tepou30?.status === "building" ? "生成中..." : "テッポウ30を更新"}
              </button>
            </div>
          </div>

          {tepou30?.progress ? (
            <p className="mt-3 text-xs text-gray-400">
              分析進捗: {tepou30.progress.analyzed}/{tepou30.progress.total}
              {tepou30.updatedAt ? ` / 更新時刻: ${new Date(tepou30.updatedAt).toLocaleString("ja-JP")}` : ""}
            </p>
          ) : null}

          {tepou30?.backtest ? (
            <div className="mt-4">
              <p className="text-xs text-gray-400">バックテスト画面</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-10">
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">検証期間（1年〜最大3年）</p>
                <p className="mt-1 text-lg font-semibold text-white">{tepou30.backtest.periodDays}日</p>
              </div>
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">取引回数</p>
                <p className="mt-1 text-lg font-semibold text-white">{tepou30.backtest.totalTrades}回</p>
              </div>
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">勝率</p>
                <p className="mt-1 text-lg font-semibold text-emerald-400">{formatSafePercent(tepou30.backtest.winRate, 2)}</p>
              </div>
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">平均利益</p>
                <p className="mt-1 text-lg font-semibold text-emerald-400">{formatSafePercent(tepou30.backtest.averageProfit, 2)}</p>
              </div>
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">平均損失</p>
                <p className="mt-1 text-lg font-semibold text-rose-400">{formatSafeSignedLossPercent(tepou30.backtest.averageLoss, 2)}</p>
              </div>
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">最大ドローダウン</p>
                <p className="mt-1 text-lg font-semibold text-amber-300">{formatSafeSignedLossPercent(tepou30.backtest.maxDrawdown, 2)}</p>
              </div>
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">期待値</p>
                <p className={`mt-1 text-lg font-semibold ${tepou30.backtest.expectedValuePercent >= 0 ? "text-cyan-400" : "text-rose-400"}`}>{formatSafePercent(tepou30.backtest.expectedValuePercent, 2)}</p>
              </div>
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">Profit Factor</p>
                <p className="mt-1 text-lg font-semibold text-cyan-300">{formatFixedNumber(tepou30.backtest.profitFactor, 2)}</p>
              </div>
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">Sharpe Ratio</p>
                <p className="mt-1 text-lg font-semibold text-cyan-300">{formatFixedNumber(tepou30.backtest.sharpeRatio, 2)}</p>
              </div>
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">Sortino Ratio</p>
                <p className="mt-1 text-lg font-semibold text-cyan-300">{formatFixedNumber(tepou30.backtest.sortinoRatio, 2)}</p>
              </div>
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <p className="text-xs text-gray-400">Calmar Ratio</p>
                <p className="mt-1 text-lg font-semibold text-cyan-300">{formatFixedNumber(tepou30.backtest.calmarRatio, 2)}</p>
              </div>
              </div>
            </div>
          ) : null}

          {tepouError ? (
            <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {tepouError}
            </p>
          ) : null}

          {tepou30?.status === "error" && tepou30.error ? (
            <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {tepou30.error}
            </p>
          ) : null}

          {tepou30?.data.length ? (
            <div className="mt-4 max-h-[70vh] space-y-3 overflow-y-auto pr-1">
              {tepou30.data.map((item) => (
                <div key={item.code} className="rounded-lg border border-gray-700 bg-gray-900 p-4">
                  <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                    <div>
                      <p className="text-xs text-gray-400">順位 / 銘柄</p>
                      <p className="mt-1 text-lg font-bold text-white">#{item.rank} {item.code}</p>
                      <p className="text-sm text-gray-300 break-all">{item.name}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">AIスコア</p>
                      <p className="mt-1 text-lg font-semibold text-cyan-400">{item.score}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">総合判定</p>
                      <p className={`mt-1 text-lg font-semibold ${judgmentTone(item.judgment)}`}>{item.judgment}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">5分後 / 15分後 / 1日後上昇確率</p>
                      <p className="mt-1 text-sm text-white">{formatPercent(item.probability5m)} / {formatPercent(item.probability15m)} / {formatPercent(item.probability1d)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">推奨価格（エントリー / 利確 / 損切）</p>
                      <p className="mt-1 text-sm text-white">{formatPrice(item.entryPrice)} / {formatPrice(item.takeProfitPrice)} / {formatPrice(item.stopLossPrice)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">勝率 / 信頼度 / 期待値</p>
                      <p className="mt-1 text-sm text-white">{formatPercent(item.winRate)} / {formatPercent(item.confidence)} / {formatSafePercent(item.expectedValuePercent, 2)}</p>
                      {typeof item.newsImportanceStars === "number" ? (
                        <p className="mt-1 text-xs text-amber-300">ニュース {renderStars(item.newsImportanceStars)}（好{item.newsPositiveCount ?? 0} / 悪{item.newsNegativeCount ?? 0}）</p>
                      ) : null}
                      {item.newsSummary ? (
                        <p className="mt-1 text-xs text-gray-300">
                          {item.newsSentiment === "bullish" ? "好材料寄り" : item.newsSentiment === "bearish" ? "悪材料寄り" : "中立"}
                          : {item.newsSummary}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
