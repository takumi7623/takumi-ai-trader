import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  canonicalizeRow,
  computeSha256,
  getHistoricalUniverseForDate,
  loadHistoricalUniverseManifest,
  MAX_PAGES_PER_DAY,
  normalizeJpxMasterCode,
  processDayMasterRows,
  RawMasterRow,
} from "./historicalUniverse";

test("normalizeJpxMasterCode: normalizes 4-digit/5-digit numeric and alphanumeric codes correctly", () => {
  assert.equal(normalizeJpxMasterCode("7203"), "7203");
  assert.equal(normalizeJpxMasterCode("72030"), "7203");
  assert.equal(normalizeJpxMasterCode(72030), "7203");
  assert.equal(normalizeJpxMasterCode("13010"), "1301");
  assert.equal(normalizeJpxMasterCode("132A0"), "132A");
  assert.equal(normalizeJpxMasterCode("132A"), "132A");
  assert.equal(normalizeJpxMasterCode("25935"), "25935");
  assert.equal(normalizeJpxMasterCode("TOOLONG123"), null);
  assert.equal(normalizeJpxMasterCode(""), null);
  assert.equal(normalizeJpxMasterCode(null), null);
});

test("canonicalizeRow: parses valid raw row and throws on invalid code", () => {
  const validRaw: RawMasterRow = {
    Date: "2025-01-31",
    Code: "72030",
    CoName: "トヨタ自動車",
    MktNm: "プライム",
  };

  const canonical = canonicalizeRow(validRaw);
  assert.equal(canonical.code, "7203");
  assert.equal(canonical.coName, "トヨタ自動車");
  assert.equal(canonical.mktNm, "プライム");

  const invalidRaw: RawMasterRow = {
    Date: "2025-01-31",
    Code: "INVALID",
  };

  assert.throws(() => canonicalizeRow(invalidRaw), /Invalid or missing Code field/);
});

test("processDayMasterRows: merges exact duplicates with audit count", () => {
  const rawRows: RawMasterRow[] = [
    { Date: "2025-01-31", Code: "72030", CoName: "トヨタ", MktNm: "プライム" },
    { Date: "2025-01-31", Code: "72030", CoName: "トヨタ", MktNm: "プライム" },
    { Date: "2025-01-31", Code: "67580", CoName: "ソニー", MktNm: "プライム" },
  ];

  const result = processDayMasterRows("2025-01-31", rawRows);
  assert.equal(result.rows.length, 2);
  assert.equal(result.exactDuplicatesRemoved, 1);
  assert.equal(result.rows[0].code, "6758");
  assert.equal(result.rows[1].code, "7203");
});

test("processDayMasterRows: Hard Fail on duplicate code with conflicting attributes", () => {
  const rawRows: RawMasterRow[] = [
    { Date: "2025-01-31", Code: "72030", CoName: "トヨタ", MktNm: "プライム" },
    { Date: "2025-01-31", Code: "72030", CoName: "トヨタ", MktNm: "スタンダード" },
  ];

  assert.throws(
    () => processDayMasterRows("2025-01-31", rawRows),
    /Duplicate Code 7203 on date 2025-01-31 has conflicting attributes/
  );
});

test("MAX_PAGES_PER_DAY: constant is defined as 50", () => {
  assert.equal(MAX_PAGES_PER_DAY, 50);
});

test("loadHistoricalUniverseManifest: SHA-256 verification & Hard Fail on missing file / mismatch", () => {
  const tmpDir = path.join(process.cwd(), ".cache", "tmp-test-manifest-universe");
  const datesDir = path.join(tmpDir, "dates");
  if (!fs.existsSync(datesDir)) {
    fs.mkdirSync(datesDir, { recursive: true });
  }

  const sampleRows = [
    {
      date: "2025-01-31",
      code: "7203",
      coName: "トヨタ自動車",
      coNameEn: "",
      s17: "1",
      s17Nm: "",
      s33: "",
      s33Nm: "",
      scaleCat: "",
      mkt: "0111",
      mktNm: "プライム",
      mrgn: "",
      mrgnNm: "",
      prodCat: "",
    },
  ];

  const dateFileContent = JSON.stringify(sampleRows, null, 2);
  const dateFileSha256 = computeSha256(dateFileContent);
  fs.writeFileSync(path.join(datesDir, "2025-01-31.json"), dateFileContent, "utf-8");

  const combinedSha = computeSha256(`2025-01-31:${dateFileSha256}`);

  const manifestPath = path.join(tmpDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      startDate: "2025-01-31",
      endDate: "2025-01-31",
      totalEvalDays: 1,
      generatedAt: "2026-09-12T00:00:00Z",
      maxPagesPerDayGuard: 50,
      overallSha256: combinedSha,
      filesByDate: {
        "2025-01-31": {
          relativePath: "dates/2025-01-31.json",
          sha256: dateFileSha256,
          recordCount: 1,
        },
      },
    })
  );

  const context = loadHistoricalUniverseManifest(manifestPath);
  assert.equal(context.manifest.overallSha256, combinedSha);

  const dayRows = getHistoricalUniverseForDate(context, "2025-01-31");
  assert.equal(dayRows.length, 1);
  assert.equal(dayRows[0].code, "7203");

  const invalidManifestPath = path.join(tmpDir, "invalid_manifest.json");
  fs.writeFileSync(
    invalidManifestPath,
    JSON.stringify({
      startDate: "2025-01-31",
      endDate: "2025-01-31",
      totalEvalDays: 1,
      generatedAt: "2026-09-12T00:00:00Z",
      maxPagesPerDayGuard: 50,
      overallSha256: "BAD_OVERALL_HASH",
      filesByDate: {
        "2025-01-31": {
          relativePath: "dates/2025-01-31.json",
          sha256: dateFileSha256,
          recordCount: 1,
        },
      },
    })
  );

  assert.throws(() => loadHistoricalUniverseManifest(invalidManifestPath), /Manifest overall SHA-256 checksum mismatch/);

  assert.throws(
    () => loadHistoricalUniverseManifest(path.join(tmpDir, "nonexistent.json")),
    /Historical Universe manifest file not found/
  );

  assert.throws(
    () => getHistoricalUniverseForDate(context, "2099-01-01"),
    /Historical Universe for date 2099-01-01 is not present in cache manifest/
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
