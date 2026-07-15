import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareTepou30Snapshots } from "./tepou30";
import type { StockTimeframe, Tepou30SortMode } from "./types";

const SNAPSHOT_DIR = path.join(process.cwd(), ".cache", "tepou30-snapshots");
const REPORT_DIR = path.join(process.cwd(), ".cache", "tepou30-reports");

type SnapshotCompareToolParams = {
  timeframe?: StockTimeframe;
  sortMode?: Tepou30SortMode;
  beforeFileName?: string;
  afterFileName?: string;
  rankingLimit?: number;
};

type MetricDirection = "increase" | "decrease";

type EvaluationMetric = {
  key: string;
  label: string;
  before: number;
  after: number;
  delta: number;
  improved: boolean;
  worsened: boolean;
  direction: MetricDirection;
};

type ComparisonResult = Awaited<ReturnType<typeof compareTepou30Snapshots>>;

function clampRankingLimit(value: number | undefined) {
  if (!value || !Number.isFinite(value)) {
    return 50;
  }

  return Math.min(Math.max(Math.round(value), 1), 300);
}

function parseCliArgs(argv: string[]): SnapshotCompareToolParams {
  const params: SnapshotCompareToolParams = {};

  for (const arg of argv) {
    if (arg.startsWith("--timeframe=")) {
      const value = arg.slice("--timeframe=".length);
      params.timeframe = value === "5m" || value === "15m" ? value : "1d";
      continue;
    }

    if (arg.startsWith("--sortMode=")) {
      params.sortMode = arg.slice("--sortMode=".length) as Tepou30SortMode;
      continue;
    }

    if (arg.startsWith("--before=")) {
      params.beforeFileName = arg.slice("--before=".length);
      continue;
    }

    if (arg.startsWith("--after=")) {
      params.afterFileName = arg.slice("--after=".length);
      continue;
    }

    if (arg.startsWith("--rankingLimit=")) {
      params.rankingLimit = Number(arg.slice("--rankingLimit=".length));
    }
  }

  return params;
}

function roundMetric(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function metricFromDelta(
  key: string,
  label: string,
  before: number,
  after: number,
  direction: MetricDirection,
  digits = 2,
): EvaluationMetric {
  const delta = roundMetric(after - before, digits);
  const improved = direction === "increase" ? delta > 0 : delta < 0;
  const worsened = direction === "increase" ? delta < 0 : delta > 0;

  return {
    key,
    label,
    before,
    after,
    delta,
    improved,
    worsened,
    direction,
  };
}

function buildEvaluation(summary: ComparisonResult["summary"]) {
  const metrics = [
    metricFromDelta("buyCount", "BUY件数", summary.buyCount.before, summary.buyCount.after, "decrease", 0),
    metricFromDelta("holdCount", "HOLD件数", summary.holdCount.before, summary.holdCount.after, "increase", 0),
    metricFromDelta("sellCount", "SELL件数", summary.sellCount.before, summary.sellCount.after, "increase", 0),
    metricFromDelta("negativeEvBuyCount", "negative EV BUY件数", summary.negativeEvBuyCount.before, summary.negativeEvBuyCount.after, "decrease", 0),
    metricFromDelta("avgScore", "平均Score", summary.avgScore.before, summary.avgScore.after, "increase", 2),
    metricFromDelta("avgExpectedValuePercent", "平均ExpectedValuePercent", summary.avgExpectedValuePercent.before, summary.avgExpectedValuePercent.after, "increase", 3),
    metricFromDelta("avgWinRate", "平均WinRate", summary.avgWinRate.before, summary.avgWinRate.after, "increase", 2),
    metricFromDelta("avgConfidence", "平均Confidence", summary.avgConfidence.before, summary.avgConfidence.after, "increase", 2),
    metricFromDelta("score95BuyCount", "95点以上BUY件数", summary.score95BuyCount.before, summary.score95BuyCount.after, "increase", 0),
    metricFromDelta("score95HoldCount", "95点以上HOLD件数", summary.score95HoldCount.before, summary.score95HoldCount.after, "decrease", 0),
    metricFromDelta("score95SellCount", "95点以上SELL件数", summary.score95SellCount.before, summary.score95SellCount.after, "decrease", 0),
  ];
  const improvedMetrics = metrics.filter((metric) => metric.improved);
  const worsenedMetrics = metrics.filter((metric) => metric.worsened);
  const scorableMetrics = metrics.filter((metric) => metric.improved || metric.worsened).length;
  const improvementRate = scorableMetrics > 0
    ? roundMetric((improvedMetrics.length / scorableMetrics) * 100, 2)
    : 0;
  const criticalFail = worsenedMetrics.some((metric) => (
    metric.key === "negativeEvBuyCount"
    || metric.key === "avgExpectedValuePercent"
    || metric.key === "avgWinRate"
  ));
  const pass = !criticalFail && improvementRate >= 50;

  return {
    pass,
    verdict: pass ? "PASS" : "FAIL",
    improvementRate,
    criticalFails: worsenedMetrics.filter((metric) => (
      metric.key === "negativeEvBuyCount"
      || metric.key === "avgExpectedValuePercent"
      || metric.key === "avgWinRate"
    )),
    improvedMetrics,
    worsenedMetrics,
    metrics,
  };
}

async function saveEvaluationJson(params: {
  timeframe: StockTimeframe;
  sortMode: Tepou30SortMode;
  beforeFileName: string;
  afterFileName: string;
  payload: unknown;
}) {
  const { timeframe, sortMode, beforeFileName, afterFileName, payload } = params;
  const beforeStem = beforeFileName.replace(/\.json$/i, "");
  const afterStem = afterFileName.replace(/\.json$/i, "");
  const fileName = `tepou30-evaluation-${timeframe}-${sortMode}-${beforeStem}-vs-${afterStem}.json`;

  await mkdir(REPORT_DIR, { recursive: true });
  const filePath = path.join(REPORT_DIR, fileName);
  await writeFile(filePath, JSON.stringify(payload), "utf-8");
  return filePath;
}

function formatMetricLine(metric: EvaluationMetric) {
  return `- ${metric.label}: ${metric.before} -> ${metric.after} (${metric.delta >= 0 ? "+" : ""}${metric.delta})`;
}

function buildMarkdownReport(params: {
  result: {
    timeframe: StockTimeframe;
    sortMode: Tepou30SortMode;
    beforeFileName: string;
    afterFileName: string;
    beforeCreatedAt: string;
    afterCreatedAt: string;
    summary: ComparisonResult["summary"];
    evaluation: ReturnType<typeof buildEvaluation>;
    rankingChanges: Array<{
      code: string;
      rankBefore: number | null;
      rankAfter: number | null;
      rankDelta: number | null;
      signal: { before: string | null; after: string | null };
      score: { before: number | null; after: number | null; delta: number | null };
      expectedValuePercent: { before: number | null; after: number | null; delta: number | null };
      winRate: { before: number | null; after: number | null; delta: number | null };
      confidence: { before: number | null; after: number | null; delta: number | null };
    }>;
  };
}) {
  const { result } = params;
  const topRankingChanges = result.rankingChanges.slice(0, 20);
  const improvedLines = result.evaluation.improvedMetrics.map(formatMetricLine).join("\n") || "- なし";
  const worsenedLines = result.evaluation.worsenedMetrics.map(formatMetricLine).join("\n") || "- なし";
  const criticalFailLines = result.evaluation.criticalFails.map(formatMetricLine).join("\n") || "- なし";
  const rankingLines = topRankingChanges.map((item) => (
    `- ${item.code}: rank ${item.rankBefore ?? "-"} -> ${item.rankAfter ?? "-"} (${item.rankDelta !== null && item.rankDelta >= 0 ? "+" : ""}${item.rankDelta ?? "-"}), signal ${item.signal.before ?? "-"} -> ${item.signal.after ?? "-"}, score ${item.score.before ?? "-"} -> ${item.score.after ?? "-"}`
  )).join("\n") || "- なし";

  return [
    "# Tepou30 Snapshot Improvement Report",
    "",
    `- Generated At: ${new Date().toISOString()}`,
    `- Timeframe: ${result.timeframe}`,
    `- Sort Mode: ${result.sortMode}`,
    `- Before Snapshot: ${result.beforeFileName}`,
    `- After Snapshot: ${result.afterFileName}`,
    `- Before Created At: ${result.beforeCreatedAt}`,
    `- After Created At: ${result.afterCreatedAt}`,
    `- Verdict: ${result.evaluation.verdict}`,
    `- Improvement Rate: ${result.evaluation.improvementRate}%`,
    "",
    "## Summary Diff",
    `- BUY/HOLD/SELL: ${result.summary.buyCount.delta} / ${result.summary.holdCount.delta} / ${result.summary.sellCount.delta}`,
    `- negative EV BUY: ${result.summary.negativeEvBuyCount.delta}`,
    `- avgScore: ${result.summary.avgScore.delta}`,
    `- avgExpectedValuePercent: ${result.summary.avgExpectedValuePercent.delta}`,
    `- avgWinRate: ${result.summary.avgWinRate.delta}`,
    `- avgConfidence: ${result.summary.avgConfidence.delta}`,
    `- 95+ BUY/HOLD/SELL: ${result.summary.score95BuyCount.delta} / ${result.summary.score95HoldCount.delta} / ${result.summary.score95SellCount.delta}`,
    "",
    "## Improved Metrics",
    improvedLines,
    "",
    "## Worsened Metrics",
    worsenedLines,
    "",
    "## Critical Fails",
    criticalFailLines,
    "",
    "## Ranking Changes Top20",
    rankingLines,
  ].join("\n");
}

async function saveMarkdownReport(params: {
  timeframe: StockTimeframe;
  sortMode: Tepou30SortMode;
  beforeFileName: string;
  afterFileName: string;
  content: string;
}) {
  const { timeframe, sortMode, beforeFileName, afterFileName, content } = params;
  const beforeStem = beforeFileName.replace(/\.json$/i, "");
  const afterStem = afterFileName.replace(/\.json$/i, "");
  const fileName = `tepou30-report-${timeframe}-${sortMode}-${beforeStem}-vs-${afterStem}.md`;

  await mkdir(REPORT_DIR, { recursive: true });
  const filePath = path.join(REPORT_DIR, fileName);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

export async function runTepou30SnapshotCompareTool(params: SnapshotCompareToolParams = {}) {
  const timeframe = params.timeframe ?? "1d";
  const sortMode = params.sortMode ?? "ai-total";
  const comparison = await compareTepou30Snapshots({
    timeframe,
    sortMode,
    beforeFileName: params.beforeFileName,
    afterFileName: params.afterFileName,
  });
  const rankingLimit = clampRankingLimit(params.rankingLimit);
  const rankingChanges = comparison.items
    .filter((item) => item.rankDelta !== null && item.rankDelta !== 0)
    .sort((left, right) => Math.abs(right.rankDelta ?? 0) - Math.abs(left.rankDelta ?? 0))
    .slice(0, rankingLimit);

  const evaluation = buildEvaluation(comparison.summary);

  const result = {
    timeframe,
    sortMode,
    beforeFileName: comparison.beforeFileName,
    afterFileName: comparison.afterFileName,
    beforeCreatedAt: comparison.beforeCreatedAt,
    afterCreatedAt: comparison.afterCreatedAt,
    summary: comparison.summary,
    evaluation,
    rankingChanges,
    items: comparison.items,
    diffJson: comparison,
  };
  const evaluationJsonPath = await saveEvaluationJson({
    timeframe,
    sortMode,
    beforeFileName: comparison.beforeFileName,
    afterFileName: comparison.afterFileName,
    payload: result,
  });
  const markdownReport = buildMarkdownReport({ result });
  const markdownReportPath = await saveMarkdownReport({
    timeframe,
    sortMode,
    beforeFileName: comparison.beforeFileName,
    afterFileName: comparison.afterFileName,
    content: markdownReport,
  });

  return {
    ...result,
    evaluationJsonPath,
    markdownReport,
    markdownReportPath,
  };
}

async function main() {
  const params = parseCliArgs(process.argv.slice(2));
  const result = await runTepou30SnapshotCompareTool(params);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedAsScript = process.argv[1]?.endsWith("tepou30SnapshotCompare.js");

if (invokedAsScript) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}