/**
 * Track Visualizer — geometry helpers for [lng, lat] polylines.
 */

export type LngLat = [number, number];

const R = 6371000; // earth radius (m)
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in meters between two [lng, lat] points. */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing a→b in degrees (0 = north, clockwise). */
export function bearing(a: LngLat, b: LngLat): number {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Total polyline length in meters. */
export function totalLength(coords: LngLat[]): number {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) sum += distanceMeters(coords[i - 1], coords[i]);
  return sum;
}

/**
 * Planar segment intersection for [lng, lat] pairs (exact enough at city scale).
 * Returns the crossing point and the fraction along each segment (t along p1→p2,
 * u along p3→p4), or null if they don't cross in the interior of both.
 */
export function segmentIntersection(
  p1: LngLat,
  p2: LngLat,
  p3: LngLat,
  p4: LngLat,
): { point: LngLat; t: number; u: number } | null {
  const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
  const x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-14) return null; // parallel / collinear
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null; // interior of both only
  return { point: [x1 + t * (x2 - x1), y1 + t * (y2 - y1)], t, u };
}

export interface Vertex {
  /** Index in the coords array. */
  index: number;
  point: LngLat;
  /** Interior turn angle in degrees (180 = straight, smaller = sharper). */
  turnDeg: number;
  /** Approx turn radius in meters at this vertex (Infinity if ~straight). */
  radius: number;
}

/**
 * Compute the turn angle and an approximate radius at each interior vertex.
 * Radius ≈ (segMin/2) / tan((180-turn)/2 / ... ) — we use the simple
 * inscribed-circle estimate from the two adjacent segment lengths.
 */
export function vertices(coords: LngLat[]): Vertex[] {
  const out: Vertex[] = [];
  for (let i = 1; i < coords.length - 1; i++) {
    const inB = bearing(coords[i - 1], coords[i]);
    const outB = bearing(coords[i], coords[i + 1]);
    let deflect = Math.abs(outB - inB) % 360;
    if (deflect > 180) deflect = 360 - deflect; // deflection from straight, 0..180
    const turnDeg = 180 - deflect; // interior angle: 180 straight, less = sharper
    const segLen = Math.min(
      distanceMeters(coords[i - 1], coords[i]),
      distanceMeters(coords[i], coords[i + 1]),
    );
    // radius of the circular arc that fits the deflection over this segment
    const radius =
      deflect < 0.5 ? Infinity : segLen / (2 * Math.tan(toRad(deflect) / 2 || 1e-9));
    out.push({ index: i, point: coords[i], turnDeg, radius });
  }
  return out;
}
