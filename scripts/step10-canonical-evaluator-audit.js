const fs = require("node:fs");
const path = require("node:path");

const CACHE_DIR = path.join(process.cwd(), ".cache");
const OUT_PATH = path.join(CACHE_DIR, "step10-canonical-evaluator-audit.json");
const OOS_2M_PATH = path.join(CACHE_DIR, "ai-precision-eval-oos-2m.json");
const SAMPLE_PATH = path.join(CACHE_DIR, "ai-precision-eval.json");
const WALK_FORWARD_PATH = path.join(CACHE_DIR, "ai-precision-eval-walk-forward-4fold.json");
const TIMEFRAMES = ["5m", "15m"];

function parseJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return parseJson(filePath);
  } catch {
    return null;
  }
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function computeCorrectCount(tradeCount, winRate) {
  return Math.round((tradeCount * winRate) / 100);
}

function stockFileRegex(timeframe) {
  return new RegExp(`^jpx-stock-(\\d+)-${timeframe.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\.json$`);
}

function normalizeDate(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function hasIntradayTime(value) {
  if (typeof value !== "string") {
    return false;
  }

  return /T\d{2}:\d{2}/.test(value) || /^\d{4}-\d{2}-\d{2}[\s_]\d{2}:\d{2}/.test(value);
}

function isCanonicalMinuteCandle(candle, timeframe) {
  if (!candle || typeof candle !== "object") {
    return false;
  }

  const expected = timeframe === "5m" ? 5 : 15;
  const origin = candle.origin;
  return typeof candle.time === "string"
    && hasIntradayTime(candle.time)
    && typeof candle.barStartAt === "string"
    && typeof candle.barEndAt === "string"
    && typeof candle.observedAt === "string"
    && typeof candle.receivedAt === "string"
    && typeof candle.granularityMinutes === "number"
    && candle.granularityMinutes === expected
    && origin && typeof origin === "object"
    && origin.kind === "canonical"
    && origin.feed === "jquants-minute";
}

function readManifestDataStatus() {
  const manifestPath = path.join(CACHE_DIR, "jpx-refresh-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const manifest = parseJson(manifestPath);
  const byTf = manifest.byTimeframe ?? {};
  const status = {};

  for (const tf of TIMEFRAMES) {
    const codes = byTf[tf]?.codes ?? {};
    let real = 0;
    let nonReal = 0;

    for (const row of Object.values(codes)) {
      if (row && row.dataStatus === "real") {
        real += 1;
      } else {
        nonReal += 1;
      }
    }

    status[tf] = { real, nonReal, total: real + nonReal };
  }

  return status;
}

function inspectTimeframe(timeframe) {
  const files = fs.readdirSync(CACHE_DIR).filter((name) => stockFileRegex(timeframe).test(name));
  const symbols = new Set();
  let minDate = null;
  let maxDate = null;

  let intradayTimeCount = 0;
  let legacyDateOnlyCount = 0;
  let receivedAtCount = 0;
  let observedAtCount = 0;
  let barStartAtCount = 0;
  let barEndAtCount = 0;
  let futureLeakageCount = 0;
  let granularityMismatchCount = 0;
  let canonicalCandleCount = 0;
  let legacyExcludedCount = 0;
  let sampleCandleKeys = [];

  for (const file of files) {
    const payload = parseJson(path.join(CACHE_DIR, file));
    const stock = payload?.data ?? payload;
    if (!stock?.code) {
      continue;
    }

    symbols.add(String(stock.code));
    const candles = Array.isArray(stock?.chartData?.candles) ? stock.chartData.candles : [];

    for (const candle of candles) {
      if (!isCanonicalMinuteCandle(candle, timeframe)) {
        legacyExcludedCount += 1;
        if (typeof candle?.time === "string") {
          legacyDateOnlyCount += hasIntradayTime(candle.time) ? 0 : 1;
        }
        continue;
      }

      canonicalCandleCount += 1;
      const time = candle?.time;
      const date = normalizeDate(time);

      if (date) {
        if (!minDate || date < minDate) {
          minDate = date;
        }
        if (!maxDate || date > maxDate) {
          maxDate = date;
        }
      }

      if (hasIntradayTime(time)) {
        intradayTimeCount += 1;
      }

      if (typeof candle?.receivedAt === "string") {
        receivedAtCount += 1;
      }
      if (typeof candle?.observedAt === "string") {
        observedAtCount += 1;
      }
      if (typeof candle?.barStartAt === "string") {
        barStartAtCount += 1;
      }
      if (typeof candle?.barEndAt === "string") {
        barEndAtCount += 1;
      }

      if (typeof candle?.granularityMinutes === "number") {
        const expected = timeframe === "5m" ? 5 : 15;
        if (candle.granularityMinutes !== expected) {
          granularityMismatchCount += 1;
        }
      } else {
        granularityMismatchCount += 1;
      }

      if (typeof candle?.barEndAt === "string" && typeof candle?.observedAt === "string") {
        if (candle.barEndAt > candle.observedAt) {
          futureLeakageCount += 1;
        }
      }

      if (typeof candle?.receivedAt === "string" && typeof candle?.observedAt === "string") {
        if (candle.receivedAt > candle.observedAt) {
          futureLeakageCount += 1;
        }
      }

      if (sampleCandleKeys.length < 1) {
        sampleCandleKeys = Object.keys(candle ?? {}).sort();
      }
    }
  }

  const realTimelineAvailable =
    canonicalCandleCount > 0
    && intradayTimeCount > 0
    && barStartAtCount > 0
    && barEndAtCount > 0
    && receivedAtCount > 0
    && observedAtCount > 0
    && futureLeakageCount === 0
    && granularityMismatchCount === 0;

  return {
    timeframe,
    fileCount: files.length,
    symbolCount: symbols.size,
    period: { from: minDate, to: maxDate },
    datetimeFieldInspection: {
        canonicalCandleCount,
        legacyExcludedCount,
      intradayTimeCount,
        legacyDateOnlyCount,
      barStartAtCount,
      barEndAtCount,
      observedAtCount,
      receivedAtCount,
        futureLeakageCount,
        granularityMismatchCount,
      sampleCandleKeys,
    },
    realTimelineAvailable,
    reasonIfUnavailable: realTimelineAvailable
      ? null
      : "cache candles do not contain full real intraday datetime fields required by canonical evaluator",
  };
}

function inspectJquantsBars() {
  const dir = path.join(CACHE_DIR, "jquants-bars");
  if (!fs.existsSync(dir)) {
    return {
      exists: false,
      period: null,
      intradayDateTimePresent: false,
      sampleKeys: [],
    };
  }

  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  let minDate = null;
  let maxDate = null;
  let intradayDateTimePresent = false;
  let sampleKeys = [];

  for (const file of files) {
    const json = parseJson(path.join(dir, file));
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      const date = normalizeDate(row?.Date);
      if (date) {
        if (!minDate || date < minDate) {
          minDate = date;
        }
        if (!maxDate || date > maxDate) {
          maxDate = date;
        }
      }

      if (hasIntradayTime(row?.Date)) {
        intradayDateTimePresent = true;
      }

      if (sampleKeys.length < 1) {
        sampleKeys = Object.keys(row ?? {}).sort();
      }
    }
  }

  return {
    exists: true,
    period: { from: minDate, to: maxDate },
    intradayDateTimePresent,
    sampleKeys,
  };
}

function summarizePrecisionEval() {
  const sample = readOptionalJson(SAMPLE_PATH);
  const fixedOos = readOptionalJson(OOS_2M_PATH);
  const walkForward = readOptionalJson(WALK_FORWARD_PATH);

  const perTimeframe = {};
  for (const timeframe of TIMEFRAMES) {
    const samplePeriod = sample?.samples?.perTimeframe?.[timeframe]?.period ?? null;
    const fixed = fixedOos?.perTimeframe?.[timeframe] ?? null;
    const folds = walkForward?.perTimeframe?.[timeframe]?.folds ?? [];
    const latestFold = Array.isArray(folds) && folds.length > 0 ? folds[folds.length - 1] : null;

    perTimeframe[timeframe] = {
      dataPeriod: samplePeriod,
      trainingCandidatePeriod: latestFold?.trainWindow ?? fixed?.trainWindow ?? null,
      validationCandidatePeriod: latestFold?.oosWindow ?? fixed?.oosWindow ?? null,
      fixedOos2mPeriod: fixed?.oosWindow ?? null,
      evaluatedCount: fixed?.tradeCount ?? null,
      correct: fixed ? computeCorrectCount(fixed.tradeCount, fixed.winRate) : null,
      incorrect: fixed ? fixed.tradeCount - computeCorrectCount(fixed.tradeCount, fixed.winRate) : null,
      accuracy: fixed ? round(fixed.winRate, 4) : null,
      winRate: fixed ? round(fixed.winRate, 4) : null,
    };
  }

  return perTimeframe;
}

function main() {
  const manifestStatus = readManifestDataStatus();
  const tf5 = inspectTimeframe("5m");
  const tf15 = inspectTimeframe("15m");
  const jquantsBars = inspectJquantsBars();
  const precisionEval = summarizePrecisionEval();

  const realTimelineReady = tf5.realTimelineAvailable && tf15.realTimelineAvailable;

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "step10-real-timeline-only-audit",
    constraints: {
      measurementOnly: true,
      noAiScoreOptimization: true,
      noWeightsOptimization: true,
      noThresholdOptimization: true,
      noLearningProfileUpdate: true,
      noOptimizer: true,
      noFeatureSelection: true,
      noBrokerOrder: true,
      noBrokerCancel: true,
      noExternalApiCall: true,
      noSyntheticTimeMapping: true,
    },
    dataSources: {
      stockCachesPattern: "jpx-stock-<code>-5m.json / jpx-stock-<code>-15m.json",
      manifestPath: path.join(CACHE_DIR, "jpx-refresh-manifest.json"),
      jquantsBarsPath: path.join(CACHE_DIR, "jquants-bars"),
      manifestRealStatus: manifestStatus,
      jquantsBars,
    },
    precisionEval,
    inspection: {
      "5m": tf5,
      "15m": tf15,
    },
    evaluation: realTimelineReady
      ? {
          status: "ready",
          note: "real intraday datetime fields are available; canonical evaluator may run with real timeline",
        }
      : {
          status: "blocked",
          reason: "real intraday datetime fields are insufficient in cache/jquants-bars data",
          note: "accuracy/win-rate must not be computed or reused",
        },
    metrics: realTimelineReady
      ? {
          "5m": "not executed in this script",
          "15m": "not executed in this script",
        }
      : {
          "5m": {
            prediction: "取得不能",
            evaluable: "取得不能",
            unevaluable: "取得不能",
            correct: "取得不能",
            incorrect: "取得不能",
            accuracy: "取得不能",
          },
          "15m": {
            prediction: "取得不能",
            evaluable: "取得不能",
            unevaluable: "取得不能",
            correct: "取得不能",
            incorrect: "取得不能",
            accuracy: "取得不能",
          },
        },
    finalDecision: realTimelineReady ? "PASS" : "FAIL",
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`Step10 audit report written: ${OUT_PATH}`);
  console.log(JSON.stringify({
    realTimelineReady,
    inspection5m: tf5.datetimeFieldInspection,
    inspection15m: tf15.datetimeFieldInspection,
    decision: report.finalDecision,
  }, null, 2));
}

main();
