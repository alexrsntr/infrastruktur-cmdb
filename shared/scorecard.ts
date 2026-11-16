// Plant scorecard (rating of each infrastructure area with 1–5 points) and WAN lines – shared by API and UI.

export const SCORE_MAX = 5;
export const SCORE_VALUES = [1, 2, 3, 4, 5] as const;
export type Score = (typeof SCORE_VALUES)[number];

export const SCORE_META: Record<Score, { label: string; color: string }> = {
  1: { label: 'Critical', color: '#cf1322' },
  2: { label: 'Poor', color: '#d4380d' },
  3: { label: 'Fair', color: '#d48806' },
  4: { label: 'Good', color: '#7cb305' },
  5: { label: 'Very good', color: '#389e0d' },
};

/** Areas offered when an administrator creates the scorecard of a plant (they can rename, remove and add areas). */
export const DEFAULT_SCORECARD_AREAS = [
  'WAN',
  'Network',
  'Switches',
  'WLAN',
  'Firewall / security',
  'Servers & storage',
  'Racks',
  'Cabling',
  'Power / UPS',
  'Server room',
  'Documentation',
] as const;

export const MAX_SCORECARD_AREAS = 40;

export interface ScorecardItem {
  id: string;
  category: string;
  /** 1–5 points, null = not rated yet */
  score: Score | null;
  comment: string | null;
  position: number;
  updated_at: string;
  updated_by_name: string | null;
}

export interface Scorecard {
  plant_id: string;
  items: ScorecardItem[];
  /** sum of the points of the rated areas and the maximum for them ("41 / 50") */
  points: number;
  max_points: number;
  /** average of the rated areas (1–5), null when nothing is rated */
  average: number | null;
  rated: number;
  updated_at: string | null;
  updated_by_name: string | null;
}

/** Body of PUT /api/plants/:id/scorecard – replaces the whole list */
export interface ScorecardInput {
  items: { category: string; score: Score | null; comment: string | null }[];
}

/** One line per plant for overviews (plant list) */
export interface ScorecardSummary {
  plant_id: string;
  points: number;
  max_points: number;
  average: number | null;
  rated: number;
  areas: number;
  updated_at: string | null;
}

/** Colour of an average or single score (rounded) */
export function scoreColor(value: number | null | undefined): string {
  if (value == null) return '#8c8c8c';
  const rounded = Math.min(SCORE_MAX, Math.max(1, Math.round(value))) as Score;
  return SCORE_META[rounded].color;
}

export function scoreLabel(value: number | null | undefined): string {
  if (value == null) return 'Not rated';
  const rounded = Math.min(SCORE_MAX, Math.max(1, Math.round(value))) as Score;
  return SCORE_META[rounded].label;
}

/** Sum, maximum and average of a list of scores (unrated areas are left out) */
export function summarizeScores(scores: (number | null)[]): { points: number; max_points: number; average: number | null; rated: number } {
  const rated = scores.filter((s): s is number => s != null);
  const points = rated.reduce((a, b) => a + b, 0);
  return {
    points,
    max_points: rated.length * SCORE_MAX,
    average: rated.length ? Math.round((points / rated.length) * 10) / 10 : null,
    rated: rated.length,
  };
}

// ---------------------------------------------------------------------------
// WAN lines
// ---------------------------------------------------------------------------

/** Suggestions – any other text is allowed too */
export const WAN_TECHNOLOGIES = ['MPLS', 'LIA (Internet)', 'DIA (dedicated Internet)', 'SD-WAN', 'Broadband / DSL', 'Fibre (FTTH / FTTB)', 'LTE / 5G', 'Satellite', 'Point-to-point'] as const;

export interface WanLine {
  id: string;
  plant_id: string;
  /** e.g. "First line", "Backup line" */
  name: string;
  technology: string | null;
  /** provider and product, e.g. "T-Systems IntraSelect FixConnect", "Vivo" */
  provider: string | null;
  bandwidth: string | null;
  circuit_id: string | null;
  contract_end: string | null;
  note: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}
