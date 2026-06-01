/**
 * Track Visualizer — derive summary stats + imperial formatting (matches the
 * game's in-game units: ft / mph).
 */

import type { PreviewInfo } from './preview';
import { totalLength } from './geometry';

/** Game's minimum turn radius (meters), from MIN_TURN_RADIUS. */
export const MIN_RADIUS_M = 29;

const M_TO_FT = 3.28084;
const MPS_TO_MPH = 2.23694;

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

export const fmtLength = (m: number): string =>
  m >= 1609 ? `${(m * 0.000621371).toFixed(2)} mi` : `${Math.round(m * M_TO_FT)} ft`;

export const fmtRadius = (m: number | null): string =>
  m == null ? '—' : `${Math.round(m * M_TO_FT).toLocaleString()} ft`;

export const fmtSpeed = (mps: number | null): string =>
  mps == null ? '—' : `${Math.round(mps * MPS_TO_MPH)} mph`;

export const fmtElev = (minM: number | null, maxM: number | null): string => {
  if (minM == null) return '—';
  const a = Math.round(minM * M_TO_FT);
  const b = Math.round((maxM ?? minM) * M_TO_FT);
  return Math.abs(b - a) < 1 ? `${a} ft` : `${a}–${b} ft`;
};
