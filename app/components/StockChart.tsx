"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type LineData,
  type Time,
} from "lightweight-charts";
import { calculateMacd, calculateRsi, calculateSma } from "@/lib/indicators";
import type { StockChartData } from "@/lib/types";

type StockChartProps = {
  data: StockChartData;
  label: string;
  code: string;
  timeframe: "5m" | "15m" | "1d";
  realtime?: boolean;
  signal?: "BUY" | "SELL" | "HOLD";
};

function toLineData(points: { time: string; value: number }[]): LineData[] {
  return points.map((point) => ({
    time: point.time,
    value: point.value,
  }));
}

export default function StockChart({
  data,
  label,
  code,
  timeframe,
  realtime = true,
  signal = "HOLD",
}: StockChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const pollingRef = useRef<{ inFlight: boolean; lastSignature: string }>({
    inFlight: false,
    lastSignature: "",
  });
  const backoffRef = useRef(0);
  const [liveCandles, setLiveCandles] = useState(data.candles);
  const effectiveCandles = useMemo(() => {
    if (liveCandles.length === 0) {
      return data.candles;
    }

    const propLast = data.candles[data.candles.length - 1]?.time;
    const liveLast = liveCandles[liveCandles.length - 1]?.time;

    if (propLast && liveLast && propLast > liveLast) {
      return data.candles;
    }

    return liveCandles;
  }, [data.candles, liveCandles]);

  useEffect(() => {
    if (!realtime || !code) {
      return;
    }

    let disposed = false;
    const pollingState = pollingRef.current;

    const signatureOf = (candles: StockChartData["candles"]) => {
      const last = candles[candles.length - 1];
      if (!last) {
        return "";
      }

      return `${candles.length}:${last.time}:${last.close}:${last.volume}`;
    };

    if (!pollingState.lastSignature) {
      pollingState.lastSignature = signatureOf(data.candles);
    }

    const poll = async () => {
      if (disposed || pollingState.inFlight || document.visibilityState === "hidden") {
        return;
      }

      pollingState.inFlight = true;

      try {
        const response = await fetch(`/api/stocks/${encodeURIComponent(code)}?timeframe=${timeframe}`, {
          cache: "no-store",
        });

        if (!response.ok || disposed) {
          return;
        }

        const payload = (await response.json()) as {
          data?: { chartData?: StockChartData } | null;
        };

        const nextCandles = payload.data?.chartData?.candles ?? [];
        const nextSignature = signatureOf(nextCandles);
        if (!disposed && nextCandles.length > 0 && nextSignature !== pollingState.lastSignature) {
          pollingState.lastSignature = nextSignature;
          setLiveCandles(nextCandles);
          backoffRef.current = 0;
        }
      } catch {
        // Ignore transient polling failures to keep chart stable.
        backoffRef.current = Math.min(backoffRef.current + 1, 4);
      } finally {
        pollingState.inFlight = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
      }
    };

    void poll();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const baseInterval = timeframe === "5m" ? 30000 : timeframe === "15m" ? 60000 : 90000;
    let timer: number | null = null;

    const schedule = () => {
      if (disposed) {
        return;
      }

      const backoffMultiplier = 1 + backoffRef.current * 0.5;
      const nextDelay = Math.round(baseInterval * backoffMultiplier);
      timer = window.setTimeout(async () => {
        await poll();
        schedule();
      }, nextDelay);
    };

    schedule();

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [code, data.candles, realtime, timeframe]);

  const seriesData = useMemo(() => {
    const candleData: CandlestickData[] = effectiveCandles.map((candle) => ({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));
    const volumeData: HistogramData[] = effectiveCandles.map((candle) => ({
      time: candle.time,
      value: candle.volume,
      color: candle.close >= candle.open ? "#22c55e66" : "#ef444466",
    }));
    const macd = calculateMacd(effectiveCandles);

    return {
      candles: candleData,
      volume: volumeData,
      ma5: toLineData(calculateSma(effectiveCandles, 5)),
      ma25: toLineData(calculateSma(effectiveCandles, 25)),
      ma75: toLineData(calculateSma(effectiveCandles, 75)),
      rsi: toLineData(calculateRsi(effectiveCandles)),
      macd: macd.map((point) => ({
        time: point.time,
        value: point.macd,
      })),
      macdSignal: macd.map((point) => ({
        time: point.time,
        value: point.signal,
      })),
      macdHistogram: macd.map((point) => ({
        time: point.time,
        value: point.histogram,
        color: point.histogram >= 0 ? "#22c55e88" : "#ef444488",
      })),
    };
  }, [effectiveCandles]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container || seriesData.candles.length === 0) {
      return;
    }

    const chart = createChart(container, {
      autoSize: true,
      height: 620,
      layout: {
        background: { type: ColorType.Solid, color: "#030712" },
        textColor: "#d1d5db",
        panes: {
          separatorColor: "#374151",
          separatorHoverColor: "#22d3ee",
        },
      },
      grid: {
        vertLines: { color: "#111827" },
        horzLines: { color: "#111827" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: "#374151",
      },
      timeScale: {
        borderColor: "#374151",
        timeVisible: timeframe !== "1d",
      },
    });

    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    const ma5Series = chart.addSeries(LineSeries, {
      color: "#facc15",
      lineWidth: 2,
      title: "5MA",
    });
    const ma25Series = chart.addSeries(LineSeries, {
      color: "#38bdf8",
      lineWidth: 2,
      title: "25MA",
    });
    const ma75Series = chart.addSeries(LineSeries, {
      color: "#c084fc",
      lineWidth: 2,
      title: "75MA",
    });
    const rsiSeries = chart.addSeries(
      LineSeries,
      {
        color: "#fb923c",
        lineWidth: 2,
        title: "RSI",
      },
      1,
    );
    const macdSeries = chart.addSeries(
      LineSeries,
      {
        color: "#22d3ee",
        lineWidth: 2,
        title: "MACD",
      },
      2,
    );
    const macdSignalSeries = chart.addSeries(
      LineSeries,
      {
        color: "#f472b6",
        lineWidth: 2,
        title: "Signal",
      },
      2,
    );
    const macdHistogramSeries = chart.addSeries(
      HistogramSeries,
      {
        title: "MACD Hist",
      },
      2,
    );

    candleSeries.setData(seriesData.candles);
    volumeSeries.setData(seriesData.volume);
    ma5Series.setData(seriesData.ma5);
    ma25Series.setData(seriesData.ma25);
    ma75Series.setData(seriesData.ma75);
    rsiSeries.setData(seriesData.rsi);
    macdSeries.setData(seriesData.macd);
    macdSignalSeries.setData(seriesData.macdSignal);
    macdHistogramSeries.setData(seriesData.macdHistogram);

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.82,
        bottom: 0,
      },
    });
    rsiSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.12,
        bottom: 0.12,
      },
    });

    const markerColor = signal === "BUY" ? "#22c55e" : signal === "SELL" ? "#ef4444" : "#facc15";
    const lastCandle = seriesData.candles[seriesData.candles.length - 1];
    const markerData = [
      {
        time: lastCandle.time as Time,
        value: lastCandle.close,
      },
    ];
    const signalSeries = chart.addSeries(LineSeries, {
      color: markerColor,
      lineWidth: 1,
      priceScaleId: "right",
    });
    signalSeries.setData(markerData);
    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [seriesData, signal, timeframe]);

  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-gray-400">チャート</p>
          <h4 className="text-xl font-bold text-white">{label}</h4>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-gray-400">
          <span className="text-yellow-300">5MA</span>
          <span className="text-sky-300">25MA</span>
          <span className="text-purple-300">75MA</span>
          <span>出来高 / RSI / MACD</span>
        </div>
      </div>

      <div
        ref={containerRef}
        className="h-[620px] w-full overflow-hidden rounded-lg border border-gray-700 bg-gray-950"
      />
    </div>
  );
}
