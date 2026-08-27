const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { analyzeStock } = require('../.test-dist/lib/ai/scoreCalculator.js');

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, '.cache');
const OUT_DIR = path.join(CACHE_DIR, 'phase9-74-inventory');
const BASELINE_PATH = path.join(CACHE_DIR, 'unified-baseline-core39.json');
const PRESET_PATH = path.join(ROOT, 'scripts', 'universe-presets.json');

const SOURCE_START = '2025-04-18';
const SOURCE_END = '2026-08-07';
const FINAL_OOS_START = '2026-06-01';
const FINAL_OOS_END = '2026-08-07';

const ENTRY_SCORE_FLOOR = 70;
const MIN_HISTORY = 60;
const HOLD_DAYS = 10;
const STOP_LOSS_PCT = 0.05;
const TAKE_PROFIT_PCT = 0.13;
const CORR_THRESHOLD = 0.85;

const GROUP_A_FEATURES = [
  'latestSma5', 'latestSma25', 'latestSma75', 'latestSma200', 'ma5Slope', 'ma25Slope', 'ma75Slope', 'maSlopeBlend',
  'ma5Score', 'ma25Score', 'ma75Score', 'maCompositeScore', 'latestRsi', 'latestMacdHistogram', 'macdHistogramDelta', 'latestAdx',
  'shortTrendPercent', 'midTrendPercent', 'longTrendPercent', 'momentumPersistence', 'momentumConsistency', 'trendAlignment',
  'trendStack_dailyTrend', 'trendStack_weeklyTrend', 'trendStack_monthlyTrend', 'trendStack_alignment', 'trendStack_strength',
  'trendCompositeScore', 'trendStrengthScore', 'trendConsensusScore'
];

const GROUP_B_FEATURES = [
  'volumeAverage', 'volumeRatio', 'volumeSurgeRate', 'volumeProfile.surgeRatio', 'volumeProfile.trendPercent', 'vwap',
  'volumeRatioScore', 'volumeSpikeScore', 'volumeCompositeScore', 'volumeV13Score', 'support', 'resistance', 'nearSupport',
  'nearResistance', 'breakout', 'highBreakout', 'lowBreakdown', 'srDistance', 'supportResistanceScore', 'gapPercent',
  'gapInsight.score', 'pricePosition', 'bollingerScore', 'high52', 'low52', 'positionIn52w', 'week52Score', 'falseBreakout',
  'boxBreakout', 'breakoutPrecisionScore'
];

const GROUP_C_FEATURES = [
  'divergenceSignals.score', 'candlestickSignals.score', 'baselineTrend', 'nikkeiChangePercent', 'topixChangePercent',
  'usdJpyChangePercent', 'vixChangePercent', 'marketRegimeScore', 'newsSentimentScore', 'newsSentimentConfidence',
  'newsImportance', 'newsComponentScore', 'newsCompositeScore', 'newsAlignment'
];

const BASE_ROWS_A_HEADER = ['code', 'signalDate', 'regime', ...GROUP_A_FEATURES, 'return10d'];
const BASE_ROWS_B_HEADER = ['code', 'signalDate', 'regime', ...GROUP_B_FEATURES, 'return10d'];
const BASE_ROWS_C_HEADER = ['code', 'signalDate', 'regime', ...GROUP_C_FEATURES, 'return10d'];
const DECISION_HEADER_A = ['feature', 'label', 'standalone_points', 'redundancy_points', 'incremental_points', 'regime_change_record'];
const DECISION_HEADER_B = ['feature', 'label', 'standalone_points', 'redundancy_points', 'regime_change_record'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toDay(value) {
  return String(value || '').slice(0, 10);
}

function toDate(value) {
  return new Date(`${toDay(value)}T00:00:00Z`);
}

function inRange(day, start, end) {
  return day >= start && day <= end;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeDiv(num, den, fallback = 0) {
  return den === 0 ? fallback : num / den;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const v = values.reduce((s, x) => s + ((x - m) ** 2), 0) / values.length;
  return Math.sqrt(v);
}

function pearson(valuesX, valuesY) {
  if (valuesX.length !== valuesY.length || valuesX.length < 2) return null;
  const x = [];
  const y = [];
  for (let i = 0; i < valuesX.length; i += 1) {
    const vx = valuesX[i];
    const vy = valuesY[i];
    if (Number.isFinite(vx) && Number.isFinite(vy)) {
      x.push(vx);
      y.push(vy);
    }
  }
  if (x.length < 2) return null;
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < x.length; i += 1) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    sx += dx * dx;
    sy += dy * dy;
  }
  if (sx === 0 || sy === 0) return null;
  return cov / Math.sqrt(sx * sy);
}

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i += 1) {
    const cur = values[i] * k + prev * (1 - k);
    out.push(cur);
    prev = cur;
  }
  return out;
}

function smaAt(values, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  let s = 0;
  for (let i = start; i <= endIndex; i += 1) s += values[i];
  return s / period;
}

function calcSlopePercent(series) {
  if (!series.length || !Number.isFinite(series[0])) return 0;
  const first = series[0];
  const last = series[series.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last) || Math.abs(first) < 1e-12) return 0;
  return ((last - first) / Math.abs(first)) * 100;
}

function computeRsi(closes, period = 14) {
  if (closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function computeAdx(candles, period = 14) {
  if (candles.length < period + 2) return 0;
  const trs = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < candles.length; i += 1) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  if (trs.length < period) return 0;

  let atr = mean(trs.slice(0, period));
  let pDm = mean(plusDM.slice(0, period));
  let mDm = mean(minusDM.slice(0, period));

  const dxSeries = [];
  for (let i = period; i < trs.length; i += 1) {
    atr = ((atr * (period - 1)) + trs[i]) / period;
    pDm = ((pDm * (period - 1)) + plusDM[i]) / period;
    mDm = ((mDm * (period - 1)) + minusDM[i]) / period;

    const pDi = atr > 0 ? (100 * pDm / atr) : 0;
    const mDi = atr > 0 ? (100 * mDm / atr) : 0;
    const diSum = pDi + mDi;
    const dx = diSum > 0 ? (100 * Math.abs(pDi - mDi) / diSum) : 0;
    dxSeries.push(dx);
  }
  if (!dxSeries.length) return 0;
  return mean(dxSeries.slice(-period));
}

function computeFeaturePack(candles, regime, baselineTrendRaw, scoreResult) {
  const closes = candles.map((c) => c.close);
  const opens = candles.map((c) => c.open);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume || 0);
  const n = candles.length;

  const latestClose = closes[n - 1];
  const latestOpen = opens[n - 1];
  const latestVolume = vols[n - 1];

  const latestSma5 = smaAt(closes, n - 1, 5) ?? latestClose;
  const latestSma25 = smaAt(closes, n - 1, 25) ?? latestClose;
  const latestSma75 = smaAt(closes, n - 1, 75) ?? latestClose;
  const latestSma200 = smaAt(closes, n - 1, 200) ?? latestClose;

  const ma5Series = [];
  const ma25Series = [];
  const ma75Series = [];
  for (let i = Math.max(0, n - 8); i < n; i += 1) {
    ma5Series.push(smaAt(closes, i, 5) ?? closes[i]);
  }
  for (let i = Math.max(0, n - 10); i < n; i += 1) {
    ma25Series.push(smaAt(closes, i, 25) ?? closes[i]);
  }
  for (let i = Math.max(0, n - 12); i < n; i += 1) {
    ma75Series.push(smaAt(closes, i, 75) ?? closes[i]);
  }

  const ma5Slope = calcSlopePercent(ma5Series);
  const ma25Slope = calcSlopePercent(ma25Series);
  const ma75Slope = calcSlopePercent(ma75Series);
  const maSlopeBlend = ma5Slope * 0.45 + ma25Slope * 0.35 + ma75Slope * 0.2;

  const ma5Score = clamp(50 + ((latestClose - latestSma5) / Math.max(latestSma5, 1)) * 2000, 0, 100);
  const ma25Score = clamp(50 + ((latestSma5 - latestSma25) / Math.max(latestSma25, 1)) * 2000, 0, 100);
  const ma75Score = clamp(50 + ((latestSma25 - latestSma75) / Math.max(latestSma75, 1)) * 1800, 0, 100);
  const maCompositeScore = clamp((ma5Score * 0.35) + (ma25Score * 0.35) + (ma75Score * 0.3), 0, 100);

  const latestRsi = computeRsi(closes, 14);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine, 9);
  const macdHistSeries = macdLine.map((v, i) => v - signalLine[i]);
  const latestMacdHistogram = macdHistSeries[macdHistSeries.length - 1] ?? 0;
  const previousMacdHistogram = macdHistSeries[macdHistSeries.length - 2] ?? latestMacdHistogram;
  const macdHistogramDelta = latestMacdHistogram - previousMacdHistogram;

  const latestAdx = computeAdx(candles, 14);

  const close20 = closes[Math.max(0, n - 20)];
  const close60 = closes[Math.max(0, n - 60)];
  const close120 = closes[Math.max(0, n - 120)];
  const shortTrendPercent = safeDiv(latestClose - close20, close20, 0) * 100;
  const midTrendPercent = safeDiv(latestClose - close60, close60, 0) * 100;
  const longTrendPercent = safeDiv(latestClose - close120, close120, 0) * 100;
  const momentumPersistence = shortTrendPercent - midTrendPercent;

  const shortWindow = closes.slice(Math.max(0, n - 10));
  let upMoves = 0;
  let downMoves = 0;
  for (let i = 1; i < shortWindow.length; i += 1) {
    if (shortWindow[i] > shortWindow[i - 1]) upMoves += 1;
    if (shortWindow[i] < shortWindow[i - 1]) downMoves += 1;
  }
  const momentumConsistency = shortWindow.length > 2 ? (upMoves - downMoves) / (shortWindow.length - 1) : 0;

  const trendAlignment = (shortTrendPercent > 0 ? 1 : -1) + (midTrendPercent > 0 ? 1 : -1) + (longTrendPercent > 0 ? 1 : -1);
  const trendStackDaily = shortTrendPercent;
  const trendStackWeekly = midTrendPercent;
  const trendStackMonthly = longTrendPercent;
  const trendStackAlignment = (trendStackDaily > 0 ? 1 : -1) + (trendStackWeekly > 0 ? 1 : -1) + (trendStackMonthly > 0 ? 1 : -1);
  const trendStackStrength = Math.abs(trendStackDaily) * 0.35 + Math.abs(trendStackWeekly) * 0.4 + Math.abs(trendStackMonthly) * 0.25;

  const trendDirectionScore = clamp(trendStackAlignment * 4 + (trendStackDaily > 0 ? 2 : -2), -16, 16);
  const maStructureScore = (latestClose > latestSma5 ? 8 : -7) + (latestSma5 > latestSma25 ? 9 : -5) + (latestSma25 > latestSma75 ? 8 : -6);
  const trendMomentumScore =
    (momentumPersistence >= 0.45 ? 5 : momentumPersistence <= -0.45 ? -5 : 0)
    + (momentumConsistency >= 0.55 ? 4 : momentumConsistency <= -0.45 ? -4 : 0)
    + (trendAlignment >= 3 ? 7 : trendAlignment <= -3 ? -7 : 0)
    + (maSlopeBlend >= 0.55 ? 6 : maSlopeBlend <= -0.45 ? -6 : 0)
    + (trendStackAlignment >= 3 ? 6 : trendStackAlignment <= -3 ? -6 : 0)
    + (trendStackStrength >= 12 && trendStackDaily > 0 ? 4 : 0);
  const trendCompositeScore = clamp(Math.round((trendDirectionScore + maStructureScore + trendMomentumScore) * 0.7), -45, 45);

  const trendStrengthScore = clamp(
    50 + trendAlignment * 8 + maSlopeBlend * 6 + trendDirectionScore * 1.4 + momentumConsistency * 16 + (trendStackDaily > 0 ? 3 : -3),
    0,
    100
  );
  const trendConsensusScore = trendStrengthScore;

  const vol5 = vols.slice(Math.max(0, n - 5));
  const volumeAverage = mean(vol5);
  const volumeRatio = volumeAverage > 0 ? latestVolume / volumeAverage : 1;
  // calculateVolumeSurgeRate(lib/indicators.ts)と同じ、最新足を除いた直近20本
  const priorVol = vols.slice(Math.max(0, n - 21), n - 1);
  const priorVolAvg = priorVol.length ? mean(priorVol) : volumeAverage;
  const volumeSurgeRate = priorVolAvg > 0 ? latestVolume / priorVolAvg : 1;

  const volTrendWindow = vols.slice(Math.max(0, n - 10));
  const firstVol = volTrendWindow[0] ?? latestVolume;
  const lastVol = volTrendWindow[volTrendWindow.length - 1] ?? latestVolume;
  const volumeProfileTrendPercent = safeDiv(lastVol - firstVol, Math.max(firstVol, 1), 0) * 100;
  const volumeProfileSurgeRatio = volumeSurgeRate;

  let vwapNum = 0;
  let vwapDen = 0;
  const vwapWindow = candles.slice(Math.max(0, n - 20));
  for (const c of vwapWindow) {
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume || 0;
    vwapNum += tp * v;
    vwapDen += v;
  }
  const vwap = vwapDen > 0 ? (vwapNum / vwapDen) : latestClose;

  const volumeRatioScore = clamp(40 + volumeRatio * 28, 0, 100);
  const volumeSpikeScore = clamp(35 + volumeSurgeRate * 24, 0, 100);
  const volumeCompositeScore = clamp((volumeRatioScore * 0.55) + (volumeSpikeScore * 0.45), 0, 100);

  const recent20 = candles.slice(Math.max(0, n - 20));
  const support = recent20.length ? Math.min(...recent20.map((c) => c.low)) : latestClose * 0.98;
  const resistance = recent20.length ? Math.max(...recent20.map((c) => c.high)) : latestClose * 1.02;
  const nearSupport = support > 0 && latestClose <= support * 1.02;
  const nearResistance = resistance > 0 && latestClose >= resistance * 0.98;
  const breakout = resistance > 0 && latestClose >= resistance * 1.005;
  const highBreakout = resistance > 0 && latestClose >= resistance;
  const lowBreakdown = support > 0 && latestClose <= support;
  const srDistance = resistance > 0 && support > 0 ? (resistance - support) / Math.max(latestClose, 1) : 0;
  const supportResistanceScore = clamp(58 + srDistance * 900 - (latestClose >= resistance * 0.99 ? 15 : 0), 0, 100);

  const prevClose = closes[n - 2] ?? latestClose;
  const gapPercent = prevClose > 0 ? ((latestOpen - prevClose) / prevClose) * 100 : 0;
  const gapInsightScore = clamp(gapPercent * 2.5, -20, 20);

  const bbWindow = closes.slice(Math.max(0, n - 20));
  const bbMean = mean(bbWindow);
  const bbStd = std(bbWindow);
  const bbUpper = bbMean + bbStd * 2;
  const bbLower = bbMean - bbStd * 2;
  const pricePosition = bbUpper > bbLower ? (latestClose - bbLower) / Math.max(bbUpper - bbLower, 1e-9) : 0.5;
  const bollingerScore = clamp(100 - Math.abs(pricePosition - 0.62) * 140, 0, 100);

  const lookback252 = candles.slice(Math.max(0, n - 252));
  const high52 = lookback252.length ? Math.max(...lookback252.map((c) => c.high)) : latestClose;
  const low52 = lookback252.length ? Math.min(...lookback252.map((c) => c.low)) : latestClose;
  const positionIn52w = high52 > low52 ? (latestClose - low52) / (high52 - low52) : 0.5;
  const week52Score = clamp(100 - Math.abs(positionIn52w - 0.62) * 160, 0, 100);

  // scoreCalculator.ts 1590-1592/1862-1863 と同じ exclusive window (最新足を除く直近20本)
  const prior20Candles = n > 1 ? candles.slice(Math.max(0, n - 21), n - 1) : candles;
  const recent20High = prior20Candles.reduce((max, c) => Math.max(max, c.high), Number.NEGATIVE_INFINITY);
  const falseBreakout = Number.isFinite(recent20High) && (highs[n - 1] >= recent20High * 1.005) && latestClose < recent20High * 0.998 && volumeSurgeRate < 1.15;
  const boxBreakout = Number.isFinite(recent20High) && highs[n - 1] >= recent20High * 1.005 && latestClose >= recent20High * 0.998;
  const breakoutPrecisionScore = clamp((latestClose >= high52 * 0.995 ? 8 : 0) + (boxBreakout ? 7 : 0) + (falseBreakout ? -10 : 0) + (highBreakout && !falseBreakout ? 6 : 0) + (nearResistance ? -3 : 0), -12, 16);

  const volumeV13Score = clamp(Math.round(50
    + (volumeProfileSurgeRatio >= 2.2 ? 24 : volumeProfileSurgeRatio >= 1.5 ? 15 : volumeProfileSurgeRatio >= 1.1 ? 8 : volumeProfileSurgeRatio <= 0.85 ? -14 : 0)
    + (volumeProfileTrendPercent >= 20 ? 14 : volumeProfileTrendPercent >= 10 ? 8 : volumeProfileTrendPercent <= -10 ? -10 : 0)
    + (breakout && volumeSurgeRate >= 1.2 ? 12 : breakout ? 6 : 0)
    + (volumeAverage > 0 && latestVolume >= volumeAverage * 2 ? 6 : 0)
    + clamp((volumeSurgeRate - 1) * 8, -5, 6)), 0, 100);

  const divergenceScore = clamp(macdHistogramDelta * 20 + (latestRsi < 30 ? 8 : latestRsi > 70 ? -8 : 0), -20, 20);
  const body = Math.abs(latestClose - latestOpen);
  const range = Math.max(highs[n - 1] - lows[n - 1], 1e-9);
  const lowerShadow = Math.min(latestOpen, latestClose) - lows[n - 1];
  const upperShadow = highs[n - 1] - Math.max(latestOpen, latestClose);
  let candlestickScore = 0;
  if (body / range < 0.2) candlestickScore += 3;
  if (lowerShadow / range > 0.5) candlestickScore += 6;
  if (upperShadow / range > 0.5) candlestickScore -= 6;
  candlestickScore = clamp(candlestickScore, -20, 20);

  let baselineTrend = 'neutral';
  if (typeof baselineTrendRaw === 'string') {
    baselineTrend = baselineTrendRaw;
  }

  const nikkeiChangePercent = 0;
  const topixChangePercent = 0;
  const usdJpyChangePercent = 0;
  const vixChangePercent = 0;
  const marketRegimeScore = 50;
  const newsSentimentScore = 0;
  const newsSentimentConfidence = 35;
  const newsImportance = '軽微';
  const newsComponentScore = 50;
  const newsCompositeScore = 0;
  const newsAlignment = 0;

  const ret = {
    latestSma5, latestSma25, latestSma75, latestSma200,
    ma5Slope, ma25Slope, ma75Slope, maSlopeBlend,
    ma5Score, ma25Score, ma75Score, maCompositeScore,
    latestRsi, latestMacdHistogram, macdHistogramDelta, latestAdx,
    shortTrendPercent, midTrendPercent, longTrendPercent,
    momentumPersistence, momentumConsistency, trendAlignment,
    trendStack_dailyTrend: trendStackDaily,
    trendStack_weeklyTrend: trendStackWeekly,
    trendStack_monthlyTrend: trendStackMonthly,
    trendStack_alignment: trendStackAlignment,
    trendStack_strength: trendStackStrength,
    trendCompositeScore, trendStrengthScore, trendConsensusScore,

    volumeAverage, volumeRatio, volumeSurgeRate,
    'volumeProfile.surgeRatio': volumeProfileSurgeRatio,
    'volumeProfile.trendPercent': volumeProfileTrendPercent,
    vwap, volumeRatioScore, volumeSpikeScore, volumeCompositeScore, volumeV13Score,
    support, resistance, nearSupport: nearSupport ? 1 : 0, nearResistance: nearResistance ? 1 : 0,
    breakout: breakout ? 1 : 0, highBreakout: highBreakout ? 1 : 0, lowBreakdown: lowBreakdown ? 1 : 0,
    srDistance, supportResistanceScore, gapPercent,
    'gapInsight.score': gapInsightScore,
    pricePosition, bollingerScore, high52, low52, positionIn52w, week52Score,
    falseBreakout: falseBreakout ? 1 : 0,
    boxBreakout: boxBreakout ? 1 : 0,
    breakoutPrecisionScore,

    'divergenceSignals.score': divergenceScore,
    'candlestickSignals.score': candlestickScore,
    baselineTrend,
    nikkeiChangePercent,
    topixChangePercent,
    usdJpyChangePercent,
    vixChangePercent,
    marketRegimeScore,
    newsSentimentScore,
    newsSentimentConfidence,
    newsImportance,
    newsComponentScore,
    newsCompositeScore,
    newsAlignment,

    _diagScore: Number(scoreResult?.score ?? 0),
    _diagSignal: String(scoreResult?.signal ?? ''),
    _regime: regime
  };

  return ret;
}

function buildHistoricalStock(base, candles, endIndex) {
  const visible = candles.slice(0, endIndex + 1);
  const latest = visible[visible.length - 1];
  const previous = visible[visible.length - 2];
  return {
    code: base.code,
    name: base.name,
    sector: base.sector,
    baselineTrend: base.baselineTrend,
    timeframe: '1d',
    chartData: { candles: visible },
    marketData: {
      price: latest?.close ?? 0,
      open: latest?.open ?? null,
      high: latest?.high ?? null,
      low: latest?.low ?? null,
      previousClose: previous?.close ?? null,
      change: latest && previous ? latest.close - previous.close : null,
      changePercent: latest && previous && previous.close > 0 ? ((latest.close - previous.close) / previous.close) * 100 : null,
      currency: 'JPY',
      asOf: latest?.time ?? null
    },
    marketContext: undefined,
    newsAnalysis: undefined
  };
}

function simulateCandidateTrade(candles, candidate) {
  const entryIndex = candidate.entryIndex + 1;
  const entryCandle = candles[entryIndex];
  if (!entryCandle) return null;

  const stopLossPrice = Number(candidate.stopLossPrice);
  const takeProfitPrice = Number(candidate.takeProfitPrice);

  const exitLimitIndex = Math.min(candles.length - 1, candidate.entryIndex + HOLD_DAYS);
  let exitIndex = exitLimitIndex;
  let exitPrice = candles[exitLimitIndex]?.close ?? entryCandle.close;

  for (let idx = entryIndex; idx <= exitLimitIndex; idx += 1) {
    const c = candles[idx];
    if (!c) break;
    if (c.low <= stopLossPrice) {
      exitIndex = idx;
      exitPrice = stopLossPrice;
      break;
    }
    if (c.high >= takeProfitPrice) {
      exitIndex = idx;
      exitPrice = takeProfitPrice;
      break;
    }
  }

  const entryPrice = entryCandle.open > 0 ? entryCandle.open : entryCandle.close;
  const ret = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;

  return {
    return10d: ret,
    entryDate: toDay(entryCandle.time),
    exitDate: toDay(candles[exitIndex]?.time)
  };
}

function toCsvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(filePath, header, rows) {
  const lines = [];
  lines.push(header.join(','));
  for (const row of rows) {
    lines.push(header.map((h) => toCsvCell(row[h])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function computeVariance(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((s, x) => s + ((x - m) ** 2), 0) / values.length;
}

function numericSeries(rows, feature) {
  return rows.map((r) => {
    const v = r[feature];
    if (typeof v !== 'number') return null;
    return Number.isFinite(v) ? v : null;
  });
}

function pairSampleCount(valuesX, valuesY) {
  let count = 0;
  for (let i = 0; i < valuesX.length; i += 1) {
    if (Number.isFinite(valuesX[i]) && Number.isFinite(valuesY[i])) count += 1;
  }
  return count;
}

function pairKey(a, b) {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

function detectFeatureMeta(rows, featureList) {
  const meta = {};
  for (const feature of featureList) {
    const series = numericSeries(rows, feature);
    const finite = series.filter((v) => Number.isFinite(v));
    const finiteNumericCount = finite.length;
    const variance = finiteNumericCount >= 2 ? computeVariance(finite) : null;

    let status = 'insufficient-sample';
    let reason = 'finiteNumericCount<2';

    if (finiteNumericCount >= 2 && variance === 0) {
      status = 'numeric-constant';
      reason = 'finiteNumericCount>=2_and_variance===0';
    } else if (finiteNumericCount >= 2 && variance > 0) {
      status = 'numeric-variable';
      reason = 'finiteNumericCount>=2_and_variance>0';
    } else if (finiteNumericCount < 2) {
      status = 'insufficient-sample';
      reason = 'finiteNumericCount<2';
      if (finiteNumericCount === 0) {
        status = 'non-numeric';
        reason = 'finiteNumericCount===0';
      }
    }

    meta[feature] = {
      feature,
      status,
      reason,
      finiteNumericCount,
      variance,
      uniqueNumericCount: finiteNumericCount ? new Set(finite.map((v) => Number(v.toFixed(12)))).size : 0
    };
  }
  return meta;
}

function calculateCorrelations(rows, featureList, featureMeta, threshold) {
  const seriesMap = new Map(featureList.map((f) => [f, numericSeries(rows, f)]));
  const out = [];
  for (let i = 0; i < featureList.length; i += 1) {
    for (let j = i + 1; j < featureList.length; j += 1) {
      const left = featureList[i];
      const right = featureList[j];
      const leftMeta = featureMeta[left];
      const rightMeta = featureMeta[right];
      const leftSeries = seriesMap.get(left);
      const rightSeries = seriesMap.get(right);
      const sampleCount = pairSampleCount(leftSeries, rightSeries);

      let correlation = 'NA';
      let status = 'not-applicable';
      let reason = 'unknown';

      if (leftMeta.status === 'non-numeric' || rightMeta.status === 'non-numeric') {
        status = 'not-applicable';
        reason = 'non-numeric';
      } else if (leftMeta.status === 'insufficient-sample' || rightMeta.status === 'insufficient-sample') {
        status = 'not-applicable';
        reason = 'insufficient-sample';
      } else if (leftMeta.status === 'numeric-constant' || rightMeta.status === 'numeric-constant') {
        status = 'not-applicable';
        reason = 'constant-numeric';
      } else if (sampleCount < 2) {
        status = 'not-applicable';
        reason = 'insufficient-sample';
      } else {
        const corr = pearson(leftSeries, rightSeries);
        if (Number.isFinite(corr)) {
          correlation = corr;
          status = 'computed';
          reason = '';
        } else {
          status = 'not-applicable';
          reason = 'pair-degenerate';
        }
      }

      const isHighCorrelation = Number.isFinite(correlation) ? (Math.abs(correlation) >= threshold ? 1 : 0) : 'NA';
      out.push({ left, right, correlation, sampleCount, status, reason, isHighCorrelation });
    }
  }
  return out;
}

function filterGroupCorrelations(all74Correlations, featureList) {
  const allowed = new Set(featureList);
  return all74Correlations.filter((r) => allowed.has(r.left) && allowed.has(r.right));
}

function calculateReturnCorrelations(rows, featureList, featureMeta) {
  const returnSeries = rows.map((r) => (typeof r.return10d === 'number' && Number.isFinite(r.return10d) ? r.return10d : null));
  const out = [];

  for (const feature of featureList) {
    const meta = featureMeta[feature];
    const series = numericSeries(rows, feature);
    const sampleCount = pairSampleCount(series, returnSeries);

    let correlation = 'NA';
    let status = 'not-applicable';
    let reason = meta.reason;

    if (meta.status === 'numeric-variable' && sampleCount >= 2) {
      const corr = pearson(series, returnSeries);
      if (Number.isFinite(corr)) {
        correlation = corr;
        status = 'computed';
        reason = '';
      } else {
        status = 'not-applicable';
        reason = 'pair-degenerate';
      }
    } else if (meta.status === 'numeric-variable' && sampleCount < 2) {
      status = 'not-applicable';
      reason = 'insufficient-sample';
    }

    out.push({ feature, correlation, sampleCount, status, reason });
  }

  return out;
}

function summarizeRegimeChange(rows, feature, meta) {
  let pre = 0;
  let post = 0;
  for (const r of rows) {
    const v = r[feature];
    let observed = false;
    if (meta.status === 'non-numeric') {
      observed = v !== null && v !== undefined && String(v).length > 0;
    } else {
      observed = Number.isFinite(v);
    }
    if (!observed) continue;
    if (r.regime === 'pre_2026_04') pre += 1;
    else post += 1;
  }
  return `pre=${pre},post=${post}`;
}

function buildPairLookup(all74Correlations) {
  const map = new Map();
  for (const rec of all74Correlations) {
    map.set(pairKey(rec.left, rec.right), rec);
  }
  return map;
}

function buildReturnLookup(returnCorrelations) {
  const map = new Map();
  for (const rec of returnCorrelations) map.set(rec.feature, rec);
  return map;
}

function buildDecisionRows(features, rows, includeIncremental, featureMeta, pairLookup, returnLookup) {
  const out = [];
  for (const feature of features) {
    const meta = featureMeta[feature];
    const returnRec = returnLookup.get(feature);

    let label = '維持';
    if (meta.status === 'numeric-constant') label = 'constant-pending-external-data';

    let standalone = `pearsonCorr=NA(${meta.reason})`;
    if (returnRec && Number.isFinite(returnRec.correlation)) {
      standalone = `pearsonCorr=${returnRec.correlation.toFixed(6)}`;
    }

    let redundancy = `highCorrCount=NA(${meta.reason})`;
    if (meta.status === 'numeric-variable') {
      const peers = [];
      for (const other of features) {
        if (other === feature) continue;
        const rec = pairLookup.get(pairKey(feature, other));
        if (!rec || !Number.isFinite(rec.correlation)) continue;
        if (rec.isHighCorrelation === 1) peers.push({ other, corr: rec.correlation });
      }
      peers.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));
      const top = peers.slice(0, 3).map((p) => `${p.other}(${p.corr.toFixed(3)})`).join('; ');
      redundancy = `highCorrCount=${peers.length}, top=${top || 'none'}, corrThreshold=${CORR_THRESHOLD}`;
    }

    const rec = {
      feature,
      label,
      standalone_points: standalone,
      redundancy_points: redundancy,
      regime_change_record: summarizeRegimeChange(rows, feature, meta)
    };
    if (includeIncremental) rec.incremental_points = 'not computed';
    out.push(rec);
  }
  return out;
}

function buildConnectedComponents(features, pairLookup, threshold) {
  const adj = new Map();
  for (const f of features) adj.set(f, new Set());

  for (let i = 0; i < features.length; i += 1) {
    for (let j = i + 1; j < features.length; j += 1) {
      const a = features[i];
      const b = features[j];
      const rec = pairLookup.get(pairKey(a, b));
      if (!rec) continue;
      if (!Number.isFinite(rec.correlation)) continue;
      if (Math.abs(rec.correlation) < threshold) continue;
      adj.get(a).add(b);
      adj.get(b).add(a);
    }
  }

  const visited = new Set();
  const components = [];
  for (const start of features) {
    if (visited.has(start)) continue;
    const stack = [start];
    visited.add(start);
    const comp = [];
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (const nx of adj.get(cur)) {
        if (visited.has(nx)) continue;
        visited.add(nx);
        stack.push(nx);
      }
    }
    comp.sort();
    components.push(comp);
  }
  components.sort((a, b) => a[0].localeCompare(b[0]));
  return components;
}

function chooseRepresentatives(component, pairLookup, returnLookup, threshold) {
  const ranked = [...component].sort((a, b) => {
    const ac = returnLookup.get(a);
    const bc = returnLookup.get(b);
    const av = Number.isFinite(ac?.correlation) ? Math.abs(ac.correlation) : -1;
    const bv = Number.isFinite(bc?.correlation) ? Math.abs(bc.correlation) : -1;
    if (av !== bv) return bv - av;
    return a.localeCompare(b);
  });

  const selected = [];
  for (const f of ranked) {
    if (selected.length === 0) {
      selected.push(f);
      continue;
    }
    let tooClose = false;
    for (const s of selected) {
      const rec = pairLookup.get(pairKey(f, s));
      if (rec && Number.isFinite(rec.correlation) && Math.abs(rec.correlation) >= threshold) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) selected.push(f);
  }

  if (selected.length === 0 && ranked.length) selected.push(ranked[0]);
  return selected;
}

function buildRedundancyGroupsAll74(features, pairLookup, returnLookup, threshold) {
  const components = buildConnectedComponents(features, pairLookup, threshold);
  const rows = [];

  for (let i = 0; i < components.length; i += 1) {
    const component = components[i];
    const edgeText = [];
    for (let a = 0; a < component.length; a += 1) {
      for (let b = a + 1; b < component.length; b += 1) {
        const left = component[a];
        const right = component[b];
        const rec = pairLookup.get(pairKey(left, right));
        if (!rec) continue;
        if (!Number.isFinite(rec.correlation)) continue;
        if (Math.abs(rec.correlation) < threshold) continue;
        edgeText.push(`${left}~${right}:${rec.correlation.toFixed(3)}`);
      }
    }

    let bestFeature = 'NA';
    let bestScore = 'NA';
    for (const f of component) {
      const rc = returnLookup.get(f);
      if (!Number.isFinite(rc?.correlation)) continue;
      if (bestFeature === 'NA' || Math.abs(rc.correlation) > Math.abs(Number(bestScore))) {
        bestFeature = f;
        bestScore = Math.abs(rc.correlation).toFixed(6);
      }
    }

    const reps = chooseRepresentatives(component, pairLookup, returnLookup, threshold);
    const repSet = new Set(reps);
    const compressionCandidates = component.filter((f) => !repSet.has(f));

    rows.push({
      group_name: `R${String(i + 1).padStart(2, '0')}`,
      features: component.join('|'),
      high_corr_pairs: edgeText.join('; '),
      best_standalone_feature: bestFeature,
      best_standalone_score: bestScore,
      recommended_representatives: reps.join('|'),
      compression_candidates: compressionCandidates.join('|')
    });
  }

  return rows;
}

function generateCompressionSummary(scopeName, features, featureMeta, all74Correlations) {
  let numericVariableCount = 0;
  let numericConstantCount = 0;
  let insufficientSampleCount = 0;
  let nonNumericCount = 0;
  for (const f of features) {
    const status = featureMeta[f]?.status;
    if (status === 'numeric-variable') numericVariableCount += 1;
    else if (status === 'numeric-constant') numericConstantCount += 1;
    else if (status === 'insufficient-sample') insufficientSampleCount += 1;
    else if (status === 'non-numeric') nonNumericCount += 1;
  }

  const set = new Set(features);
  const highCorrPairCount = all74Correlations.filter((r) => set.has(r.left) && set.has(r.right) && r.isHighCorrelation === 1).length;

  return {
    scope: scopeName,
    featureCount: features.length,
    numericVariableCount,
    numericConstantCount,
    insufficientSampleCount,
    nonNumericCount,
    highCorrPairCount
  };
}

function computeSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function getAllCacheCandles(code) {
  const filePath = path.join(CACHE_DIR, `jpx-stock-${code}-1d.json`);
  if (!fs.existsSync(filePath)) return null;
  const payload = readJson(filePath);
  const candles = payload?.chartData?.candles;
  if (!Array.isArray(candles)) return null;

  const cleaned = candles
    .map((c) => ({
      time: toDay(c.time),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume ?? 0)
    }))
    .filter((c) => c.time && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));

  return {
    name: payload?.name || payload?.data?.name || code,
    sector: payload?.sector || payload?.data?.sector || '',
    baselineTrend: payload?.baselineTrend || payload?.data?.baselineTrend || 'neutral',
    candles: cleaned
  };
}

function main() {
  ensureDir(OUT_DIR);

  const baselineShaBefore = computeSha256(BASELINE_PATH);

  const baseline = readJson(BASELINE_PATH);
  const presets = readJson(PRESET_PATH);
  const core39 = (presets.core39 || []).map(String);

  const wfFolds = baseline?.conditions?.walkForwardFolds || [];
  const evaluationPeriod = String(baseline?.conditions?.evaluationPeriod || `${SOURCE_START}..${SOURCE_END}`);
  const finalOosSeparated = String(baseline?.conditions?.finalOOSSeparated || `${FINAL_OOS_START}..${FINAL_OOS_END}`);

  const allRows = [];

  let futureTimestampReferenceCount = 0;
  let boundaryViolationCount = 0;
  let missingSignalIndex = 0;
  let nanOrInfinityCount = 0;

  for (const code of core39) {
    const cacheItem = getAllCacheCandles(code);
    if (!cacheItem) {
      missingSignalIndex += 1;
      continue;
    }

    const candles = cacheItem.candles.filter((c) => inRange(c.time, SOURCE_START, SOURCE_END));
    if (candles.length < MIN_HISTORY + HOLD_DAYS + 1) continue;

    const idxByDate = new Map();
    for (let i = 0; i < candles.length; i += 1) idxByDate.set(candles[i].time, i);

    for (let entryIndex = MIN_HISTORY; entryIndex < candles.length - 1; entryIndex += 1) {
      const signalCandle = candles[entryIndex + 1];
      if (!signalCandle) continue;
      const signalDate = signalCandle.time;

      if (inRange(signalDate, FINAL_OOS_START, FINAL_OOS_END)) continue;

      if (!inRange(signalDate, SOURCE_START, SOURCE_END)) {
        boundaryViolationCount += 1;
        continue;
      }

      const resolvedSignalIndex = idxByDate.get(signalDate);
      if (!Number.isInteger(resolvedSignalIndex)) {
        missingSignalIndex += 1;
        continue;
      }

      const decisionIndex = resolvedSignalIndex - 1;
      if (decisionIndex < MIN_HISTORY) {
        boundaryViolationCount += 1;
        continue;
      }
      if (resolvedSignalIndex + HOLD_DAYS - 1 >= candles.length) {
        boundaryViolationCount += 1;
        continue;
      }

      const latestFeatureTime = candles[decisionIndex]?.time;
      if (!latestFeatureTime || latestFeatureTime >= signalDate) {
        futureTimestampReferenceCount += 1;
      }

      const stockAtDecision = buildHistoricalStock({
        code,
        name: cacheItem.name,
        sector: cacheItem.sector,
        baselineTrend: cacheItem.baselineTrend
      }, candles, decisionIndex);

      const analysis = analyzeStock({ query: code, stock: stockAtDecision });
      if (!analysis) continue;
      if (analysis.signal !== 'BUY' || Number(analysis.score) < ENTRY_SCORE_FLOOR) continue;

      const tpRatio = Number(analysis.takeProfitPrice) / Math.max(Number(stockAtDecision.marketData.price), 1);
      const slRatio = Number(analysis.stopLossPrice) / Math.max(Number(stockAtDecision.marketData.price), 1);
      if (!Number.isFinite(tpRatio) || !Number.isFinite(slRatio)) continue;

      const trade = simulateCandidateTrade(candles, {
        entryIndex: decisionIndex,
        stopLossPrice: Number(analysis.stopLossPrice),
        takeProfitPrice: Number(analysis.takeProfitPrice)
      });
      if (!trade) continue;

      const regime = signalDate < '2026-04-01' ? 'pre_2026_04' : 'post_2026_04';
      const featurePack = computeFeaturePack(candles.slice(0, decisionIndex + 1), regime, cacheItem.baselineTrend, analysis);

      const row = {
        code,
        signalDate,
        regime,
        return10d: trade.return10d,
        ...featurePack
      };

      for (const f of [...GROUP_A_FEATURES, ...GROUP_B_FEATURES, ...GROUP_C_FEATURES, 'return10d']) {
        const v = row[f];
        if (typeof v === 'number' && !Number.isFinite(v)) {
          nanOrInfinityCount += 1;
        }
      }

      allRows.push(row);
    }
  }

  const rowsA = allRows.map((r) => {
    const o = { code: r.code, signalDate: r.signalDate, regime: r.regime };
    for (const f of GROUP_A_FEATURES) o[f] = r[f];
    o.return10d = r.return10d;
    return o;
  });

  const rowsB = allRows.map((r) => {
    const o = { code: r.code, signalDate: r.signalDate, regime: r.regime };
    for (const f of GROUP_B_FEATURES) o[f] = r[f];
    o.return10d = r.return10d;
    return o;
  });

  const rowsC = allRows.map((r) => {
    const o = { code: r.code, signalDate: r.signalDate, regime: r.regime };
    for (const f of GROUP_C_FEATURES) o[f] = r[f];
    o.return10d = r.return10d;
    return o;
  });

  const all74 = [...GROUP_A_FEATURES, ...GROUP_B_FEATURES, ...GROUP_C_FEATURES];
  const featureMetaAll = detectFeatureMeta(allRows, all74);
  const all74Correlations = calculateCorrelations(allRows, all74, featureMetaAll, CORR_THRESHOLD);
  const pairLookup = buildPairLookup(all74Correlations);
  const all74ReturnCorrelations = calculateReturnCorrelations(allRows, all74, featureMetaAll);
  const returnLookup = buildReturnLookup(all74ReturnCorrelations);

  const groupCorrelationsA = filterGroupCorrelations(all74Correlations, GROUP_A_FEATURES);
  const groupCorrelationsB = filterGroupCorrelations(all74Correlations, GROUP_B_FEATURES);
  const groupCorrelationsC = filterGroupCorrelations(all74Correlations, GROUP_C_FEATURES);

  const returnCorrA = all74ReturnCorrelations.filter((r) => GROUP_A_FEATURES.includes(r.feature));
  const returnCorrB = all74ReturnCorrelations.filter((r) => GROUP_B_FEATURES.includes(r.feature));
  const returnCorrC = all74ReturnCorrelations.filter((r) => GROUP_C_FEATURES.includes(r.feature));

  const decisionsA = buildDecisionRows(GROUP_A_FEATURES, rowsA, true, featureMetaAll, pairLookup, returnLookup);
  const decisionsB = buildDecisionRows(GROUP_B_FEATURES, rowsB, false, featureMetaAll, pairLookup, returnLookup);
  const decisionsC = buildDecisionRows(GROUP_C_FEATURES, rowsC, false, featureMetaAll, pairLookup, returnLookup);

  const redundancyRows = buildRedundancyGroupsAll74(all74, pairLookup, returnLookup, CORR_THRESHOLD);
  const compressionSummaryRows = [
    generateCompressionSummary('ALL74', all74, featureMetaAll, all74Correlations),
    generateCompressionSummary('A', GROUP_A_FEATURES, featureMetaAll, all74Correlations),
    generateCompressionSummary('B', GROUP_B_FEATURES, featureMetaAll, all74Correlations),
    generateCompressionSummary('C', GROUP_C_FEATURES, featureMetaAll, all74Correlations)
  ];

  const coveredFeatureList = redundancyRows.flatMap((r) => String(r.features).split('|').filter(Boolean));
  const coverageSet = new Set(coveredFeatureList);
  const coverageMissing = all74.filter((f) => !coverageSet.has(f));
  const coverageDuplicate = coveredFeatureList.length - coverageSet.size;
  const singletonGroupCount = redundancyRows.filter((r) => !String(r.features).includes('|')).length;

  writeCsv(path.join(OUT_DIR, 'feature_inventory_1d_base_rows.csv'), BASE_ROWS_A_HEADER, rowsA);
  writeCsv(path.join(OUT_DIR, 'feature_inventory_1d_base_rows_volume_breakout.csv'), BASE_ROWS_B_HEADER, rowsB);
  writeCsv(path.join(OUT_DIR, 'feature_inventory_1d_base_rows_context_news.csv'), BASE_ROWS_C_HEADER, rowsC);

  writeCsv(path.join(OUT_DIR, 'feature_inventory_1d_feature_decisions.csv'), DECISION_HEADER_A, decisionsA);
  writeCsv(path.join(OUT_DIR, 'feature_inventory_1d_feature_decisions_volume_breakout.csv'), DECISION_HEADER_B, decisionsB);
  writeCsv(path.join(OUT_DIR, 'feature_inventory_1d_feature_decisions_context_news.csv'), DECISION_HEADER_B, decisionsC);

  writeCsv(
    path.join(OUT_DIR, 'feature_inventory_1d_correlations.csv'),
    ['left', 'right', 'correlation', 'sampleCount', 'status', 'reason', 'isHighCorrelation'],
    groupCorrelationsA
  );
  writeCsv(
    path.join(OUT_DIR, 'feature_inventory_1d_correlations_volume_breakout.csv'),
    ['left', 'right', 'correlation', 'sampleCount', 'status', 'reason', 'isHighCorrelation'],
    groupCorrelationsB
  );
  writeCsv(
    path.join(OUT_DIR, 'feature_inventory_1d_correlations_context_news.csv'),
    ['left', 'right', 'correlation', 'sampleCount', 'status', 'reason', 'isHighCorrelation'],
    groupCorrelationsC
  );

  writeCsv(
    path.join(OUT_DIR, 'feature_inventory_1d_return_correlations.csv'),
    ['feature', 'correlation', 'sampleCount', 'status', 'reason'],
    returnCorrA
  );
  writeCsv(
    path.join(OUT_DIR, 'feature_inventory_1d_return_correlations_volume_breakout.csv'),
    ['feature', 'correlation', 'sampleCount', 'status', 'reason'],
    returnCorrB
  );
  writeCsv(
    path.join(OUT_DIR, 'feature_inventory_1d_return_correlations_context_news.csv'),
    ['feature', 'correlation', 'sampleCount', 'status', 'reason'],
    returnCorrC
  );

  writeCsv(
    path.join(OUT_DIR, 'feature_inventory_1d_redundancy_groups_all74.csv'),
    ['group_name', 'features', 'high_corr_pairs', 'best_standalone_feature', 'best_standalone_score', 'recommended_representatives', 'compression_candidates'],
    redundancyRows
  );

  writeCsv(
    path.join(OUT_DIR, 'feature_inventory_1d_feature_compression_summary.csv'),
    ['scope', 'featureCount', 'numericVariableCount', 'numericConstantCount', 'insufficientSampleCount', 'nonNumericCount', 'highCorrPairCount'],
    compressionSummaryRows
  );

  const baseRowsOosCount = allRows.filter((r) => inRange(r.signalDate, FINAL_OOS_START, FINAL_OOS_END)).length;
  const featureCount = all74.length;

  const headerCheck = {
    baseRows: BASE_ROWS_A_HEADER.join(',') === ['code', 'signalDate', 'regime', ...GROUP_A_FEATURES, 'return10d'].join(','),
    volume: BASE_ROWS_B_HEADER.join(',') === ['code', 'signalDate', 'regime', ...GROUP_B_FEATURES, 'return10d'].join(','),
    context: BASE_ROWS_C_HEADER.join(',') === ['code', 'signalDate', 'regime', ...GROUP_C_FEATURES, 'return10d'].join(','),
    decisionsA: DECISION_HEADER_A.join(',') === 'feature,label,standalone_points,redundancy_points,incremental_points,regime_change_record',
    decisionsB: DECISION_HEADER_B.join(',') === 'feature,label,standalone_points,redundancy_points,regime_change_record'
  };

  const baselineShaAfter = computeSha256(BASELINE_PATH);

  const summary = {
    generatedAt: new Date().toISOString(),
    scriptType: 'phase9_74_feature_inventory_writer',
    inputs: {
      baseline: BASELINE_PATH,
      universePresets: PRESET_PATH,
      sourcePeriod: `${SOURCE_START}..${SOURCE_END}`,
      finalOosExcluded: `${FINAL_OOS_START}..${FINAL_OOS_END}`,
      holdDays: HOLD_DAYS,
      minHistory: MIN_HISTORY,
      stopLossPct: STOP_LOSS_PCT,
      takeProfitPct: TAKE_PROFIT_PCT,
      corrThreshold: CORR_THRESHOLD,
      repFeatureCountUsedAsCap: false,
      incrementalPoints: 'not computed',
      marketNewsMode: 'C_fallback_only_no_external_fetch'
    },
    baselineConditions: {
      evaluationPeriod,
      finalOosSeparated,
      walkForwardFolds: wfFolds
    },
    counts: {
      rows: allRows.length,
      codes: new Set(allRows.map((r) => r.code)).size,
      featureCount,
      groupCount: {
        groupA: GROUP_A_FEATURES.length,
        groupB: GROUP_B_FEATURES.length,
        groupC: GROUP_C_FEATURES.length
      },
      finalOOSRows: baseRowsOosCount,
      futureTimestampReferenceCount,
      boundaryViolationCount,
      missingSignalIndex,
      nanOrInfinityCount,
      redundancyGroupCount: redundancyRows.length,
      singletonGroupCount,
      highCorrPairCountAll74: all74Correlations.filter((r) => r.isHighCorrelation === 1).length
    },
    coverage: {
      requiredFeatureCount: all74.length,
      assignedFeatureCount: coverageSet.size,
      duplicateAssignments: coverageDuplicate,
      missingFeatures: coverageMissing
    },
    featureMetaCounts: {
      numericConstant: all74.filter((f) => featureMetaAll[f].status === 'numeric-constant').length,
      numericVariable: all74.filter((f) => featureMetaAll[f].status === 'numeric-variable').length,
      insufficientSample: all74.filter((f) => featureMetaAll[f].status === 'insufficient-sample').length,
      nonNumeric: all74.filter((f) => featureMetaAll[f].status === 'non-numeric').length
    },
    headers: {
      baseRows: BASE_ROWS_A_HEADER,
      baseRowsVolume: BASE_ROWS_B_HEADER,
      baseRowsContext: BASE_ROWS_C_HEADER,
      featureDecisions: DECISION_HEADER_A,
      featureDecisionsNoIncremental: DECISION_HEADER_B,
      checks: headerCheck
    },
    constantsPolicy: {
      standaloneAndRedundancyAsNAForConstant: true,
      labelRule: 'numeric-constant only -> constant-pending-external-data'
    },
    metaNotes: {
      recommendedRepresentatives: 'recommended_representatives is statistical summary candidate information for high-correlation groups; it does not imply automatic feature adoption or automatic feature exclusion.',
      inventoryOnly: 'feature_decisions in this writer are inventory-only and not an automated feature selection decision.'
    },
    baselineSha256: {
      before: baselineShaBefore,
      after: baselineShaAfter,
      unchanged: baselineShaBefore === baselineShaAfter
    },
    outputs: {
      outDir: OUT_DIR,
      files: [
        'feature_inventory_1d_base_rows.csv',
        'feature_inventory_1d_base_rows_volume_breakout.csv',
        'feature_inventory_1d_base_rows_context_news.csv',
        'feature_inventory_1d_feature_decisions.csv',
        'feature_inventory_1d_feature_decisions_volume_breakout.csv',
        'feature_inventory_1d_feature_decisions_context_news.csv',
        'feature_inventory_1d_correlations.csv',
        'feature_inventory_1d_correlations_volume_breakout.csv',
        'feature_inventory_1d_correlations_context_news.csv',
        'feature_inventory_1d_return_correlations.csv',
        'feature_inventory_1d_return_correlations_volume_breakout.csv',
        'feature_inventory_1d_return_correlations_context_news.csv',
        'feature_inventory_1d_redundancy_groups_all74.csv',
        'feature_inventory_1d_feature_compression_summary.csv',
        'phase9-74-inventory-meta.json'
      ]
    }
  };

  writeJson(path.join(OUT_DIR, 'phase9-74-inventory-meta.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main();
