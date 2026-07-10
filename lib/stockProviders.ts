import type {
  Stock,
  StockApiSource,
  StockCandle,
  StockMarketData,
  StockTimeframe,
} from "./types";
import { fetchJQuantsJson, JQuantsHttpError } from "./jquantsClient";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type StockProvider = Exclude<StockApiSource, "mock">;

type AlphaVantageQuote = {
  "01. symbol"?: string;
  "02. open"?: string;
  "03. high"?: string;
  "04. low"?: string;
  "05. price"?: string;
  "08. previous close"?: string;
  "09. change"?: string;
  "10. change percent"?: string;
};

type FinnhubSearchResult = {
  description?: string;
  displaySymbol?: string;
  symbol?: string;
};

type FinnhubSearchResponse = {
  result?: FinnhubSearchResult[];
};

type FinnhubQuoteResponse = {
  c?: number;
  d?: number;
  dp?: number;
  h?: number;
  l?: number;
  o?: number;
  pc?: number;
  t?: number;
};

type FinnhubCandleResponse = {
  c?: number[];
  h?: number[];
  l?: number[];
  o?: number[];
  s?: string;
  t?: number[];
  v?: number[];
};

const stockCache = new Map<string, { expiresAt: number; value: Stock }>();
const inFlightStockRequests = new Map<string, Promise<Stock | null>>();
const jpxMasterMetaCache = new Map<string, { expiresAt: number; value: { name: string; sector: string } | null }>();

const JPX_META_OVERRIDES: Record<string, { name: string; sector: string }> = {
  "7203": { name: "トヨタ自動車", sector: "輸送用機器" },
  "6758": { name: "ソニーグループ", sector: "電気機器" },
  "7974": { name: "任天堂", sector: "その他製品" },
};

const JPX_MASTER_META_TTL_MS = 6 * 60 * 60 * 1000;
const STOCK_SNAPSHOT_DIR = path.join(process.cwd(), ".cache");
const SCORE_HISTORY_CANDLES = 320;

function getCacheTtlMs(timeframe: StockTimeframe) {
  if (timeframe === "5m") {
    return 45_000;
  }

  if (timeframe === "15m") {
    return 90_000;
  }

  return 180_000;
}

function parseNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value.replace("%", "").trim());

  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function readNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const parsed = parseNumber(record[key]);

    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function normalizeTokyoSymbol(query: string) {
  const normalized = query.trim().toUpperCase();

  return /^\d{4}$/.test(normalized) ? `${normalized}.T` : normalized;
}

function createStock(params: {
  code: string;
  name: string;
  sector?: string;
  description?: string;
  marketData: StockMarketData;
  candles?: StockCandle[];
  dataStatus?: "real" | "mock" | "error";
  dataReason?: string | null;
  timeframe?: StockTimeframe;
}): Stock {
  const changePercent = params.marketData.changePercent ?? 0;

  return {
    code: params.code,
    name: params.name || params.code,
    sector: params.sector || "未分類",
    baselineTrend:
      changePercent > 1 ? "up" : changePercent < -1 ? "volatile" : "neutral",
    description:
      params.description ||
      "実データAPIから取得した日本株データをもとに分析しています。",
    marketData: params.marketData,
    chartData: {
      candles: params.candles ?? [],
    },
    dataStatus: params.dataStatus ?? "real",
    dataReason: params.dataReason ?? null,
    timeframe: params.timeframe ?? "1d",
  };
}

async function fetchWithRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === attempts) {
        throw error;
      }

      const delayMs = 500 * attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

async function fetchJson(url: URL, init?: RequestInit) {
  return fetchWithRetry(async () => {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn(`Stock provider request failed: ${response.status}`, body);
      throw new Error(`Stock provider request failed: ${response.status}`);
    }

    return response.json() as Promise<unknown>;
  });
}

function normalizeAlphaVantageCandles(json: unknown): StockCandle[] {
  if (!isRecord(json)) {
    return [];
  }

  const series = json["Time Series (Daily)"];

  if (!isRecord(series)) {
    return [];
  }

  return Object.entries(series)
    .map(([time, value]) => {
      if (!isRecord(value)) {
        return null;
      }

      const open = parseNumber(value["1. open"]);
      const high = parseNumber(value["2. high"]);
      const low = parseNumber(value["3. low"]);
      const close = parseNumber(value["4. close"]);
      const volume = parseNumber(value["5. volume"]);

      if (open === null || high === null || low === null || close === null) {
        return null;
      }

      return {
        time,
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
      };
    })
    .filter((candle): candle is StockCandle => candle !== null)
    .sort((left, right) => left.time.localeCompare(right.time))
    .slice(-SCORE_HISTORY_CANDLES);
}

function normalizeFinnhubCandles(json: FinnhubCandleResponse): StockCandle[] {
  if (json.s !== "ok" || !json.t || !json.o || !json.h || !json.l || !json.c) {
    return [];
  }

  return json.t
    .map((time, index) => {
      const open = json.o?.[index];
      const high = json.h?.[index];
      const low = json.l?.[index];
      const close = json.c?.[index];

      if (
        open === undefined ||
        high === undefined ||
        low === undefined ||
        close === undefined
      ) {
        return null;
      }

      return {
        time: new Date(time * 1000).toISOString().slice(0, 10),
        open,
        high,
        low,
        close,
        volume: json.v?.[index] ?? 0,
      };
    })
    .filter((candle): candle is StockCandle => candle !== null);
}

function resolveJpxCode(query: string) {
  const trimmed = query.trim();
  const numericCode = trimmed.replace(/\D/g, "");

  if (/^\d{4}$/.test(numericCode)) {
    return numericCode;
  }

  const aliases: Record<string, string> = {
    "トヨタ自動車": "7203",
    "トヨタ": "7203",
    "ソニー": "6758",
    "任天堂": "7974",
    "日立": "6501",
    "三菱商事": "8058",
    "三井物産": "8031",
  };

  return aliases[trimmed] ?? trimmed;
}

function normalizeJpxCandles(json: unknown): StockCandle[] {
  if (!isRecord(json)) {
    return [];
  }

  const rawCandles = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.daily_quotes)
      ? json.daily_quotes
    : Array.isArray(json)
      ? json
      : [];

  return rawCandles
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }

      const time = readString(item, ["Date", "date", "time", "timestamp"]);
      const open = readNumber(item, ["O", "Open", "open"]);
      const high = readNumber(item, ["H", "High", "high"]);
      const low = readNumber(item, ["L", "Low", "low"]);
      const close = readNumber(item, ["C", "AdjC", "Close", "close", "price"]);
      const volume = readNumber(item, ["Vo", "AdjVo", "Volume", "volume"]);

      if (!time || open === null || high === null || low === null || close === null) {
        return null;
      }

      return {
        time: time.slice(0, 10),
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
      };
    })
    .filter((candle): candle is StockCandle => candle !== null)
    .sort((left, right) => left.time.localeCompare(right.time))
    .slice(-SCORE_HISTORY_CANDLES);
}

function normalizeJpxMasterCode(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const text = String(value).replace(/\D/g, "");
  if (/^\d{4}$/.test(text)) {
    return text;
  }

  if (/^\d{5}$/.test(text)) {
    return text.slice(0, 4);
  }

  return null;
}

function stockSnapshotPath(code: string, timeframe: StockTimeframe) {
  return path.join(STOCK_SNAPSHOT_DIR, `jpx-stock-${code}-${timeframe}.json`);
}

function normalizeCachedStock(value: unknown, timeframe: StockTimeframe): Stock | null {
  if (!isRecord(value)) {
    return null;
  }

  const direct = value;
  const wrapped = isRecord(value.data) ? (value.data as Record<string, unknown>) : null;
  const stockLike = wrapped ?? direct;
  const code = typeof stockLike.code === "string" ? stockLike.code : "";
  if (!/^\d{4}$/.test(code)) {
    return null;
  }

  const name = typeof stockLike.name === "string" && stockLike.name.trim() ? stockLike.name : code;
  const sector = typeof stockLike.sector === "string" && stockLike.sector.trim() ? stockLike.sector : "未分類";
  const marketData = isRecord(stockLike.marketData) ? (stockLike.marketData as StockMarketData) : null;
  const chartData = isRecord(stockLike.chartData) && Array.isArray((stockLike.chartData as Record<string, unknown>).candles)
    ? ((stockLike.chartData as { candles: StockCandle[] }).candles)
    : [];

  if (!marketData || chartData.length === 0) {
    return null;
  }

  return createStock({
    code,
    name,
    sector,
    description: "J-Quants API V2 の実データキャッシュを利用しています。",
    marketData,
    candles: chartData,
    dataStatus: "real",
    dataReason: "cached-real-data",
    timeframe,
  });
}

function normalizeStockFromJpxBarsSnapshot(
  json: unknown,
  code: string,
  timeframe: StockTimeframe,
): Stock | null {
  const candles = normalizeJpxCandles(json).filter((candle) => candle.time.length > 0);
  if (candles.length < 2) {
    return null;
  }

  const sorted = [...candles].sort((left, right) => left.time.localeCompare(right.time)).slice(-SCORE_HISTORY_CANDLES);
  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2] ?? latest;
  const previousClose = previous.close;
  const change = latest.close - previousClose;
  const changePercent = previousClose > 0 ? (change / previousClose) * 100 : null;
  const override = JPX_META_OVERRIDES[code];

  return createStock({
    code,
    name: override?.name || code,
    sector: override?.sector || "未分類",
    description: "J-Quants API V2 の実データスナップショットを利用しています。",
    marketData: {
      price: latest.close,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      previousClose,
      change,
      changePercent,
      currency: "JPY",
      asOf: `${latest.time}T00:00:00.000Z`,
    },
    candles: sorted,
    dataStatus: "real",
    dataReason: "cached-real-bars",
    timeframe,
  });
}

async function saveJpxStockSnapshot(stock: Stock, timeframe: StockTimeframe) {
  try {
    await mkdir(STOCK_SNAPSHOT_DIR, { recursive: true });
    await writeFile(stockSnapshotPath(stock.code, timeframe), JSON.stringify(stock), "utf-8");
  } catch {
    // Ignore snapshot write failures and continue serving live data.
  }
}

function parseJsonFlexible(raw: Uint8Array): unknown | null {
  const decoders = ["utf-8", "utf-16le", "shift_jis"];

  for (const encoding of decoders) {
    try {
      const text = new TextDecoder(encoding).decode(raw).replace(/^\uFEFF/, "").replace(/^\u0000+/, "").trim();
      if (!text.startsWith("{") && !text.startsWith("[")) {
        continue;
      }

      return JSON.parse(text);
    } catch {
      continue;
    }
  }

  return null;
}

async function loadJpxStockSnapshot(code: string, timeframe: StockTimeframe): Promise<Stock | null> {
  const candidates = [
    stockSnapshotPath(code, timeframe),
    stockSnapshotPath(code, "1d"),
    path.join(process.cwd(), "tmp_jquants.json"),
    path.join(process.cwd(), timeframe === "5m" ? "tmp_route_5m.json" : timeframe === "15m" ? "tmp_route.json" : "tmp_route_daily.json"),
  ];

  for (const filePath of candidates) {
    try {
      const raw = await readFile(filePath);
      const json = parseJsonFlexible(raw);
      if (!json) {
        continue;
      }

      const normalized = normalizeCachedStock(json, timeframe);
      const fromBars = normalized ?? normalizeStockFromJpxBarsSnapshot(json, code, timeframe);
      if (!fromBars) {
        continue;
      }

      const override = JPX_META_OVERRIDES[fromBars.code];
      if (override) {
        return {
          ...fromBars,
          name: override.name,
          sector: override.sector,
        };
      }

      return fromBars;
    } catch {
      continue;
    }
  }

  return null;
}

async function fetchJpxMasterMeta(code: string): Promise<{ name: string; sector: string } | null> {
  const override = JPX_META_OVERRIDES[code];
  if (override) {
    return override;
  }

  const cached = jpxMasterMetaCache.get(code);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const url = new URL("https://api.jquants.com/v2/equities/master");
  url.searchParams.set("code", code);

  try {
    const json = await fetchJQuantsJson(url);
    if (!isRecord(json)) {
      jpxMasterMetaCache.set(code, { expiresAt: Date.now() + JPX_MASTER_META_TTL_MS, value: null });
      return null;
    }

    const rows = Array.isArray(json.data) ? json.data : [];
    for (const row of rows) {
      if (!isRecord(row)) {
        continue;
      }

      const normalizedCode = normalizeJpxMasterCode(row.Code ?? row.code);
      if (normalizedCode !== code) {
        continue;
      }

      const name = readString(row, ["CompanyName", "CoName", "IssueName", "Name", "name"]);
      const sector = readString(row, ["Sector33CodeName", "S33Nm", "Sector17CodeName", "S17Nm", "MktNm", "MarketCodeName"]);
      const value = {
        name: name || code,
        sector: sector || "未分類",
      };

      jpxMasterMetaCache.set(code, { expiresAt: Date.now() + JPX_MASTER_META_TTL_MS, value });
      return value;
    }
  } catch (error) {
    if (!(error instanceof JQuantsHttpError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 429))) {
      console.warn("Failed to fetch J-Quants master metadata.", error);
    }
  }

  jpxMasterMetaCache.set(code, { expiresAt: Date.now() + 10 * 60 * 1000, value: null });
  return null;
}

function getCachedStock(key: string) {
  const cached = stockCache.get(key);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt < Date.now()) {
    stockCache.delete(key);
    return null;
  }

  return cached.value;
}

function setCachedStock(key: string, stock: Stock, timeframe: StockTimeframe) {
  stockCache.set(key, {
    expiresAt: Date.now() + getCacheTtlMs(timeframe),
    value: stock,
  });
}

function buildJpxEndpointCandidates(baseUrl: string | undefined) {
  const defaults = [
    "https://api.jquants.com/v2/equities/bars/daily",
    "https://api.jquants.com/v2/prices/daily_quotes",
  ];

  const candidates = [
    baseUrl,
    process.env.JPX_API_BASE_URL,
    ...defaults,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const unique = new Set<string>();
  const urls: URL[] = [];

  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (unique.has(normalized)) {
      continue;
    }

    unique.add(normalized);
    urls.push(new URL(normalized));
  }

  return urls;
}

async function fetchJpxJsonWithFallback(
  code: string,
  baseUrl: string | undefined,
): Promise<{ json: unknown; url: URL } | null> {
  const candidates = buildJpxEndpointCandidates(baseUrl);

  for (const candidate of candidates) {
    const paramPatterns = [
      { code, range: "daily" },
      { code },
    ];

    for (const params of paramPatterns) {
      const url = new URL(candidate);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      try {
        const json = await fetchJQuantsJson(url);
        const candles = normalizeJpxCandles(json);
        if (candles.length > 0) {
          return { json, url };
        }
      } catch (error) {
        if (error instanceof JQuantsHttpError && (error.status === 401 || error.status === 403 || error.status === 429)) {
          return null;
        }

        console.warn(`J-Quants probe failed for ${url.toString()}`, error);
        continue;
      }
    }
  }

  return null;
}

export async function fetchAlphaVantageStock(
  query: string,
  apiKey: string,
): Promise<Stock | null> {
  const symbol = normalizeTokyoSymbol(query);
  const quoteUrl = new URL("https://www.alphavantage.co/query");
  const dailyUrl = new URL("https://www.alphavantage.co/query");

  quoteUrl.searchParams.set("function", "GLOBAL_QUOTE");
  quoteUrl.searchParams.set("symbol", symbol);
  quoteUrl.searchParams.set("apikey", apiKey);

  dailyUrl.searchParams.set("function", "TIME_SERIES_DAILY");
  dailyUrl.searchParams.set("symbol", symbol);
  dailyUrl.searchParams.set("outputsize", "compact");
  dailyUrl.searchParams.set("apikey", apiKey);

  const [quoteJson, dailyJson] = await Promise.all([
    fetchJson(quoteUrl),
    fetchJson(dailyUrl),
  ]);

  if (!isRecord(quoteJson) || !isRecord(quoteJson["Global Quote"])) {
    return null;
  }

  const quote = quoteJson["Global Quote"] as AlphaVantageQuote;
  const price = parseNumber(quote["05. price"]);

  if (price === null) {
    return null;
  }

  return createStock({
    code: quote["01. symbol"] || symbol,
    name: quote["01. symbol"] || symbol,
    description: "Alpha Vantage の株価データをもとに分析しています。",
    marketData: {
      price,
      open: parseNumber(quote["02. open"]),
      high: parseNumber(quote["03. high"]),
      low: parseNumber(quote["04. low"]),
      previousClose: parseNumber(quote["08. previous close"]),
      change: parseNumber(quote["09. change"]),
      changePercent: parseNumber(quote["10. change percent"]),
      currency: "JPY",
      asOf: null,
    },
    candles: normalizeAlphaVantageCandles(dailyJson),
  });
}

export async function fetchFinnhubStock(
  query: string,
  apiKey: string,
): Promise<Stock | null> {
  const fallbackSymbol = normalizeTokyoSymbol(query);
  const searchUrl = new URL("https://finnhub.io/api/v1/search");

  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("token", apiKey);

  const searchJson = (await fetchJson(searchUrl)) as FinnhubSearchResponse;
  const searchResult = searchJson.result?.find((item) => {
    return item.symbol?.endsWith(".T") || item.displaySymbol?.endsWith(".T");
  });
  const symbol = searchResult?.symbol || fallbackSymbol;
  const quoteUrl = new URL("https://finnhub.io/api/v1/quote");
  const candleUrl = new URL("https://finnhub.io/api/v1/stock/candle");
  const to = Math.floor(Date.now() / 1000);
  const from = to - 60 * 60 * 24 * 220;

  quoteUrl.searchParams.set("symbol", symbol);
  quoteUrl.searchParams.set("token", apiKey);

  candleUrl.searchParams.set("symbol", symbol);
  candleUrl.searchParams.set("resolution", "D");
  candleUrl.searchParams.set("from", String(from));
  candleUrl.searchParams.set("to", String(to));
  candleUrl.searchParams.set("token", apiKey);

  const [quote, candles] = await Promise.all([
    fetchJson(quoteUrl) as Promise<FinnhubQuoteResponse>,
    fetchJson(candleUrl) as Promise<FinnhubCandleResponse>,
  ]);

  if (!quote.c) {
    return null;
  }

  return createStock({
    code: symbol,
    name: searchResult?.description || searchResult?.displaySymbol || symbol,
    description: "Finnhub の株価データをもとに分析しています。",
    marketData: {
      price: quote.c ?? null,
      open: quote.o ?? null,
      high: quote.h ?? null,
      low: quote.l ?? null,
      previousClose: quote.pc ?? null,
      change: quote.d ?? null,
      changePercent: quote.dp ?? null,
      currency: "JPY",
      asOf: quote.t ? new Date(quote.t * 1000).toISOString() : null,
    },
    candles: normalizeFinnhubCandles(candles),
  });
}

export async function fetchJpxStock(
  query: string,
  baseUrl: string | undefined,
  timeframe: StockTimeframe = "1d",
): Promise<Stock | null> {
  const hasAuth = Boolean(
    process.env.JPX_API_KEY
    || process.env.JPX_ID_TOKEN
    || (process.env.JPX_MAIL_ADDRESS && process.env.JPX_PASSWORD),
  );

  if (!hasAuth) {
    return null;
  }

  const code = resolveJpxCode(query);
  try {
    const result = await fetchJpxJsonWithFallback(code, baseUrl);

    if (!result) {
      return loadJpxStockSnapshot(code, timeframe);
    }

    const { json } = result;

    if (!isRecord(json)) {
      return loadJpxStockSnapshot(code, timeframe);
    }

    const candles = normalizeJpxCandles(json);
    if (candles.length === 0) {
      return loadJpxStockSnapshot(code, timeframe);
    }

    const latest = candles[candles.length - 1];
    const previous = candles[candles.length - 2];
    const price = latest.close;
    const previousClose = previous?.close ?? latest.close;
    const change = price - previousClose;
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : null;
    const masterMeta = await fetchJpxMasterMeta(code);
    const companyName = masterMeta?.name || query.trim() || code;
    const sectorName = masterMeta?.sector || "未分類";

    const stock = createStock({
      code,
      name: companyName,
      sector: sectorName,
      description: "J-Quants API V2 の株価データをもとに分析しています。",
      marketData: {
        price,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        previousClose,
        change,
        changePercent,
        currency: "JPY",
        asOf: latest.time ? `${latest.time}T00:00:00.000Z` : null,
      },
      candles,
      dataStatus: "real",
      dataReason: null,
      timeframe,
    });

    await saveJpxStockSnapshot(stock, timeframe);
    return stock;
  } catch {
    return loadJpxStockSnapshot(code, timeframe);
  }
}

export async function fetchStockFromProvider(
  query: string,
  provider: StockProvider,
  timeframe?: StockTimeframe,
): Promise<Stock | null> {
  const effectiveTimeframe = timeframe ?? "1d";
  const cacheKey = `${provider}:${effectiveTimeframe.toLowerCase()}:${query.trim().toLowerCase()}`;
  const cached = getCachedStock(cacheKey);

  if (cached) {
    return cached;
  }

  const inFlight = inFlightStockRequests.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    let stock: Stock | null = null;

    if (provider === "alpha-vantage") {
      const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
      stock = apiKey ? await fetchAlphaVantageStock(query, apiKey) : null;
    } else if (provider === "finnhub") {
      const apiKey = process.env.FINNHUB_API_KEY;
      stock = apiKey ? await fetchFinnhubStock(query, apiKey) : null;
    } else {
      stock = await fetchJpxStock(query, process.env.JPX_API_BASE_URL, effectiveTimeframe);
    }

    if (stock) {
      setCachedStock(cacheKey, stock, effectiveTimeframe);
    }

    return stock;
  })()
    .finally(() => {
      inFlightStockRequests.delete(cacheKey);
    });

  inFlightStockRequests.set(cacheKey, request);
  return request;
}
