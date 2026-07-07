import { getTepou30 } from "@/lib/tepou30";
import type { StockTimeframe, Tepou30Response, Tepou30SortMode } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const timeframeParam = searchParams.get("timeframe");
  const timeframe: StockTimeframe = timeframeParam === "5m" ? "5m" : timeframeParam === "15m" ? "15m" : "1d";
  const refresh = searchParams.get("refresh") === "1";
  const sortModeParam = searchParams.get("sortMode");
  const sortMode: Tepou30SortMode = sortModeParam === "expected-value" ? "expected-value" : sortModeParam === "win-rate" ? "win-rate" : sortModeParam === "risk-reward" ? "risk-reward" : sortModeParam === "day-trader" ? "risk-reward" : "ai-total";

  try {
    const payload = await getTepou30(timeframe, refresh, sortMode);
    const statusCode = payload.status === "error" ? 500 : 200;

    return Response.json(payload satisfies Tepou30Response, { status: statusCode });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch Tepou30.";

    return Response.json(
      {
        success: false,
        status: "error",
        data: [],
        error: message,
      } satisfies Tepou30Response,
      { status: 500 },
    );
  }
}
