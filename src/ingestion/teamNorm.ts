// Canonical team name normalization.
// All match records and odds snapshots should store the canonical form.
// Apply at both ingestion points (oddsApi, espnScores, openfootball) and at rating lookup.

const OVERRIDES: Record<string, string> = {
  // EPL
  'AFC Bournemouth': 'Bournemouth',
  'Brighton & Hove Albion FC': 'Brighton and Hove Albion',
  'Brighton & Hove Albion': 'Brighton and Hove Albion',
  'Nottingham Forest FC': 'Nottingham Forest',
  'Wolverhampton Wanderers FC': 'Wolverhampton Wanderers',
  'Manchester City FC': 'Manchester City',
  'Manchester United FC': 'Manchester United',
  'Tottenham Hotspur FC': 'Tottenham Hotspur',
  'Newcastle United FC': 'Newcastle United',
  'West Ham United FC': 'West Ham United',
  'Leicester City FC': 'Leicester City',
  'Ipswich Town FC': 'Ipswich Town',
  'Southampton FC': 'Southampton',
  'Luton Town FC': 'Luton Town',
  // La Liga
  'FC Barcelona': 'Barcelona',
  'Real Madrid CF': 'Real Madrid',
  'Villarreal CF': 'Villarreal',
  'Cádiz CF': 'Cadiz',
  'Real Valladolid CF': 'Real Valladolid',
  'Celta de Vigo': 'Celta Vigo',
  'CA Osasuna': 'Osasuna',
  'Atlético Madrid': 'Atletico Madrid',
  'Athletic Bilbao': 'Athletic Club',
  'Alavés': 'Alaves',
  'Deportivo Alavés': 'Alaves',
  'CD Alavés': 'Alaves',
  'UD Las Palmas': 'Las Palmas',
  'CD Leganés': 'Leganes',
  'Leganés': 'Leganes',
  'Girona FC': 'Girona',
  'Rayo Vallecano de Madrid': 'Rayo Vallecano',
  'Real Betis Balompié': 'Real Betis',
  'Sevilla FC': 'Sevilla',
  'Real Sociedad de Fútbol': 'Real Sociedad',
  'Valencia CF': 'Valencia',
  'UD Almería': 'Almeria',
  'Mallorca': 'Mallorca',
  'RCD Mallorca': 'Mallorca',
  'Getafe CF': 'Getafe',
  'RCD Espanyol': 'Espanyol',
  'Valladolid': 'Real Valladolid',
  // Bundesliga
  'FC Bayern München': 'Bayern Munich',
  'FC Bayern Munich': 'Bayern Munich',
  'Bayern München': 'Bayern Munich',
  'Borussia Dortmund': 'Borussia Dortmund',
  'Bayer 04 Leverkusen': 'Bayer Leverkusen',
  'VfB Stuttgart': 'Stuttgart',
  'FC St. Pauli 1910': 'St. Pauli',
  'SV Darmstadt 98': 'Darmstadt',
  '1. FC Köln': 'Koln',
  '1. FC Heidenheim 1846': 'Heidenheim',
  'Sport-Club Freiburg': 'Freiburg',
  'TSG 1899 Hoffenheim': 'Hoffenheim',
  'SV Werder Bremen': 'Werder Bremen',
  'Borussia Mönchengladbach': 'Borussia Monchengladbach',
  'Eintracht Frankfurt': 'Eintracht Frankfurt',
  'RB Leipzig': 'RB Leipzig',
  // Serie A
  'FC Internazionale Milano': 'Inter Milan',
  'Internazionale': 'Inter Milan',
  'Inter': 'Inter Milan',
  'Atalanta BC': 'Atalanta',
  'SS Lazio': 'Lazio',
  'AC Milan': 'AC Milan',
  'Juventus FC': 'Juventus',
  'SSC Napoli': 'Napoli',
  'AS Roma': 'AS Roma',
  'ACF Fiorentina': 'Fiorentina',
  'AC Monza': 'Monza',
  'US Lecce': 'Lecce',
  'Venezia FC': 'Venezia',
  'Cagliari Calcio': 'Cagliari',
  'Udinese Calcio': 'Udinese',
  'Torino FC': 'Torino',
  'Hellas Verona FC': 'Hellas Verona',
  'Genoa CFC': 'Genoa',
  'Bologna FC 1909': 'Bologna',
};

// Strips common suffixes and applies override map
export function normalizeTeam(name: string): string {
  const trimmed = name.trim();

  // Check exact override first
  if (OVERRIDES[trimmed]) return OVERRIDES[trimmed];

  // Strip trailing FC, CF, SC, SV, etc.
  const stripped = trimmed
    .replace(/\s+(FC|CF|SC|SV|AC|SS|AS|US|CD|UD|RCD|SAD|SAD|BV|BSC|FSV|TSV|VfL|VfB|SG|FV|SSC|AFC|RFC)$/i, '')
    .trim();

  // Check override on stripped form
  if (OVERRIDES[stripped]) return OVERRIDES[stripped];

  return stripped || trimmed;
}
