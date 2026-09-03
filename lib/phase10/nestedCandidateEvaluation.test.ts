import assert from "node:assert/strict";
import test from "node:test";
import {
  COEFFICIENT_OPTIONS,
  PHASE10_DATES,
  evaluateRound1Candidate,
  assertFinalOosRows,
  assertPreOosRows,
  evaluateFrozenSpecOnFinalOos,
  freezeFinalCandidateSpec,
  passesRound1Gate,
  selectCoefficientOnInnerValidation,
  summarizeTradeRows,
  sha256,
  splitOuterTrain,
  fitCandidateOnInnerTrain,
} from "./nestedCandidateEvaluation";

function row(code: string, signalDate: string, featureValue: number, return10d: number) {
  return { code, signalDate, featureValue, return10d };
}

const preOosRows = [
  row("1001", "2026-01-05", -2, -1),
  row("1002", "2026-01-06", -1, -1),
  row("1001", "2026-01-07", 1, 1),
  row("1002", "2026-01-08", 2, 1),
  row("1001", "2026-05-29", 3, 1),
];

test("uses Phase 10 dates from one fixed configuration", () => {
  assert.equal(PHASE10_DATES.preOosMaxSignalDate, "2026-05-29");
  assert.equal(PHASE10_DATES.finalOosStart, "2026-06-01");
  assert.equal(PHASE10_DATES.finalOosEnd, "2026-08-07");
});

test("selection and freeze inputs reject Final OOS rows", () => {
  const finalOosRow = row("1001", "2026-06-01", 99, 99);
  assert.throws(() => assertPreOosRows([...preOosRows, finalOosRow]), /exclude Final OOS/);
  assert.throws(() => splitOuterTrain([...preOosRows, finalOosRow]), /exclude Final OOS/);
  assert.throws(() => freezeFinalCandidateSpec([...preOosRows, finalOosRow], ["sma5Slope"], 1, "baseline"), /exclude Final OOS/);
});

test("Final OOS content changes cannot change selection or frozen parameters", () => {
  const changedFinalOosRows = [row("9999", "2026-06-01", -999, -999)];
  const split = splitOuterTrain(preOosRows);
  const fit = fitCandidateOnInnerTrain(split.innerTrain);
  const coefficient = selectCoefficientOnInnerValidation(fit, split.innerValidation, (_rows, value) => value);
  const spec = freezeFinalCandidateSpec(preOosRows, ["sma5Slope"], coefficient, "baseline");
  assert.equal(coefficient, 4);
  assert.equal(sha256(spec), sha256(freezeFinalCandidateSpec(preOosRows, ["sma5Slope"], coefficient, "baseline")));
  assert.equal(changedFinalOosRows.length, 1);
});

test("removing Final OOS rows cannot change selection or frozen parameters", () => {
  const inputWithFinalOos = [...preOosRows, row("9999", "2026-06-01", 200, -200)];
  const preOosOnly = inputWithFinalOos.filter((item) => item.signalDate <= PHASE10_DATES.preOosMaxSignalDate);
  const fitA = fitCandidateOnInnerTrain(splitOuterTrain(preOosOnly).innerTrain);
  const fitB = fitCandidateOnInnerTrain(splitOuterTrain(preOosRows).innerTrain);
  assert.deepEqual(fitA, fitB);
  assert.equal(sha256(freezeFinalCandidateSpec(preOosOnly, ["sma5Slope"], 1, "baseline")), sha256(freezeFinalCandidateSpec(preOosRows, ["sma5Slope"], 1, "baseline")));
});

test("Final OOS evaluator applies only the frozen spec and leaves it unchanged", () => {
  const spec = freezeFinalCandidateSpec(preOosRows, ["sma5Slope"], COEFFICIENT_OPTIONS[5], "baseline");
  const before = sha256(spec);
  const result = evaluateFrozenSpecOnFinalOos(spec, [row("1001", "2026-06-01", 2, -1)], (_row, increment) => increment);
  assert.equal(result.frozenSpecSha256, before);
  assert.equal(sha256(spec), before);
  assert.equal(result.values.length, 1);
});

test("Final OOS evaluator rejects date ranges outside the fixed window", () => {
  const spec = freezeFinalCandidateSpec(preOosRows, ["sma5Slope"], 1, "baseline");
  assert.throws(() => assertFinalOosRows([row("1001", "2026-05-29", 1, 1)]), /fixed Final OOS date range/);
  assert.throws(() => evaluateFrozenSpecOnFinalOos(spec, [row("1001", "2026-08-08", 1, 1)], () => 0), /fixed Final OOS date range/);
});

test("Round 1 evaluation uses pre-OOS rows only and keeps score-increment metrics unchanged", () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, index) => row(`10${index}`, `2025-12-${String((index % 20) + 1).padStart(2, "0")}`, index, index % 2 === 0 ? 1 : -1)),
    row("9999", "2026-06-01", 999, 999),
  ];
  assert.throws(() => evaluateRound1Candidate("sma5Slope", rows), /exclude Final OOS/);
  const result = evaluateRound1Candidate("sma5Slope", rows.filter((item) => item.signalDate <= PHASE10_DATES.preOosMaxSignalDate));
  assert.equal(result.round1Passed, false);
  assert.deepEqual(result.pooledCandidateMetrics, result.pooledBaselineMetrics);
  assert.equal(result.pooledDeltas.ev, 0);
});

test("Round 1 pass gate applies the fixed AND criteria", () => {
  const baseline = summarizeTradeRows([row("1", "2026-01-01", 1, 1), row("2", "2026-01-02", 1, -1)]);
  const candidate = { tradeCount: 2, winRate: baseline.winRate, ev: baseline.ev + 0.1, pf: baseline.pf + 0.1, maxDD: baseline.maxDD, misclassificationRate: baseline.misclassificationRate };
  const passingDelta = { tradeCount: 0, tradeCountRatio: 1, winRate: 0, ev: 0.1, pf: 0.1, maxDD: 0, misclassificationRate: 0 };
  assert.equal(passesRound1Gate([passingDelta, passingDelta, passingDelta], passingDelta, baseline, candidate), true);
  assert.equal(passesRound1Gate([passingDelta, { ...passingDelta, ev: 0 }, { ...passingDelta, ev: 0 }], passingDelta, baseline, candidate), false);
  assert.equal(passesRound1Gate([passingDelta, passingDelta, passingDelta], { ...passingDelta, pf: 0 }, baseline, candidate), false);
});