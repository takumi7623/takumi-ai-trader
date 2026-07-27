import test from "node:test";
import assert from "node:assert/strict";

import { fetchJpxStock } from "./stockProviders";

type FetchCall = {
  url: string;
};

function makeMinuteRows(date: string, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const minute = String(index).padStart(2, "0");
    const price = 100 + index;

    return {
      Date: date,
      Time: `09:${minute}`,
      Open: price,
      High: price + 1,
      Low: price - 1,
      Close: price + 0.5,
      Volume: 1000 + index,
      Turnover: (1000 + index) * (price + 0.5),
    };
  });
}

function makeDailyRows() {
  return [
    {
      Date: "2026-07-26",
      Open: 200,
      High: 210,
      Low: 195,
      Close: 205,
      Volume: 5000,
    },
    {
      Date: "2026-07-25",
      Open: 190,
      High: 205,
      Low: 188,
      Close: 200,
      Volume: 4800,
    },
  ];
}

function installFetchMock() {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });

    if (url.includes("/v2/equities/bars/minute")) {
      const parsed = new URL(url);
      const tradeDate = parsed.searchParams.get("date")
        ?? parsed.searchParams.get("from")
        ?? parsed.searchParams.get("start")
        ?? "2026-07-27";
      const rows = makeMinuteRows(tradeDate, 15);
      return new Response(JSON.stringify({ data: rows }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.includes("/v2/equities/bars/daily") || url.includes("/v2/prices/daily_quotes")) {
      return new Response(JSON.stringify({ data: makeDailyRows() }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.includes("/v2/equities/master")) {
      return new Response(JSON.stringify({
        data: [
          {
            Code: "7203",
            CompanyName: "トヨタ自動車",
            Sector33CodeName: "輸送用機器",
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response("not found", { status: 404 });
  };

  return () => {
    globalThis.fetch = originalFetch;
    return calls;
  };
}

function setJpxAuthEnv() {
  const prev = {
    JPX_API_KEY: process.env.JPX_API_KEY,
    JPX_ID_TOKEN: process.env.JPX_ID_TOKEN,
    JPX_MAIL_ADDRESS: process.env.JPX_MAIL_ADDRESS,
    JPX_PASSWORD: process.env.JPX_PASSWORD,
  };

  process.env.JPX_API_KEY = "test-key";
  delete process.env.JPX_ID_TOKEN;
  delete process.env.JPX_MAIL_ADDRESS;
  delete process.env.JPX_PASSWORD;

  return () => {
    if (prev.JPX_API_KEY === undefined) {
      delete process.env.JPX_API_KEY;
    } else {
      process.env.JPX_API_KEY = prev.JPX_API_KEY;
    }

    if (prev.JPX_ID_TOKEN === undefined) {
      delete process.env.JPX_ID_TOKEN;
    } else {
      process.env.JPX_ID_TOKEN = prev.JPX_ID_TOKEN;
    }

    if (prev.JPX_MAIL_ADDRESS === undefined) {
      delete process.env.JPX_MAIL_ADDRESS;
    } else {
      process.env.JPX_MAIL_ADDRESS = prev.JPX_MAIL_ADDRESS;
    }

    if (prev.JPX_PASSWORD === undefined) {
      delete process.env.JPX_PASSWORD;
    } else {
      process.env.JPX_PASSWORD = prev.JPX_PASSWORD;
    }
  };
}

test("5m JPX stock uses official minute bars and preserves intraday timestamps", async () => {
  const restoreEnv = setJpxAuthEnv();
  const restoreFetch = installFetchMock();

  try {
    const stock = await fetchJpxStock("9999", undefined, "5m");
    assert.ok(stock);
    assert.equal(stock?.timeframe, "5m");
    assert.ok((stock?.chartData?.candles?.length ?? 0) > 0);
    const candle = stock?.chartData?.candles[0];
    assert.ok(candle);
    assert.match(candle.time, /T\d{2}:\d{2}:00\+09:00/);
    assert.equal(typeof (candle as { barStartAt?: string }).barStartAt, "string");
    assert.equal(typeof (candle as { barEndAt?: string }).barEndAt, "string");
    assert.equal(typeof (candle as { observedAt?: string }).observedAt, "string");
    assert.equal(typeof (candle as { receivedAt?: string }).receivedAt, "string");
  } finally {
    const calls = restoreFetch();
    restoreEnv();

    assert.ok(calls.some((call) => call.url.includes("/v2/equities/bars/minute")));
    assert.ok(!calls.some((call) => call.url.includes("/v2/equities/bars/daily")));
  }
});

test("1d JPX stock stays on the daily path", async () => {
  const restoreEnv = setJpxAuthEnv();
  const restoreFetch = installFetchMock();

  try {
    const stock = await fetchJpxStock("7203", undefined, "1d");
    assert.ok(stock);
    assert.equal(stock?.timeframe, "1d");
    assert.ok((stock?.chartData?.candles?.length ?? 0) > 0);
    assert.match(stock!.chartData!.candles[0].time, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    const calls = restoreFetch();
    restoreEnv();

    assert.ok(calls.some((call) => call.url.includes("/v2/equities/bars/daily") || call.url.includes("/v2/prices/daily_quotes")));
    assert.ok(!calls.some((call) => call.url.includes("/v2/equities/bars/minute")));
  }
});

test("15m JPX stock uses official minute bars and preserves intraday timestamps", async () => {
  const restoreEnv = setJpxAuthEnv();
  const restoreFetch = installFetchMock();

  try {
    const stock = await fetchJpxStock("9998", undefined, "15m");
    assert.ok(stock);
    assert.equal(stock?.timeframe, "15m");
    assert.ok((stock?.chartData?.candles?.length ?? 0) > 0);
    const candle = stock?.chartData?.candles[0];
    assert.ok(candle);
    assert.match(candle.time, /T\d{2}:\d{2}:00\+09:00/);
    assert.equal(typeof (candle as { barStartAt?: string }).barStartAt, "string");
    assert.equal(typeof (candle as { barEndAt?: string }).barEndAt, "string");
    assert.equal(typeof (candle as { observedAt?: string }).observedAt, "string");
    assert.equal(typeof (candle as { receivedAt?: string }).receivedAt, "string");
  } finally {
    const calls = restoreFetch();
    restoreEnv();

    assert.ok(calls.some((call) => call.url.includes("/v2/equities/bars/minute")));
    assert.ok(!calls.some((call) => call.url.includes("/v2/equities/bars/daily")));
  }
});