import {
  type CandidateFit,
  type Coefficient,
  type MetricDeltas,
  type Phase10ScoredRow,
  type TradeMetrics,
  PHASE10_OUTER_FOLDS,
  assertPreOosRows,
  fitCandidateOnInnerTrain,
  metricDeltas,
  passesRound1Gate,
  scoreIncrement,
  splitOuterTrain,
  summarizeTradeRows,
} from "./nestedCandidateEvaluation";

export const ROUND2_MOMENTUM_FEATURES = [
  "normalizedMacdHistogram",
  "sma5Slope",
  "midTrendReturn",
] as const;

export const ROUND2_POSITION_FEATURES = [
  "relativeLow52Distance",
  "bollingerPricePosition",
] as const;

export const ROUND2_FAMILIES = {
  momentum: ROUND2_MOMENTUM_FEATURES,
  position: ROUND2_POSITION_FEATURES,
} as const;

export const ROUND2_COEFFICIENT_GRID = [-4, -2, -1, -0.5, 0, 0.5, 1, 2, 4] as const;
export const ROUND2_COEFFICIENT_PAIR_COUNT = ROUND2_COEFFICIENT_GRID.length * ROUND2_COEFFICIENT_GRID.length;
export const ROUND2_SCORE_FLOOR = 70;

export type Round2FeatureName = typeof ROUND2_MOMENTUM_FEATURES[number] | typeof ROUND2_POSITION_FEATURES[number];
export type Round2FamilyName = keyof typeof ROUND2_FAMILIES;

export type Round2CoefficientPair = Readonly<{
  kMomentum: Coefficient;
  kPosition: Coefficient;
}>;

export type Round2FeatureRow = Phase10ScoredRow & Readonly<{
  features: Readonly<Record<Round2FeatureName, number>>;
}>;

export type Round2FamilyFit = Readonly<{
  features: Readonly<Record<Round2FeatureName, CandidateFit>>;
  familyFallback: Readonly<Record<Round2FamilyName, boolean>>;
}>;

export type Round2FamilyComposite = Readonly<{
  momentumComposite: number;
  positionComposite: number;
  familyFallback: Readonly<Record<Round2FamilyName, boolean>>;
}>;

export type Round2Gate2Result = Readonly<{
  passed: boolean;
  selectedMatches: boolean;
  baselineRowCount: number;
  selectedRowCount: number;
  baselineMetrics: TradeMetrics;
  selectedMetrics: TradeMetrics;
}>;

export type Round2AndCondition = Readonly<{
  condition: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  name: string;
  passed: boolean;
}>;

export type Round2FoldEvaluation = Readonly<{
  foldName: string;
  trainEnd: string;
  innerTrainRows: number;
  innerValidationRows: number;
  fit: Round2FamilyFit;
  baselineMetrics: TradeMetrics;
  candidateMetrics: TradeMetrics;
  deltas: MetricDeltas;
}>;

export type Round2CoefficientEvaluation = Readonly<{
  coefficientPair: Round2CoefficientPair;
  folds: readonly Round2FoldEvaluation[];
  pooledBaselineMetrics: TradeMetrics;
  pooledCandidateMetrics: TradeMetrics;
  pooledDeltas: MetricDeltas;
  andConditions: readonly Round2AndCondition[];
  passed: boolean;
}>;

export type Round2SearchResult = Readonly<{
  coefficientPairCount: number;
  evaluatedPairCount: number;
  passingPairCount: number;
  passingEvaluations: readonly Round2CoefficientEvaluation[];
  noChangeReference: Round2CoefficientEvaluation;
  selected: Round2CoefficientEvaluation | null;
  diagnosticsBest: Round2CoefficientEvaluation;
  coefficientSearchExecuted: true;
}>;

function featureRows(rows: readonly Round2FeatureRow[], featureName: Round2FeatureName) {
  return rows.map((row) => ({
    code: row.code,
    signalDate: row.signalDate,
    return10d: row.return10d,
    featureValue: row.features[featureName],
  }));
}

function mean(values: readonly number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function metricsEqual(left: TradeMetrics, right: TradeMetrics) {
  const epsilon = 1e-12;
  return Math.abs(left.tradeCount - right.tradeCount) <= epsilon
    && Math.abs(left.winRate - right.winRate) <= epsilon
    && Math.abs(left.ev - right.ev) <= epsilon
    && Math.abs(left.pf - right.pf) <= epsilon
    && Math.abs(left.maxDD - right.maxDD) <= epsilon
    && Math.abs(left.misclassificationRate - right.misclassificationRate) <= epsilon;
}

function coefficientNorm(pair: Round2CoefficientPair) {
  return Math.abs(pair.kMomentum) + Math.abs(pair.kPosition);
}

function candidateRowsForPair(rows: readonly Round2FeatureRow[], fit: Round2FamilyFit, coefficientPair: Round2CoefficientPair) {
  return selectRound2Rows(rows, fit, coefficientPair, ROUND2_SCORE_FLOOR);
}

function conditionList(
  foldDeltas: readonly MetricDeltas[],
  pooledDeltas: MetricDeltas,
  pooledBaseline: TradeMetrics,
  pooledCandidate: TradeMetrics,
): readonly Round2AndCondition[] {
  const epsilon = 1e-10;
  const evImprovedFolds = foldDeltas.filter((delta) => delta.ev > epsilon).length;
  const pfImprovedFolds = foldDeltas.filter((delta) => delta.pf > epsilon).length;

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
    { condition: 7, name: "delta EV improves in at least 2 folds", passed: evImprovedFolds >= 2 },
    { condition: 8, name: "delta PF improves in at least 2 folds", passed: pfImprovedFolds >= 2 },
    { condition: 9, name: "no fold has worse MaxDD", passed: foldDeltas.every((delta) => delta.maxDD <= epsilon) },
  ];
}

export function compareBySelectionPriority(left: Round2CoefficientEvaluation, right: Round2CoefficientEvaluation) {
  const leftTradeCountDistance = Math.abs(left.pooledDeltas.tradeCountRatio - 1);
  const rightTradeCountDistance = Math.abs(right.pooledDeltas.tradeCountRatio - 1);
  const priorityComparisons = [
    right.pooledDeltas.ev - left.pooledDeltas.ev,
    right.pooledDeltas.pf - left.pooledDeltas.pf,
    left.pooledDeltas.maxDD - right.pooledDeltas.maxDD,
    right.pooledDeltas.winRate - left.pooledDeltas.winRate,
    leftTradeCountDistance - rightTradeCountDistance,
    coefficientNorm(left.coefficientPair) - coefficientNorm(right.coefficientPair),
  ];

  for (const comparison of priorityComparisons) {
    if (comparison !== 0) return comparison;
  }

  const leftNoChange = left.coefficientPair.kMomentum === 0 && left.coefficientPair.kPosition === 0;
  const rightNoChange = right.coefficientPair.kMomentum === 0 && right.coefficientPair.kPosition === 0;
  if (leftNoChange !== rightNoChange) return leftNoChange ? -1 : 1;
  if (left.coefficientPair.kMomentum !== right.coefficientPair.kMomentum) return left.coefficientPair.kMomentum - right.coefficientPair.kMomentum;
  return left.coefficientPair.kPosition - right.coefficientPair.kPosition;
}

export function buildRound2CoefficientPairs(): readonly Round2CoefficientPair[] {
  return ROUND2_COEFFICIENT_GRID.flatMap((kMomentum) => (
    ROUND2_COEFFICIENT_GRID.map((kPosition) => ({ kMomentum, kPosition }))
  ));
}

export function fitRound2Families(rows: readonly Round2FeatureRow[]): Round2FamilyFit {
  const features = Object.fromEntries(
    [...ROUND2_MOMENTUM_FEATURES, ...ROUND2_POSITION_FEATURES].map((featureName) => [
      featureName,
      fitCandidateOnInnerTrain(featureRows(rows, featureName)),
    ]),
  ) as Record<Round2FeatureName, CandidateFit>;

  return {
    features,
    familyFallback: {
      momentum: ROUND2_MOMENTUM_FEATURES.every((featureName) => features[featureName].fallback),
      position: ROUND2_POSITION_FEATURES.every((featureName) => features[featureName].fallback),
    },
  };
}

export function computeRound2FamilyComposite(row: Round2FeatureRow, fit: Round2FamilyFit): Round2FamilyComposite {
  const featureIncrement = (featureName: Round2FeatureName) => scoreIncrement(row.features[featureName], fit.features[featureName], 1);

  return {
    momentumComposite: fit.familyFallback.momentum ? 0 : mean(ROUND2_MOMENTUM_FEATURES.map(featureIncrement)),
    positionComposite: fit.familyFallback.position ? 0 : mean(ROUND2_POSITION_FEATURES.map(featureIncrement)),
    familyFallback: fit.familyFallback,
  };
}

export function round2CandidateScore(row: Round2FeatureRow, fit: Round2FamilyFit, coefficientPair: Round2CoefficientPair) {
  const composite = computeRound2FamilyComposite(row, fit);
  return row.baselineScore
    + coefficientPair.kMomentum * composite.momentumComposite
    + coefficientPair.kPosition * composite.positionComposite;
}

export function selectRound2Rows(
  rows: readonly Round2FeatureRow[],
  fit: Round2FamilyFit,
  coefficientPair: Round2CoefficientPair,
  scoreFloor = ROUND2_SCORE_FLOOR,
) {
  return rows.filter((row) => round2CandidateScore(row, fit, coefficientPair) >= scoreFloor);
}

export function gate2Round2CoefficientZero(rows: readonly Round2FeatureRow[]): Round2Gate2Result {
  const fit = fitRound2Families(rows);
  const selected = selectRound2Rows(rows, fit, { kMomentum: 0, kPosition: 0 }, ROUND2_SCORE_FLOOR);
  const baselineKeys = new Set(rows.map((row) => `${row.code}_${row.signalDate}`));
  const selectedKeys = new Set(selected.map((row) => `${row.code}_${row.signalDate}`));
  const selectedMatches = baselineKeys.size === selectedKeys.size && [...baselineKeys].every((key) => selectedKeys.has(key));
  const baselineMetrics = summarizeTradeRows(rows);
  const selectedMetrics = summarizeTradeRows(selected);

  return {
    passed: selectedMatches && metricsEqual(baselineMetrics, selectedMetrics),
    selectedMatches,
    baselineRowCount: rows.length,
    selectedRowCount: selected.length,
    baselineMetrics,
    selectedMetrics,
  };
}

export function evaluateRound2CoefficientPair(
  rows: readonly Round2FeatureRow[],
  coefficientPair: Round2CoefficientPair,
): Round2CoefficientEvaluation {
  assertPreOosRows(rows);
  const pooledBaselineRows: Round2FeatureRow[] = [];
  const pooledCandidateRows: Round2FeatureRow[] = [];

  const folds = PHASE10_OUTER_FOLDS.map((fold) => {
    const outerTrainRows = rows.filter((row) => row.signalDate <= fold.trainEnd);
    const split = splitOuterTrain(outerTrainRows);
    const innerTrain = split.innerTrain as unknown as readonly Round2FeatureRow[];
    const innerValidation = split.innerValidation as unknown as readonly Round2FeatureRow[];
    const fit = fitRound2Families(innerTrain);
    const candidateRows = candidateRowsForPair(innerValidation, fit, coefficientPair);
    pooledBaselineRows.push(...innerValidation);
    pooledCandidateRows.push(...candidateRows);

    const baselineMetrics = summarizeTradeRows(innerValidation);
    const candidateMetrics = summarizeTradeRows(candidateRows);
    return {
      foldName: fold.name,
      trainEnd: fold.trainEnd,
      innerTrainRows: innerTrain.length,
      innerValidationRows: innerValidation.length,
      fit,
      baselineMetrics,
      candidateMetrics,
      deltas: metricDeltas(baselineMetrics, candidateMetrics),
    };
  });

  const pooledBaselineMetrics = summarizeTradeRows(pooledBaselineRows);
  const pooledCandidateMetrics = summarizeTradeRows(pooledCandidateRows);
  const pooledDeltas = metricDeltas(pooledBaselineMetrics, pooledCandidateMetrics);
  const foldDeltas = folds.map((fold) => fold.deltas);
  const andConditions = conditionList(foldDeltas, pooledDeltas, pooledBaselineMetrics, pooledCandidateMetrics);

  return {
    coefficientPair,
    folds,
    pooledBaselineMetrics,
    pooledCandidateMetrics,
    pooledDeltas,
    andConditions,
    passed: passesRound1Gate(foldDeltas, pooledDeltas, pooledBaselineMetrics, pooledCandidateMetrics),
  };
}

export function searchRound2CoefficientPairs(rows: readonly Round2FeatureRow[]): Round2SearchResult {
  const pairs = buildRound2CoefficientPairs();
  const evaluations = pairs.map((pair) => evaluateRound2CoefficientPair(rows, pair));
  const sortedDiagnostics = [...evaluations].sort(compareBySelectionPriority);
  const passing = evaluations.filter((evaluation) => evaluation.passed).sort(compareBySelectionPriority);
  const noChangeReference = evaluations.find((evaluation) => (
    evaluation.coefficientPair.kMomentum === 0 && evaluation.coefficientPair.kPosition === 0
  ));
  if (!noChangeReference) throw new Error("Round2 coefficient grid must include the (0, 0) no-change reference");

  return {
    coefficientPairCount: pairs.length,
    evaluatedPairCount: evaluations.length,
    passingPairCount: passing.length,
    passingEvaluations: passing,
    noChangeReference,
    selected: passing[0] ?? null,
    diagnosticsBest: sortedDiagnostics[0],
    coefficientSearchExecuted: true,
  };
}