/**
 * Per-sport model specifications. Feature keys reference the JSON keys written
 * by the Phase 2 feature builders into prediction_features (featureVersion v1).
 *
 * Rugby is intentionally absent — it is skipped (insufficient data); rugby
 * matches return a null prediction with flag "insufficient_data".
 */

export type ModelKind = 'dixon_coles' | 'logistic';

export interface ModelSpec {
  sport: 'football' | 'tennis' | 'nba' | 'nfl' | 'mlb';
  kind: ModelKind;
  trainer: string;          // python script under prediction/python
  artifact: string;         // filename under prediction/models
  target?: string;          // binary target key (logistic)
  features?: string[];      // predictor keys (logistic)
  marginTarget?: string;    // optional regression target (expected margin/run line)
  // For single-class datasets (tennis: A is always the winner), maps each
  // feature to how it mirrors under an A<->B swap: "negate" or a counterpart key.
  symmetrize?: Record<string, string>;
}

export const MODEL_SPECS: Record<string, ModelSpec> = {
  football: {
    sport: 'football',
    kind: 'dixon_coles',
    trainer: 'train_dixon_coles.py',
    artifact: 'football_dixon_coles.joblib',
    // Dixon-Coles fits to actual_home_goals/actual_away_goals (carried in features).
  },

  tennis: {
    sport: 'tennis',
    kind: 'logistic',
    trainer: 'train_logistic.py',
    artifact: 'tennis_logistic.joblib',
    target: 'target_a_wins',
    // ELO diff + rank diff + surface H2H + fatigue (per spec). Directional diffs
    // are negated under A<->B mirroring; surface_h2h_matches is symmetric.
    features: ['elo_diff', 'rank_diff', 'surface_h2h_win_diff', 'surface_h2h_matches', 'fatigue_diff'],
    symmetrize: {
      elo_diff: 'negate',
      rank_diff: 'negate',
      surface_h2h_win_diff: 'negate',
      fatigue_diff: 'negate',
      // surface_h2h_matches: symmetric → unchanged (omitted = identity)
    },
  },

  nba: {
    sport: 'nba',
    kind: 'logistic',
    trainer: 'train_logistic.py',
    artifact: 'nba_logistic.joblib',
    target: 'target_home_win',
    // net rating diff + rest diff + back-to-back flags + home advantage.
    features: ['net_rating_diff', 'home_rest_days', 'away_rest_days', 'home_back_to_back', 'away_back_to_back', 'home_court'],
    marginTarget: 'point_margin', // computed at export time from goals; see train.ts
  },

  nfl: {
    sport: 'nfl',
    kind: 'logistic',
    trainer: 'train_logistic.py',
    artifact: 'nfl_logistic.joblib',
    target: 'target_home_win',
    // MAX 5 features (285-row sample): EPA diff + rest + bye + QB present + home advantage.
    features: ['epa_diff', 'home_rest_days', 'home_bye_week', 'home_qb_present', 'home_field'],
  },

  mlb: {
    sport: 'mlb',
    kind: 'logistic',
    trainer: 'train_logistic.py',
    artifact: 'mlb_logistic.joblib',
    target: 'target_home_win',
    // starting pitcher ERA diff + run form diff + ballpark factor + home advantage.
    features: ['sp_era_diff', 'run_form_diff', 'ballpark_run_factor', 'home_field'],
    marginTarget: 'run_line', // computed at export time
  },
};
