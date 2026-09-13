const fs = require("node:fs");
const path = require("node:path");
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const root = process.cwd();
const { fetchJQuantsJson } = require(path.join(root, ".test-dist", "lib", "jquantsClient.js"));
const {
  processDayMasterRows,
  computeSha256,
  MAX_PAGES_PER_DAY,
} = require(path.join(root, ".test-dist", "lib", "historicalUniverse.js"));

function getTradingDates() {
  const cacheDir = path.join(root, ".cache");
  const files = fs.readdirSync(cacheDir).filter((f) => f.startsWith("jpx-stock-") && f.endsWith("-1d.json"));
  const datesSet = new Set();

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(cacheDir, file), "utf-8"));
      const candles = data.chartData?.candles || data.candles || [];
      for (const candle of candles) {
        const dateStr = String(candle.time || candle.date || "").slice(0, 10);
        if (dateStr >= "2025-01-31" && dateStr <= "2026-04-17") {
          datesSet.add(dateStr);
        }
      }
    } catch {
      // ignore individual malformed file reads
    }
  }

  const sortedDates = Array.from(datesSet).sort();
  if (sortedDates.length === 0) {
    throw new Error("[HardFail] Failed to detect trading dates in .cache for range 2025-01-31 to 2026-04-17.");
  }

  return sortedDates;
}

async function fetchDayMasterPages(dateStr) {
  const yyyymmdd = dateStr.replace(/-/g, "");
  const baseUrl = "https://api.jquants.com/v2/equities/master";
  let paginationKey = null;
  let page = 0;
  const rawRows = [];

  while (true) {
    page++;
    if (page > MAX_PAGES_PER_DAY) {
      throw new Error(
        `[HardFail] Exceeded maximum pagination limit (${MAX_PAGES_PER_DAY} pages) for date ${dateStr}. Processing halted.`
      );
    }

    const url = new URL(baseUrl);
    url.searchParams.set("date", yyyymmdd);
    if (paginationKey) {
      url.searchParams.set("pagination_key", paginationKey);
    }

    let responseData;
    try {
      responseData = await fetchJQuantsJson(url);
    } catch (err) {
      throw new Error(
        `[HardFail] API request failed for date ${dateStr} (page ${page}): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!responseData || typeof responseData !== "object") {
      throw new Error(`[HardFail] Invalid API response format for date ${dateStr} (page ${page}).`);
    }

    const pageRows =
      responseData.data ||
      responseData.info ||
      responseData.equities ||
      responseData.master ||
      (Array.isArray(responseData) ? responseData : null);

    if (!Array.isArray(pageRows)) {
      throw new Error(`[HardFail] API response for date ${dateStr} (page ${page}) did not contain a valid array of master rows.`);
    }

    if (pageRows.length === 0 && page === 1) {
      throw new Error(
        `[HardFail] API returned 0 master rows for date ${dateStr}. Forward-fill / current master fallback is strictly prohibited.`
      );
    }

    rawRows.push(...pageRows);

    const nextKey = responseData.pagination_key || responseData.continuation_token;
    if (typeof nextKey === "string" && nextKey.trim()) {
      paginationKey = nextKey.trim();
    } else {
      break;
    }
  }

  return {
    rawRows,
    totalPages: page,
  };
}

async function main() {
  console.log("=================================================");
  console.log(" Historical Universe Acquisition & Freezing Script");
  console.log("=================================================");

  const tradingDates = getTradingDates();
  console.log(`[1/4] Found ${tradingDates.length} evaluation trading dates (${tradingDates[0]} to ${tradingDates[tradingDates.length - 1]}).`);
  console.log(`[2/4] Fetching historical master snapshots from J-Quants V2 API...`);

  const cacheBaseDir = path.join(root, ".cache", "historical_universe_20250131_20260417");
  const datesSubDir = path.join(cacheBaseDir, "dates");
  if (!fs.existsSync(datesSubDir)) {
    fs.mkdirSync(datesSubDir, { recursive: true });
  }

  const filesByDate = {};
  const paginationByDate = {};
  const recordCountByDate = {};
  let totalRecordsAcrossDays = 0;
  let totalExactDuplicatesRemoved = 0;

  for (let i = 0; i < tradingDates.length; i++) {
    const dateStr = tradingDates[i];
    const { rawRows, totalPages } = await fetchDayMasterPages(dateStr);

    const { rows: processedRows, exactDuplicatesRemoved } = processDayMasterRows(dateStr, rawRows);

    const relativePath = path.join("dates", `${dateStr}.json`);
    const fullPath = path.join(cacheBaseDir, relativePath);

    const fileContent = JSON.stringify(processedRows, null, 2);
    const dateSha256 = computeSha256(fileContent);

    fs.writeFileSync(fullPath, fileContent, "utf-8");

    filesByDate[dateStr] = {
      relativePath: relativePath.replace(/\\/g, "/"),
      sha256: dateSha256,
      recordCount: processedRows.length,
    };

    recordCountByDate[dateStr] = processedRows.length;
    totalRecordsAcrossDays += processedRows.length;
    totalExactDuplicatesRemoved += exactDuplicatesRemoved;

    paginationByDate[dateStr] = {
      date: dateStr,
      totalPages,
      totalRawRows: rawRows.length,
      uniqueRows: processedRows.length,
      exactDuplicatesRemoved,
    };

    if ((i + 1) % 20 === 0 || i === tradingDates.length - 1) {
      console.log(`  Progress: ${i + 1}/${tradingDates.length} dates processed. (${dateStr}: ${processedRows.length} stocks, ${totalPages} page(s))`);
    }
  }

  console.log(`[3/4] Calculating overall manifest SHA-256 checksum...`);
  const combinedSha256s = Object.keys(filesByDate)
    .sort()
    .map((d) => `${d}:${filesByDate[d].sha256}`)
    .join("\n");
  const overallSha256 = computeSha256(combinedSha256s);

  const manifest = {
    startDate: tradingDates[0],
    endDate: tradingDates[tradingDates.length - 1],
    totalEvalDays: tradingDates.length,
    generatedAt: new Date().toISOString(),
    maxPagesPerDayGuard: MAX_PAGES_PER_DAY,
    overallSha256,
    filesByDate,
  };

  const manifestPath = path.join(cacheBaseDir, "manifest.json");
  const sha256FilePath = path.join(cacheBaseDir, "overall.sha256");
  const auditFilePath = path.join(root, ".cache", "historical_universe_audit.json");

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  fs.writeFileSync(sha256FilePath, `${overallSha256}\n`, "utf-8");

  const auditData = {
    generatedAt: manifest.generatedAt,
    startDate: manifest.startDate,
    endDate: manifest.endDate,
    totalEvalDays: manifest.totalEvalDays,
    totalRecordsAcrossDays,
    totalExactDuplicatesRemoved,
    maxPagesPerDayGuard: MAX_PAGES_PER_DAY,
    overallSha256,
    paginationByDate,
    recordCountByDate,
  };

  fs.writeFileSync(auditFilePath, JSON.stringify(auditData, null, 2), "utf-8");

  console.log(`[4/4] Output files saved successfully:`);
  console.log(`  - Manifest:     ${manifestPath}`);
  console.log(`  - SHA-256 File: ${sha256FilePath}`);
  console.log(`  - Audit Log:    ${auditFilePath}`);
  console.log("-------------------------------------------------");
  console.log(`Summary:`);
  console.log(`  Total Evaluation Days: ${manifest.totalEvalDays}`);
  console.log(`  Total Stock Records:   ${totalRecordsAcrossDays}`);
  console.log(`  Total Exact Duplicates: ${totalExactDuplicatesRemoved}`);
  console.log(`  Max Page Guard Limit:   ${MAX_PAGES_PER_DAY}`);
  console.log(`  Overall SHA-256:        ${overallSha256}`);
  console.log("=================================================");
}

main().catch((err) => {
  console.error("\nFATAL ERROR (Hard Fail Triggered):");
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
