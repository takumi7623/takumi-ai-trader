import type { AiScoreWeights } from "../types";
import type { AiScoreBacktestResult } from "./types";
import {
  applyAiScoreWeightProfile,
  deriveAiScoreWeightProfileFromBacktest,
  deriveMarketRegimeWeightStoresFromBacktest,
  loadAiScoreWeightStore,
  saveAiScoreWeightStore,
} from "./weightProfile";

export type AiScoreBacktestOptimizationResult = {
  changed: boolean;
  notes: string[];
  profile: ReturnType<typeof deriveAiScoreWeightProfileFromBacktest>;
  store: ReturnType<typeof deriveMarketRegimeWeightStoresFromBacktest>;
  weights: AiScoreWeights;
};

export function optimizeAiScoreWeightsFromBacktest(
  result: AiScoreBacktestResult,
  currentWeights: AiScoreWeights,
) : AiScoreBacktestOptimizationResult {
  const currentStore = loadAiScoreWeightStore();
  const currentProfile = currentStore.defaultProfile;
  const profile = deriveAiScoreWeightProfileFromBacktest(result, currentProfile);
  const store = deriveMarketRegimeWeightStoresFromBacktest(result, currentStore);
  const weights = applyAiScoreWeightProfile(currentWeights, profile);
  const changed = JSON.stringify(weights) !== JSON.stringify(currentWeights)
    || JSON.stringify(profile) !== JSON.stringify(currentProfile)
    || JSON.stringify(store) !== JSON.stringify(currentStore);

  return {
    changed,
    notes: [
      `AI score weights optimized from backtest: winRate=${result.totals.winRate.toFixed(2)}%`,
      `profitFactor=${result.totals.profitFactor.toFixed(2)}`,
      `maxDrawdown=${result.totals.maxDrawdown.toFixed(2)}%`,
      `updated regime-aware store written to weights.json after save`,
    ],
    profile,
    store,
    weights,
  };
}

export async function saveAiScoreWeightsFromBacktest(
  result: AiScoreBacktestResult,
  currentWeights: AiScoreWeights,
  filePath?: string,
) {
  const optimized = optimizeAiScoreWeightsFromBacktest(result, currentWeights);
  saveAiScoreWeightStore(optimized.store, filePath);
  return optimized;
}
