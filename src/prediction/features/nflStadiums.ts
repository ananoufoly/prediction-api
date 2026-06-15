/**
 * NFL home-stadium coordinates + dome flag, keyed by team abbreviation.
 * Dome/retractable-closed venues are weather-neutral; we flag them so the
 * weather features can be zeroed/ignored rather than fetched misleadingly.
 * Coordinates are approximate stadium locations (sufficient for daily weather).
 */
export interface Stadium {
  lat: number;
  lon: number;
  dome: boolean;
}

export const NFL_STADIUMS: Record<string, Stadium> = {
  ARI: { lat: 33.53, lon: -112.26, dome: true },   // retractable, usually closed
  ATL: { lat: 33.76, lon: -84.40, dome: true },    // retractable
  BAL: { lat: 39.28, lon: -76.62, dome: false },
  BUF: { lat: 42.77, lon: -78.79, dome: false },
  CAR: { lat: 35.23, lon: -80.85, dome: false },
  CHI: { lat: 41.86, lon: -87.62, dome: false },
  CIN: { lat: 39.10, lon: -84.52, dome: false },
  CLE: { lat: 41.51, lon: -81.70, dome: false },
  DAL: { lat: 32.75, lon: -97.09, dome: true },    // retractable
  DEN: { lat: 39.74, lon: -105.02, dome: false },
  DET: { lat: 42.34, lon: -83.05, dome: true },
  GB:  { lat: 44.50, lon: -88.06, dome: false },
  HOU: { lat: 29.68, lon: -95.41, dome: true },    // retractable
  IND: { lat: 39.76, lon: -86.16, dome: true },    // retractable
  JAX: { lat: 30.32, lon: -81.64, dome: false },
  KC:  { lat: 39.05, lon: -94.48, dome: false },
  LV:  { lat: 36.09, lon: -115.18, dome: true },
  LAC: { lat: 33.95, lon: -118.34, dome: true },   // SoFi (fixed canopy)
  LA:  { lat: 33.95, lon: -118.34, dome: true },
  LAR: { lat: 33.95, lon: -118.34, dome: true },
  MIA: { lat: 25.96, lon: -80.24, dome: false },
  MIN: { lat: 44.97, lon: -93.26, dome: true },
  NE:  { lat: 42.09, lon: -71.26, dome: false },
  NO:  { lat: 29.95, lon: -90.08, dome: true },
  NYG: { lat: 40.81, lon: -74.07, dome: false },
  NYJ: { lat: 40.81, lon: -74.07, dome: false },
  PHI: { lat: 39.90, lon: -75.17, dome: false },
  PIT: { lat: 40.45, lon: -80.02, dome: false },
  SF:  { lat: 37.40, lon: -121.97, dome: false },
  SEA: { lat: 47.59, lon: -122.33, dome: false },
  TB:  { lat: 27.98, lon: -82.50, dome: false },
  TEN: { lat: 36.17, lon: -86.77, dome: false },
  WAS: { lat: 38.91, lon: -76.86, dome: false },
};
