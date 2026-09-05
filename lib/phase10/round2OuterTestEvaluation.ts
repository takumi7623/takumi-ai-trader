import {
  type MetricDeltas,
  type TradeMetrics,
  assertPreOosRows,
  metricDeltas,
  passesRound1Gate,
  summarizeTradeRows,
} from "./nestedCandidateEvaluation";
import {
  type Round2AndCondition,
  type Round2FamilyFit,
  type Round2FeatureRow,
  fitRound2Families,
  selectRound2Rows,
} from "./round2FamilyEvaluation";

export const FROZEN_ROUND2_COEFFICIENT_PAIR = {
  kMomentum: -4,
  kPosition: 1,
} as const;

export type Round2OuterFold = Readonly<{
  name: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
}>;

export type Round2OuterTestFoldResult = Readonly<{
  foldName: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  frozenCoefficientPair: typeof FROZEN_ROUND2_COEFFICIENT_PAIR;
  outerTrainRows: number;
  outerTestRows: number;
  fit: Round2FamilyFit;
  baselineMetrics: TradeMetrics;
  candidateMetrics: TradeMetrics;
  deltas: MetricDeltas;
}>;

export type Round2OuterTestResult = Readonly<{
  frozenCoefficientPair: typeof FROZEN_ROUND2_COEFFICIENT_PAIR;
  folds: readonly Round2OuterTestFoldResult[];
  pooledBaselineMetrics: TradeMetrics;
  pooledCandidateMetrics: TradeMetrics;
  pooledDeltas: MetricDeltas;
  and9Diagnostic: readonly Round2AndCondition[];
  and9Passed: boolean;
  coefficientSearchExecuted: false;
  selectionPriorityExecuted: false;
  adoptionDecisionMade: false;
}>;

function conditionList(
  foldDeltas: readonly MetricDeltas[],
  pooledDeltas: MetricDeltas,
  pooledBaseline: TradeMetrics,
  pooledCandidate: TradeMetrics,
): readonly Round2AndCondition[] {
  const epsilon = 1e-10;
  return [
    { condition: 1, name: "pooled delta EV > 0", passed: pooledDeltas.ev > epsilon },
    { condition: 2, name: "pooled delta PF > 0", passed: pooledDeltas.pf > epsilon },
    { condition: 3, name: "pooled delta MaxDD <= 0", passed: pooledDeltas.maxDD <= epsilon },
    { condition: 4, name: "pooled delta WinRate >= 0", passed: pooledDeltas.winRate >= -epsilon },
    {
      condition: 5,
      name: "pooled TradeCount ratio is between 80% and 120% of Baseline",
      passed: pooledDeltas.tradeCountRatio >= 0.8 - epsilon && pooledDeltas.tradeCountRatio <= 1.2 + epsilon,
    },
    { condition: 6, name: "Baseline and Candidate both have TradeCount > 0", passed: pooledBaseline.tradeCount > 0 && pooledCandidate.tradeCount > 0 },
    { condition: 7, name: "delta EV improves in at least 2 folds", passed: foldDeltas.filter((delta) => delta.ev > epsilon).length >= 2 },
    { condition: 8, name: "delta PF improves in at least 2 folds", passed: foldDeltas.filter((delta) => delta.pf > epsilon).length >= 2 },
    { condition: 9, name: "no fold has worse MaxDD", passed: foldDeltas.every((delta) => delta.maxDD <= epsilon) },
  ];
}

function assertFoldDefinition(fold: Round2OuterFold) {
  if (!(fold.trainEnd < fold.testStart && fold.testStart <= fold.testEnd)) {
    throw new Error(`Invalid Round2 Outer Test fold: ${fold.name}`);
  }
}

export function evaluateFrozenRound2OuterTest(
  rows: readonly Round2FeatureRow[],
  folds: readonly Round2OuterFold[],
): Round2OuterTestResult {
  assertPreOosRows(rows);
  const pooledBaselineRows: Round2FeatureRow[] = [];
  const pooledCandidateRows: Round2FeatureRow[] = [];
  const foldResults = folds.map((fold) => {
    assertFoldDefinition(fold);
    const outerTrainRows = rows.filter((row) => row.signalDate <= fold.trainEnd);
    const outerTestRows = rows.filter((row) => row.signalDate >= fold.testStart && row.signalDate <= fold.testEnd);
    const fit = fitRound2Families(outerTrainRows);
    const candidateRows = selectRound2Rows(outerTestRows, fit, FROZEN_ROUND2_COEFFICIENT_PAIR);
    const baselineMetrics = summarizeTradeRows(outerTestRows);
    const candidateMetrics = summarizeTradeRows(candidateRows);
    pooledBaselineRows.push(...outerTestRows);
    pooledCandidateRows.push(...candidateRows);

    return {
      foldName: fold.name,
      trainEnd: fold.trainEnd,
      testStart: fold.testStart,
      testEnd: fold.testEnd,
      frozenCoefficientPair: FROZEN_ROUND2_COEFFICIENT_PAIR,
      outerTrainRows: outerTrainRows.length,
      outerTestRows: outerTestRows.length,
      fit,
      baselineMetrics,
      candidateMetrics,
      deltas: metricDeltas(baselineMetrics, candidateMetrics),
    };
  });

  const pooledBaselineMetrics = summarizeTradeRows(pooledBaselineRows);
  const pooledCandidateMetrics = summarizeTradeRows(pooledCandidateRows);
  const pooledDeltas = metricDeltas(pooledBaselineMetrics, pooledCandidateMetrics);
  const foldDeltas = foldResults.map((fold) => fold.deltas);
  const and9Diagnostic = conditionList(foldDeltas, pooledDeltas, pooledBaselineMetrics, pooledCandidateMetrics);

  return {
    frozenCoefficientPair: FROZEN_ROUND2_COEFFICIENT_PAIR,
    folds: foldResults,
    pooledBaselineMetrics,
    pooledCandidateMetrics,
    pooledDeltas,
    and9Diagnostic,
    and9Passed: passesRound1Gate(foldDeltas, pooledDeltas, pooledBaselineMetrics, pooledCandidateMetrics),
    coefficientSearchExecuted: false,
    selectionPriorityExecuted: false,
    adoptionDecisionMade: false,
  };
}