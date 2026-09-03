import { createHash } from "node:crypto";

export const PHASE10_DATES = {
  preOosMaxSignalDate: "2026-05-29",
  finalOosStart: "2026-06-01",
  finalOosEnd: "2026-08-07",
} as const;

export const ROUND1_CANDIDATES = [
  "normalizedMacdHistogram",
  "relativeLow52Distance",
  "bollingerPricePosition",
  "relativeSma200Distance",
  "sma5Slope",
  "midTrendReturn",
] as const;

export const COEFFICIENT_OPTIONS = [-4, -2, -1, -0.5, 0, 0.5, 1, 2, 4] as const;

export type Round1CandidateName = typeof ROUND1_CANDIDATES[number];
export type Coefficient = typeof COEFFICIENT_OPTIONS[number];

export type Phase10Row = Readonly<{
  code: string;
  signalDate: string;
  return10d: number;
  featureValue: number;
}>;

export type Phase10ScoredRow = Phase10Row & Readonly<{
  baselineScore: number;
}>;

export type CandidateFit = Readonly<{
  median: number;
  iqr: number;
  direction: -1 | 1;
  fallback: boolean;
}>;

export type FrozenCandidateSpec = Readonly<{
  schemaVersion: 1;
  status: "frozen-for-final-oos";
  candidateNames: readonly Round1CandidateName[];
  coefficient: Coefficient;
  fit: CandidateFit;
  incrementClamp: Readonly<{ min: -4; max: 4 }>;
  applicationPoint: "after-calibrated-final-score";
  preOosMaxSignalDate: typeof PHASE10_DATES.preOosMaxSignalDate;
  finalOosStart: typeof PHASE10_DATES.finalOosStart;
  finalOosEnd: typeof PHASE10_DATES.finalOosEnd;
  finalOosUsedForSelection: false;
  baselineSha256: string;
}>;

export type NestedSplit = Readonly<{
  innerTrain: readonly Phase10Row[];
  innerValidation: readonly Phase10Row[];
}>;

export type TradeMetrics = Readonly<{
  tradeCount: number;
  winRate: number;
  ev: number;
  pf: number;
  maxDD: number;
  misclassificationRate: number;
}>;

export type MetricDeltas = Readonly<{
  tradeCount: number;
  tradeCountRatio: number;
  winRate: number;
  ev: number;
  pf: number;
  maxDD: number;
  misclassificationRate: number;
}>;

export type Round1FoldResult = Readonly<{
  foldName: string;
  trainEnd: string;
  innerTrainRows: number;
  innerValidationRows: number;
  coefficient: Coefficient;
  fit: CandidateFit;
  baselineMetrics: TradeMetrics;
  candidateMetrics: TradeMetrics;
  deltas: MetricDeltas;
  passed: boolean;
}>;

export type Round1CandidateResult = Readonly<{
  candidateName: Round1CandidateName;
  selectedCoefficient: Coefficient;
  folds: readonly Round1FoldResult[];
  pooledBaselineMetrics: TradeMetrics;
  pooledCandidateMetrics: TradeMetrics;
  pooledDeltas: MetricDeltas;
  round1Passed: boolean;
}>;

export const PHASE10_OUTER_FOLDS = [
  { name: "WF1", trainEnd: "2026-01-07" },
  { name: "WF2", trainEnd: "2026-02-25" },
  { name: "WF3", trainEnd: "2026-04-10" },
] as const;

function sortedRows(rows: readonly Phase10Row[]) {
  return [...rows].sort((left, right) => left.signalDate.localeCompare(right.signalDate) || left.code.localeCompare(right.code));
}

function percentile(values: readonly number[], ratio: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mean(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function sampleVariance(values: readonly number[], average: number) {
  if (values.length < 2) return Number.NaN;
  return values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1);
}

function cohensD(winners: readonly number[], losers: readonly number[]) {
  if (winners.length < 2 || losers.length < 2) return Number.NaN;
  const winnerMean = mean(winners);
  const loserMean = mean(losers);
  const pooledVariance = (
    (winners.length - 1) * sampleVariance(winners, winnerMean)
    + (losers.length - 1) * sampleVariance(losers, loserMean)
  ) / (winners.length + losers.length - 2);
  return pooledVariance > 0 ? (winnerMean - loserMean) / Math.sqrt(pooledVariance) : Number.NaN;
}

export function isPreOosDate(signalDate: string) {
  return signalDate <= PHASE10_DATES.preOosMaxSignalDate;
}

export function isFinalOosDate(signalDate: string) {
  return signalDate >= PHASE10_DATES.finalOosStart && signalDate <= PHASE10_DATES.finalOosEnd;
}

export function assertPreOosRows(rows: readonly Phase10Row[]) {
  if (rows.some((row) => !isPreOosDate(row.signalDate))) {
    throw new Error("Phase 10 selection and freeze inputs must exclude Final OOS rows");
  }
}

export function assertFinalOosRows(rows: readonly Phase10Row[]) {
  if (rows.some((row) => !isFinalOosDate(row.signalDate))) {
    throw new Error("Final OOS evaluator accepts only the fixed Final OOS date range");
  }
}

export function splitOuterTrain(rows: readonly Phase10Row[]): NestedSplit {
  assertPreOosRows(rows);
  const sorted = sortedRows(rows);
  const splitIndex = Math.floor(sorted.length * 0.8);
  return {
    innerTrain: sorted.slice(0, splitIndex),
    innerValidation: sorted.slice(splitIndex),
  };
}

export function fitCandidateOnInnerTrain(rows: readonly Phase10Row[]): CandidateFit {
  assertPreOosRows(rows);
  const values = rows.map((row) => row.featureValue).filter(Number.isFinite);
  const winners = rows.filter((row) => row.return10d > 0).map((row) => row.featureValue).filter(Number.isFinite);
  const losers = rows.filter((row) => row.return10d <= 0).map((row) => row.featureValue).filter(Number.isFinite);
  if (values.length < 2) return { median: 0, iqr: 0, direction: 1, fallback: true };

  const median = percentile(values, 0.5);
  const iqr = percentile(values, 0.75) - percentile(values, 0.25);
  const effect = cohensD(winners, losers);
  if (!Number.isFinite(iqr) || iqr === 0 || !Number.isFinite(effect) || effect === 0) {
    return { median, iqr, direction: 1, fallback: true };
  }
  return { median, iqr, direction: effect > 0 ? 1 : -1, fallback: false };
}

export function scoreIncrement(featureValue: number, fit: CandidateFit, coefficient: Coefficient) {
  if (fit.fallback || !Number.isFinite(featureValue)) return 0;
  const raw = coefficient * fit.direction * ((featureValue - fit.median) / fit.iqr);
  return Math.max(-4, Math.min(4, raw));
}

export function selectCoefficientOnInnerValidation(
  fit: CandidateFit,
  validationRows: readonly Phase10Row[],
  evaluate: (rows: readonly Phase10Row[], coefficient: Coefficient, fit: CandidateFit) => number,
) {
  assertPreOosRows(validationRows);
  if (fit.fallback || validationRows.length === 0) return 0 as Coefficient;
  return [...COEFFICIENT_OPTIONS].sort((left, right) => {
    const scoreDifference = evaluate(validationRows, right, fit) - evaluate(validationRows, left, fit);
    if (scoreDifference !== 0) return scoreDifference;
    if (Math.abs(left) !== Math.abs(right)) return Math.abs(left) - Math.abs(right);
    return left - right;
  })[0];
}

export function selectRoundCandidates(
  results: readonly Readonly<{ candidateName: Round1CandidateName; passed: boolean }>[],
) {
  return results.filter((result) => result.passed).map((result) => result.candidateName);
}

export function summarizeTradeRows(rows: readonly Phase10Row[]): TradeMetrics {
  const returns = rows.map((row) => row.return10d).filter(Number.isFinite);
  if (returns.length === 0) {
    return { tradeCount: 0, winRate: 0, ev: 0, pf: 0, maxDD: 0, misclassificationRate: 0 };
  }

  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0).map((value) => Math.abs(value));
  const grossProfit = sum(wins);
  const grossLoss = sum(losses);

  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const row of sortedRows(rows)) {
    equity *= 1 + (row.return10d / 100);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
  }

  return {
    tradeCount: returns.length,
    winRate: wins.length / returns.length,
    ev: sum(returns) / returns.length,
    pf: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    maxDD,
    misclassificationRate: 1 - (wins.length / returns.length),
  };
}

export function metricDeltas(baseline: TradeMetrics, candidate: TradeMetrics): MetricDeltas {
  return {
    tradeCount: candidate.tradeCount - baseline.tradeCount,
    tradeCountRatio: baseline.tradeCount > 0 ? candidate.tradeCount / baseline.tradeCount : 0,
    winRate: candidate.winRate - baseline.winRate,
    ev: candidate.ev - baseline.ev,
    pf: candidate.pf - baseline.pf,
    maxDD: candidate.maxDD - baseline.maxDD,
    misclassificationRate: candidate.misclassificationRate - baseline.misclassificationRate,
  };
}

export function evaluateScoreIncrementOnly(rows: readonly Phase10Row[]): TradeMetrics {
  assertPreOosRows(rows);
  return summarizeTradeRows(rows);
}

export function selectRowsByCandidateScore(
  rows: readonly Phase10ScoredRow[],
  fit: CandidateFit,
  coefficient: Coefficient,
  scoreFloor = 70,
) {
  assertPreOosRows(rows);
  return rows.filter((row) => {
    const candidateScore = row.baselineScore + scoreIncrement(row.featureValue, fit, coefficient);
    return candidateScore >= scoreFloor;
  });
}

export function evaluateCandidateScoreFilter(
  rows: readonly Phase10ScoredRow[],
  fit: CandidateFit,
  coefficient: Coefficient,
  scoreFloor = 70,
): TradeMetrics {
  return summarizeTradeRows(selectRowsByCandidateScore(rows, fit, coefficient, scoreFloor));
}

export function passesRound1Gate(foldDeltas: readonly MetricDeltas[], pooledDeltas: MetricDeltas, pooledBaseline: TradeMetrics, pooledCandidate: TradeMetrics) {
  const epsilon = 1e-10;
  const evImprovedFolds = foldDeltas.filter((delta) => delta.ev > epsilon).length;
  const pfImprovedFolds = foldDeltas.filter((delta) => delta.pf > epsilon).length;
  const noFoldMaxDdWorse = foldDeltas.every((delta) => delta.maxDD <= epsilon);

  return pooledDeltas.ev > epsilon
    && pooledDeltas.pf > epsilon
    && pooledDeltas.maxDD <= epsilon
    && pooledDeltas.winRate >= -epsilon
    && pooledDeltas.tradeCountRatio >= 0.8 - epsilon
    && pooledDeltas.tradeCountRatio <= 1.2 + epsilon
    && pooledCandidate.tradeCount > 0
    && pooledBaseline.tradeCount > 0
    && evImprovedFolds >= 2
    && pfImprovedFolds >= 2
    && noFoldMaxDdWorse;
}

export function evaluateRound1Candidate(
  candidateName: Round1CandidateName,
  rows: readonly Phase10Row[],
): Round1CandidateResult {
  assertPreOosRows(rows);
  const folds = PHASE10_OUTER_FOLDS.map((fold) => {
    const outerTrainRows = rows.filter((row) => row.signalDate <= fold.trainEnd);
    const split = splitOuterTrain(outerTrainRows);
    const fit = fitCandidateOnInnerTrain(split.innerTrain);
    const coefficient = selectCoefficientOnInnerValidation(
      fit,
      split.innerValidation,
      (validationRows) => evaluateScoreIncrementOnly(validationRows).ev,
    );
    const baselineMetrics = summarizeTradeRows(split.innerValidation);
    const candidateMetrics = evaluateScoreIncrementOnly(split.innerValidation);
    const deltas = metricDeltas(baselineMetrics, candidateMetrics);

    return {
      foldName: fold.name,
      trainEnd: fold.trainEnd,
      innerTrainRows: split.innerTrain.length,
      innerValidationRows: split.innerValidation.length,
      coefficient,
      fit,
      baselineMetrics,
      candidateMetrics,
      deltas,
      passed: passesRound1Gate([deltas], deltas, baselineMetrics, candidateMetrics),
    };
  });

  const innerValidationRows = PHASE10_OUTER_FOLDS.flatMap((fold) => {
    const outerTrainRows = rows.filter((row) => row.signalDate <= fold.trainEnd);
    return splitOuterTrain(outerTrainRows).innerValidation;
  });
  const pooledBaselineMetrics = summarizeTradeRows(innerValidationRows);
  const pooledCandidateMetrics = evaluateScoreIncrementOnly(innerValidationRows);
  const pooledDeltas = metricDeltas(pooledBaselineMetrics, pooledCandidateMetrics);
  const foldDeltas = folds.map((fold) => fold.deltas);

  return {
    candidateName,
    selectedCoefficient: folds[folds.length - 1]?.coefficient ?? 0,
    folds,
    pooledBaselineMetrics,
    pooledCandidateMetrics,
    pooledDeltas,
    round1Passed: passesRound1Gate(foldDeltas, pooledDeltas, pooledBaselineMetrics, pooledCandidateMetrics),
  };
}

export function evaluateRound1ScoredCandidate(
  candidateName: Round1CandidateName,
  rows: readonly Phase10ScoredRow[],
  scoreFloor = 70,
): Round1CandidateResult {
  assertPreOosRows(rows);
  const folds = PHASE10_OUTER_FOLDS.map((fold) => {
    const outerTrainRows = rows.filter((row) => row.signalDate <= fold.trainEnd);
    const split = splitOuterTrain(outerTrainRows);
    const innerValidation = split.innerValidation as readonly Phase10ScoredRow[];
    const fit = fitCandidateOnInnerTrain(split.innerTrain);
    const coefficient = selectCoefficientOnInnerValidation(
      fit,
      innerValidation,
      (validationRows, option, candidateFit) => evaluateCandidateScoreFilter(
        validationRows as readonly Phase10ScoredRow[],
        candidateFit,
        option,
        scoreFloor,
      ).ev,
    );
    const baselineMetrics = summarizeTradeRows(innerValidation);
    const candidateMetrics = evaluateCandidateScoreFilter(innerValidation, fit, coefficient, scoreFloor);
    const deltas = metricDeltas(baselineMetrics, candidateMetrics);

    return {
      foldName: fold.name,
      trainEnd: fold.trainEnd,
      innerTrainRows: split.innerTrain.length,
      innerValidationRows: split.innerValidation.length,
      coefficient,
      fit,
      baselineMetrics,
      candidateMetrics,
      deltas,
      passed: passesRound1Gate([deltas], deltas, baselineMetrics, candidateMetrics),
    };
  });

  const innerValidationRows = PHASE10_OUTER_FOLDS.flatMap((fold) => {
    const outerTrainRows = rows.filter((row) => row.signalDate <= fold.trainEnd);
    return splitOuterTrain(outerTrainRows).innerValidation;
  }) as unknown as readonly Phase10ScoredRow[];
  const latestFit = folds[folds.length - 1]?.fit ?? fitCandidateOnInnerTrain(rows);
  const selectedCoefficient = folds[folds.length - 1]?.coefficient ?? 0;
  const pooledBaselineMetrics = summarizeTradeRows(innerValidationRows);
  const pooledCandidateMetrics = evaluateCandidateScoreFilter(innerValidationRows, latestFit, selectedCoefficient, scoreFloor);
  const pooledDeltas = metricDeltas(pooledBaselineMetrics, pooledCandidateMetrics);
  const foldDeltas = folds.map((fold) => fold.deltas);

  return {
    candidateName,
    selectedCoefficient,
    folds,
    pooledBaselineMetrics,
    pooledCandidateMetrics,
    pooledDeltas,
    round1Passed: passesRound1Gate(foldDeltas, pooledDeltas, pooledBaselineMetrics, pooledCandidateMetrics),
  };
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function freezeFinalCandidateSpec(
  rows: readonly Phase10Row[],
  candidateNames: readonly Round1CandidateName[],
  coefficient: Coefficient,
  baselineSha256: string,
): Readonly<FrozenCandidateSpec> {
  assertPreOosRows(rows);
  const fit = fitCandidateOnInnerTrain(rows);
  return deepFreeze({
    schemaVersion: 1,
    status: "frozen-for-final-oos",
    candidateNames: [...candidateNames],
    coefficient,
    fit,
    incrementClamp: { min: -4, max: 4 },
    applicationPoint: "after-calibrated-final-score",
    preOosMaxSignalDate: PHASE10_DATES.preOosMaxSignalDate,
    finalOosStart: PHASE10_DATES.finalOosStart,
    finalOosEnd: PHASE10_DATES.finalOosEnd,
    finalOosUsedForSelection: false,
    baselineSha256,
  });
}

export function evaluateFrozenSpecOnFinalOos(
  spec: Readonly<FrozenCandidateSpec>,
  finalOosRows: readonly Phase10Row[],
  applyIncrement: (row: Phase10Row, increment: number) => number,
) {
  if (spec.status !== "frozen-for-final-oos" || spec.finalOosUsedForSelection !== false) {
    throw new Error("Final OOS evaluation requires a frozen candidate specification");
  }
  assertFinalOosRows(finalOosRows);
  const specHashBefore = sha256(spec);
  const values = finalOosRows.map((row) => applyIncrement(row, scoreIncrement(row.featureValue, spec.fit, spec.coefficient)));
  if (sha256(spec) !== specHashBefore) throw new Error("Frozen candidate specification changed during Final OOS evaluation");
  return { frozenSpecSha256: specHashBefore, values };
}