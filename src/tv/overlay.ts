/**
 * Track Visualizer — on-map overlay.
 *
 * - Mouse-following summary tooltip while drawing.
 * - Height labels at every node of the route you're laying down. Elevation comes
 *   from this session's captured preview heights, falling back to the network
 *   elevation layer so blueprint tracks from PREVIOUS sessions also resolve.
 * - Optional height labels on already-constructed tracks (toggle).
 *
 * Labels are plain DOM positioned via map.project() each frame, at a low z-index
 * (above the map, below the game's UI).
 */

import type { ModdingAPI } from '../types';
import type { PreviewInfo } from './preview';
import { distanceMeters } from './geometry';
import { readPreview, readElevationNodes, readConstructedElevationNodes } from './preview';
import { computeStats, fmtLength, fmtRadius, fmtSpeed, fmtElev, fmtHeight } from './format';

const NODE_MERGE_PX = 26;
/** Slow fallback recompute of the network elevation cache (~5 s @ 60fps); primary
 *  trigger is onTrackChange + toggle, so this rarely fires. */
const NETWORK_RECOMPUTE_FRAMES = 300;

interface MapLike {
  getContainer(): HTMLElement;
  project(lnglat: [number, number]): { x: number; y: number };
}

type LngLat = [number, number];
type GeoNode = { coord: LngLat; elevM: number };

let tooltip: HTMLDivElement | null = null;
let nodeEls: HTMLDivElement[] = [];
let mouse: { x: number; y: number } | null = null;
let raf = 0;
let started = false;
let hideNodes = false;
let showBuilt = false;

let frame = 0;
let networkElev: GeoNode[] = []; // per-endpoint heights of all placed tracks (built + blueprint)
let builtGeo: GeoNode[] = []; // constructed-track nodes (when showBuilt)
let elevDirty = true;

export function setHideNodes(v: boolean): void {
  hideNodes = v;
}
export function isHideNodes(): boolean {
  return hideNodes;
}
export function setShowBuilt(v: boolean): void {
  showBuilt = v;
  elevDirty = true;
}
export function isShowBuilt(): boolean {
  return showBuilt;
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

function nearestElev(nodes: GeoNode[], coord: LngLat, maxM = 8): number | null {
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

export function startOverlay(api: ModdingAPI): void {
  const map = api.utils.getMap?.() as unknown as MapLike | null;
  if (!map || started) return;
  started = true;

  const container = map.getContainer();
  tooltip = makeTooltip();
  container.appendChild(tooltip);

  document.addEventListener('mousemove', (ev: MouseEvent) => {
    const rect = container.getBoundingClientRect();
    mouse = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  });

  // Placed tracks rarely change — refresh the elevation cache only when they do.
  try {
    api.hooks.onTrackChange(() => {
      elevDirty = true;
    });
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
  tooltip?.remove();
  nodeEls.forEach((e) => e.remove());
  tooltip = null;
  nodeEls = [];
  raf = 0;
  started = false;
}

function dedupGeo(raw: GeoNode[]): GeoNode[] {
  const out: GeoNode[] = [];
  for (const n of raw) {
    if (!out.some((d) => distanceMeters(d.coord, n.coord) < 8)) out.push(n);
  }
  return out;
}

/** Refresh the network elevation cache (built + blueprint) and the built-node set. */
function recomputeNetwork(api: ModdingAPI): void {
  networkElev = readConstructedElevationNodes();

  if (!showBuilt) {
    builtGeo = [];
  } else {
    const raw: GeoNode[] = [];
    try {
      for (const t of api.gameState.getTracks()) {
        if (t.buildType !== 'constructed') continue;
        const c = t.coords as LngLat[] | undefined;
        if (!c || c.length < 2) continue;
        for (const coord of [c[0], c[c.length - 1]]) {
          const elevM = nearestElev(networkElev, coord);
          if (elevM != null) raw.push({ coord, elevM });
        }
      }
    } catch {
      /* ignore */
    }
    builtGeo = dedupGeo(raw);
  }
}

/** Geographic nodes of the in-progress route (preview rubber-band + placed blueprints). */
function inProgressGeoNodes(api: ModdingAPI, preview: PreviewInfo): GeoNode[] {
  for (const en of readElevationNodes()) recordElev(en.coord, en.elevM);

  const out: GeoNode[] = [];
  const add = (coord: LngLat) => {
    // This session's captured set-height first; fall back to the network layer so
    // blueprint tracks placed in PREVIOUS sessions still resolve.
    const elevM = nearestElev(captured, coord) ?? nearestElev(networkElev, coord);
    if (elevM != null) out.push({ coord, elevM });
  };

  try {
    for (const t of api.gameState.getTracks()) {
      if (t.buildType !== 'blueprint') continue;
      const c = t.coords as LngLat[] | undefined;
      if (!c || c.length < 2) continue;
      add(c[0]);
      add(c[c.length - 1]);
    }
  } catch {
    /* ignore */
  }

  if (preview.segments.length > 0) {
    const segs = preview.segments;
    add(segs[0].coords[0] as LngLat);
    for (const s of segs) add(s.coords[s.coords.length - 1] as LngLat);
  }
  return out;
}

function update(api: ModdingAPI, map: MapLike, container: HTMLElement): void {
  if (!tooltip) return;
  frame++;
  const preview = readPreview();

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

  // --- node height labels ---
  const needNetwork = !hideNodes || showBuilt;
  if (needNetwork && (elevDirty || frame % NETWORK_RECOMPUTE_FRAMES === 1)) {
    recomputeNetwork(api);
    elevDirty = false;
  }

  const geo: GeoNode[] = [];
  if (!hideNodes) geo.push(...inProgressGeoNodes(api, preview));
  if (showBuilt) geo.push(...builtGeo);

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
}
