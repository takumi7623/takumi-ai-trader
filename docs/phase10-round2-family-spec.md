# Phase10 Round2 Candidate Spec: Family 2-Score Model

## Status

- Document status: draft specification only
- Implementation status: not implemented
- Adoption status: not formally adopted
- Final OOS status: sealed, unused
- Based on commit: `fc3d440` Phase10-3 gates

This document defines the Round2 design candidate only. It must not be treated as an approval to change `ScoreCalculator`, Baseline logic, inventory, writer, or Final OOS evaluation.

## Naming Separation

The committed Phase10-3 gate names are reserved for implementation-level safety checks:

- Gate0: replay environment hash recording
- Gate1: Baseline replay ledger identity check
- Gate2: coefficient=0 selected set and metrics identity check
- Gate3: coefficient-driven metrics delta connection check

Round2-specific operating constraints use a separate numbering system and must not reuse Gate0-Gate3 names.

## Round2 Operating Rules

- R1: coefficient and structure selection uses Inner Train and Inner Validation only.
- R2: Outer Test is not used for coefficient selection or pass/fail tuning; it may be used only after the Round2 spec is frozen for confirmation.
- R3: Final OOS is not read, summarized, optimized against, or reported until explicit approval for a one-time final evaluation.

If any of R1-R3 is violated, Round2 results are invalid and must not be used for adoption decisions.

## Round2 Model Choice

Use proposal D: family-level 2-score model.

The Round1 PASS candidates are grouped into two pre-fixed families:

### Momentum Family

- `normalizedMacdHistogram`
- `sma5Slope`
- `midTrendReturn`

### Position Family

- `relativeLow52Distance`
- `bollingerPricePosition`

`relativeSma200Distance` is excluded from Round2 because Round1 failed due to Inner Train `IQR=0` fallback.

## Score Formula

For each row, compute two family composites from train-fitted normalized feature values:

```text
momentumComposite = mean(z(normalizedMacdHistogram), z(sma5Slope), z(midTrendReturn))
positionComposite = mean(z(relativeLow52Distance), z(bollingerPricePosition))

candidateScore = baselineScore
  + kMomentum * momentumComposite
  + kPosition * positionComposite
```

Selection rule:

```text
candidateSelected = baseline BUY row && candidateScore >= 70
```

This remains a Baseline BUY filtering sandbox. It can remove existing Baseline BUY rows but does not create new BUY rows from non-BUY candidates.

## Fitting Rules

For each outer fold:

1. Build the outer train rows using only `signalDate <= fold.trainEnd`.
2. Split outer train into Inner Train and Inner Validation using the existing Phase10 split logic.
3. Fit each feature's median, IQR, and direction on Inner Train only.
4. Convert feature values to signed robust z-scores:

```text
z(feature) = direction * (featureValue - median) / IQR
```

5. If a feature has fallback=true or non-finite z-score, its family contribution is `0` for that row.
6. If every feature in a family falls back, that family composite is `0` and must be reported as family fallback.

No statistic may be fitted using Inner Validation, Outer Test, or Final OOS.

## Coefficient Search

Use a low-degree 2D coefficient grid:

```text
kMomentum in [-4, -2, -1, -0.5, 0, 0.5, 1, 2, 4]
kPosition in [-4, -2, -1, -0.5, 0, 0.5, 1, 2, 4]
```

The grid is pre-fixed before execution:

- `kMomentum` lower bound: `-4`
- `kMomentum` upper bound: `4`
- `kMomentum` step policy: fixed discrete grid, not a uniform linear step. The tested values are exactly `[-4, -2, -1, -0.5, 0, 0.5, 1, 2, 4]`; no intermediate values may be added after seeing results.
- `kPosition` lower bound: `-4`
- `kPosition` upper bound: `4`
- `kPosition` step policy: fixed discrete grid, not a uniform linear step. The tested values are exactly `[-4, -2, -1, -0.5, 0, 0.5, 1, 2, 4]`; no intermediate values may be added after seeing results.
- Total coefficient combinations: `9 * 9 = 81`.

The coefficient pair `(0, 0)` must be included as the no-change reference.

## Selection Priority

Round2 coefficient adoption is a two-stage decision:

1. Hard pass/fail filter: apply the Round2 AND9 criteria exactly as defined below.
2. Ranking among passing coefficient pairs: use the fixed priority order below.

Ranking priority among passing pairs:

1. Higher pooled delta EV
2. Higher pooled delta PF
3. Lower pooled delta MaxDD
4. Higher pooled delta WinRate
5. TradeCount preservation: prefer pooled TradeCount ratio closest to `1.0`, while still inside the 80%-120% hard gate
6. Smaller absolute coefficient norm: `abs(kMomentum) + abs(kPosition)`
7. Prefer `(0, 0)` if still tied
8. Stable lexical order by `(kMomentum, kPosition)` if still tied

This priority order is aligned with Round1 AND9: EV and PF are the primary improvement requirements, MaxDD and WinRate are safety constraints, and TradeCount is a hard preservation band plus a later tie-breaker.

If no coefficient pair passes AND9, Round2 fails and no best-passing pair is selected. A best-observed diagnostic pair may be reported separately, but it must be labeled `diagnostic-only` and must not be treated as selected.

## Inner Validation Fold Aggregation

Use the same aggregation style as Round1:

- Pooled Inner Validation metrics are computed by concatenating the Inner Validation rows from WF1, WF2, and WF3 outer-train splits.
- Fold deltas are computed separately for WF1, WF2, and WF3 Inner Validation slices.
- AND9 uses both pooled metrics and fold-level requirements.
- The selection rank uses pooled deltas first, then fold-level requirements through the hard AND9 filter.

Do not use average fold metrics as the primary selection objective. Do not use worst-fold-only ranking as the primary selection objective. Worst-fold behavior is controlled through the AND9 requirements, especially EV/PF improvement count and no worse MaxDD.

The coefficient search must not inspect Outer Test or Final OOS.

## Search Freeze Rule

After Round2 coefficient search starts, the following items are frozen and must not be changed based on observed results:

1. `kMomentum` range and tested grid values
2. `kPosition` range and tested grid values
3. total coefficient combination set
4. family membership
5. normalization and fallback rules
6. selection priority order
7. Inner Validation fold aggregation method
8. AND9 pass criteria

Any later change to these items requires a new pre-declared Round2 specification version before rerunning the search. Results from the old specification must not be reused as if they came from the new one.

## Required Pre-Search Gates

Before any Round2 coefficient search:

1. Phase10-3 Gate0 must pass.
2. Phase10-3 Gate1 must pass.
3. Phase10-3 Gate2 must pass for the Round2 input rows.
4. If any of the above fail, Round2 coefficient search must not run.

## Round2 Pass Criteria

Use the same AND9 criteria used for Round1 reporting, evaluated on pooled Inner Validation and fold deltas:

1. pooled delta EV > 0
2. pooled delta PF > 0
3. pooled delta MaxDD <= 0
4. pooled delta WinRate >= 0
5. pooled TradeCount ratio is between 80% and 120% of Baseline
6. Baseline and Candidate both have TradeCount > 0
7. delta EV improves in at least 2 folds
8. delta PF improves in at least 2 folds
9. no fold has worse MaxDD

All criteria must pass. Passing Round2 means only that the candidate family spec may proceed to a frozen confirmation step; it is not formal adoption.

## Reporting Requirements

Round2 output must report:

- Gate0-Gate2 status before coefficient search
- selected `(kMomentum, kPosition)`
- family fallback status for each fold
- Baseline and Candidate absolute TradeCount
- delta TradeCount as count and percent
- pooled delta EV, PF, MaxDD, WinRate, TradeCount, and misclassification
- fold-level delta EV, PF, MaxDD, TradeCount, and pass/fail components
- confirmation that Outer Test and Final OOS were not used for coefficient selection

## Explicit Non-Goals

- Do not modify `lib/ai/scoreCalculator.ts`.
- Do not modify Baseline generation logic.
- Do not modify Phase9 inventory or writer outputs.
- Do not run the Phase9 writer.
- Do not use Outer Test for coefficient selection.
- Do not use Final OOS.
- Do not treat Round2 coefficients as officially adopted without a later freeze and approval step.
