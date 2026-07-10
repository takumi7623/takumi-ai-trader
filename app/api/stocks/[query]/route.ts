import { fetchJpxNewsAnalysis } from "@/lib/newsAnalyzer";
import { fetchMarketContext } from "@/lib/marketContext";
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
        source: "jpx",
        error: "Query is required.",
      } satisfies StockApiResponse,
      { status: 400 },
    );
  }

  try {
    const providerStock = await fetchStockFromProvider(decodedQuery, "jpx", timeframe);

    if (providerStock) {
      const [newsAnalysis, marketContext] = await Promise.all([
        fetchJpxNewsAnalysis(providerStock.code),
        fetchMarketContext(),
      ]);
      const stock = {
        ...providerStock,
        newsAnalysis,
        marketContext: marketContext ?? providerStock.marketContext,
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
      {
        success: false,
        data: null,
        source: "jpx",
        error: reason,
      } satisfies StockApiResponse,
      { status: 502 },
    );
  }

  return Response.json(
    {
      success: false,
      data: null,
      source: "jpx",
      error: "Provider returned no data.",
    } satisfies StockApiResponse,
    { status: 502 },
  );
}
