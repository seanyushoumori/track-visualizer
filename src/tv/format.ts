/**
 * Track Visualizer — derive summary stats + unit formatting that mirrors the
 * game's own units setting (localStorage `settings_useImperialUnits`; metric by
 * default, exactly like the game). Imperial: ft / mi / mph. Metric: m / km / km/h.
 */

import type { PreviewInfo } from './preview';
import { totalLength } from './geometry';

/** Game's minimum turn radius (meters), from MIN_TURN_RADIUS. */
export const MIN_RADIUS_M = 29;

const M_TO_FT = 3.28084;
const M_TO_MI = 0.000621371;
const MPS_TO_MPH = 2.23694;
const MPS_TO_KMH = 3.6;

/** Read the game's own units setting (metric by default) from localStorage. */
function readGameImperial(): boolean {
  try {
    return localStorage.getItem('settings_useImperialUnits') === 'true';
  } catch {
    return false;
  }
}

/**
 * Imperial vs metric for the overlay. Initialized on load to match the game's own
 * setting, then flipped by the panel's m/ft toggle for the session. The game keeps
 * its *live* units toggle in an in-memory store a mod can't read, so we re-sync to
 * it on each load/reload rather than tracking it live.
 */
let imperial = readGameImperial();

export function isImperial(): boolean {
  return imperial;
}

export function setImperial(v: boolean): void {
  imperial = v;
}

export interface PreviewStats {
  lengthM: number;
  minRadius: number | null; // meters
  minSpeed: number | null; // m/s (the curve-limited max speed)
  minElev: number | null; // meters
  maxElev: number | null; // meters
  tooSharp: boolean;
  segmentCount: number;
}

export function computeStats(p: PreviewInfo): PreviewStats {
  const lengthM = totalLength(p.coords);
  let minRadius: number | null = null;
  let minSpeed: number | null = null;
  let minElev: number | null = null;
  let maxElev: number | null = null;
  for (const s of p.segments) {
    if (s.radius != null && s.radius > 0) {
      minRadius = minRadius == null ? s.radius : Math.min(minRadius, s.radius);
    }
    if (s.speed != null) minSpeed = minSpeed == null ? s.speed : Math.min(minSpeed, s.speed);
    if (s.elevation != null) {
      minElev = minElev == null ? s.elevation : Math.min(minElev, s.elevation);
      maxElev = maxElev == null ? s.elevation : Math.max(maxElev, s.elevation);
    }
  }
  return {
    lengthM,
    minRadius,
    minSpeed,
    minElev,
    maxElev,
    tooSharp: minRadius != null && minRadius < MIN_RADIUS_M,
    segmentCount: p.segments.length,
  };
}

export const fmtLength = (m: number): string => {
  if (isImperial()) {
    return m >= 1609 ? `${(m * M_TO_MI).toFixed(2)} mi` : `${Math.round(m * M_TO_FT)} ft`;
  }
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
};

export const fmtRadius = (m: number | null): string => {
  if (m == null) return '—';
  return isImperial()
    ? `${Math.round(m * M_TO_FT).toLocaleString()} ft`
    : `${Math.round(m).toLocaleString()} m`;
};

export const fmtSpeed = (mps: number | null): string => {
  if (mps == null) return '—';
  return isImperial()
    ? `${Math.round(mps * MPS_TO_MPH)} mph`
    : `${Math.round(mps * MPS_TO_KMH)} km/h`;
};

/** A single height/elevation value in the game's current units. */
export const fmtHeight = (m: number): string =>
  isImperial() ? `${Math.round(m * M_TO_FT)} ft` : `${Math.round(m)} m`;

export const fmtElev = (minM: number | null, maxM: number | null): string => {
  if (minM == null) return '—';
  const imp = isImperial();
  const unit = imp ? 'ft' : 'm';
  const a = imp ? Math.round(minM * M_TO_FT) : Math.round(minM);
  const b = imp ? Math.round((maxM ?? minM) * M_TO_FT) : Math.round(maxM ?? minM);
  return Math.abs(b - a) < 1 ? `${a} ${unit}` : `${a}–${b} ${unit}`;
};
