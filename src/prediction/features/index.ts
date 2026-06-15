import { computeFootballFeatures } from './football.js';
import { computeTennisFeatures } from './tennis.js';
import { computeBasketballFeatures } from './basketball.js';
import { computeNflFeatures } from './nfl.js';
import { computeBaseballFeatures } from './baseball.js';
import { computeRugbyFeatures } from './rugby.js';

export const FEATURE_BUILDERS: Record<string, () => Promise<void>> = {
  football: () => computeFootballFeatures(),
  tennis: () => computeTennisFeatures(),
  nba: () => computeBasketballFeatures(),
  nfl: () => computeNflFeatures(),
  mlb: () => computeBaseballFeatures(),
  rugby: () => computeRugbyFeatures(),
};

export {
  computeFootballFeatures, computeTennisFeatures, computeBasketballFeatures,
  computeNflFeatures, computeBaseballFeatures, computeRugbyFeatures,
};
