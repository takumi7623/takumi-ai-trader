import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyDataQuality,
  classifyLiquidity,
  fetchDataQualityWindow,
  fetchLiquidityTurnoverWindow,
  generateRecentBusinessDates,
  isUsableLiquidityDayRows,
  selectV1Candidates,
} from "./tepou30";
import type { StockCandle } from "./types";

// Dates already present in the repo's real .cache/jquants-bars/ (read-only hits,
// no network call and no cache write occur for these).
const EXISTING_CACHED_DATES = [
  "2026-04-15",
  "2026-04-16",
  "2026-04-17",
  "2026-04-20",
  "2026-04-21",
];

// A deliberately fictitious date that cannot exist in the real bars cache, used
// only to simulate a failed/malformed fetch via a mocked globalThis.fetch. Since
// the simulated response never reaches a successful (rows.length > 0) state,
// fetchDailyBarsByDate never calls saveBarsCache, so no cache file is written.
const UNCACHED_TEST_DATE = "1900-01-01";

function makeCandidate(code: string) {
  return {
    code,
    meta: { name: code, sector: "テスト" },
    candles: [] as StockCandle[],
  };
}

test("generateRecentBusinessDates never generates a future date and skips weekends", () => {
  const dates = generateRecentBusinessDates(10);
  assert.equal(dates.length, 10);

  const subscriptionEndDate = new Date("2026-04-21T00:00:00.000Z");
  const upperBound = new Date(Math.min(Date.now(), subscriptionEndDate.getTime()));

  for (const dateText of dates) {
    const parsed = new Date(`${dateText}T00:00:00.000Z`);
    assert.ok(parsed.getTime() <= upperBound.getTime(), `${dateText} must not be after the allowed upper bound`);
    const day = parsed.getUTCDay();
    assert.notEqual(day, 0, `${dateText} must not be a Sunday`);
    assert.notEqual(day, 6, `${dateText} must not be a Saturday`);
  }
});

test("isUsableLiquidityDayRows rejects empty, non-array, and schema-mismatched responses", () => {
  assert.equal(isUsableLiquidityDayRows([]), false);
  assert.equal(isUsableLiquidityDayRows(undefined), false);
  assert.equal(isUsableLiquidityDayRows(null), false);
  assert.equal(isUsableLiquidityDayRows({}), false);
  assert.equal(isUsableLiquidityDayRows([{ NotCode: "7203" }]), false);
  assert.equal(isUsableLiquidityDayRows([{ Code: "7203", Va: 1000 }]), true);
});

test("classifyLiquidity: validDays >= 10 is ok, boundary value 10 is ok (off-by-one check)", () => {
  const exactlyTen = Array.from({ length: 10 }, (_, index) => 1_500_000 + index);
  const result = classifyLiquidity(exactlyTen);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.validDays, 10);
  }
});

test("classifyLiquidity: validDays === 9 (just below boundary) is insufficientData", () => {
  const nine = Array.from({ length: 9 }, (_, index) => 1_500_000 + index);
  const result = classifyLiquidity(nine);
  assert.equal(result.status, "insufficientData");
  if (result.status === "insufficientData") {
    assert.equal(result.validDays, 9);
  }
});

test("classifyLiquidity: validDays === 0 is missingMarketData", () => {
  assert.equal(classifyLiquidity([]).status, "missingMarketData");
});

test("classifyLiquidity: undefined values is missingMarketData", () => {
  assert.equal(classifyLiquidity(undefined).status, "missingMarketData");
});

test("selectV1Candidates: turnoverByCode === null returns candidates unchanged", () => {
  const candidates = [makeCandidate("1001"), makeCandidate("1002")];
  const result = selectV1Candidates(candidates, null);
  assert.deepEqual(result, candidates);
});

test("selectV1Candidates: applies the 1,000,000 threshold only to codes with >=10 valid days", () => {
  const candidates = [
    makeCandidate("OK_ABOVE"), // 10 valid days, average above threshold -> kept
    makeCandidate("OK_BELOW"), // 10 valid days, average below threshold -> excluded
    makeCandidate("INSUFFICIENT"), // 9 valid days -> excluded regardless of average
    makeCandidate("MISSING"), // no data at all -> excluded
    makeCandidate("NOT_IN_MAP"), // code absent from turnoverByCode entirely -> excluded
  ];

  const turnoverByCode = new Map<string, number[]>([
    ["OK_ABOVE", Array.from({ length: 10 }, () => 5_000_000)],
    ["OK_BELOW", Array.from({ length: 10 }, () => 500_000)],
    ["INSUFFICIENT", Array.from({ length: 9 }, () => 5_000_000)],
    ["MISSING", []],
  ]);

  const result = selectV1Candidates(candidates, turnoverByCode).map((candidate) => candidate.code);
  assert.deepEqual(result, ["OK_ABOVE"]);
});

test("selectV1Candidates: does not alter unrelated candidate fields (no data-quality filter side effects)", () => {
  const candidate = makeCandidate("7203");
  const turnoverByCode = new Map<string, number[]>([
    ["7203", Array.from({ length: 10 }, () => 5_000_000)],
  ]);

  const [result] = selectV1Candidates([candidate], turnoverByCode);
  assert.equal(result, candidate);
});

test("fetchLiquidityTurnoverWindow: all target dates available (existing real cache, read-only) returns a populated map", async () => {
  const universeSet = new Set(["13010", "1301"]);
  const result = await fetchLiquidityTurnoverWindow(EXISTING_CACHED_DATES, universeSet);
  assert.ok(result !== null);
  assert.ok((result as Map<string, number[]>).size > 0);
});

test("fetchLiquidityTurnoverWindow: one failing date (HTTP error) among the target dates causes the whole window to return null", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("19000101")) {
      return new Response("simulated failure", { status: 500 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const dates = [...EXISTING_CACHED_DATES.slice(0, 4), UNCACHED_TEST_DATE];
    const universeSet = new Set(["13010"]);
    const result = await fetchLiquidityTurnoverWindow(dates, universeSet);
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchLiquidityTurnoverWindow: a malformed (schema-mismatched) response for one date also causes the window to return null", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("19000101")) {
      // Valid HTTP 200 but no usable "data" array: must be treated the same as a failure.
      return new Response(JSON.stringify({ unexpected: "shape" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const dates = [...EXISTING_CACHED_DATES.slice(0, 4), UNCACHED_TEST_DATE];
    const universeSet = new Set(["13010"]);
    const result = await fetchLiquidityTurnoverWindow(dates, universeSet);
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- classifyDataQuality helpers -------------------------------------------

function buildPresence(length: number, falseIndices: number[]): boolean[] {
  const presence = new Array(length).fill(true) as boolean[];
  for (const index of falseIndices) {
    presence[index] = false;
  }
  return presence;
}

test("classifyDataQuality: 60/60 present (clean baseline) is ok", () => {
  const presence = buildPresence(60, []);
  assert.equal(classifyDataQuality(presence).status, "ok");
});

test("classifyDataQuality: total exactly 48 (boundary) is ok", () => {
  // 12 false days outside the recent-20 window, no run longer than 2.
  const presence = buildPresence(60, [20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 58, 59]);
  const result = classifyDataQuality(presence);
  assert.equal(result.status, "ok");
});

test("classifyDataQuality: total 47 (one below the boundary) is insufficientTotalDays", () => {
  const presence = buildPresence(60, [20, 21, 24, 28, 32, 36, 40, 44, 48, 52, 56, 58, 59]);
  const result = classifyDataQuality(presence);
  assert.equal(result.status, "insufficientTotalDays");
  if (result.status === "insufficientTotalDays") {
    assert.equal(result.totalDays, 47);
  }
});

test("classifyDataQuality: recent-window missing exactly 2 (boundary) is ok", () => {
  const presence = buildPresence(60, [5, 15]);
  const result = classifyDataQuality(presence);
  assert.equal(result.status, "ok");
});

test("classifyDataQuality: recent-window missing 3 (one above the boundary) is insufficientRecentDays", () => {
  const presence = buildPresence(60, [5, 10, 15]);
  const result = classifyDataQuality(presence);
  assert.equal(result.status, "insufficientRecentDays");
  if (result.status === "insufficientRecentDays") {
    assert.equal(result.recentMissing, 3);
  }
});

test("classifyDataQuality: consecutive gap exactly 5 (boundary) is ok", () => {
  const presence = buildPresence(60, [30, 31, 32, 33, 34]);
  const result = classifyDataQuality(presence);
  assert.equal(result.status, "ok");
});

test("classifyDataQuality: consecutive gap of 6 (one above the boundary) is excessiveConsecutiveGap", () => {
  const presence = buildPresence(60, [30, 31, 32, 33, 34, 35]);
  const result = classifyDataQuality(presence);
  assert.equal(result.status, "excessiveConsecutiveGap");
  if (result.status === "excessiveConsecutiveGap") {
    assert.equal(result.longestGap, 6);
  }
});

test("classifyDataQuality: all 60 days false is missingMarketData", () => {
  const presence = buildPresence(60, Array.from({ length: 60 }, (_, index) => index));
  assert.equal(classifyDataQuality(presence).status, "missingMarketData");
});

test("classifyDataQuality: undefined presence is missingMarketData", () => {
  assert.equal(classifyDataQuality(undefined).status, "missingMarketData");
});

test("fetchDataQualityWindow: all target dates available (existing real cache, read-only) returns a populated map", async () => {
  const universeSet = new Set(["13010", "1301"]);
  const result = await fetchDataQualityWindow(EXISTING_CACHED_DATES, universeSet);
  assert.ok(result !== null);
  assert.ok((result as Map<string, boolean[]>).size > 0);
});

test("fetchDataQualityWindow: one failing date (HTTP error) among the target dates causes the whole window to return null", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("19000101")) {
      return new Response("simulated failure", { status: 500 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const dates = [...EXISTING_CACHED_DATES.slice(0, 4), UNCACHED_TEST_DATE];
    const universeSet = new Set(["13010"]);
    const result = await fetchDataQualityWindow(dates, universeSet);
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchDataQualityWindow: a malformed (schema-mismatched) response for one date also causes the window to return null", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("19000101")) {
      return new Response(JSON.stringify({ unexpected: "shape" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const dates = [...EXISTING_CACHED_DATES.slice(0, 4), UNCACHED_TEST_DATE];
    const universeSet = new Set(["13010"]);
    const result = await fetchDataQualityWindow(dates, universeSet);
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("selectV1Candidates: dataQualityByCode === null applies liquidity filter only", () => {
  const candidates = [makeCandidate("LIQ_OK"), makeCandidate("LIQ_BELOW")];
  const turnoverByCode = new Map<string, number[]>([
    ["LIQ_OK", Array.from({ length: 10 }, () => 5_000_000)],
    ["LIQ_BELOW", Array.from({ length: 10 }, () => 500_000)],
  ]);

  const result = selectV1Candidates(candidates, turnoverByCode, null).map((candidate) => candidate.code);
  assert.deepEqual(result, ["LIQ_OK"]);
});

test("selectV1Candidates: turnoverByCode === null applies data-quality filter only", () => {
  const candidates = [makeCandidate("DQ_OK"), makeCandidate("DQ_BAD")];
  const dataQualityByCode = new Map<string, boolean[]>([
    ["DQ_OK", buildPresence(60, [])],
    ["DQ_BAD", buildPresence(60, Array.from({ length: 60 }, (_, index) => index))],
  ]);

  const result = selectV1Candidates(candidates, null, dataQualityByCode).map((candidate) => candidate.code);
  assert.deepEqual(result, ["DQ_OK"]);
});

test("selectV1Candidates: both maps provided combine as an AND condition", () => {
  const candidates = [
    makeCandidate("BOTH_OK"),
    makeCandidate("DQ_FAILS_LIQ_OK"),
    makeCandidate("DQ_OK_LIQ_FAILS"),
  ];

  const turnoverByCode = new Map<string, number[]>([
    ["BOTH_OK", Array.from({ length: 10 }, () => 5_000_000)],
    ["DQ_FAILS_LIQ_OK", Array.from({ length: 10 }, () => 5_000_000)],
    ["DQ_OK_LIQ_FAILS", Array.from({ length: 10 }, () => 500_000)],
  ]);
  const dataQualityByCode = new Map<string, boolean[]>([
    ["BOTH_OK", buildPresence(60, [])],
    ["DQ_FAILS_LIQ_OK", buildPresence(60, Array.from({ length: 60 }, (_, index) => index))],
    ["DQ_OK_LIQ_FAILS", buildPresence(60, [])],
  ]);

  const result = selectV1Candidates(candidates, turnoverByCode, dataQualityByCode).map((candidate) => candidate.code);
  assert.deepEqual(result, ["BOTH_OK"]);
});

test("selectV1Candidates: both maps null keeps existing (unfiltered) behavior", () => {
  const candidates = [makeCandidate("1001"), makeCandidate("1002")];
  const result = selectV1Candidates(candidates, null, null);
  assert.deepEqual(result, candidates);
});
