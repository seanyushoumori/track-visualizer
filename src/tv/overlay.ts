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
import { distanceMeters } from './geometry';
import { readPreview, readElevationNodes, readConstructedElevationNodes } from './preview';
import { computeStats, fmtLength, fmtRadius, fmtSpeed, fmtElev, fmtHeight } from './format';

const NODE_MERGE_PX = 26;
const GRID_DEG = 0.0001; // ~10 m spatial-index cell
const ELEV_SNAP_M = 8; // elevation lookup + geo-dedup radius
const SIG_INTERVAL_FRAMES = 90; // ~1.5 s cheap "did the track set change?" check

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
let mouse: { x: number; y: number } | null = null;
let raf = 0;
let started = false;
let hideNodes = false;
let showBuilt = false;

let mapRef: MapLike | null = null;
let onMove: (() => void) | null = null;

let frame = 0;
let cachedGeo: GeoNode[] = []; // deduped existing-node set (blueprint + built)
let networkGrid: Grid = new Map(); // spatial index over the network elevation table
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
  return d;
}

function makeNodeLabel(): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = [
    'position:absolute;z-index:1;pointer-events:none;transform:translate(-50%,-150%)',
    'color:#111;font:11px/1 system-ui,-apple-system,sans-serif;font-weight:600',
    'text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 2px #fff,0 0 2px #fff;white-space:nowrap;display:none',
  ].join(';');
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
  lastSig = trackSignature(api);
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
  tooltip = null;
  nodeEls = [];
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

  // Project + viewport-cull + screen-space dedupe.
  const w = container.clientWidth;
  const h = container.clientHeight;
  const kept: { x: number; y: number; elevM: number }[] = [];
  for (const n of geo) {
    const pt = map.project(n.coord);
    if (pt.x < -40 || pt.y < -40 || pt.x > w + 40 || pt.y > h + 40) continue;
    if (kept.some((k) => Math.hypot(k.x - pt.x, k.y - pt.y) < NODE_MERGE_PX)) continue;
    kept.push({ x: pt.x, y: pt.y, elevM: n.elevM });
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

  needsRender = false;
}
