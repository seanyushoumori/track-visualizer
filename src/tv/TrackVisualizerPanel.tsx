/**
 * Track Visualizer — live readout panel.
 *
 * Re-renders ~10×/s and reads the in-progress drag preview, showing length,
 * curve radius, curve-limited speed, and elevation (using the game's own
 * per-segment values). The same data also renders on the map via the overlay.
 */

import { useEffect, useState } from 'react';
import { readPreview } from './preview';
import { computeStats, fmtLength, fmtRadius, fmtSpeed, fmtElev } from './format';
import { isHideNodes, setHideNodes, isShowBuilt, setShowBuilt } from './overlay';

const api = window.SubwayBuilderAPI;
const { Switch, Label } = api.utils.components as Record<string, React.ComponentType<any>>;

export function TrackVisualizerPanel() {
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);

  const preview = readPreview();

  const toggles = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="tv-nodes">Show node heights</Label>
        <Switch
          id="tv-nodes"
          checked={!isHideNodes()}
          onCheckedChange={(v: boolean) => {
            setHideNodes(!v);
            rerender();
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="tv-built">Show built-track heights</Label>
        <Switch
          id="tv-built"
          checked={isShowBuilt()}
          onCheckedChange={(v: boolean) => {
            setShowBuilt(v);
            rerender();
          }}
        />
      </div>
    </div>
  );

  if (!preview.active) {
    return (
      <div className="flex flex-col gap-3 p-3 text-sm">
        {toggles}
        <p className="text-muted-foreground">
          Start drawing track — live geometry (length, curve radius, speed, elevation) appears
          here and as a tooltip on the map next to your route. Node heights stay labelled on the
          map for the whole route you're laying down.
        </p>
      </div>
    );
  }

  const s = computeStats(preview);

  return (
    <div className="flex flex-col gap-2 p-3 text-sm">
      {toggles}
      <div className="flex items-center justify-between">
        <span className="font-medium">Drawing track</span>
        {preview.isValid != null ? (
          <span className={preview.isValid ? 'text-green-600' : 'text-red-500'}>
            {preview.isValid ? 'buildable' : 'invalid'}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">Length</span>
        <span className="text-right tabular-nums">{fmtLength(s.lengthM)}</span>

        <span className="text-muted-foreground">Min curve radius</span>
        <span className={`text-right tabular-nums ${s.tooSharp ? 'text-red-500' : ''}`}>
          {fmtRadius(s.minRadius)}
          {s.tooSharp ? ' ⚠' : ''}
        </span>

        <span className="text-muted-foreground">Max speed</span>
        <span className="text-right tabular-nums">{fmtSpeed(s.minSpeed)}</span>

        <span className="text-muted-foreground">Elevation</span>
        <span className="text-right tabular-nums">{fmtElev(s.minElev, s.maxElev)}</span>

        <span className="text-muted-foreground">Segments</span>
        <span className="text-right tabular-nums">{s.segmentCount}</span>
      </div>

      <p className="mt-1 text-[11px] text-muted-foreground">
        Curve radius and speed come straight from the game; a red radius means it's tighter than
        the 29 m minimum.
      </p>
    </div>
  );
}
