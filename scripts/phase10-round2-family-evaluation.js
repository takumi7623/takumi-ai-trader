const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const phase10 = require(path.join(process.cwd(), ".test-dist", "lib", "phase10", "nestedCandidateEvaluation.js"));
const round2 = require(path.join(process.cwd(), ".test-dist", "lib", "phase10", "round2FamilyEvaluation.js"));
const { analyzeStock } = require(path.join(process.cwd(), ".test-dist", "lib", "ai", "scoreCalculator.js"));

const INVENTORY_DIR = path.join(process.cwd(), ".cache", "phase9-74-inventory");
const BASELINE_LEDGER_PATH = path.join(process.cwd(), ".cache", "unified-baseline-core39-trade-ledger-new-baseline.json");
const UNIVERSE_PRESET_PATH = path.join(process.cwd(), "scripts", "universe-presets.json");
const FOLD_META_PATH = path.join(process.cwd(), ".cache", "feature_inventory_1d_ablation_meta.json");
const WEIGHTS_PATH = path.join(process.cwd(), ".cache", "weights.json");
const SCORE_CALCULATOR_PATH = path.join(process.cwd(), ".test-dist", "lib", "ai", "scoreCalculator.js");

const REPLAY_IMPLEMENTATION_VERSION = "phase10-round2-baseline-replay-v1";
const SOURCE_START = "2025-04-18";
const SOURCE_END = "2026-08-07";
const FINAL_OOS_START = "2026-06-01";
const FINAL_OOS_END = "2026-08-07";
const ENTRY_SCORE_FLOOR = 70;
const HORIZON = 10;
const MAX_HOLDING_DAYS = 10;

const round1MaxTrainEnd = phase10.PHASE10_OUTER_FOLDS[phase10.PHASE10_OUTER_FOLDS.length - 1].trainEnd;
const summaryOnly = process.argv.includes("--summary");
const candidatesOnly = process.argv.includes("--candidates");

const FEATURE_EXTRACTORS = {
  normalizedMacdHistogram: (row) => (Number(row.latestMacdHistogram) / row.decisionClose) * 100,
  relativeLow52Distance: (row) => (Number(row.low52) - row.decisionClose) / row.decisionClose,
  bollingerPricePosition: (row) => Number(row.pricePosition),
  sma5Slope: (row) => Number(row.ma5Slope),
  midTrendReturn: (row) => Number(row.midTrendPercent),
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashFile(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function toDay(value) {
  return String(value || "").slice(0, 10);
}

function inRange(day, start, end) {
  return day >= start && day <= end;
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(12)) : value;
}

function loadCsv(fileName) {
  const lines = fs.readFileSync(path.join(INVENTORY_DIR, fileName), "utf8").trim().split("\n");
  const header = lines[0].replace(/^\uFEFF/, "").split(",");
  return lines.slice(1).map((line) => {
    const values = line.replace(/\r$/, "").split(",");
    return Object.fromEntries(header.map((column, index) => [column, values[index]]));
  });
}

function loadInventoryRows() {
  const groupA = loadCsv("feature_inventory_1d_base_rows.csv");
  const groupB = loadCsv("feature_inventory_1d_base_rows_volume_breakout.csv");
  const rows = groupA.map((row, index) => ({ ...row, ...groupB[index], return10d: Number(row.return10d) }));
  const decisionCloseByKey = loadDecisionCloseMap(rows);
  return rows.map((row) => ({
    ...row,
    decisionClose: decisionCloseByKey.get(`${row.code}_${row.signalDate}`),
  })).filter((row) => Number.isFinite(row.decisionClose) && row.signalDate <= round1MaxTrainEnd);
}

function loadDecisionCloseMap(rows) {
  const byKey = new Map();
  for (const code of new Set(rows.map((row) => row.code))) {
    const snapshot = readJson(path.join(process.cwd(), ".cache", `jpx-stock-${code}-1d.json`));
    const candles = snapshot.chartData?.candles ?? snapshot.data?.chartData?.candles ?? [];
    for (let index = 1; index < candles.length; index += 1) {
      byKey.set(`${code}_${toDay(candles[index].time)}`, Number(candles[index - 1].close));
    }
  }
  return byKey;
}

function loadUniverseCandles(codes) {
  const result = [];
  for (const code of codes) {
    const filePath = path.join(process.cwd(), ".cache", `jpx-stock-${code}-1d.json`);
    if (!fs.existsSync(filePath)) continue;
    const payload = readJson(filePath);
    const candles = payload.chartData?.candles ?? payload.data?.chartData?.candles ?? [];
    const filtered = candles.filter((candle) => candle?.time && inRange(toDay(candle.time), SOURCE_START, SOURCE_END));
    if (!filtered.length) continue;

    result.push({
      code,
      baseStock: {
        code,
        name: payload.name || payload.data?.name || code,
        sector: payload.sector || payload.data?.sector || "",
        baselineTrend: payload.baselineTrend || payload.data?.baselineTrend || "neutral",
        timeframe: "1d",
        marketData: {
          price: filtered[filtered.length - 1]?.close ?? 0,
          open: filtered[filtered.length - 1]?.open ?? null,
          high: filtered[filtered.length - 1]?.high ?? null,
          low: filtered[filtered.length - 1]?.low ?? null,
          previousClose: filtered[filtered.length - 2]?.close ?? null,
          currency: "JPY",
        },
      },
      candles: filtered,
      filePath,
    });
  }
  return result;
}

function buildHistoricalStock(baseStock, candles, entryIndex) {
  const visibleCandles = candles.slice(0, entryIndex + 1);
  const latest = visibleCandles[visibleCandles.length - 1];
  const previous = visibleCandles[visibleCandles.length - 2];
  return {
    ...baseStock,
    chartData: { candles: visibleCandles },
    marketData: {
      price: latest?.close ?? baseStock.marketData?.price ?? 0,
      open: latest?.open ?? baseStock.marketData?.open ?? null,
      high: latest?.high ?? baseStock.marketData?.high ?? null,
      low: latest?.low ?? baseStock.marketData?.low ?? null,
      previousClose: previous?.close ?? baseStock.marketData?.previousClose ?? null,
      change: latest && previous ? latest.close - previous.close : baseStock.marketData?.change ?? null,
      changePercent: latest && previous && previous.close > 0
        ? ((latest.close - previous.close) / previous.close) * 100
        : baseStock.marketData?.changePercent ?? null,
      currency: baseStock.marketData?.currency ?? "JPY",
      asOf: latest?.time ?? baseStock.marketData?.asOf ?? null,
    },
    timeframe: baseStock.timeframe ?? "1d",
  };
}

function buildBaselineReplayCandidates(universeData) {
  const rows = [];
  for (const item of universeData) {
    const { code, baseStock, candles } = item;
    for (let entryIndex = 60; entryIndex < candles.length - 1; entryIndex += 1) {
      const signalDate = toDay(candles[entryIndex + 1]?.time);
      if (!signalDate || inRange(signalDate, FINAL_OOS_START, FINAL_OOS_END)) continue;

      const stockAtDecision = buildHistoricalStock(baseStock, candles, entryIndex);
      const analysis = analyzeStock({ query: code, stock: stockAtDecision });
      if (!analysis || analysis.signal !== "BUY" || Number(analysis.score) < ENTRY_SCORE_FLOOR) continue;

      rows.push({
        code,
        signalDate,
        entryIndex,
        baselineScore: Number(analysis.score),
        baselineSignal: analysis.signal,
        stopLossPrice: Number(analysis.stopLossPrice),
        takeProfitPrice: Number(analysis.takeProfitPrice),
      });
    }
  }
  return rows;
}

function simulateCandidateTrade(codeDataMap, candidate) {
  const item = codeDataMap.get(candidate.code);
  if (!item) return null;
  const candles = item.candles;
  const entryCandle = candles[candidate.entryIndex + 1];
  if (!entryCandle) return null;

  const exitLimitIndex = Math.min(candles.length - 1, candidate.entryIndex + Math.min(HORIZON, MAX_HOLDING_DAYS));
  let exitIndex = exitLimitIndex;
  let exitPrice = candles[exitLimitIndex]?.close ?? entryCandle.close;
  let exitReason = "time-expiry";

  for (let index = candidate.entryIndex + 1; index <= exitLimitIndex; index += 1) {
    const candle = candles[index];
    if (!candle) break;
    if (candle.low <= candidate.stopLossPrice) {
      exitIndex = index;
      exitPrice = candidate.stopLossPrice;
      exitReason = "stop-loss";
      break;
    }
    if (candle.high >= candidate.takeProfitPrice) {
      exitIndex = index;
      exitPrice = candidate.takeProfitPrice;
      exitReason = "take-profit";
      break;
    }
  }

  const entryPrice = entryCandle.open > 0 ? entryCandle.open : entryCandle.close;
  return {
    entryDate: toDay(entryCandle.time),
    exitDate: toDay(candles[exitIndex]?.time ?? entryCandle.time),
    exitReason,
    returnPercent: entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0,
    horizonEffective: Math.min(HORIZON, MAX_HOLDING_DAYS),
  };
}

function buildReplayLedger(candidates, codeDataMap, folds) {
  const rows = [];
  for (const fold of folds) {
    for (const candidate of candidates) {
      if (!inRange(candidate.signalDate, fold.testStart, fold.testEnd)) continue;
      const trade = simulateCandidateTrade(codeDataMap, candidate);
      if (!trade) continue;
      rows.push({
        horizon: HORIZON,
        fold: fold.name,
        ticker: candidate.code,
        signal_date: candidate.signalDate,
        entry_date: trade.entryDate,
        exit_date: trade.exitDate,
        exit_reason: trade.exitReason,
        return_percent: trade.returnPercent,
        horizon_effective: trade.horizonEffective,
        entry_index: candidate.entryIndex,
      });
    }
  }
  return rows.sort(compareLedgerRowsByIdentity);
}

function ledgerIdentity(row) {
  return [row.horizon, row.fold, row.ticker, row.signal_date, row.entry_date, row.entry_index].join("|");
}

function compareLedgerRowsByIdentity(left, right) {
  return ledgerIdentity(left).localeCompare(ledgerIdentity(right));
}

function summarizeLedgerRows(rows) {
  return phase10.summarizeTradeRows(rows.map((row) => ({
    code: row.ticker,
    signalDate: row.signal_date,
    return10d: row.return_percent,
    featureValue: 0,
  })));
}

function compareReplayLedger(replayRows, existingRows) {
  const mismatches = [];
  if (replayRows.length !== existingRows.length) {
    mismatches.push({ type: "rowCount", replay: replayRows.length, existing: existingRows.length });
  }

  const replayByKey = new Map(replayRows.map((row) => [ledgerIdentity(row), row]));
  const existingByKey = new Map(existingRows.map((row) => [ledgerIdentity(row), row]));
  for (const key of replayByKey.keys()) {
    if (!existingByKey.has(key)) mismatches.push({ type: "missingExisting", key });
  }
  for (const key of existingByKey.keys()) {
    if (!replayByKey.has(key)) mismatches.push({ type: "missingReplay", key });
  }

  for (const [key, replay] of replayByKey.entries()) {
    const existing = existingByKey.get(key);
    if (!existing) continue;
    const fields = ["exit_date", "exit_reason", "horizon_effective"];
    for (const field of fields) {
      if (replay[field] !== existing[field]) mismatches.push({ type: "field", key, field, replay: replay[field], existing: existing[field] });
    }
    if (Math.abs(replay.return_percent - existing.return_percent) > 1e-10) {
      mismatches.push({ type: "field", key, field: "return_percent", replay: replay.return_percent, existing: existing.return_percent });
    }
  }

  return {
    passed: mismatches.length === 0,
    mismatchCount: mismatches.length,
    firstMismatches: mismatches.slice(0, 20),
    replayMetrics: summarizeLedgerRows(replayRows),
    existingMetrics: summarizeLedgerRows(existingRows),
  };
}

function collectInputCacheHashes(universeData) {
  const files = universeData.map((item) => item.filePath).sort();
  const fileHashes = files.map((filePath) => ({
    file: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
    sha256: hashFile(filePath),
  }));
  return {
    count: fileHashes.length,
    combinedSha256: sha256Buffer(Buffer.from(fileHashes.map((item) => `${item.file}:${item.sha256}`).join("\n"))),
  };
}

function gate0Environment(universeData) {
  const inventoryFiles = [
    path.join(INVENTORY_DIR, "feature_inventory_1d_base_rows.csv"),
    path.join(INVENTORY_DIR, "feature_inventory_1d_base_rows_volume_breakout.csv"),
    path.join(INVENTORY_DIR, "feature_inventory_1d_base_rows_context_news.csv"),
  ];
  return {
    passed: true,
    replayImplementationVersion: REPLAY_IMPLEMENTATION_VERSION,
    replayImplementationSha256: hashFile(__filename),
    scoreCalculatorSha256: hashFile(SCORE_CALCULATOR_PATH),
    weightsJsonSha256: fs.existsSync(WEIGHTS_PATH) ? hashFile(WEIGHTS_PATH) : null,
    universePresetSha256: hashFile(UNIVERSE_PRESET_PATH),
    foldMetaSha256: hashFile(FOLD_META_PATH),
    inputCache: collectInputCacheHashes(universeData),
    inventorySha256: inventoryFiles.map((filePath) => ({
      file: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
      sha256: hashFile(filePath),
    })),
  };
}

function buildRound2Rows(inventoryRows, replayCandidates) {
  const replayBySignal = new Map(replayCandidates.map((row) => [`${row.code}_${row.signalDate}`, row]));
  return inventoryRows.map((row) => {
    const replay = replayBySignal.get(`${row.code}_${row.signalDate}`);
    if (!replay) return null;
    return {
      code: row.code,
      signalDate: row.signalDate,
      return10d: row.return10d,
      featureValue: 0,
      baselineScore: replay.baselineScore,
      features: {
        normalizedMacdHistogram: FEATURE_EXTRACTORS.normalizedMacdHistogram(row),
        relativeLow52Distance: FEATURE_EXTRACTORS.relativeLow52Distance(row),
        bollingerPricePosition: FEATURE_EXTRACTORS.bollingerPricePosition(row),
        sma5Slope: FEATURE_EXTRACTORS.sma5Slope(row),
        midTrendReturn: FEATURE_EXTRACTORS.midTrendReturn(row),
      },
    };
  }).filter(Boolean);
}

const presets = readJson(UNIVERSE_PRESET_PATH);
const meta = readJson(FOLD_META_PATH);
const universeData = loadUniverseCandles((presets.core39 || []).map(String));
const codeDataMap = new Map(universeData.map((item) => [item.code, item]));
const gate0 = gate0Environment(universeData);
const replayCandidates = buildBaselineReplayCandidates(universeData);
const replayLedger = buildReplayLedger(replayCandidates, codeDataMap, meta.settings.walkForwardFolds || []);
const existingLedger = readJson(BASELINE_LEDGER_PATH).rows
  .filter((row) => row.horizon === HORIZON)
  .map((row) => ({ ...row, return_percent: Number(row.return_percent) }))
  .sort(compareLedgerRowsByIdentity);
const gate1 = compareReplayLedger(replayLedger, existingLedger);
const inventoryRows = loadInventoryRows();
const round2Rows = buildRound2Rows(inventoryRows, replayCandidates);
const gate2 = gate1.passed ? round2.gate2Round2CoefficientZero(round2Rows) : {
  passed: false,
  skipped: true,
  reason: "Gate1 failed; Round2 coefficient search must not run.",
};
const coefficientPairs = round2.buildRound2CoefficientPairs();
const searchResult = gate1.passed && gate2.passed
  ? round2.searchRound2CoefficientPairs(round2Rows)
  : {
    coefficientSearchExecuted: false,
    skipped: true,
    reason: "Gate0-Gate2 did not pass; Round2 coefficient search was not executed.",
  };

const output = {
  stage: "round2-step3-fixed-grid-search",
  gates: { gate0, gate1, gate2 },
  coefficientGrid: {
    kMomentum: round2.ROUND2_COEFFICIENT_GRID,
    kPosition: round2.ROUND2_COEFFICIENT_GRID,
    pairCount: coefficientPairs.length,
    includesNoChangeReference: coefficientPairs.some((pair) => pair.kMomentum === 0 && pair.kPosition === 0),
  },
  rowCount: inventoryRows.length,
  round2RowCount: round2Rows.length,
  maxSignalDate: inventoryRows.reduce((max, row) => row.signalDate > max ? row.signalDate : max, ""),
  round1MaxTrainEnd,
  searchResult,
};

function priorityDecision(previous, current) {
  const comparisons = [
    ["pooledDeltaEV", previous.pooledDeltas.ev, current.pooledDeltas.ev, "descending"],
    ["pooledDeltaPF", previous.pooledDeltas.pf, current.pooledDeltas.pf, "descending"],
    ["pooledDeltaMaxDD", previous.pooledDeltas.maxDD, current.pooledDeltas.maxDD, "ascending"],
    ["pooledDeltaWinRate", previous.pooledDeltas.winRate, current.pooledDeltas.winRate, "descending"],
    ["tradeCountDistanceFrom1", Math.abs(previous.pooledDeltas.tradeCountRatio - 1), Math.abs(current.pooledDeltas.tradeCountRatio - 1), "ascending"],
    ["coefficientNorm", Math.abs(previous.coefficientPair.kMomentum) + Math.abs(previous.coefficientPair.kPosition), Math.abs(current.coefficientPair.kMomentum) + Math.abs(current.coefficientPair.kPosition), "ascending"],
  ];
  for (const [rule, previousValue, currentValue] of comparisons) {
    if (previousValue !== currentValue) return { rule, previousValue, currentValue };
  }
  const previousNoChange = previous.coefficientPair.kMomentum === 0 && previous.coefficientPair.kPosition === 0;
  const currentNoChange = current.coefficientPair.kMomentum === 0 && current.coefficientPair.kPosition === 0;
  if (previousNoChange !== currentNoChange) return { rule: "noChangeReference", previousValue: previousNoChange, currentValue: currentNoChange };
  return { rule: "lexicalOrder", previousValue: [previous.coefficientPair.kMomentum, previous.coefficientPair.kPosition], currentValue: [current.coefficientPair.kMomentum, current.coefficientPair.kPosition] };
}

function candidateAudit(search) {
  if (!search.coefficientSearchExecuted) return search;
  return {
    coefficientSearchExecuted: true,
    coefficientPairCount: search.coefficientPairCount,
    evaluatedPairCount: search.evaluatedPairCount,
    passingPairCount: search.passingPairCount,
    selectedCoefficientPair: search.selected?.coefficientPair ?? null,
    passingCandidates: search.passingEvaluations.map((evaluation, index, list) => ({
      rank: index + 1,
      coefficientPair: evaluation.coefficientPair,
      pooledDeltas: {
        ev: evaluation.pooledDeltas.ev,
        pf: evaluation.pooledDeltas.pf,
        maxDD: evaluation.pooledDeltas.maxDD,
        winRate: evaluation.pooledDeltas.winRate,
        tradeCountRatio: evaluation.pooledDeltas.tradeCountRatio,
      },
      tieBreakFromPrevious: index === 0 ? null : priorityDecision(list[index - 1], evaluation),
    })),
  };
}

const summary = {
  stage: output.stage,
  gate0Passed: gate0.passed,
  gate1Passed: gate1.passed,
  gate1MismatchCount: gate1.mismatchCount,
  gate2,
  coefficientGrid: output.coefficientGrid,
  rowCount: output.rowCount,
  round2RowCount: output.round2RowCount,
  maxSignalDate: output.maxSignalDate,
  round1MaxTrainEnd: output.round1MaxTrainEnd,
  searchResult: searchResult.coefficientSearchExecuted ? {
    coefficientSearchExecuted: true,
    coefficientPairCount: searchResult.coefficientPairCount,
    evaluatedPairCount: searchResult.evaluatedPairCount,
    passingPairCount: searchResult.passingPairCount,
    noChangeReference: {
      coefficientPair: searchResult.noChangeReference.coefficientPair,
      pooledDeltas: searchResult.noChangeReference.pooledDeltas,
      pooledBaselineMetrics: searchResult.noChangeReference.pooledBaselineMetrics,
      pooledCandidateMetrics: searchResult.noChangeReference.pooledCandidateMetrics,
      andConditions: searchResult.noChangeReference.andConditions,
    },
    selected: searchResult.selected ? {
      coefficientPair: searchResult.selected.coefficientPair,
      pooledDeltas: searchResult.selected.pooledDeltas,
      pooledBaselineMetrics: searchResult.selected.pooledBaselineMetrics,
      pooledCandidateMetrics: searchResult.selected.pooledCandidateMetrics,
      andConditions: searchResult.selected.andConditions,
      foldDeltas: searchResult.selected.folds.map((fold) => ({
        foldName: fold.foldName,
        deltas: fold.deltas,
        baselineTradeCount: fold.baselineMetrics.tradeCount,
        candidateTradeCount: fold.candidateMetrics.tradeCount,
        familyFallback: fold.fit.familyFallback,
      })),
    } : null,
    diagnosticsBest: {
      coefficientPair: searchResult.diagnosticsBest.coefficientPair,
      passed: searchResult.diagnosticsBest.passed,
      pooledDeltas: searchResult.diagnosticsBest.pooledDeltas,
    },
  } : searchResult,
};

console.log(JSON.stringify(candidatesOnly ? candidateAudit(searchResult) : summaryOnly ? summary : output, (key, value) => typeof value === "number" ? formatNumber(value) : value, 2));