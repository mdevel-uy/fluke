// Shared lane-color identity (decisión Dani 29-jul): the graph lanes, the
// ref/tag chips on rows and the sidebar branch dots all speak the same
// color. Static class maps keep Tailwind's purge happy.

export type LaneColorToken =
  | 'brand'
  | 'merged'
  | 'warning'
  | 'success'
  | 'info'
  | 'error'
  | 'neutral';

export const LANE_TOKEN_TEXT: Record<LaneColorToken, string> = {
  brand: 'text-brand-on-surface',
  merged: 'text-merged',
  warning: 'text-warning',
  success: 'text-success',
  info: 'text-info',
  error: 'text-error',
  neutral: 'text-border-strong',
};

export const LANE_TOKEN_BG: Record<LaneColorToken, string> = {
  brand: 'bg-brand-on-surface',
  merged: 'bg-merged',
  warning: 'bg-warning',
  success: 'bg-success',
  info: 'bg-info',
  error: 'bg-error',
  neutral: 'bg-border-strong',
};

/** Rotation for lanes without a workspace (Sourcetree-style rainbow). */
export const LANE_TOKEN_PALETTE: LaneColorToken[] = [
  'brand',
  'merged',
  'warning',
  'success',
  'info',
  'error',
];
