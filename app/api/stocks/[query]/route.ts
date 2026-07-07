import { findMockStock } from "@/lib/mockStocks";
import { createMockChartData } from "@/lib/mockChartData";
import { fetchJpxNewsAnalysis } from "@/lib/newsAnalyzer";
import { getTepou30LearningProfile } from "@/lib/tepou30";
import { fetchStockFromProvider } from "@/lib/stockProviders";
import type { Stock, StockApiResponse, StockApiSource, StockTimeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

function buildResponse(
  data: StockApiResponse["data"],
  source: StockApiSource,
  error?: string,
): StockApiResponse {
  return {
    success: true,
    data,
    source,
    error,
  };
}

function buildMockStock(query: string, timeframe: StockTimeframe, reason: string): Stock {
  const stock = findMockStock(query);
  const fallback: Stock = stock ?? {
    code: query,
    name: "検索銘柄",
    sector: "未分類",
    baselineTrend: "neutral",
    description:
      "実データが取得できないため、代替データをもとにチャートとAIスコアを表示しています。",
  };

  return {
    ...fallback,
    chartData: fallback.chartData ?? createMockChartData(fallback.code),
    dataStatus: "mock",
    dataReason: reason,
    timeframe,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ query: string }> },
) {
  const { query } = await params;
  const decodedQuery = decodeURIComponent(query).trim();
  const { searchParams } = new URL(request.url);
  const timeframeParam = searchParams.get("timeframe");
  const timeframe: StockTimeframe = timeframeParam === "5m" ? "5m" : timeframeParam === "15m" ? "15m" : "1d";
  const learning = await getTepou30LearningProfile(timeframe);

  if (!decodedQuery) {
    return Response.json(
      {
        success: false,
        data: null,
        source: "mock",
        error: "Query is required.",
      } satisfies StockApiResponse,
      { status: 400 },
    );
  }

  try {
    const providerStock = await fetchStockFromProvider(decodedQuery, "jpx", timeframe);

    if (providerStock) {
      const newsAnalysis = await fetchJpxNewsAnalysis(providerStock.code);
      const stock = {
        ...providerStock,
        newsAnalysis,
        analysisWeights: learning.weights,
        analysisLearningProfile: learning.learningProfile,
        analysisBacktest: learning.backtest,
      };

      return Response.json(
        buildResponse(
          {
            ...stock,
            description: `${stock.description} 直近のバックテスト結果を反映した重みでAI判定を行っています。`,
          },
          "jpx",
        ),
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "External stock API failed.";
    console.error(reason);

    return Response.json(
      buildResponse(
        {
          ...buildMockStock(decodedQuery, timeframe, reason),
          analysisWeights: learning.weights,
          analysisLearningProfile: learning.learningProfile,
          analysisBacktest: learning.backtest,
        },
        "mock",
        reason,
      ),
    );
  }

  return Response.json(
    buildResponse(
      {
        ...buildMockStock(decodedQuery, timeframe, "Provider returned no data."),
        analysisWeights: learning.weights,
        analysisLearningProfile: learning.learningProfile,
        analysisBacktest: learning.backtest,
      },
      "mock",
      "Provider returned no data.",
    ),
  );
}
