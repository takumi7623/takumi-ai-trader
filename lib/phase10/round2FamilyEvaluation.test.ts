import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUND2_COEFFICIENT_PAIR_COUNT,
  ROUND2_FAMILIES,
  buildRound2CoefficientPairs,
  compareBySelectionPriority,
  computeRound2FamilyComposite,
  evaluateRound2CoefficientPair,
  fitRound2Families,
  gate2Round2CoefficientZero,
  round2CandidateScore,
  searchRound2CoefficientPairs,
  selectRound2Rows,
  type Round2FeatureRow,
} from "./round2FamilyEvaluation";
import type { Round2CoefficientEvaluation } from "./round2FamilyEvaluation";

function row(code: string, signalDate: string, baselineScore: number, return10d: number, seed: number): Round2FeatureRow {
  return {
    code,
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

function evaluation(params: {
  kMomentum: -4 | -2 | -1 | -0.5 | 0 | 0.5 | 1 | 2 | 4;
  kPosition: -4 | -2 | -1 | -0.5 | 0 | 0.5 | 1 | 2 | 4;
  ev?: number;
  pf?: number;
  maxDD?: number;
  winRate?: number;
  tradeCountRatio?: number;
}): Round2CoefficientEvaluation {
  const deltas = {
    tradeCount: 0,
    tradeCountRatio: params.tradeCountRatio ?? 1,
    winRate: params.winRate ?? 0.01,
    ev: params.ev ?? 0.01,
    pf: params.pf ?? 0.01,
    maxDD: params.maxDD ?? 0,
    misclassificationRate: 0,
  };
  const metrics = { tradeCount: 10, winRate: 0.5, ev: 1, pf: 1.2, maxDD: 5, misclassificationRate: 0.5 };
  return {
    coefficientPair: { kMomentum: params.kMomentum, kPosition: params.kPosition },
    folds: [],
    pooledBaselineMetrics: metrics,
    pooledCandidateMetrics: metrics,
    pooledDeltas: deltas,
    andConditions: [],
    passed: true,
  };
}

function selectedByComparator(...evaluations: Round2CoefficientEvaluation[]) {
  return evaluations.sort(compareBySelectionPriority)[0];
}

test("Round2 coefficient grid is pre-fixed to 81 pairs and includes the no-change reference", () => {
  const pairs = buildRound2CoefficientPairs();
  assert.equal(pairs.length, ROUND2_COEFFICIENT_PAIR_COUNT);
  assert.equal(ROUND2_COEFFICIENT_PAIR_COUNT, 81);
  assert.deepEqual(pairs[0], { kMomentum: -4, kPosition: -4 });
  assert.deepEqual(pairs[pairs.length - 1], { kMomentum: 4, kPosition: 4 });
  assert.ok(pairs.some((pair) => pair.kMomentum === 0 && pair.kPosition === 0));
});

test("Round2 family membership matches the fixed proposal D spec", () => {
  assert.deepEqual([...ROUND2_FAMILIES.momentum], ["normalizedMacdHistogram", "sma5Slope", "midTrendReturn"]);
  assert.deepEqual([...ROUND2_FAMILIES.position], ["relativeLow52Distance", "bollingerPricePosition"]);
});

test("Round2 family composites are fitted from feature rows and affect candidate score", () => {
  const rows = [
    row("1001", "2026-01-01", 70, -1, -2),
    row("1002", "2026-01-02", 70, 1, -1),
    row("1003", "2026-01-03", 70, -1, 1),
    row("1004", "2026-01-04", 70, 1, 2),
  ];
  const fit = fitRound2Families(rows);
  const composite = computeRound2FamilyComposite(rows[3], fit);
  assert.equal(Number.isFinite(composite.momentumComposite), true);
  assert.equal(Number.isFinite(composite.positionComposite), true);
  assert.notEqual(round2CandidateScore(rows[3], fit, { kMomentum: 1, kPosition: 1 }), rows[3].baselineScore);
});

test("Round2 Gate2 coefficient zero preserves selected rows and metrics", () => {
  const rows = [
    row("1001", "2026-01-01", 70, -1, -2),
    row("1002", "2026-01-02", 71, 1, -1),
    row("1003", "2026-01-03", 72, -1, 1),
    row("1004", "2026-01-04", 73, 1, 2),
  ];
  const result = gate2Round2CoefficientZero(rows);
  assert.equal(result.passed, true);
  assert.equal(result.selectedMatches, true);
  assert.equal(result.baselineRowCount, rows.length);
  assert.equal(result.selectedRowCount, rows.length);
  assert.deepEqual(result.selectedMetrics, result.baselineMetrics);
});

test("Round2 zero coefficient selection does not depend on feature values", () => {
  const rows = [
    row("1001", "2026-01-01", 70, -1, -100),
    row("1002", "2026-01-02", 70, 1, 100),
  ];
  const fit = fitRound2Families(rows);
  const selected = selectRound2Rows(rows, fit, { kMomentum: 0, kPosition: 0 });
  assert.equal(selected.length, rows.length);
});

test("Round2 coefficient pair evaluation reports AND9 conditions", () => {
  const rows = Array.from({ length: 60 }, (_, index) => row(
    `10${index}`,
    `2026-01-${String((index % 20) + 1).padStart(2, "0")}`,
    70,
    index % 2 === 0 ? 1 : -1,
    index - 30,
  ));
  const result = evaluateRound2CoefficientPair(rows, { kMomentum: 0, kPosition: 0 });
  assert.equal(result.andConditions.length, 9);
  assert.deepEqual(result.coefficientPair, { kMomentum: 0, kPosition: 0 });
  assert.equal(result.pooledDeltas.tradeCount, 0);
  assert.equal(result.pooledDeltas.ev, 0);
});

test("Round2 search evaluates the fixed 81-pair grid", () => {
  const rows = Array.from({ length: 60 }, (_, index) => row(
    `20${index}`,
    `2026-01-${String((index % 20) + 1).padStart(2, "0")}`,
    70,
    index % 3 === 0 ? 2 : -1,
    index - 30,
  ));
  const result = searchRound2CoefficientPairs(rows);
  assert.equal(result.coefficientPairCount, 81);
  assert.equal(result.evaluatedPairCount, 81);
  assert.equal(result.coefficientSearchExecuted, true);
  assert.equal(result.passingEvaluations.length, result.passingPairCount);
  assert.deepEqual(result.noChangeReference.coefficientPair, { kMomentum: 0, kPosition: 0 });
  assert.equal(result.noChangeReference.pooledDeltas.ev, 0);
  assert.equal(result.noChangeReference.pooledDeltas.pf, 0);
  assert.equal(result.diagnosticsBest.andConditions.length, 9);
});

test("Selection Priority A selects the largest pooled delta EV", () => {
  const selected = selectedByComparator(
    evaluation({ kMomentum: -4, kPosition: -4, ev: 0.1, pf: 0.9 }),
    evaluation({ kMomentum: -2, kPosition: -2, ev: 0.2, pf: 0.1 }),
  );
  assert.deepEqual(selected.coefficientPair, { kMomentum: -2, kPosition: -2 });
});

test("Selection Priority B uses pooled delta PF when pooled delta EV ties", () => {
  const selected = selectedByComparator(
    evaluation({ kMomentum: -4, kPosition: -4, ev: 0.1, pf: 0.1 }),
    evaluation({ kMomentum: -2, kPosition: -2, ev: 0.1, pf: 0.2 }),
  );
  assert.deepEqual(selected.coefficientPair, { kMomentum: -2, kPosition: -2 });
});

test("Selection Priority C prefers lower pooled delta MaxDD after EV and PF tie", () => {
  const selected = selectedByComparator(
    evaluation({ kMomentum: -4, kPosition: -4, ev: 0.1, pf: 0.2, maxDD: 0 }),
    evaluation({ kMomentum: -2, kPosition: -2, ev: 0.1, pf: 0.2, maxDD: -0.1 }),
  );
  assert.deepEqual(selected.coefficientPair, { kMomentum: -2, kPosition: -2 });
});

test("Selection Priority E-1 prefers the smaller coefficient norm after higher priorities tie", () => {
  const selected = selectedByComparator(
    evaluation({ kMomentum: -4, kPosition: 0, ev: 0.1, pf: 0.2 }),
    evaluation({ kMomentum: -1, kPosition: 1, ev: 0.1, pf: 0.2 }),
  );
  assert.deepEqual(selected.coefficientPair, { kMomentum: -1, kPosition: 1 });
});

test("Selection Priority E-2 uses the no-change reference then lexical order after prior ties", () => {
  const noChangeSelected = selectedByComparator(
    evaluation({ kMomentum: 0, kPosition: 0, ev: 0.1, pf: 0.2 }),
    evaluation({ kMomentum: -1, kPosition: 1, ev: 0.1, pf: 0.2 }),
  );
  assert.deepEqual(noChangeSelected.coefficientPair, { kMomentum: 0, kPosition: 0 });

  const lexicalSelected = selectedByComparator(
    evaluation({ kMomentum: 1, kPosition: -1, ev: 0.1, pf: 0.2 }),
    evaluation({ kMomentum: -1, kPosition: 1, ev: 0.1, pf: 0.2 }),
  );
  assert.deepEqual(lexicalSelected.coefficientPair, { kMomentum: -1, kPosition: 1 });
});

test("AND9 hard filter excludes the no-change reference from real search passing candidates", () => {
  const rows = Array.from({ length: 60 }, (_, index) => row(
    `30${index}`,
    `2026-01-${String((index % 20) + 1).padStart(2, "0")}`,
    70,
    index % 3 === 0 ? 2 : -1,
    index - 30,
  ));
  const result = searchRound2CoefficientPairs(rows);
  assert.equal(result.noChangeReference.passed, false);
  assert.equal(result.noChangeReference.andConditions.find((condition) => condition.condition === 1)?.passed, false);
  assert.equal(result.noChangeReference.andConditions.find((condition) => condition.condition === 2)?.passed, false);
  assert.equal(result.passingEvaluations.some((candidate) => (
    candidate.coefficientPair.kMomentum === 0 && candidate.coefficientPair.kPosition === 0
  )), false);
});