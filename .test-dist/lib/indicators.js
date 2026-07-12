"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateSma = calculateSma;
exports.calculateRsi = calculateRsi;
exports.calculateMacd = calculateMacd;
exports.calculateVolumeAverage = calculateVolumeAverage;
exports.calculateBollingerBands = calculateBollingerBands;
exports.calculateAtr = calculateAtr;
exports.calculateAdx = calculateAdx;
exports.calculateSupportResistance = calculateSupportResistance;
exports.calculateVolumeSurgeRate = calculateVolumeSurgeRate;
function round(value) {
    return Math.round(value * 100) / 100;
}
function calculateSma(candles, period) {
    const points = [];
    for (let index = period - 1; index < candles.length; index += 1) {
        const slice = candles.slice(index - period + 1, index + 1);
        const sum = slice.reduce((total, candle) => total + candle.close, 0);
        points.push({
            time: candles[index].time,
            value: round(sum / period),
        });
    }
    return points;
}
function calculateRsi(candles, period = 14) {
    const points = [];
    for (let index = period; index < candles.length; index += 1) {
        let gains = 0;
        let losses = 0;
        for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
            const change = candles[cursor].close - candles[cursor - 1].close;
            if (change >= 0) {
                gains += change;
            }
            else {
                losses += Math.abs(change);
            }
        }
        const averageGain = gains / period;
        const averageLoss = losses / period;
        const rsi = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
        points.push({
            time: candles[index].time,
            value: round(rsi),
        });
    }
    return points;
}
function calculateEma(values, period) {
    const multiplier = 2 / (period + 1);
    const ema = [];
    values.forEach((value, index) => {
        if (index === 0) {
            ema.push(value);
            return;
        }
        ema.push(value * multiplier + ema[index - 1] * (1 - multiplier));
    });
    return ema;
}
function calculateMacd(candles) {
    const closes = candles.map((candle) => candle.close);
    const ema12 = calculateEma(closes, 12);
    const ema26 = calculateEma(closes, 26);
    const macdLine = closes.map((_, index) => ema12[index] - ema26[index]);
    const signalLine = calculateEma(macdLine, 9);
    return candles.slice(26).map((candle, offset) => {
        const index = offset + 26;
        const macd = macdLine[index];
        const signal = signalLine[index];
        return {
            time: candle.time,
            macd: round(macd),
            signal: round(signal),
            histogram: round(macd - signal),
        };
    });
}
function calculateVolumeAverage(candles, period = 20) {
    if (candles.length === 0) {
        return 0;
    }
    const values = candles.slice(-period).map((candle) => candle.volume);
    const total = values.reduce((sum, value) => sum + value, 0);
    return round(total / values.length);
}
function calculateBollingerBands(candles, period = 20, multiplier = 2) {
    const points = [];
    for (let index = period - 1; index < candles.length; index += 1) {
        const slice = candles.slice(index - period + 1, index + 1);
        const closes = slice.map((candle) => candle.close);
        const middle = closes.reduce((sum, value) => sum + value, 0) / period;
        const variance = closes.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
        const deviation = Math.sqrt(variance);
        points.push({
            time: candles[index].time,
            middle: round(middle),
            upper: round(middle + multiplier * deviation),
            lower: round(middle - multiplier * deviation),
        });
    }
    return points;
}
function calculateAtr(candles, period = 14) {
    const points = [];
    for (let index = 1; index < candles.length; index += 1) {
        const current = candles[index];
        const previous = candles[index - 1];
        const trueRange = Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
        points.push({
            time: current.time,
            value: trueRange,
        });
    }
    if (points.length < period) {
        return [];
    }
    const atrPoints = [];
    for (let index = period - 1; index < points.length; index += 1) {
        const slice = points.slice(index - period + 1, index + 1);
        const average = slice.reduce((sum, point) => sum + point.value, 0) / period;
        atrPoints.push({
            time: points[index].time,
            value: round(average),
        });
    }
    return atrPoints;
}
function calculateAdx(candles, period = 14) {
    if (candles.length <= period * 2) {
        return [];
    }
    const trValues = [];
    const plusDmValues = [];
    const minusDmValues = [];
    for (let index = 1; index < candles.length; index += 1) {
        const current = candles[index];
        const previous = candles[index - 1];
        const upMove = current.high - previous.high;
        const downMove = previous.low - current.low;
        const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
        const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
        const trueRange = Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
        trValues.push(trueRange);
        plusDmValues.push(plusDm);
        minusDmValues.push(minusDm);
    }
    const dxValues = [];
    for (let index = period - 1; index < trValues.length; index += 1) {
        const trSlice = trValues.slice(index - period + 1, index + 1);
        const plusSlice = plusDmValues.slice(index - period + 1, index + 1);
        const minusSlice = minusDmValues.slice(index - period + 1, index + 1);
        const trSum = trSlice.reduce((sum, value) => sum + value, 0);
        const plusSum = plusSlice.reduce((sum, value) => sum + value, 0);
        const minusSum = minusSlice.reduce((sum, value) => sum + value, 0);
        if (trSum === 0) {
            dxValues.push(0);
            continue;
        }
        const plusDi = (100 * plusSum) / trSum;
        const minusDi = (100 * minusSum) / trSum;
        const denominator = plusDi + minusDi;
        const dx = denominator === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / denominator;
        dxValues.push(dx);
    }
    if (dxValues.length < period) {
        return [];
    }
    const adxPoints = [];
    for (let index = period - 1; index < dxValues.length; index += 1) {
        const slice = dxValues.slice(index - period + 1, index + 1);
        const average = slice.reduce((sum, value) => sum + value, 0) / period;
        adxPoints.push({
            time: candles[index + period].time,
            value: round(average),
        });
    }
    return adxPoints;
}
function calculateSupportResistance(candles, lookback = 20) {
    const slice = candles.slice(-lookback);
    if (slice.length === 0) {
        return { support: 0, resistance: 0 };
    }
    return {
        support: round(slice.reduce((min, candle) => Math.min(min, candle.low), slice[0].low)),
        resistance: round(slice.reduce((max, candle) => Math.max(max, candle.high), slice[0].high)),
    };
}
function calculateVolumeSurgeRate(candles, period = 20) {
    if (candles.length < 2) {
        return 0;
    }
    const averageVolume = calculateVolumeAverage(candles.slice(0, -1), period);
    if (averageVolume === 0) {
        return 0;
    }
    const latestVolume = candles[candles.length - 1].volume;
    return round(latestVolume / averageVolume);
}
