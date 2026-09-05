const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const phase10 = require(path.join(process.cwd(), ".test-dist", "lib", "phase10", "nestedCandidateEvaluation.js"));
const round2 = require(path.join(process.cwd(), ".test-dist", "lib", "phase10", "round2FamilyEvaluation.js"));
const round3 = require(path.join(process.cwd(), ".test-dist", "lib", "phase10", "round3FamilyEvaluation.js"));
const { analyzeStock } = require(path.join(process.cwd(), ".test-dist", "lib", "ai", "scoreCalculator.js"));

const INVENTORY_DIR = path.join(process.cwd(), ".cache", "phase9-74-inventory");
const BASELINE_LEDGER_PATH = path.join(process.cwd(), ".cache", "unified-baseline-core39-trade-ledger-new-baseline.json");
const UNIVERSE_PRESET_PATH = path.join(process.cwd(), "scripts", "universe-presets.json");
const FOLD_META_PATH = path.join(process.cwd(), ".cache", "feature_inventory_1d_ablation_meta.json");
const WEIGHTS_PATH = path.join(process.cwd(), ".cache", "weights.json");
const SCORE_CALCULATOR_PATH = path.join(process.cwd(), ".test-dist", "lib", "ai", "scoreCalculator.js");
const REPLAY_IMPLEMENTATION_VERSION = "phase10-round3-replay-v1";
const SOURCE_START = "2025-04-18";
const SOURCE_END = "2026-08-07";
const FINAL_OOS_START = "2026-06-01";
const FINAL_OOS_END = "2026-08-07";
const ENTRY_SCORE_FLOOR = 70;
const HORIZON = 10;
const MAX_HOLDING_DAYS = 10;

const FEATURE_EXTRACTORS = {
  normalizedMacdHistogram: (row) => (Number(row.latestMacdHistogram) / row.decisionClose) * 100,
  relativeLow52Distance: (row) => (Number(row.low52) - row.decisionClose) / row.decisionClose,
  bollingerPricePosition: (row) => Number(row.pricePosition),
  sma5Slope: (row) => Number(row.ma5Slope),
  midTrendReturn: (row) => Number(row.midTrendPercent),
};

function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")); }
function hashFile(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function toDay(value) { return String(value || "").slice(0, 10); }
function inRange(day, start, end) { return day >= start && day <= end; }
function formatNumber(value) { return Number.isFinite(value) ? Number(value.toFixed(12)) : value; }

function loadCsv(fileName) {
  const lines = fs.readFileSync(path.join(INVENTORY_DIR, fileName), "utf8").trim().split("\n");
  const header = lines[0].replace(/^\uFEFF/, "").split(",");
  return lines.slice(1).map((line) => Object.fromEntries(line.replace(/\r$/, "").split(",").map((value, index) => [header[index], value])));
}

function loadUniverseCandles(codes) {
  return codes.flatMap((code) => {
    const filePath = path.join(process.cwd(), ".cache", `jpx-stock-${code}-1d.json`);
    if (!fs.existsSync(filePath)) return [];
    const payload = readJson(filePath);
    const candles = (payload.chartData?.candles ?? payload.data?.chartData?.candles ?? []).filter((candle) => candle?.time && inRange(toDay(candle.time), SOURCE_START, SOURCE_END));
    if (!candles.length) return [];
    return [{ code, filePath, candles, baseStock: { code, name: payload.name || payload.data?.name || code, sector: payload.sector || payload.data?.sector || "", baselineTrend: payload.baselineTrend || payload.data?.baselineTrend || "neutral", timeframe: "1d", marketData: { price: candles.at(-1)?.close ?? 0, previousClose: candles.at(-2)?.close ?? null, currency: "JPY" } } }];
  });
}

function historicalStock(baseStock, candles, entryIndex) {
  const visible = candles.slice(0, entryIndex + 1);
  const latest = visible.at(-1);
  const previous = visible.at(-2);
  return { ...baseStock, chartData: { candles: visible }, marketData: { ...baseStock.marketData, price: latest?.close ?? 0, open: latest?.open ?? null, high: latest?.high ?? null, low: latest?.low ?? null, previousClose: previous?.close ?? null, change: latest && previous ? latest.close - previous.close : null, changePercent: latest && previous && previous.close > 0 ? ((latest.close - previous.close) / previous.close) * 100 : null, asOf: latest?.time ?? null } };
}

function replayCandidates(universeData) {
  return universeData.flatMap(({ code, baseStock, candles }) => {
    const rows = [];
    for (let entryIndex = 60; entryIndex < candles.length - 1; entryIndex += 1) {
      const signalDate = toDay(candles[entryIndex + 1]?.time);
      if (!signalDate || inRange(signalDate, FINAL_OOS_START, FINAL_OOS_END)) continue;
      const analysis = analyzeStock({ query: code, stock: historicalStock(baseStock, candles, entryIndex) });
      if (analysis?.signal === "BUY" && Number(analysis.score) >= ENTRY_SCORE_FLOOR) rows.push({ code, signalDate, entryIndex, baselineScore: Number(analysis.score), stopLossPrice: Number(analysis.stopLossPrice), takeProfitPrice: Number(analysis.takeProfitPrice) });
    }
    return rows;
  });
}

function tradeForCandidate(codeDataMap, candidate) {
  const candles = codeDataMap.get(candidate.code)?.candles;
  const entryCandle = candles?.[candidate.entryIndex + 1];
  if (!candles || !entryCandle) return null;
  const exitLimit = Math.min(candles.length - 1, candidate.entryIndex + Math.min(HORIZON, MAX_HOLDING_DAYS));
  let exitIndex = exitLimit;
  let exitPrice = candles[exitLimit]?.close ?? entryCandle.close;
  let exitReason = "time-expiry";
  for (let index = candidate.entryIndex + 1; index <= exitLimit; index += 1) {
    const candle = candles[index];
    if (candle.low <= candidate.stopLossPrice) { exitIndex = index; exitPrice = candidate.stopLossPrice; exitReason = "stop-loss"; break; }
    if (candle.high >= candidate.takeProfitPrice) { exitIndex = index; exitPrice = candidate.takeProfitPrice; exitReason = "take-profit"; break; }
  }
  const entryPrice = entryCandle.open > 0 ? entryCandle.open : entryCandle.close;
  return { entryDate: toDay(entryCandle.time), exitDate: toDay(candles[exitIndex]?.time), exitReason, returnPercent: ((exitPrice - entryPrice) / entryPrice) * 100, horizonEffective: Math.min(HORIZON, MAX_HOLDING_DAYS) };
}

function ledgerIdentity(row) { return [row.horizon, row.fold, row.ticker, row.signal_date, row.entry_date, row.entry_index].join("|"); }

function gate1Replay(universeData, candidates, folds) {
  const codeDataMap = new Map(universeData.map((item) => [item.code, item]));
  const replay = [];
  for (const fold of folds) for (const candidate of candidates) {
    if (!inRange(candidate.signalDate, fold.testStart, fold.testEnd)) continue;
    const trade = tradeForCandidate(codeDataMap, candidate);
    if (trade) replay.push({ horizon: HORIZON, fold: fold.name, ticker: candidate.code, signal_date: candidate.signalDate, entry_date: trade.entryDate, exit_date: trade.exitDate, exit_reason: trade.exitReason, return_percent: trade.returnPercent, horizon_effective: trade.horizonEffective, entry_index: candidate.entryIndex });
  }
  const existing = readJson(BASELINE_LEDGER_PATH).rows.filter((row) => row.horizon === HORIZON);
  const replayByKey = new Map(replay.map((row) => [ledgerIdentity(row), row]));
  const existingByKey = new Map(existing.map((row) => [ledgerIdentity(row), row]));
  const mismatches = [];
  if (replay.length !== existing.length) mismatches.push("rowCount");
  for (const [key, row] of replayByKey) {
    const baseline = existingByKey.get(key);
    if (!baseline || row.exit_date !== baseline.exit_date || row.exit_reason !== baseline.exit_reason || row.horizon_effective !== baseline.horizon_effective || Math.abs(row.return_percent - baseline.return_percent) > 1e-10) mismatches.push(key);
  }
  for (const key of existingByKey.keys()) if (!replayByKey.has(key)) mismatches.push(key);
  return { passed: mismatches.length === 0, mismatchCount: mismatches.length, replayRows: replay.length, existingRows: existing.length };
}

function decisionCloseMap(rows) {
  const byKey = new Map();
  for (const code of new Set(rows.map((row) => row.code))) {
    const snapshot = readJson(path.join(process.cwd(), ".cache", `jpx-stock-${code}-1d.json`));
    const candles = snapshot.chartData?.candles ?? snapshot.data?.chartData?.candles ?? [];
    for (let index = 1; index < candles.length; index += 1) byKey.set(`${code}_${toDay(candles[index].time)}`, Number(candles[index - 1].close));
  }
  return byKey;
}

function round3Rows(candidates) {
  const groupA = loadCsv("feature_inventory_1d_base_rows.csv");
  const groupB = loadCsv("feature_inventory_1d_base_rows_volume_breakout.csv");
  const rows = groupA.map((row, index) => ({ ...row, ...groupB[index], return10d: Number(row.return10d) }));
  const closes = decisionCloseMap(rows);
  const candidateByKey = new Map(candidates.map((candidate) => [`${candidate.code}_${candidate.signalDate}`, candidate]));
  return rows.map((row) => {
    const decisionClose = closes.get(`${row.code}_${row.signalDate}`);
    const candidate = candidateByKey.get(`${row.code}_${row.signalDate}`);
    if (!Number.isFinite(decisionClose) || !candidate) return null;
    return { code: row.code, signalDate: row.signalDate, return10d: row.return10d, featureValue: 0, baselineScore: candidate.baselineScore, features: { normalizedMacdHistogram: FEATURE_EXTRACTORS.normalizedMacdHistogram({ ...row, decisionClose }), relativeLow52Distance: FEATURE_EXTRACTORS.relativeLow52Distance({ ...row, decisionClose }), bollingerPricePosition: FEATURE_EXTRACTORS.bollingerPricePosition(row), sma5Slope: FEATURE_EXTRACTORS.sma5Slope(row), midTrendReturn: FEATURE_EXTRACTORS.midTrendReturn(row) } };
  }).filter(Boolean);
}

const presets = readJson(UNIVERSE_PRESET_PATH);
const meta = readJson(FOLD_META_PATH);
const folds = meta.settings.walkForwardFolds;
const universeData = loadUniverseCandles((presets.core39 || []).map(String));
const candidates = replayCandidates(universeData);
const gate0 = { passed: true, replayImplementationVersion: REPLAY_IMPLEMENTATION_VERSION, replayImplementationSha256: hashFile(__filename), scoreCalculatorSha256: hashFile(SCORE_CALCULATOR_PATH), weightsJsonSha256: hashFile(WEIGHTS_PATH), universePresetSha256: hashFile(UNIVERSE_PRESET_PATH), foldMetaSha256: hashFile(FOLD_META_PATH) };
const gate1 = gate1Replay(universeData, candidates, folds);
const rows = round3Rows(candidates);
phase10.assertPreOosRows(rows);
const gate2 = gate1.passed ? round2.gate2Round2CoefficientZero(rows) : { passed: false, skipped: true, reason: "Gate1 failed; Round3 was not evaluated." };
if (!gate0.passed || !gate1.passed || !gate2.passed) throw new Error("Gate0-Gate2 must pass before Round3 evaluation");

const result = round3.evaluateRound3(rows);

console.log(JSON.stringify({
  gates: { gate0, gate1, gate2 },
  round3Result: result,
}, (key, value) => typeof value === "number" ? formatNumber(value) : value, 2));
