/**
 * Track Visualizer — reads the live in-progress track preview from the game store.
 *
 * As the player drags, the game writes `previewTracksGeojsonFeatures.lines.geojson`
 * (a FeatureCollection). Each feature is a track segment whose `properties` already
 * carry the game's own computed `radius` (m), `speed` (m/s) and `elevation` (m) —
 * so we read those directly rather than estimating from densified points.
 */

import type { LngLat } from './geometry';

interface Bridge {
  getState?: () => Record<string, unknown>;
}

function getState(): Record<string, unknown> | null {
  try {
    const b = (window as unknown as { __subwayBuilder_storeCallbacks__?: Bridge })
      .__subwayBuilder_storeCallbacks__;
    return b?.getState?.() ?? null;
  } catch {
    return null;
  }
}

export interface PreviewSegment {
  coords: LngLat[];
  radius: number | null; // meters (curve radius); large = nearly straight
  speed: number | null; // m/s (curve-limited)
  elevation: number | null; // meters
}

export interface PreviewInfo {
  active: boolean;
  segments: PreviewSegment[];
  /** All coordinates flattened, for length + label positioning. */
  coords: LngLat[];
  /** The game's own buildability flag for the current draw, if exposed. */
  isValid: boolean | null;
}

interface Feature {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: { radius?: unknown; speed?: unknown; elevation?: unknown };
}

const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

export function readPreview(): PreviewInfo {
  const st = getState();
  if (!st) return { active: false, segments: [], coords: [], isValid: null };

  const pf = st['previewTracksGeojsonFeatures'] as
    | { lines?: { geojson?: { features?: Feature[] } }; validation?: { isValid?: boolean } }
    | undefined;
  const features = pf?.lines?.geojson?.features ?? [];

  const segments: PreviewSegment[] = [];
  const coords: LngLat[] = [];
  for (const f of features) {
    const g = f.geometry;
    let segCoords: LngLat[] = [];
    if (g?.type === 'LineString') segCoords = (g.coordinates as LngLat[]) ?? [];
    else if (g?.type === 'MultiLineString') segCoords = ((g.coordinates as LngLat[][]) ?? []).flat();
    if (segCoords.length === 0) continue;
    coords.push(...segCoords);
    const p = f.properties ?? {};
    segments.push({
      coords: segCoords,
      radius: num(p.radius),
      speed: num(p.speed),
      elevation: num(p.elevation),
    });
  }

  const validation = (pf?.validation ?? st['previewValidation']) as { isValid?: boolean } | undefined;
  return {
    active: coords.length > 0,
    segments,
    coords,
    isValid: typeof validation?.isValid === 'boolean' ? validation.isValid : null,
  };
}

/**
 * Parse a track-elevation geojson (preview or constructed) into per-endpoint
 * elevations. The game splits each segment into halves (first half carries
 * startElevation, second half endElevation), so each half's endpoints recover
 * the real per-node set-height (vs the averaged value in the main features).
 */
function parseElevNodes(g: unknown): { coord: LngLat; elevM: number }[] {
  const wrap = g as
    | { lines?: { geojson?: { features?: unknown[] } }; geojson?: { features?: unknown[] }; features?: unknown[] }
    | undefined;
  const fc = (wrap?.lines?.geojson ?? wrap?.geojson ?? wrap) as { features?: unknown[] } | undefined;
  const features = fc?.features;
  if (!Array.isArray(features)) return [];

  const out: { coord: LngLat; elevM: number }[] = [];
  for (const f of features as Array<{
    properties?: { elevation?: unknown };
    geometry?: { type?: string; coordinates?: unknown };
  }>) {
    const elev = num(f?.properties?.elevation);
    if (elev == null) continue;
    const geom = f?.geometry;
    const lines: LngLat[][] =
      geom?.type === 'MultiLineString'
        ? ((geom.coordinates as LngLat[][]) ?? [])
        : [(geom?.coordinates as LngLat[]) ?? []];
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 1) continue;
      out.push({ coord: line[0], elevM: elev });
      out.push({ coord: line[line.length - 1], elevM: elev });
    }
  }
  return out;
}

/** Per-endpoint elevations of the in-progress (preview) track. */
export function readElevationNodes(): { coord: LngLat; elevM: number }[] {
  return parseElevNodes(getState()?.['previewTrackElevationsGeojson']);
}

/** Per-endpoint elevations of already-constructed tracks. */
export function readConstructedElevationNodes(): { coord: LngLat; elevM: number }[] {
  return parseElevNodes(getState()?.['trackElevationsGeojson']);
}
