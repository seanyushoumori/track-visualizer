/**
 * Track Visualizer — on-map overlay.
 *
 * - Mouse-following summary tooltip while drawing.
 * - Height labels at every node of the route you're laying down + (optionally)
 *   already-constructed tracks.
 *
 * Performance model:
 * - The existing-node set (placed blueprint + built tracks) is CACHED and rebuilt
 *   only when the network changes — driven by mutation hooks (onTrackChange,
 *   onTrackBuilt, onBlueprintPlaced, onStationBuilt/Deleted, onCityLoad) plus a
 *   cheap O(N) "track-set signature" catch-all (so e.g. Build-Blueprints, which
 *   re-categorises blueprint→constructed, can't leave stale labels).
 * - Elevation lookups use a spatial grid → the rebuild is O(N), not O(N²).
 * - Only the live preview (rubber-band) is recomputed per frame, and only while
 *   drawing. Labels are re-projected only when the camera moves or the set changes;
 *   idle frames do nothing.
 */

import type { ModdingAPI } from '../types';
import type { PreviewInfo } from './preview';
import { distanceMeters, segmentIntersection } from './geometry';
import { readPreview, readElevationNodes, readConstructedElevationNodes } from './preview';
import { computeStats, fmtLength, fmtRadius, fmtSpeed, fmtElev, fmtHeight } from './format';

const NODE_MERGE_PX = 26;
const GRID_DEG = 0.0001; // ~10 m spatial-index cell
const ELEV_SNAP_M = 8; // elevation lookup + geo-dedup radius
const SIG_INTERVAL_FRAMES = 90; // ~1.5 s cheap "did the track set change?" check
const JUNCTION_M = 4; // crossings within this of a node are junctions, not crossings
const SAME_HEIGHT_M = 2; // two tracks within this elevation gap count as "same height"
const XOVER_DEDUP_DEG = 0.0001 / 14; // ~0.7 m — merge only near-coincident crossings, keep distinct ones
const XOVER_DEBOUNCE_FRAMES = 30; // recompute crossings ~0.5 s after edits settle, not per-mutation

interface MapLike {
  getContainer(): HTMLElement;
  project(lnglat: [number, number]): { x: number; y: number };
  on?(type: string, cb: () => void): void;
  off?(type: string, cb: () => void): void;
}

type LngLat = [number, number];
type GeoNode = { coord: LngLat; elevM: number };
type Grid = Map<string, GeoNode[]>;

let tooltip: HTMLDivElement | null = null;
let nodeEls: HTMLDivElement[] = [];
let dotEls: HTMLDivElement[] = []; // crossing markers
let mouse: { x: number; y: number } | null = null;
let raf = 0;
let started = false;
let hideNodes = false;
let showBuilt = false;
let showIntersections = false;

let mapRef: MapLike | null = null;
let onMove: (() => void) | null = null;

let frame = 0;
let cachedGeo: GeoNode[] = []; // deduped existing-node set (blueprint + built)
let networkGrid: Grid = new Map(); // spatial index over the network elevation table
let intersectionPts: LngLat[] = []; // same-height track crossings (cached)
let intersectionsDirty = false; // crossings need a (debounced) recompute
let lastRebuildFrame = 0; // frame of the last network rebuild — debounce baseline
let nodesDirty = true; // rebuild the existing-node set
let needsRender = true; // re-project / reposition labels
let wasDrawing = false;
let lastSig = '';

export function setHideNodes(v: boolean): void {
  hideNodes = v;
  nodesDirty = true;
  needsRender = true;
}
export function isHideNodes(): boolean {
  return hideNodes;
}
export function setShowBuilt(v: boolean): void {
  showBuilt = v;
  nodesDirty = true;
  needsRender = true;
}
export function isShowBuilt(): boolean {
  return showBuilt;
}
export function setShowIntersections(v: boolean): void {
  showIntersections = v;
  nodesDirty = true; // recompute crossings on the next rebuild
  needsRender = true;
}
export function isShowIntersections(): boolean {
  return showIntersections;
}
/** Force one render pass — e.g. after the units toggle changes label text. */
export function requestRender(): void {
  needsRender = true;
}

// --- captured set-elevation per node (recorded from the preview during drag) ---
const captured: GeoNode[] = [];

function recordElev(coord: LngLat, elevM: number | null): void {
  if (elevM == null) return;
  for (const c of captured) {
    if (distanceMeters(c.coord, coord) < 3) {
      c.elevM = elevM;
      return;
    }
  }
  captured.push({ coord, elevM });
  if (captured.length > 4000) captured.shift();
}

// --- spatial index ---
function cellKey(lng: number, lat: number): string {
  return `${Math.floor(lng / GRID_DEG)}|${Math.floor(lat / GRID_DEG)}`;
}
function buildGrid(nodes: GeoNode[]): Grid {
  const g: Grid = new Map();
  for (const n of nodes) {
    const k = cellKey(n.coord[0], n.coord[1]);
    const b = g.get(k);
    if (b) b.push(n);
    else g.set(k, [n]);
  }
  return g;
}
/** Nearest node elevation within `maxM` (checks the cell + 8 neighbours). O(1) amortised. */
function nearestElevGrid(grid: Grid, coord: LngLat, maxM = ELEV_SNAP_M): number | null {
  const cx = Math.floor(coord[0] / GRID_DEG);
  const cy = Math.floor(coord[1] / GRID_DEG);
  let best: number | null = null;
  let bestD = maxM;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const b = grid.get(`${cx + dx}|${cy + dy}`);
      if (!b) continue;
      for (const n of b) {
        const d = distanceMeters(n.coord, coord);
        if (d < bestD) {
          bestD = d;
          best = n.elevM;
        }
      }
    }
  }
  return best;
}
/** Linear nearest — only for small live sets (the preview's `captured` heights). */
function nearestElev(nodes: GeoNode[], coord: LngLat, maxM = ELEV_SNAP_M): number | null {
  let best: number | null = null;
  let bestD = maxM;
  for (const c of nodes) {
    const d = distanceMeters(c.coord, coord);
    if (d < bestD) {
      bestD = d;
      best = c.elevM;
    }
  }
  return best;
}
/** Grid-based dedupe at `ELEV_SNAP_M`. O(N). */
function gridDedup(raw: GeoNode[]): GeoNode[] {
  const g: Grid = new Map();
  const out: GeoNode[] = [];
  for (const n of raw) {
    const cx = Math.floor(n.coord[0] / GRID_DEG);
    const cy = Math.floor(n.coord[1] / GRID_DEG);
    let dup = false;
    for (let dx = -1; dx <= 1 && !dup; dx++) {
      for (let dy = -1; dy <= 1 && !dup; dy++) {
        const b = g.get(`${cx + dx}|${cy + dy}`);
        if (b) for (const m of b) if (distanceMeters(m.coord, n.coord) < ELEV_SNAP_M) { dup = true; break; }
      }
    }
    if (dup) continue;
    out.push(n);
    const k = `${cx}|${cy}`;
    const b = g.get(k);
    if (b) b.push(n);
    else g.set(k, [n]);
  }
  return out;
}

function makeTooltip(): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = [
    'position:absolute;z-index:2;pointer-events:none;transform:translate(16px,16px)',
    'background:rgba(17,17,17,0.88);color:#fff;font:12px/1.45 system-ui,-apple-system,sans-serif',
    'padding:7px 9px;border-radius:7px;white-space:nowrap;display:none',
    'box-shadow:0 2px 10px rgba(0,0,0,0.45)',
  ].join(';');
  d.setAttribute('data-tv-ov', '1');
  return d;
}

function makeNodeLabel(): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = [
    'position:absolute;z-index:1;pointer-events:none;transform:translate(-50%,-150%)',
    'color:#111;font:11px/1 system-ui,-apple-system,sans-serif;font-weight:600',
    'text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 2px #fff,0 0 2px #fff;white-space:nowrap;display:none',
  ].join(';');
  d.setAttribute('data-tv-ov', '1');
  return d;
}

function makeDot(): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = [
    'position:absolute;z-index:1;pointer-events:none;transform:translate(-50%,-50%)',
    'width:12px;height:12px;border-radius:50%;box-sizing:border-box',
    'background:rgba(245,158,11,0.25);border:2px solid #f59e0b;display:none',
  ].join(';');
  d.setAttribute('data-tv-ov', '1');
  return d;
}

/** Cheap O(N) signature of the track set (counts only) — catches missed mutations. */
function trackSignature(api: ModdingAPI): string {
  let total = 0;
  let blueprint = 0;
  try {
    for (const t of api.gameState.getTracks()) {
      total++;
      if (t.buildType === 'blueprint') blueprint++;
    }
  } catch {
    /* ignore */
  }
  return `${total}|${blueprint}`;
}

/** Rebuild the cached existing-node set (placed blueprint + built). O(N) via the grid. */
function rebuildExisting(api: ModdingAPI): void {
  networkGrid = buildGrid(readConstructedElevationNodes());
  const capturedGrid = buildGrid(captured);
  const blueprintElev = (coord: LngLat) =>
    nearestElevGrid(capturedGrid, coord) ?? nearestElevGrid(networkGrid, coord);

  const raw: GeoNode[] = [];
  try {
    for (const t of api.gameState.getTracks()) {
      const c = t.coords as LngLat[] | undefined;
      if (!c || c.length < 2) continue;
      const ends: LngLat[] = [c[0], c[c.length - 1]];
      if (t.buildType === 'blueprint') {
        if (hideNodes) continue;
        for (const coord of ends) {
          const e = blueprintElev(coord);
          if (e != null) raw.push({ coord, elevM: e });
        }
      } else if (t.buildType === 'constructed') {
        if (!showBuilt) continue;
        for (const coord of ends) {
          const e = nearestElevGrid(networkGrid, coord);
          if (e != null) raw.push({ coord, elevM: e });
        }
      }
    }
  } catch {
    /* ignore */
  }

  cachedGeo = gridDedup(raw);
  // Don't run the (potentially expensive) crossing pass inline on every mutation —
  // mark it dirty and let the debounced recompute in update() handle it.
  if (showIntersections) {
    intersectionsDirty = true;
    lastRebuildFrame = frame;
  } else {
    intersectionPts = [];
    intersectionsDirty = false;
  }
  lastSig = trackSignature(api);
}

/** Same-height track crossings: interior segment intersections at ~equal elevation. */
function computeIntersections(api: ModdingAPI): LngLat[] {
  // Prefer the reliable constructed-elevation grid (same source the height labels
  // use); only fall back to the drag-captured set — checking captured first can
  // return a nearby track's elevation at a dense interchange and false-match heights.
  const elevAt = (coord: LngLat): number | null =>
    nearestElevGrid(networkGrid, coord) ?? nearestElev(captured, coord);

  type Seg = { a: LngLat; b: LngLat; ea: number; eb: number };
  const segs: Seg[] = [];
  try {
    for (const t of api.gameState.getTracks()) {
      const c = t.coords as LngLat[] | undefined;
      if (!c || c.length < 2) continue;
      for (let i = 1; i < c.length; i++) {
        const a = c[i - 1];
        const b = c[i];
        const ea = elevAt(a);
        const eb = elevAt(b);
        if (ea == null || eb == null) continue; // no elevation data → can't judge height
        segs.push({ a, b, ea, eb });
      }
    }
  } catch {
    /* ignore */
  }

  // Bucket segments into the grid cells their bounding box covers, to prune pairs.
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / GRID_DEG);
    const x1 = Math.floor(Math.max(s.a[0], s.b[0]) / GRID_DEG);
    const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / GRID_DEG);
    const y1 = Math.floor(Math.max(s.a[1], s.b[1]) / GRID_DEG);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x}|${y}`;
        const arr = buckets.get(k);
        if (arr) arr.push(i);
        else buckets.set(k, [i]);
      }
  }

  const out: LngLat[] = [];
  const seenPair = new Set<string>();
  const seenPt = new Set<string>();
  for (const arr of buckets.values()) {
    for (let p = 0; p < arr.length; p++) {
      for (let q = p + 1; q < arr.length; q++) {
        const i = Math.min(arr[p], arr[q]);
        const j = Math.max(arr[p], arr[q]);
        const pk = `${i}|${j}`;
        if (seenPair.has(pk)) continue;
        seenPair.add(pk);
        const A = segs[i];
        const B = segs[j];
        const hit = segmentIntersection(A.a, A.b, B.a, B.b);
        if (!hit) continue;
        // skip junctions: crossing coinciding with a node of either segment
        if (
          distanceMeters(hit.point, A.a) < JUNCTION_M ||
          distanceMeters(hit.point, A.b) < JUNCTION_M ||
          distanceMeters(hit.point, B.a) < JUNCTION_M ||
          distanceMeters(hit.point, B.b) < JUNCTION_M
        )
          continue;
        // elevation of each track at the crossing (linear along the segment)
        const eA = A.ea + hit.t * (A.eb - A.ea);
        const eB = B.ea + hit.u * (B.eb - B.ea);
        if (Math.abs(eA - eB) > SAME_HEIGHT_M) continue; // different heights → grade-separated
        const ptk = `${Math.round(hit.point[0] / XOVER_DEDUP_DEG)}|${Math.round(hit.point[1] / XOVER_DEDUP_DEG)}`;
        if (seenPt.has(ptk)) continue;
        seenPt.add(ptk);
        out.push(hit.point);
      }
    }
  }
  return out;
}

/** Live preview (rubber-band) nodes — small set, recomputed each frame while drawing. */
function previewNodes(preview: PreviewInfo): GeoNode[] {
  for (const en of readElevationNodes()) recordElev(en.coord, en.elevM);
  const out: GeoNode[] = [];
  const add = (coord: LngLat) => {
    const e = nearestElev(captured, coord) ?? nearestElevGrid(networkGrid, coord);
    if (e != null) out.push({ coord, elevM: e });
  };
  if (preview.segments.length > 0) {
    add(preview.segments[0].coords[0] as LngLat);
    for (const s of preview.segments) add(s.coords[s.coords.length - 1] as LngLat);
  }
  return out;
}

export function startOverlay(api: ModdingAPI): void {
  const map = api.utils.getMap?.() as unknown as MapLike | null;
  if (!map || started) return;
  started = true;

  // Tear down any overlay a previous (hot-reloaded) module instance left behind:
  // remove its orphaned DOM, and bump a global generation so its RAF loop self-stops.
  const G = window as unknown as { __tvOverlayGen?: number };
  const myGen = (G.__tvOverlayGen = (G.__tvOverlayGen ?? 0) + 1);
  document.querySelectorAll('[data-tv-ov]').forEach((e) => e.remove());

  mapRef = map;
  const container = map.getContainer();
  tooltip = makeTooltip();
  container.appendChild(tooltip);

  document.addEventListener('mousemove', (ev: MouseEvent) => {
    const rect = container.getBoundingClientRect();
    mouse = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  });

  // Existing nodes change only on mutations — refresh the cache when they happen.
  const markDirty = () => {
    nodesDirty = true;
  };
  const onCity = () => {
    captured.length = 0;
    cachedGeo = [];
    nodesDirty = true;
    needsRender = true;
  };
  for (const wire of [
    () => api.hooks.onTrackChange(markDirty),
    () => api.hooks.onTrackBuilt(markDirty),
    () => api.hooks.onBlueprintPlaced(markDirty),
    () => api.hooks.onStationBuilt(markDirty),
    () => api.hooks.onStationDeleted(markDirty),
    () => api.hooks.onCityLoad(onCity),
    () => api.hooks.onGameLoaded(onCity),
  ]) {
    try {
      wire();
    } catch {
      /* hook may not exist */
    }
  }

  // Re-project labels only when the camera moves.
  onMove = () => {
    needsRender = true;
  };
  try {
    map.on?.('move', onMove);
    map.on?.('resize', onMove);
  } catch {
    /* ignore */
  }

  const loop = () => {
    if (myGen !== G.__tvOverlayGen) return; // a newer instance took over → stop this loop
    try {
      update(api, map, container);
    } catch {
      /* ignore per-frame errors */
    }
    raf = requestAnimationFrame(loop);
  };
  loop();
}

export function stopOverlay(): void {
  if (raf) cancelAnimationFrame(raf);
  if (mapRef && onMove) {
    try {
      mapRef.off?.('move', onMove);
      mapRef.off?.('resize', onMove);
    } catch {
      /* ignore */
    }
  }
  tooltip?.remove();
  nodeEls.forEach((e) => e.remove());
  dotEls.forEach((e) => e.remove());
  tooltip = null;
  nodeEls = [];
  dotEls = [];
  mapRef = null;
  onMove = null;
  raf = 0;
  started = false;
}

function update(api: ModdingAPI, map: MapLike, container: HTMLElement): void {
  if (!tooltip) return;
  frame++;
  const preview = readPreview();
  const drawing = preview.active && preview.segments.length > 0;

  // --- mouse-following summary tooltip (while actively drawing) ---
  if (preview.active && preview.coords.length >= 2) {
    const s = computeStats(preview);
    const radColor = s.tooSharp ? '#f87171' : '#fff';
    tooltip.innerHTML =
      `<div style="font-weight:600;margin-bottom:2px">${fmtLength(s.lengthM)}</div>` +
      `<div>min curve <span style="color:${radColor}">${fmtRadius(s.minRadius)}${s.tooSharp ? ' ⚠' : ''}</span></div>` +
      `<div>max speed ${fmtSpeed(s.minSpeed)}</div>` +
      `<div>elevation ${fmtElev(s.minElev, s.maxElev)}</div>` +
      (preview.isValid === false ? `<div style="color:#f87171">not buildable</div>` : '');
    const last = preview.coords[preview.coords.length - 1];
    const anchor = mouse ?? map.project([last[0], last[1]]);
    tooltip.style.left = `${anchor.x}px`;
    tooltip.style.top = `${anchor.y}px`;
    tooltip.style.display = 'block';
  } else {
    tooltip.style.display = 'none';
  }

  // --- refresh the existing-node set: on mutation, or a cheap periodic signature change ---
  if (nodesDirty) {
    rebuildExisting(api);
    nodesDirty = false;
    needsRender = true;
  } else if (frame % SIG_INTERVAL_FRAMES === 0 && trackSignature(api) !== lastSig) {
    rebuildExisting(api);
    needsRender = true;
  }

  // --- debounced crossing recompute: the expensive pass runs once edits settle ---
  if (showIntersections && intersectionsDirty && frame - lastRebuildFrame >= XOVER_DEBOUNCE_FRAMES) {
    intersectionPts = computeIntersections(api);
    intersectionsDirty = false;
    needsRender = true;
  }

  // --- live preview nodes (only while drawing) ---
  let pv: GeoNode[] = [];
  if (drawing && !hideNodes) {
    pv = previewNodes(preview);
    needsRender = true;
  }
  if (drawing !== wasDrawing) needsRender = true; // start/stop of a drag needs one render
  wasDrawing = drawing;

  if (!needsRender) return;

  const geo = pv.length ? cachedGeo.concat(pv) : cachedGeo;

  // Project + viewport-cull + screen-space dedupe (grid-bucketed → O(N), not O(N²)).
  const w = container.clientWidth;
  const h = container.clientHeight;
  const kept: { x: number; y: number; elevM: number }[] = [];
  const screenGrid = new Map<string, { x: number; y: number }[]>();
  for (const n of geo) {
    const pt = map.project(n.coord);
    if (pt.x < -40 || pt.y < -40 || pt.x > w + 40 || pt.y > h + 40) continue;
    const cx = Math.floor(pt.x / NODE_MERGE_PX);
    const cy = Math.floor(pt.y / NODE_MERGE_PX);
    let dup = false;
    for (let dx = -1; dx <= 1 && !dup; dx++) {
      for (let dy = -1; dy <= 1 && !dup; dy++) {
        const b = screenGrid.get(`${cx + dx}|${cy + dy}`);
        if (b) for (const k of b) if (Math.hypot(k.x - pt.x, k.y - pt.y) < NODE_MERGE_PX) { dup = true; break; }
      }
    }
    if (dup) continue;
    kept.push({ x: pt.x, y: pt.y, elevM: n.elevM });
    const key = `${cx}|${cy}`;
    const b = screenGrid.get(key);
    if (b) b.push({ x: pt.x, y: pt.y });
    else screenGrid.set(key, [{ x: pt.x, y: pt.y }]);
  }

  for (let i = 0; i < kept.length; i++) {
    let el = nodeEls[i];
    if (!el) {
      el = makeNodeLabel();
      container.appendChild(el);
      nodeEls[i] = el;
    }
    const n = kept[i];
    el.textContent = fmtHeight(n.elevM);
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    el.style.display = 'block';
  }
  for (let i = kept.length; i < nodeEls.length; i++) nodeEls[i].style.display = 'none';

  // --- same-height crossing markers ---
  if (showIntersections) {
    let di = 0;
    for (const pt of intersectionPts) {
      const p = map.project(pt);
      if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) continue;
      let el = dotEls[di];
      if (!el) {
        el = makeDot();
        container.appendChild(el);
        dotEls[di] = el;
      }
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      el.style.display = 'block';
      di++;
    }
    for (let i = di; i < dotEls.length; i++) dotEls[i].style.display = 'none';
  } else {
    for (const el of dotEls) el.style.display = 'none';
  }

  needsRender = false;
}
