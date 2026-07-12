"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMockChartData = createMockChartData;
function formatDate(date) {
    return date.toISOString().slice(0, 10);
}
function buildSeed(value) {
    return [...value].reduce((total, char) => total + char.charCodeAt(0), 0);
}
function createMockChartData(code) {
    const seed = buildSeed(code);
    const candles = [];
    const start = new Date();
    let price = 1200 + (seed % 3500);
    start.setDate(start.getDate() - 180);
    for (let index = 0; index < 130; index += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        if (date.getDay() === 0 || date.getDay() === 6) {
            continue;
        }
        const wave = Math.sin((index + seed) / 7) * 28;
        const drift = (index % 11) - 5;
        const open = Math.max(100, price + wave);
        const close = Math.max(100, open + drift + Math.cos(index / 5) * 18);
        const high = Math.max(open, close) + 12 + (seed % 9);
        const low = Math.min(open, close) - 12 - (seed % 7);
        candles.push({
            time: formatDate(date),
            open: Math.round(open),
            high: Math.round(high),
            low: Math.round(low),
            close: Math.round(close),
            volume: 800000 + ((seed + index * 7919) % 2400000),
        });
        price = close;
    }
    return { candles };
}
