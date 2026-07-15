import type { AiScoreWeights } from "../types";
import type { AiScoreBacktestResult } from "./types";
import {
  applyAiScoreWeightProfile,
  deriveAiScoreWeightProfileFromBacktest,
  loadAiScoreWeightProfile,
  saveAiScoreWeightProfile,
} from "./weightProfile";

export type AiScoreBacktestOptimizationResult = {
  changed: boolean;
  notes: string[];
  profile: ReturnType<typeof deriveAiScoreWeightProfileFromBacktest>;
  weights: AiScoreWeights;
};

export function optimizeAiScoreWeightsFromBacktest(
  result: AiScoreBacktestResult,
  currentWeights: AiScoreWeights,
) : AiScoreBacktestOptimizationResult {
  const currentProfile = loadAiScoreWeightProfile();
  const profile = deriveAiScoreWeightProfileFromBacktest(result, currentProfile);
  const weights = applyAiScoreWeightProfile(currentWeights, profile);
  const changed = JSON.stringify(weights) !== JSON.stringify(currentWeights) || JSON.stringify(profile) !== JSON.stringify(currentProfile);

  return {
    changed,
    notes: [
      `AI score weights optimized from backtest: winRate=${result.totals.winRate.toFixed(2)}%`,
      `profitFactor=${result.totals.profitFactor.toFixed(2)}`,
      `maxDrawdown=${result.totals.maxDrawdown.toFixed(2)}%`,
      `updated profile written to weights.json after save`,
    ],
    profile,
    weights,
  };
}

export async function saveAiScoreWeightsFromBacktest(
  result: AiScoreBacktestResult,
  currentWeights: AiScoreWeights,
  filePath?: string,
) {
  const optimized = optimizeAiScoreWeightsFromBacktest(result, currentWeights);
  saveAiScoreWeightProfile(optimized.profile, filePath);
  return optimized;
}
