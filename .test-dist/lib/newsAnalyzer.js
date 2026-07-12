"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchJpxNewsAnalysis = fetchJpxNewsAnalysis;
const jquantsClient_1 = require("./jquantsClient");
const JQUANTS_NEWS_ENDPOINT = process.env.JPX_NEWS_ENDPOINT || "https://api.jquants.com/v2/news";
const POSITIVE_WORDS = [
    "決算",
    "適時開示",
    "ir",
    "上方修正",
    "増配",
    "提携",
    "受注",
    "成長",
    "黒字",
    "最高益",
    "好調",
    "上昇",
    "買収",
    "expansion",
    "upgrade",
    "growth",
    "profit",
    "増収",
    "増益",
    "受注拡大",
    "業績予想引き上げ",
    "自社株買い",
    "record high",
    "beat",
    "outperform",
];
const NEGATIVE_WORDS = [
    "決算",
    "適時開示",
    "ir",
    "下方修正",
    "減配",
    "赤字",
    "不正",
    "下落",
    "訴訟",
    "減益",
    "悪化",
    "中止",
    "事故",
    "downgrade",
    "loss",
    "risk",
    "lawsuit",
    "減収",
    "業績予想引き下げ",
    "赤字拡大",
    "減損",
    "供給不足",
    "miss",
    "underperform",
];
const POSITIVE_PHRASES = [
    { phrase: "決算説明資料", weight: 1.4 },
    { phrase: "適時開示", weight: 1.3 },
    { phrase: "ir説明会", weight: 1.2 },
    { phrase: "通期見通し引き上げ", weight: 2.6 },
    { phrase: "四半期決算で増益", weight: 2.4 },
    { phrase: "営業利益が市場予想を上回", weight: 2.3 },
    { phrase: "上方修正", weight: 2.2 },
    { phrase: "業績上方修正", weight: 2.8 },
    { phrase: "業績予想引き上げ", weight: 2 },
    { phrase: "増配", weight: 1.8 },
    { phrase: "大口受注", weight: 2.4 },
    { phrase: "大型受注", weight: 2.4 },
    { phrase: "自社株買い", weight: 1.7 },
    { phrase: "大型提携", weight: 2.1 },
    { phrase: "record high", weight: 1.6 },
    { phrase: "outperform", weight: 1.5 },
];
const NEGATIVE_PHRASES = [
    { phrase: "決算説明資料", weight: 0.8 },
    { phrase: "適時開示", weight: 0.8 },
    { phrase: "ir説明会", weight: 0.7 },
    { phrase: "通期見通し引き下げ", weight: 2.6 },
    { phrase: "四半期決算で減益", weight: 2.4 },
    { phrase: "営業利益が市場予想を下回", weight: 2.3 },
    { phrase: "下方修正", weight: 2.2 },
    { phrase: "業績下方修正", weight: 2.8 },
    { phrase: "業績予想引き下げ", weight: 2 },
    { phrase: "減損", weight: 1.9 },
    { phrase: "赤字拡大", weight: 1.9 },
    { phrase: "不祥事", weight: 2.3 },
    { phrase: "行政処分", weight: 2.2 },
    { phrase: "訴訟", weight: 2.1 },
    { phrase: "supply shortage", weight: 1.5 },
    { phrase: "underperform", weight: 1.5 },
];
const NEWS_CACHE_TTL_MS = 3 * 60 * 1000;
const newsCache = new Map();
function readString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return "";
}
function collectHeadlines(rows) {
    return rows
        .map((row) => {
        return readString(row, ["headline", "Headline", "title", "Title", "Subject", "subject"]);
    })
        .filter((headline) => headline.length > 0)
        .slice(0, 12);
}
function readBody(row) {
    return readString(row, [
        "body",
        "Body",
        "text",
        "Text",
        "content",
        "Content",
        "disclosure_text",
        "DisclosureText",
        "description",
        "Description",
    ]);
}
function readPublishedAt(row) {
    return readString(row, ["published_at", "publishedAt", "disclosedDate", "date", "Date", "time"]);
}
function recencyWeight(publishedAtText) {
    if (!publishedAtText) {
        return 0.85;
    }
    const timestamp = Date.parse(publishedAtText);
    if (!Number.isFinite(timestamp)) {
        return 0.85;
    }
    const ageDays = Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
    if (ageDays <= 1) {
        return 1.3;
    }
    if (ageDays <= 3) {
        return 1.15;
    }
    if (ageDays <= 7) {
        return 1;
    }
    if (ageDays <= 14) {
        return 0.85;
    }
    return 0.65;
}
function scoreHeadline(text) {
    const normalized = text.toLowerCase();
    let score = 0;
    let positiveHits = 0;
    let negativeHits = 0;
    for (const word of POSITIVE_WORDS) {
        if (normalized.includes(word.toLowerCase())) {
            score += 1;
            positiveHits += 1;
        }
    }
    for (const word of NEGATIVE_WORDS) {
        if (normalized.includes(word.toLowerCase())) {
            score -= 1;
            negativeHits += 1;
        }
    }
    for (const item of POSITIVE_PHRASES) {
        if (normalized.includes(item.phrase.toLowerCase())) {
            score += item.weight;
            positiveHits += 1;
        }
    }
    for (const item of NEGATIVE_PHRASES) {
        if (normalized.includes(item.phrase.toLowerCase())) {
            score -= item.weight;
            negativeHits += 1;
        }
    }
    return {
        score,
        positiveHits,
        negativeHits,
    };
}
function summarizeSentiment(rows) {
    if (rows.length === 0) {
        return {
            sentiment: "neutral",
            importance: "軽微",
            score: 0,
            confidence: 35,
            starRating: 1,
            positiveCount: 0,
            negativeCount: 0,
            summary: "直近ニュースが少ないため、中立評価です。",
            headlines: [],
            details: [],
            updatedAt: new Date().toISOString(),
        };
    }
    const headlines = collectHeadlines(rows);
    const scoredRows = rows
        .map((row) => {
        const headline = readString(row, ["headline", "Headline", "title", "Title", "Subject", "subject"]);
        const body = readBody(row);
        const text = `${headline} ${body}`.trim();
        if (!text) {
            return null;
        }
        const publishedAt = readPublishedAt(row);
        const weight = recencyWeight(publishedAt);
        const scored = scoreHeadline(text);
        return {
            headline,
            publishedAt,
            weightedScore: scored.score * weight,
            rawScore: scored.score,
            positiveHits: scored.positiveHits,
            negativeHits: scored.negativeHits,
        };
    })
        .filter((item) => Boolean(item));
    const raw = scoredRows.reduce((total, item) => total + item.weightedScore, 0);
    const positiveHits = scoredRows.reduce((total, item) => total + item.positiveHits, 0);
    const negativeHits = scoredRows.reduce((total, item) => total + item.negativeHits, 0);
    const mixedSignalPenalty = positiveHits > 0 && negativeHits > 0
        ? Math.min(10, Math.abs(positiveHits - negativeHits) <= 2 ? 8 : 5)
        : 0;
    const denominator = Math.max(scoredRows.length, 1);
    const normalizedScore = Math.max(-100, Math.min(100, Math.round((raw / denominator) * 30)));
    const sentiment = normalizedScore >= 12 ? "bullish" : normalizedScore <= -12 ? "bearish" : "neutral";
    const confidence = Math.max(35, Math.min(92, 40 + scoredRows.length * 3 + Math.abs(normalizedScore) / 2.8 - mixedSignalPenalty));
    const starRating = Math.max(1, Math.min(5, Math.round((Math.abs(normalizedScore) / 24) * 3 + confidence / 50)));
    const importance = Math.abs(normalizedScore) >= 24
        ? "重要"
        : Math.abs(normalizedScore) >= 12
            ? "普通"
            : "軽微";
    const importantLabel = Math.abs(normalizedScore) >= 24
        ? sentiment === "bullish"
            ? "重要な好材料"
            : sentiment === "bearish"
                ? "重要な悪材料"
                : "重要材料は限定的"
        : "";
    const summary = sentiment === "bullish"
        ? `ニュースフローはやや強気で、ポジティブ材料が優勢です（+${positiveHits}/-${negativeHits}）。${importantLabel ? ` ${importantLabel}が含まれています。` : ""}`
        : sentiment === "bearish"
            ? `ニュースフローは弱気寄りで、ネガティブ材料に注意が必要です（+${positiveHits}/-${negativeHits}）。${importantLabel ? ` ${importantLabel}が含まれています。` : ""}`
            : `ニュースフローは中立で、方向感は限定的です（+${positiveHits}/-${negativeHits}）。`;
    const details = scoredRows
        .map((row) => {
        const sentimentLabel = row.rawScore >= 1.2
            ? "positive"
            : row.rawScore <= -1.2
                ? "negative"
                : "neutral";
        const importanceStars = Math.max(1, Math.min(5, Math.round(Math.abs(row.rawScore) * 1.4)));
        return {
            headline: row.headline,
            sentiment: sentimentLabel,
            importanceStars,
            publishedAt: row.publishedAt || undefined,
        };
    })
        .slice(0, 10);
    return {
        sentiment,
        importance,
        score: normalizedScore,
        confidence: Math.round(confidence),
        starRating,
        positiveCount: positiveHits,
        negativeCount: negativeHits,
        summary,
        headlines,
        details,
        updatedAt: new Date().toISOString(),
    };
}
async function fetchEndpoint(url) {
    try {
        return await (0, jquantsClient_1.fetchJQuantsJson)(url);
    }
    catch (error) {
        if (error instanceof jquantsClient_1.JQuantsHttpError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 410)) {
            throw error;
        }
        throw error;
    }
}
function getCached(code) {
    const cached = newsCache.get(code);
    if (!cached) {
        return null;
    }
    if (cached.expiresAt < Date.now()) {
        newsCache.delete(code);
        return null;
    }
    return cached.value;
}
function setCached(code, value) {
    newsCache.set(code, {
        expiresAt: Date.now() + NEWS_CACHE_TTL_MS,
        value,
    });
}
async function fetchJpxNewsAnalysis(code) {
    const cached = getCached(code);
    if (cached) {
        return cached;
    }
    const today = new Date();
    const from = new Date(today.getTime() - 1000 * 60 * 60 * 24 * 30);
    const fromCompact = `${from.getFullYear()}${String(from.getMonth() + 1).padStart(2, "0")}${String(from.getDate()).padStart(2, "0")}`;
    try {
        const url = new URL(JQUANTS_NEWS_ENDPOINT);
        url.searchParams.set("code", code);
        url.searchParams.set("from", fromCompact);
        const json = await fetchEndpoint(url);
        const rows = json && typeof json === "object" && "data" in json && Array.isArray(json.data)
            ? (json.data.filter((row) => Boolean(row && typeof row === "object")))
            : [];
        if (rows.length > 0) {
            const analyzed = summarizeSentiment(rows);
            setCached(code, analyzed);
            return analyzed;
        }
    }
    catch {
        // On unavailable endpoint (401/403/404/429), fall through to neutral fallback.
    }
    const fallback = summarizeSentiment([]);
    setCached(code, fallback);
    return fallback;
}
