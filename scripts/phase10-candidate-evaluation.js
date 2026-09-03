const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const core = require(path.join(process.cwd(), ".test-dist", "lib", "phase10", "nestedCandidateEvaluation.js"));
const { analyzeStock } = require(path.join(process.cwd(), ".test-dist", "lib", "ai", "scoreCalculator.js"));

const INVENTORY_DIR = path.join(process.cwd(), ".cache", "phase9-74-inventory");
const BASELINE_LEDGER_PATH = path.join(process.cwd(), ".cache", "unified-baseline-core39-trade-ledger-new-baseline.json");
const UNIVERSE_PRESET_PATH = path.join(process.cwd(), "scripts", "universe-presets.json");
const FOLD_META_PATH = path.join(process.cwd(), ".cache", "feature_inventory_1d_ablation_meta.json");
const WEIGHTS_PATH = path.join(process.cwd(), ".cache", "weights.json");
const SCORE_CALCULATOR_PATH = path.join(process.cwd(), ".test-dist", "lib", "ai", "scoreCalculator.js");

const REPLAY_IMPLEMENTATION_VERSION = "phase10-baseline-replay-v1";
const SOURCE_START = "2025-04-18";
const SOURCE_END = "2026-08-07";
const FINAL_OOS_START = "2026-06-01";
const FINAL_OOS_END = "2026-08-07";
const ENTRY_SCORE_FLOOR = 70;
const HORIZON = 10;
const MAX_HOLDING_DAYS = 10;

const CANDIDATES = {
  normalizedMacdHistogram: (row) => (Number(row.latestMacdHistogram) / row.decisionClose) * 100,
  relativeLow52Distance: (row) => (Number(row.low52) - row.decisionClose) / row.decisionClose,
  bollingerPricePosition: (row) => Number(row.pricePosition),
  relativeSma200Distance: (row) => (Number(row.latestSma200) - row.decisionClose) / row.decisionClose,
  sma5Slope: (row) => Number(row.ma5Slope),
  midTrendReturn: (row) => Number(row.midTrendPercent),
};

const round1MaxTrainEnd = core.PHASE10_OUTER_FOLDS[core.PHASE10_OUTER_FOLDS.length - 1].trainEnd;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const inputPath = argumentValue("--pre-oos-input");
const summaryOnly = process.argv.includes("--summary");

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

function dateValue(day) {
  return new Date(`${day}T00:00:00Z`);
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

function loadDecisionCloseMap(rows) {
  const byKey = new Map();
  for (const code of new Set(rows.map((row) => row.code))) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".cache", `jpx-stock-${code}-1d.json`), "utf8"));
    const candles = snapshot.chartData?.candles ?? snapshot.data?.chartData?.candles ?? [];
    for (let index = 1; index < candles.length; index += 1) {
      byKey.set(`${code}_${String(candles[index].time).slice(0, 10)}`, Number(candles[index - 1].close));
    }
  }
  return byKey;
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
  return core.summarizeTradeRows(rows.map((row) => ({
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
    files: fileHashes,
  };
}

function gate0Environment(universeData) {
  const inventoryFiles = [
    path.join(INVENTORY_DIR, "feature_inventory_1d_base_rows.csv"),
    path.join(INVENTORY_DIR, "feature_inventory_1d_base_rows_volume_breakout.csv"),
    path.join(INVENTORY_DIR, "feature_inventory_1d_base_rows_context_news.csv"),
  ];
  const scriptPath = __filename;
  return {
    passed: true,
    note: "Historical baselineScore was not stored, so historical score-value 100% proof is impossible; this records reproducibility inputs for audit.",
    replayImplementationVersion: REPLAY_IMPLEMENTATION_VERSION,
    replayImplementationSha256: hashFile(scriptPath),
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

function buildScoredRound1Rows(inventoryRows, replayCandidates) {
  const replayBySignal = new Map(replayCandidates.map((row) => [`${row.code}_${row.signalDate}`, row]));
  return inventoryRows.map((row) => {
    const replay = replayBySignal.get(`${row.code}_${row.signalDate}`);
    if (!replay) return null;
    return {
      raw: row,
      code: row.code,
      signalDate: row.signalDate,
      return10d: row.return10d,
      baselineScore: replay.baselineScore,
    };
  }).filter(Boolean);
}

function metricsEqual(left, right) {
  const fields = ["tradeCount", "winRate", "ev", "pf", "maxDD", "misclassificationRate"];
  return fields.every((field) => Math.abs(left[field] - right[field]) <= 1e-12);
}

function gate2CoefficientZero(scoredRows) {
  const rows = scoredRows.map((row) => ({
    code: row.code,
    signalDate: row.signalDate,
    return10d: row.return10d,
    featureValue: 0,
    baselineScore: row.baselineScore,
  }));
  const fit = { median: 0, iqr: 0, direction: 1, fallback: true };
  const selected = core.selectRowsByCandidateScore(rows, fit, 0, ENTRY_SCORE_FLOOR);
  const baselineMetrics = core.summarizeTradeRows(rows);
  const selectedMetrics = core.summarizeTradeRows(selected);
  const baselineKeys = new Set(rows.map((row) => `${row.code}_${row.signalDate}`));
  const selectedKeys = new Set(selected.map((row) => `${row.code}_${row.signalDate}`));
  const selectedMatches = baselineKeys.size === selectedKeys.size && [...baselineKeys].every((key) => selectedKeys.has(key));
  const foldChecks = core.PHASE10_OUTER_FOLDS.map((fold) => {
    const outerTrainRows = rows.filter((row) => row.signalDate <= fold.trainEnd);
    const split = core.splitOuterTrain(outerTrainRows);
    const validationRows = split.innerValidation;
    const validationSelected = core.selectRowsByCandidateScore(validationRows, fit, 0, ENTRY_SCORE_FLOOR);
    const validationBaselineMetrics = core.summarizeTradeRows(validationRows);
    const validationSelectedMetrics = core.summarizeTradeRows(validationSelected);
    const validationBaselineKeys = new Set(validationRows.map((row) => `${row.code}_${row.signalDate}`));
    const validationSelectedKeys = new Set(validationSelected.map((row) => `${row.code}_${row.signalDate}`));
    const validationSelectedMatches = validationBaselineKeys.size === validationSelectedKeys.size
      && [...validationBaselineKeys].every((key) => validationSelectedKeys.has(key));

    return {
      foldName: fold.name,
      trainEnd: fold.trainEnd,
      baselineRowCount: validationRows.length,
      selectedRowCount: validationSelected.length,
      selectedMatches: validationSelectedMatches,
      metricsMatch: metricsEqual(validationBaselineMetrics, validationSelectedMetrics),
      baselineMetrics: validationBaselineMetrics,
      selectedMetrics: validationSelectedMetrics,
    };
  });
  const round1SlicesPassed = foldChecks.every((check) => check.selectedMatches && check.metricsMatch);

  return {
    passed: selectedMatches && metricsEqual(baselineMetrics, selectedMetrics) && round1SlicesPassed,
    selectedMatches,
    round1SlicesPassed,
    baselineRowCount: rows.length,
    selectedRowCount: selected.length,
    baselineMetrics,
    selectedMetrics,
    foldChecks,
  };
}

function evaluateRows(rows) {
  core.assertPreOosRows(rows);
  return core.ROUND1_CANDIDATES.map((candidateName) => {
    const candidateRows = rows.map((row) => ({
      code: row.code,
      signalDate: row.signalDate,
      return10d: row.return10d,
      featureValue: CANDIDATES[candidateName](row),
    }));
    return core.evaluateRound1Candidate(candidateName, candidateRows);
  });
}

function evaluateScoredRows(scoredRows) {
  core.assertPreOosRows(scoredRows);
  return core.ROUND1_CANDIDATES.map((candidateName) => {
    const candidateRows = scoredRows.map((row) => ({
      code: row.code,
      signalDate: row.signalDate,
      return10d: row.return10d,
      baselineScore: row.baselineScore,
      featureValue: CANDIDATES[candidateName](row.raw),
    }));
    return core.evaluateRound1ScoredCandidate(candidateName, candidateRows, ENTRY_SCORE_FLOOR);
  });
}

const presets = readJson(UNIVERSE_PRESET_PATH);
const meta = readJson(FOLD_META_PATH);
const core39 = (presets.core39 || []).map(String);
const universeData = loadUniverseCandles(core39);
const codeDataMap = new Map(universeData.map((item) => [item.code, item]));
const gate0 = gate0Environment(universeData);
const replayCandidates = buildBaselineReplayCandidates(universeData);
const replayLedger = buildReplayLedger(replayCandidates, codeDataMap, meta.settings.walkForwardFolds || []);
const existingLedger = readJson(BASELINE_LEDGER_PATH).rows
  .filter((row) => row.horizon === HORIZON)
  .map((row) => ({ ...row, return_percent: Number(row.return_percent) }))
  .sort(compareLedgerRowsByIdentity);
const gate1 = compareReplayLedger(replayLedger, existingLedger);

const rows = inputPath ? JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8")) : loadInventoryRows();
const scoredRows = buildScoredRound1Rows(rows, replayCandidates);
const gate2 = gate1.passed ? gate2CoefficientZero(scoredRows) : {
  passed: false,
  skipped: true,
  reason: "Gate1 failed; coefficient=0 baseline identity was not evaluated.",
};

let results = [];
let gate3 = { passed: false, skipped: true, reason: "Gate2 failed; coefficient search was not executed." };
if (gate1.passed && gate2.passed) {
  results = evaluateScoredRows(scoredRows);
  gate3 = { passed: true, skipped: false, reason: "Gate0-Gate2 passed; coefficient search executed." };
}

const output = {
  gates: { gate0, gate1, gate2, gate3 },
  dates: core.PHASE10_DATES,
  candidateCount: core.ROUND1_CANDIDATES.length,
  coefficientOptionCount: core.COEFFICIENT_OPTIONS.length,
  coefficientOptions: core.COEFFICIENT_OPTIONS,
  source: inputPath ? path.resolve(inputPath) : "phase9-74-inventory",
  rowCount: rows.length,
  scoredRowCount: scoredRows.length,
  replayCandidateCount: replayCandidates.length,
  replayLedgerRows: replayLedger.length,
  existingLedgerRows: existingLedger.length,
  historicalBaselineScoreProof: "impossible: historical row-level baselineScore was not stored; Gate0 records replay inputs and Gate1/Gate2 prove trade/zero-increment identity only.",
  maxSignalDate: rows.reduce((max, row) => row.signalDate > max ? row.signalDate : max, ""),
  round1MaxTrainEnd,
  results,
};

const summary = {
  gate0Passed: output.gates.gate0.passed,
  gate1Passed: output.gates.gate1.passed,
  gate1MismatchCount: output.gates.gate1.mismatchCount,
  gate1ReplayMetrics: output.gates.gate1.replayMetrics,
  gate1ExistingMetrics: output.gates.gate1.existingMetrics,
  gate2: output.gates.gate2,
  gate3: output.gates.gate3,
  rowCount: output.rowCount,
  scoredRowCount: output.scoredRowCount,
  replayCandidateCount: output.replayCandidateCount,
  replayLedgerRows: output.replayLedgerRows,
  existingLedgerRows: output.existingLedgerRows,
  maxSignalDate: output.maxSignalDate,
  round1MaxTrainEnd: output.round1MaxTrainEnd,
  historicalBaselineScoreProof: output.historicalBaselineScoreProof,
  results: output.results.map((result) => ({
    candidateName: result.candidateName,
    selectedCoefficient: result.selectedCoefficient,
    round1Passed: result.round1Passed,
    pooledDeltas: result.pooledDeltas,
    pooledCandidateMetrics: result.pooledCandidateMetrics,
  })),
};

console.log(JSON.stringify(summaryOnly ? summary : output, (key, value) => typeof value === "number" ? formatNumber(value) : value, 2));