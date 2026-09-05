import {
  type MetricDeltas,
  type TradeMetrics,
  assertPreOosRows,
  metricDeltas,
  passesRound1Gate,
  summarizeTradeRows,
} from "./nestedCandidateEvaluation";
import {
  type Round2CoefficientEvaluation,
  type Round2CoefficientPair,
  type Round2FamilyFit,
  type Round2FeatureRow,
  fitRound2Families,
  searchRound2CoefficientPairs,
  selectRound2Rows,
} from "./round2FamilyEvaluation";

export const ROUND3_EQUIVALENCE_BAND_EV = 0.005;

export type Round3HypothesisResult = Readonly<{
  hypothesisName: "HypothesisA" | "HypothesisB";
  selectedPair: Round2CoefficientPair | null;
  innerPassingCount: number;
  innerEvaluation: Round2CoefficientEvaluation | null;
  outerFoldResults: readonly Readonly<{
    foldName: string;
    trainEnd: string;
    testStart: string;
    testEnd: string;
    baselineMetrics: TradeMetrics;
    candidateMetrics: TradeMetrics;
    deltas: MetricDeltas;
  }>[];
  outerPooledBaselineMetrics: TradeMetrics | null;
  outerPooledCandidateMetrics: TradeMetrics | null;
  outerPooledDeltas: MetricDeltas | null;
  outerPassed: boolean;
}>;

export type Round3OverallResult = Readonly<{
  hypothesisA: Round3HypothesisResult;
  hypothesisB: Round3HypothesisResult;
  finalAdoption: "HypothesisA" | "HypothesisB" | "MaintainBaseline";
  adoptedPair: Round2CoefficientPair | null;
}>;

function coefficientNorm(pair: Round2CoefficientPair): number {
  return Math.sqrt(pair.kMomentum ** 2 + pair.kPosition ** 2);
}

function metricsEqualEpsilon(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

export function selectHypothesisACandidate(
  searchResult: ReturnType<typeof searchRound2CoefficientPairs>,
): Round2CoefficientEvaluation | null {
  const passing = searchResult.passingEvaluations;
  if (!passing || passing.length === 0) return null;

  const maxEv = Math.max(...passing.map((p) => p.pooledDeltas.ev));
  const band = passing.filter((p) => maxEv - p.pooledDeltas.ev <= ROUND3_EQUIVALENCE_BAND_EV + 1e-9);

  const sorted = [...band].sort((left, right) => {
    if (!metricsEqualEpsilon(left.pooledDeltas.maxDD, right.pooledDeltas.maxDD)) {
      return left.pooledDeltas.maxDD - right.pooledDeltas.maxDD;
    }
    if (!metricsEqualEpsilon(left.pooledDeltas.pf, right.pooledDeltas.pf)) {
      return right.pooledDeltas.pf - left.pooledDeltas.pf;
    }
    if (!metricsEqualEpsilon(left.pooledDeltas.winRate, right.pooledDeltas.winRate)) {
      return right.pooledDeltas.winRate - left.pooledDeltas.winRate;
    }
    const normDiff = coefficientNorm(left.coefficientPair) - coefficientNorm(right.coefficientPair);
    if (!metricsEqualEpsilon(normDiff, 0)) return normDiff;
    return left.coefficientPair.kMomentum - right.coefficientPair.kMomentum
      || left.coefficientPair.kPosition - right.coefficientPair.kPosition;
  });

  return sorted[0] ?? null;
}

export function selectHypothesisBCandidate(
  searchResult: ReturnType<typeof searchRound2CoefficientPairs>,
): Round2CoefficientEvaluation | null {
  const passing = searchResult.passingEvaluations;
  if (!passing || passing.length === 0) return null;

  const restricted = passing.filter(
    (p) => p.coefficientPair.kMomentum >= 0 && p.coefficientPair.kPosition >= 0,
  );
  if (restricted.length === 0) return null;

  const sorted = [...restricted].sort((left, right) => {
    if (!metricsEqualEpsilon(left.pooledDeltas.ev, right.pooledDeltas.ev)) {
      return right.pooledDeltas.ev - left.pooledDeltas.ev;
    }
    if (!metricsEqualEpsilon(left.pooledDeltas.pf, right.pooledDeltas.pf)) {
      return right.pooledDeltas.pf - left.pooledDeltas.pf;
    }
    if (!metricsEqualEpsilon(left.pooledDeltas.maxDD, right.pooledDeltas.maxDD)) {
      return left.pooledDeltas.maxDD - right.pooledDeltas.maxDD;
    }
    if (!metricsEqualEpsilon(left.pooledDeltas.winRate, right.pooledDeltas.winRate)) {
      return right.pooledDeltas.winRate - left.pooledDeltas.winRate;
    }
    const normDiff = coefficientNorm(left.coefficientPair) - coefficientNorm(right.coefficientPair);
    if (!metricsEqualEpsilon(normDiff, 0)) return normDiff;
    return left.coefficientPair.kMomentum - right.coefficientPair.kMomentum
      || left.coefficientPair.kPosition - right.coefficientPair.kPosition;
  });

  return sorted[0] ?? null;
}

const ROUND3_OUTER_FOLDS = [
  { name: "WF1", trainEnd: "2026-01-07", testStart: "2026-01-08", testEnd: "2026-02-25" },
  { name: "WF2", trainEnd: "2026-02-25", testStart: "2026-02-26", testEnd: "2026-04-10" },
  { name: "WF3", trainEnd: "2026-04-10", testStart: "2026-04-13", testEnd: "2026-05-29" },
] as const;

export function evaluateRound3OuterTest(
  rows: readonly Round2FeatureRow[],
  pair: Round2CoefficientPair,
): {
  outerFoldResults: readonly Readonly<{
    foldName: string;
    trainEnd: string;
    testStart: string;
    testEnd: string;
    baselineMetrics: TradeMetrics;
    candidateMetrics: TradeMetrics;
    deltas: MetricDeltas;
  }>[];
  outerPooledBaselineMetrics: TradeMetrics;
  outerPooledCandidateMetrics: TradeMetrics;
  outerPooledDeltas: MetricDeltas;
  outerPassed: boolean;
} {
  assertPreOosRows(rows);
  const pooledBaselineRows: Round2FeatureRow[] = [];
  const pooledCandidateRows: Round2FeatureRow[] = [];

  const outerFoldResults = ROUND3_OUTER_FOLDS.map((fold) => {
    const outerTrainRows = rows.filter((r) => r.signalDate <= fold.trainEnd);
    const outerTestRows = rows.filter((r) => r.signalDate >= fold.testStart && r.signalDate <= fold.testEnd);
    const fit = fitRound2Families(outerTrainRows);
    const candidateRows = selectRound2Rows(outerTestRows, fit, pair);

    const baselineMetrics = summarizeTradeRows(outerTestRows);
    const candidateMetrics = summarizeTradeRows(candidateRows);
    pooledBaselineRows.push(...outerTestRows);
    pooledCandidateRows.push(...candidateRows);

    return {
      foldName: fold.name,
      trainEnd: fold.trainEnd,
      testStart: fold.testStart,
      testEnd: fold.testEnd,
      baselineMetrics,
      candidateMetrics,
      deltas: metricDeltas(baselineMetrics, candidateMetrics),
    };
  });

  const outerPooledBaselineMetrics = summarizeTradeRows(pooledBaselineRows);
  const outerPooledCandidateMetrics = summarizeTradeRows(pooledCandidateRows);
  const outerPooledDeltas = metricDeltas(outerPooledBaselineMetrics, outerPooledCandidateMetrics);
  const foldDeltas = outerFoldResults.map((f) => f.deltas);

  const outerPassed = passesRound1Gate(
    foldDeltas,
    outerPooledDeltas,
    outerPooledBaselineMetrics,
    outerPooledCandidateMetrics,
  );

  return {
    outerFoldResults,
    outerPooledBaselineMetrics,
    outerPooledCandidateMetrics,
    outerPooledDeltas,
    outerPassed,
  };
}

export function evaluateRound3(
  preOosRows: readonly Round2FeatureRow[],
): Round3OverallResult {
  assertPreOosRows(preOosRows);
  const searchResult = searchRound2CoefficientPairs(preOosRows);

  const selectedA = selectHypothesisACandidate(searchResult);
  let hypothesisA: Round3HypothesisResult;
  if (!selectedA) {
    hypothesisA = {
      hypothesisName: "HypothesisA",
      selectedPair: null,
      innerPassingCount: 0,
      innerEvaluation: null,
      outerFoldResults: [],
      outerPooledBaselineMetrics: null,
      outerPooledCandidateMetrics: null,
      outerPooledDeltas: null,
      outerPassed: false,
    };
  } else {
    const outerA = evaluateRound3OuterTest(preOosRows, selectedA.coefficientPair);
    hypothesisA = {
      hypothesisName: "HypothesisA",
      selectedPair: selectedA.coefficientPair,
      innerPassingCount: searchResult.passingEvaluations.length,
      innerEvaluation: selectedA,
      ...outerA,
    };
  }

  const selectedB = selectHypothesisBCandidate(searchResult);
  const innerPassingBCount = searchResult.passingEvaluations.filter(
    (p) => p.coefficientPair.kMomentum >= 0 && p.coefficientPair.kPosition >= 0,
  ).length;
  let hypothesisB: Round3HypothesisResult;
  if (!selectedB) {
    hypothesisB = {
      hypothesisName: "HypothesisB",
      selectedPair: null,
      innerPassingCount: innerPassingBCount,
      innerEvaluation: null,
      outerFoldResults: [],
      outerPooledBaselineMetrics: null,
      outerPooledCandidateMetrics: null,
      outerPooledDeltas: null,
      outerPassed: false,
    };
  } else {
    const outerB = evaluateRound3OuterTest(preOosRows, selectedB.coefficientPair);
    hypothesisB = {
      hypothesisName: "HypothesisB",
      selectedPair: selectedB.coefficientPair,
      innerPassingCount: innerPassingBCount,
      innerEvaluation: selectedB,
      ...outerB,
    };
  }

  let finalAdoption: "HypothesisA" | "HypothesisB" | "MaintainBaseline" = "MaintainBaseline";
  let adoptedPair: Round2CoefficientPair | null = null;

  if (hypothesisA.outerPassed && !hypothesisB.outerPassed) {
    finalAdoption = "HypothesisA";
    adoptedPair = hypothesisA.selectedPair;
  } else if (!hypothesisA.outerPassed && hypothesisB.outerPassed) {
    finalAdoption = "HypothesisB";
    adoptedPair = hypothesisB.selectedPair;
  } else if (hypothesisA.outerPassed && hypothesisB.outerPassed) {
    const deltasA = hypothesisA.outerPooledDeltas!;
    const deltasB = hypothesisB.outerPooledDeltas!;
    const ratioDiffA = Math.abs(deltasA.tradeCountRatio - 1.0);
    const ratioDiffB = Math.abs(deltasB.tradeCountRatio - 1.0);

    if (!metricsEqualEpsilon(deltasA.ev, deltasB.ev)) {
      if (deltasA.ev > deltasB.ev) {
        finalAdoption = "HypothesisA";
        adoptedPair = hypothesisA.selectedPair;
      } else {
        finalAdoption = "HypothesisB";
        adoptedPair = hypothesisB.selectedPair;
      }
    } else if (!metricsEqualEpsilon(deltasA.pf, deltasB.pf)) {
      if (deltasA.pf > deltasB.pf) {
        finalAdoption = "HypothesisA";
        adoptedPair = hypothesisA.selectedPair;
      } else {
        finalAdoption = "HypothesisB";
        adoptedPair = hypothesisB.selectedPair;
      }
    } else if (!metricsEqualEpsilon(deltasA.maxDD, deltasB.maxDD)) {
      if (deltasA.maxDD < deltasB.maxDD) {
        finalAdoption = "HypothesisA";
        adoptedPair = hypothesisA.selectedPair;
      } else {
        finalAdoption = "HypothesisB";
        adoptedPair = hypothesisB.selectedPair;
      }
    } else if (!metricsEqualEpsilon(deltasA.winRate, deltasB.winRate)) {
      if (deltasA.winRate > deltasB.winRate) {
        finalAdoption = "HypothesisA";
        adoptedPair = hypothesisA.selectedPair;
      } else {
        finalAdoption = "HypothesisB";
        adoptedPair = hypothesisB.selectedPair;
      }
    } else if (!metricsEqualEpsilon(ratioDiffA, ratioDiffB)) {
      if (ratioDiffA < ratioDiffB) {
        finalAdoption = "HypothesisA";
        adoptedPair = hypothesisA.selectedPair;
      } else {
        finalAdoption = "HypothesisB";
        adoptedPair = hypothesisB.selectedPair;
      }
    } else {
      finalAdoption = "HypothesisA";
      adoptedPair = hypothesisA.selectedPair;
    }
  }

  return {
    hypothesisA,
    hypothesisB,
    finalAdoption,
    adoptedPair,
  };
}
