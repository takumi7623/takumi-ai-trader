import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUND3_EQUIVALENCE_BAND_EV,
  evaluateRound3,
  evaluateRound3OuterTest,
  selectHypothesisACandidate,
  selectHypothesisBCandidate,
} from "./round3FamilyEvaluation";
import type { Round2FeatureRow } from "./round2FamilyEvaluation";

function mockRow(signalDate: string, baselineScore: number, return10d: number, seed: number): Round2FeatureRow {
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
    mockRow("2026-01-02", 70, -1, -2),
    mockRow("2026-01-03", 71, 1, -1),
    mockRow("2026-01-04", 72, -1, 1),
    mockRow("2026-01-05", 73, 1, 2),
    mockRow("2026-01-08", 70, -1, -2),
    mockRow("2026-01-09", 70, 1, 2),
    mockRow("2026-01-10", 70, 1, 1),
  ];
}

test("Round3 Equivalence Band constant is frozen at 0.005%", () => {
  assert.equal(ROUND3_EQUIVALENCE_BAND_EV, 0.005);
});

test("Round3 Hypotheses reject Final OOS rows", () => {
  const oosRows = [...evaluationRows(), mockRow("2026-06-01", 70, 1, 1)];
  assert.throws(() => evaluateRound3(oosRows), /exclude Final OOS/);
  assert.throws(() => evaluateRound3OuterTest(oosRows, { kMomentum: 1, kPosition: 1 }), /exclude Final OOS/);
});

test("Round3 Hypotheses selection functions handle empty passing candidates gracefully", () => {
  const mockSearchResult = {
    coefficientPairCount: 81,
    evaluatedPairCount: 81,
    passingPairCount: 0,
    passingEvaluations: [],
    noChangeReference: {} as any,
    selected: null as any,
    diagnosticsBest: null as any,
    coefficientSearchExecuted: true as const,
  };
  assert.equal(selectHypothesisACandidate(mockSearchResult), null);
  assert.equal(selectHypothesisBCandidate(mockSearchResult), null);
});
