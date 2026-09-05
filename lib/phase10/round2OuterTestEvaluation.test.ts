import assert from "node:assert/strict";
import test from "node:test";
import {
  FROZEN_ROUND2_COEFFICIENT_PAIR,
  evaluateFrozenRound2OuterTest,
} from "./round2OuterTestEvaluation";
import type { Round2FeatureRow } from "./round2FamilyEvaluation";

const folds = [{ name: "WF1", trainEnd: "2026-01-07", testStart: "2026-01-08", testEnd: "2026-01-10" }];

function row(signalDate: string, baselineScore: number, return10d: number, seed: number): Round2FeatureRow {
  return {
    code: `10${signalDate.slice(-2)}`,
    signalDate,
    baselineScore,
    return10d,
    featureValue: 0,
    features: {
      normalizedMacdHistogram: seed,
      sma5Slope: seed * 0.5,
      midTrendReturn: seed * 0.25,
      relativeLow52Distance: -seed,
      bollingerPricePosition: seed * 0.1,
    },
  };
}

function evaluationRows() {
  return [
    row("2026-01-02", 70, -1, -2),
    row("2026-01-03", 71, 1, -1),
    row("2026-01-04", 72, -1, 1),
    row("2026-01-05", 73, 1, 2),
    row("2026-01-08", 70, -1, -2),
    row("2026-01-09", 70, 1, 2),
    row("2026-01-10", 70, 1, 1),
  ];
}

test("Outer Test uses the frozen Round2 pair without coefficient search or Selection Priority", () => {
  const result = evaluateFrozenRound2OuterTest(evaluationRows(), folds);
  assert.deepEqual(result.frozenCoefficientPair, FROZEN_ROUND2_COEFFICIENT_PAIR);
  assert.deepEqual(result.folds[0].frozenCoefficientPair, FROZEN_ROUND2_COEFFICIENT_PAIR);
  assert.equal(result.coefficientSearchExecuted, false);
  assert.equal(result.selectionPriorityExecuted, false);
  assert.equal(result.adoptionDecisionMade, false);
});

test("Outer Test fits only Outer Train and evaluates only the declared test range", () => {
  const result = evaluateFrozenRound2OuterTest(evaluationRows(), folds);
  assert.equal(result.folds[0].outerTrainRows, 4);
  assert.equal(result.folds[0].outerTestRows, 3);
  assert.equal(result.pooledBaselineMetrics.tradeCount, 3);
});

test("Outer Test rejects Final OOS rows", () => {
  assert.throws(
    () => evaluateFrozenRound2OuterTest([...evaluationRows(), row("2026-06-01", 70, 1, 1)], folds),
    /exclude Final OOS/,
  );
});

test("Outer Test AND9 is diagnostic and cannot alter the frozen pair or adoption state", () => {
  const result = evaluateFrozenRound2OuterTest(evaluationRows(), folds);
  assert.equal(result.and9Diagnostic.length, 9);
  assert.deepEqual(result.frozenCoefficientPair, FROZEN_ROUND2_COEFFICIENT_PAIR);
  assert.equal(result.adoptionDecisionMade, false);
});