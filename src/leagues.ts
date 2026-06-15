export const ALL_LEAGUES = [
  'EPL',
  'La Liga',
  'Bundesliga',
  'Serie A',
  'Ligue 1',
  'Champions League',
  'Europa League',
  'DFB-Pokal',
  'Eredivisie',
  'Liga Portugal',
  'MLS',
  'Süper Lig',
  'J League',
  'K League 1',
  'FIFA World Cup',
  'Copa Libertadores',
  'Copa Sudamericana',
] as const;

export type League = typeof ALL_LEAGUES[number];

// Leagues with full xG history on Understat (used for model quality)
export const XG_LEAGUES = new Set(['EPL', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1']);
