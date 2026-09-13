const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const root = process.cwd();
const { loadHistoricalUniverseManifest, getHistoricalUniverseForDate } = require(path.join(
  root,
  ".test-dist",
  "lib",
  "historicalUniverse.js"
));
const { analyzeStock } = require(path.join(root, ".test-dist", "lib", "ai", "scoreCalculator.js"));

const CACHE_DIR = path.join(root, ".cache");
const OUTPUT_JSON_PATH = path.join(CACHE_DIR, "phase10_candidate_extraction_1d_oos.json");

const FOLDS = [
  { name: "Fold 1", oosStart: "2025-08-18", oosEnd: "2025-10-17" },
  { name: "Fold 2", oosStart: "2025-10-20", oosEnd: "2025-12-19" },
  { name: "Fold 3", oosStart: "2025-12-22", oosEnd: "2026-02-13" },
  { name: "Fold 4", oosStart: "2026-02-17", oosEnd: "2026-04-17" },
];

const HOLDING_DAYS_1D = 2;
const ENTRY_SCORE_FLOOR = 70;
const DATA_QUALITY_MIN_TOTAL_DAYS = 48;
const DATA_QUALITY_RECENT_WINDOW_DAYS = 20;
const DATA_QUALITY_MAX_RECENT_MISSING = 2;
const DATA_QUALITY_MAX_CONSECUTIVE_MISSING = 5;
const LIQUIDITY_MIN_AVERAGE_VA = 1000000;
const PERCENTILE_EXCLUSION_RATIO = 0.05;

function computeSha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function loadStockMap() {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => /^jpx-stock-\d+-1d\.json$/.test(f));
  const stockMap = new Map();

  for (const file of files) {
    try {
      const rawText = fs.readFileSync(path.join(CACHE_DIR, file), "utf-8");
      const json = JSON.parse(rawText.replace(/^\uFEFF/, ""));
      const stock = json.data ?? json;
      const candles = stock.chartData?.candles ?? stock.candles ?? [];
      if (stock.code && candles.length > 0) {
        stockMap.set(stock.code, {
          ...stock,
          candles: [...candles].sort((a, b) => a.time.localeCompare(b.time)),
        });
      }
    } catch {
      // ignore
    }
  }

  return stockMap;
}

function buildTradingCalendar(stockMap) {
  const datesSet = new Set();
  for (const stock of stockMap.values()) {
    for (const candle of stock.candles) {
      if (candle.time) {
        datesSet.add(candle.time.slice(0, 10));
      }
    }
  }
  return Array.from(datesSet).sort();
}

function longestFalseStreak(presence) {
  let longest = 0;
  let current = 0;
  for (const present of presence) {
    current = present ? 0 : current + 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

function evaluateQualityForStock(stock, evalDateIndex, calendar) {
  if (!stock) {
    return { status: "noCandleData" };
  }

  const startDateIndex = Math.max(0, evalDateIndex - 59);
  const windowDates = calendar.slice(startDateIndex, evalDateIndex + 1);

  const candleMap = new Map(stock.candles.map((c) => [c.time.slice(0, 10), c]));
  const presence = windowDates.map((d) => {
    const c = candleMap.get(d);
    return Boolean(c && c.volume > 0 && c.close > 0);
  });

  const totalDays = presence.filter(Boolean).length;
  if (totalDays < DATA_QUALITY_MIN_TOTAL_DAYS) {
    return { status: "insufficientTotalDays", totalDays };
  }

  const recentWindow = presence.slice(-DATA_QUALITY_RECENT_WINDOW_DAYS);
  const recentMissing = recentWindow.filter((p) => !p).length;
  if (recentMissing > DATA_QUALITY_MAX_RECENT_MISSING) {
    return { status: "insufficientRecentDays", recentMissing };
  }

  const longestGap = longestFalseStreak(presence);
  if (longestGap > DATA_QUALITY_MAX_CONSECUTIVE_MISSING) {
    return { status: "excessiveConsecutiveGap", longestGap };
  }

  return { status: "ok" };
}

function calculateAverageVa20(stock, evalDateIndex, calendar) {
  if (!stock) return null;

  const startDateIndex = Math.max(0, evalDateIndex - 19);
  const windowDates = calendar.slice(startDateIndex, evalDateIndex + 1);

  const candleMap = new Map(stock.candles.map((c) => [c.time.slice(0, 10), c]));
  const vaValues = [];

  for (const dateStr of windowDates) {
    const c = candleMap.get(dateStr);
    if (c && c.volume > 0 && c.close > 0) {
      vaValues.push(c.volume * c.close);
    }
  }

  if (vaValues.length === 0) return null;
  const averageVa = vaValues.reduce((sum, v) => sum + v, 0) / vaValues.length;
  return averageVa;
}

function buildHistoricalStock(stock, endIndex) {
  const visibleCandles = stock.candles.slice(0, endIndex + 1);
  const latest = visibleCandles[visibleCandles.length - 1];
  const previous = visibleCandles[visibleCandles.length - 2] ?? latest;

  return {
    ...stock,
    chartData: { candles: visibleCandles },
    marketData: {
      price: latest.close,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      previousClose: previous.close,
      change: latest.close - previous.close,
      changePercent: previous.close > 0 ? ((latest.close - previous.close) / previous.close) * 100 : 0,
      currency: "JPY",
      asOf: `${latest.time}T00:00:00.000Z`,
    },
    timeframe: "1d",
  };
}

function simulate1dTrade(stock, evalCandleIndex) {
  const candles = stock.candles;
  const evalCandle = candles[evalCandleIndex];
  const historicalStock = buildHistoricalStock(stock, evalCandleIndex);

  const analysis = analyzeStock({ query: stock.code, stock: historicalStock });
  if (analysis.signal !== "BUY" || analysis.score < ENTRY_SCORE_FLOOR) {
    return null;
  }

  const entryCandle = candles[evalCandleIndex + 1];
  if (!entryCandle) return null;

  const stopLoss = analysis.stopLossPrice;
  const takeProfit = analysis.takeProfitPrice;
  const exitLimitIndex = Math.min(candles.length - 1, evalCandleIndex + 1 + HOLDING_DAYS_1D);

  let exitIndex = exitLimitIndex;
  let exitPrice = candles[exitLimitIndex]?.close ?? entryCandle.close;

  for (let idx = evalCandleIndex + 1; idx <= exitLimitIndex; idx++) {
    const c = candles[idx];
    if (!c) break;
    if (c.low <= stopLoss) {
      exitIndex = idx;
      exitPrice = stopLoss;
      break;
    }
    if (c.high >= takeProfit) {
      exitIndex = idx;
      exitPrice = takeProfit;
      break;
    }
  }

  const entryPrice = entryCandle.open > 0 ? entryCandle.open : entryCandle.close;
  const returnPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;

  return {
    code: stock.code,
    evalDate: evalCandle.time,
    entryDate: entryCandle.time,
    exitDate: candles[exitIndex]?.time ?? entryCandle.time,
    score: analysis.score,
    entryPrice,
    exitPrice,
    returnPercent,
    stopLoss,
    takeProfit,
  };
}

function computeMetrics(trades) {
  if (!trades || trades.length === 0) {
    return {
      tradeCount: 0,
      winRate: 0,
      ev: 0,
      pf: 0,
      maxDD: 0,
      topShare: 0,
      hhi: 0,
    };
  }

  const returns = trades.map((t) => t.returnPercent);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0).map((r) => Math.abs(r));

  const grossProfit = wins.reduce((sum, r) => sum + r, 0);
  const grossLoss = losses.reduce((sum, r) => sum + r, 0);

  const sortedTrades = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.code.localeCompare(b.code));
  let equity = 1;
  let peak = 1;
  let maxDD = 0;

  for (const t of sortedTrades) {
    equity *= 1 + t.returnPercent / 100;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
  }

  const countsByCode = new Map();
  for (const t of trades) {
    countsByCode.set(t.code, (countsByCode.get(t.code) ?? 0) + 1);
  }

  let maxSingleCount = 0;
  let sumSqShares = 0;
  for (const count of countsByCode.values()) {
    maxSingleCount = Math.max(maxSingleCount, count);
    const share = count / trades.length;
    sumSqShares += share * share;
  }

  const topShare = (maxSingleCount / trades.length) * 100;
  const hhi = sumSqShares * 10000;

  return {
    tradeCount: trades.length,
    winRate: (wins.length / trades.length) * 100,
    ev: returns.reduce((sum, r) => sum + r, 0) / trades.length,
    pf: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    maxDD,
    topShare,
    hhi,
  };
}

async function main() {
  console.log("==================================================================");
  console.log(" 1D Candidate Extraction OOS Evaluation (Baseline -> Q -> Q+L -> Q+L+P)");
  console.log("==================================================================");

  const manifestContext = loadHistoricalUniverseManifest();
  const manifestSha256 = manifestContext.manifest.overallSha256;
  console.log(`[1/5] Historical Universe Manifest Loaded (SHA-256: ${manifestSha256})`);
  console.log(`      Evaluation Days in Manifest: ${manifestContext.manifest.totalEvalDays}`);

  const stockMap = loadStockMap();
  console.log(`[2/5] Loaded ${stockMap.size} stock candle files from .cache.`);

  const calendar = buildTradingCalendar(stockMap);
  console.log(`[3/5] Built trading calendar (${calendar[0]} to ${calendar[calendar.length - 1]}, ${calendar.length} total trading days).`);

  const conditionKeys = ["Baseline", "Q", "Q_L", "Q_L_P"];
  const tradesByConditionAndFold = {
    Baseline: { "Fold 1": [], "Fold 2": [], "Fold 3": [], "Fold 4": [], Pooled: [] },
    Q: { "Fold 1": [], "Fold 2": [], "Fold 3": [], "Fold 4": [], Pooled: [] },
    Q_L: { "Fold 1": [], "Fold 2": [], "Fold 3": [], "Fold 4": [], Pooled: [] },
    Q_L_P: { "Fold 1": [], "Fold 2": [], "Fold 3": [], "Fold 4": [], Pooled: [] },
  };

  const auditStats = {
    byFold: {},
    pooled: {
      totalEvalDays: 0,
      candidatesPerDay: { Baseline: 0, Q: 0, Q_L: 0, Q_L_P: 0 },
      exclusionsPerDay: {
        noCandleData: 0,
        insufficientTotalDays: 0,
        insufficientRecentDays: 0,
        excessiveConsecutiveGap: 0,
        insufficientAverageVa: 0,
        percentileBottom5: 0,
      },
    },
  };

  let totalEvaluatedDates = 0;
  let leakageCheckPassed = true;
  let leakageErrorDetails = "";

  console.log("[4/5] Executing 4-Fold Walk-Forward OOS Candidate Extraction Backtest...");

  for (const fold of FOLDS) {
    console.log(`\n--- Processing ${fold.name} (${fold.oosStart} to ${fold.oosEnd}) ---`);
    const foldDates = calendar.filter((d) => d >= fold.oosStart && d <= fold.oosEnd);

    const foldAudit = {
      evalDays: foldDates.length,
      candidatesPerDay: { Baseline: [], Q: [], Q_L: [], Q_L_P: [] },
      exclusions: {
        noCandleData: 0,
        insufficientTotalDays: 0,
        insufficientRecentDays: 0,
        excessiveConsecutiveGap: 0,
        insufficientAverageVa: 0,
        percentileBottom5: 0,
      },
    };

    for (let dIdx = 0; dIdx < foldDates.length; dIdx++) {
      const dateStr = foldDates[dIdx];
      const evalDateCalendarIndex = calendar.indexOf(dateStr);
      if (evalDateCalendarIndex < 0) continue;

      totalEvaluatedDates++;

      let masterRows;
      try {
        masterRows = getHistoricalUniverseForDate(manifestContext, dateStr);
      } catch (err) {
        throw new Error(`[HardFail] Historical Universe lookup failed for date ${dateStr}: ${err.message}`);
      }

      const masterCodes = masterRows.map((r) => r.code);
      foldAudit.candidatesPerDay.Baseline.push(masterCodes.length);

      const qPassedCodes = [];
      const qEvaluatedPopulation = [];

      for (const code of masterCodes) {
        const stock = stockMap.get(code);
        const qResult = evaluateQualityForStock(stock, evalDateCalendarIndex, calendar);

        if (qResult.status === "ok") {
          qPassedCodes.push(code);
          const averageVa = calculateAverageVa20(stock, evalDateCalendarIndex, calendar);
          if (averageVa !== null) {
            qEvaluatedPopulation.push({ code, averageVa });
          }
        } else {
          foldAudit.exclusions[qResult.status] = (foldAudit.exclusions[qResult.status] ?? 0) + 1;
          auditStats.pooled.exclusionsPerDay[qResult.status] = (auditStats.pooled.exclusionsPerDay[qResult.status] ?? 0) + 1;
        }
      }

      foldAudit.candidatesPerDay.Q.push(qPassedCodes.length);

      const qlPassedCodes = [];
      for (const code of qPassedCodes) {
        const stock = stockMap.get(code);
        const averageVa = calculateAverageVa20(stock, evalDateCalendarIndex, calendar);
        if (averageVa !== null && averageVa >= LIQUIDITY_MIN_AVERAGE_VA) {
          qlPassedCodes.push(code);
        } else {
          foldAudit.exclusions.insufficientAverageVa++;
          auditStats.pooled.exclusionsPerDay.insufficientAverageVa++;
        }
      }

      foldAudit.candidatesPerDay.Q_L.push(qlPassedCodes.length);

      const sortedPop = [...qEvaluatedPopulation].sort(
        (a, b) => a.averageVa - b.averageVa || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
      );
      const cutoffCount = Math.floor(sortedPop.length * PERCENTILE_EXCLUSION_RATIO);
      const pExcludedSet = new Set(sortedPop.slice(0, cutoffCount).map((item) => item.code));

      foldAudit.exclusions.percentileBottom5 += cutoffCount;
      auditStats.pooled.exclusionsPerDay.percentileBottom5 += cutoffCount;

      const qlpPassedCodes = qlPassedCodes.filter((code) => !pExcludedSet.has(code));
      foldAudit.candidatesPerDay.Q_L_P.push(qlpPassedCodes.length);

      const baselineSet = new Set(masterCodes);
      const qSet = new Set(qPassedCodes);
      const qlSet = new Set(qlPassedCodes);
      const qlpSet = new Set(qlpPassedCodes);

      for (const code of baselineSet) {
        const stock = stockMap.get(code);
        if (!stock) continue;

        const evalCandleIndex = stock.candles.findIndex((c) => c.time.slice(0, 10) === dateStr);
        if (evalCandleIndex < 0) continue;

        const trade = simulate1dTrade(stock, evalCandleIndex);
        if (trade) {
          if (trade.entryDate <= dateStr) {
            leakageCheckPassed = false;
            leakageErrorDetails += `Look-ahead leakage detected: trade entryDate ${trade.entryDate} <= evalDate ${dateStr} for ${code}\n`;
          }

          if (baselineSet.has(code)) {
            tradesByConditionAndFold.Baseline[fold.name].push(trade);
            tradesByConditionAndFold.Baseline.Pooled.push(trade);
          }
          if (qSet.has(code)) {
            tradesByConditionAndFold.Q[fold.name].push(trade);
            tradesByConditionAndFold.Q.Pooled.push(trade);
          }
          if (qlSet.has(code)) {
            tradesByConditionAndFold.Q_L[fold.name].push(trade);
            tradesByConditionAndFold.Q_L.Pooled.push(trade);
          }
          if (qlpSet.has(code)) {
            tradesByConditionAndFold.Q_L_P[fold.name].push(trade);
            tradesByConditionAndFold.Q_L_P.Pooled.push(trade);
          }
        }
      }
    }

    auditStats.byFold[fold.name] = foldAudit;
  }

  console.log("\n[5/5] Calculating Metrics and Assembly Summary...");

  if (!leakageCheckPassed) {
    throw new Error(`[HardFail] Leakage check failed!\n${leakageErrorDetails}`);
  }

  const results = {};
  for (const condKey of conditionKeys) {
    results[condKey] = {};
    for (const foldName of ["Fold 1", "Fold 2", "Fold 3", "Fold 4", "Pooled"]) {
      const trades = tradesByConditionAndFold[condKey][foldName];
      results[condKey][foldName] = computeMetrics(trades);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    manifestSha256,
    totalEvaluatedDates,
    leakageCheckPassed,
    results,
    auditStats,
  };

  fs.writeFileSync(OUTPUT_JSON_PATH, JSON.stringify(summary, null, 2), "utf-8");

  console.log("\n==================================================================");
  console.log(" POOLED OOS SUMMARY (2025-08-18 to 2026-04-17)");
  console.log("==================================================================");
  console.log(
    "Condition".padEnd(12) +
      " | " +
      "Trades".padStart(8) +
      " | " +
      "WinRate (%)".padStart(11) +
      " | " +
      "EV (%)".padStart(10) +
      " | " +
      "PF".padStart(8) +
      " | " +
      "MaxDD (%)".padStart(10) +
      " | " +
      "TopShare (%)".padStart(12) +
      " | " +
      "HHI".padStart(8)
  );
  console.log("---------------------------------------------------------------------------------------------------");

  for (const condKey of conditionKeys) {
    const m = results[condKey].Pooled;
    console.log(
      condKey.padEnd(12) +
        " | " +
        String(m.tradeCount).padStart(8) +
        " | " +
        m.winRate.toFixed(2).padStart(11) +
        " | " +
        m.ev.toFixed(3).padStart(10) +
        " | " +
        m.pf.toFixed(3).padStart(8) +
        " | " +
        m.maxDD.toFixed(2).padStart(10) +
        " | " +
        m.topShare.toFixed(2).padStart(12) +
        " | " +
        m.hhi.toFixed(1).padStart(8)
    );
  }

  console.log("==================================================================");
  console.log(`Detailed JSON output saved to: ${OUTPUT_JSON_PATH}`);
  console.log("==================================================================");
}

main().catch((err) => {
  console.error("\nFATAL ERROR:");
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
