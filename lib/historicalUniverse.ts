import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_PAGES_PER_DAY = 50;

export interface RawMasterRow {
  Date?: string;
  Code?: string;
  CoName?: string;
  CoNameEn?: string;
  S17?: string;
  S17Nm?: string;
  S33?: string;
  S33Nm?: string;
  ScaleCat?: string;
  Mkt?: string;
  MktNm?: string;
  Mrgn?: string;
  MrgnNm?: string;
  ProdCat?: string;
  [key: string]: unknown;
}

export interface HistoricalMasterRow {
  date: string;
  code: string;
  coName: string;
  coNameEn: string;
  s17: string;
  s17Nm: string;
  s33: string;
  s33Nm: string;
  scaleCat: string;
  mkt: string;
  mktNm: string;
  mrgn: string;
  mrgnNm: string;
  prodCat: string;
}

export interface DateFileMeta {
  relativePath: string;
  sha256: string;
  recordCount: number;
}

export interface HistoricalUniverseManifest {
  startDate: string;
  endDate: string;
  totalEvalDays: number;
  generatedAt: string;
  maxPagesPerDayGuard: number;
  overallSha256: string;
  filesByDate: Record<string, DateFileMeta>;
}

export interface PaginationResult {
  date: string;
  totalPages: number;
  totalRawRows: number;
  uniqueRows: number;
  exactDuplicatesRemoved: number;
}

export interface HistoricalUniverseAudit {
  generatedAt: string;
  startDate: string;
  endDate: string;
  totalEvalDays: number;
  totalRecordsAcrossDays: number;
  totalExactDuplicatesRemoved: number;
  maxPagesPerDayGuard: number;
  overallSha256: string;
  paginationByDate: Record<string, PaginationResult>;
  recordCountByDate: Record<string, number>;
}

export function normalizeJpxMasterCode(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const text = String(value).trim().toUpperCase();

  if (/^[A-Z0-9]{4}$/.test(text)) {
    return text;
  }

  if (/^[A-Z0-9]{5}$/.test(text)) {
    if (text.endsWith("0")) {
      return text.slice(0, 4);
    }
    return text;
  }

  return null;
}

export function canonicalizeRow(raw: RawMasterRow): HistoricalMasterRow {
  const rawCode = raw.Code ?? raw.code;
  const normalizedCode = normalizeJpxMasterCode(rawCode);
  if (!normalizedCode) {
    throw new Error(`[HardFail] Invalid or missing Code field: ${JSON.stringify(rawCode)}`);
  }

  return {
    date: String(raw.Date ?? raw.date ?? ""),
    code: normalizedCode,
    coName: String(raw.CoName ?? raw.coName ?? ""),
    coNameEn: String(raw.CoNameEn ?? raw.coNameEn ?? ""),
    s17: String(raw.S17 ?? raw.s17 ?? ""),
    s17Nm: String(raw.S17Nm ?? raw.s17Nm ?? ""),
    s33: String(raw.S33 ?? raw.s33 ?? ""),
    s33Nm: String(raw.S33Nm ?? raw.s33Nm ?? ""),
    scaleCat: String(raw.ScaleCat ?? raw.scaleCat ?? ""),
    mkt: String(raw.Mkt ?? raw.mkt ?? ""),
    mktNm: String(raw.MktNm ?? raw.mktNm ?? ""),
    mrgn: String(raw.Mrgn ?? raw.mrgn ?? ""),
    mrgnNm: String(raw.MrgnNm ?? raw.mrgnNm ?? ""),
    prodCat: String(raw.ProdCat ?? raw.prodCat ?? ""),
  };
}

export function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function processDayMasterRows(
  dateStr: string,
  rawRows: RawMasterRow[]
): { rows: HistoricalMasterRow[]; exactDuplicatesRemoved: number } {
  const codeMap = new Map<string, HistoricalMasterRow>();
  let exactDuplicatesRemoved = 0;

  for (const raw of rawRows) {
    const canonical = canonicalizeRow(raw);
    const existing = codeMap.get(canonical.code);

    if (existing) {
      const isExactDuplicate =
        existing.date === canonical.date &&
        existing.coName === canonical.coName &&
        existing.coNameEn === canonical.coNameEn &&
        existing.s17 === canonical.s17 &&
        existing.s17Nm === canonical.s17Nm &&
        existing.s33 === canonical.s33 &&
        existing.s33Nm === canonical.s33Nm &&
        existing.scaleCat === canonical.scaleCat &&
        existing.mkt === canonical.mkt &&
        existing.mktNm === canonical.mktNm &&
        existing.mrgn === canonical.mrgn &&
        existing.mrgnNm === canonical.mrgnNm &&
        existing.prodCat === canonical.prodCat;

      if (isExactDuplicate) {
        exactDuplicatesRemoved++;
      } else {
        throw new Error(
          `[HardFail] Duplicate Code ${canonical.code} on date ${dateStr} has conflicting attributes!\n` +
            `Existing: ${JSON.stringify(existing)}\n` +
            `New: ${JSON.stringify(canonical)}`
        );
      }
    } else {
      codeMap.set(canonical.code, canonical);
    }
  }

  const sortedRows = Array.from(codeMap.values()).sort((left, right) =>
    left.code.localeCompare(right.code)
  );

  return {
    rows: sortedRows,
    exactDuplicatesRemoved,
  };
}

export function loadHistoricalUniverseManifest(
  manifestPath?: string
): { manifest: HistoricalUniverseManifest; manifestDir: string } {
  const targetPath =
    manifestPath ||
    path.join(process.cwd(), ".cache", "historical_universe_20250131_20260417", "manifest.json");

  if (!fs.existsSync(targetPath)) {
    throw new Error(
      `[HardFail] Historical Universe manifest file not found at: ${targetPath}. Dynamic API fallback is strictly forbidden.`
    );
  }

  const rawText = fs.readFileSync(targetPath, "utf-8");
  const manifest = JSON.parse(rawText) as HistoricalUniverseManifest;

  if (
    !manifest ||
    !manifest.overallSha256 ||
    !manifest.filesByDate ||
    typeof manifest.totalEvalDays !== "number"
  ) {
    throw new Error(`[HardFail] Historical Universe manifest structure is invalid: ${targetPath}`);
  }

  const manifestDir = path.dirname(targetPath);

  const combinedSha256s = Object.keys(manifest.filesByDate)
    .sort()
    .map((d) => `${d}:${manifest.filesByDate[d].sha256}`)
    .join("\n");
  const recomputedOverallSha256 = computeSha256(combinedSha256s);

  if (recomputedOverallSha256 !== manifest.overallSha256) {
    throw new Error(
      `[HardFail] Manifest overall SHA-256 checksum mismatch!\nExpected: ${manifest.overallSha256}\nActual:   ${recomputedOverallSha256}`
    );
  }

  return { manifest, manifestDir };
}

export function getHistoricalUniverseForDate(
  context: { manifest: HistoricalUniverseManifest; manifestDir: string },
  date: string
): HistoricalMasterRow[] {
  const normalizedDate = date.slice(0, 10);
  const fileMeta = context.manifest.filesByDate[normalizedDate];

  if (!fileMeta) {
    throw new Error(
      `[HardFail] Historical Universe for date ${normalizedDate} is not present in cache manifest. Forward-fill / current master fallback is strictly forbidden.`
    );
  }

  const dateFilePath = path.join(context.manifestDir, fileMeta.relativePath);
  if (!fs.existsSync(dateFilePath)) {
    throw new Error(
      `[HardFail] Historical Universe date file missing at: ${dateFilePath}. Dynamic API fallback is strictly forbidden.`
    );
  }

  const content = fs.readFileSync(dateFilePath, "utf-8");
  const actualSha256 = computeSha256(content);

  if (actualSha256 !== fileMeta.sha256) {
    throw new Error(
      `[HardFail] SHA-256 checksum mismatch for date ${normalizedDate}!\nExpected: ${fileMeta.sha256}\nActual:   ${actualSha256}`
    );
  }

  const rows = JSON.parse(content) as HistoricalMasterRow[];
  if (!Array.isArray(rows) || rows.length !== fileMeta.recordCount) {
    throw new Error(
      `[HardFail] Record count mismatch or corrupt data for date ${normalizedDate}. Expected: ${fileMeta.recordCount}, Got: ${Array.isArray(rows) ? rows.length : "non-array"}`
    );
  }

  return rows;
}
