/**
 * Track Visualizer — live readout panel.
 *
 * Re-renders ~10×/s and reads the in-progress drag preview, showing length,
 * curve radius, curve-limited speed, and elevation (using the game's own
 * per-segment values). The same data also renders on the map via the overlay.
 */

import { useEffect, useState } from 'react';
import { readPreview } from './preview';
import { computeStats, fmtLength, fmtRadius, fmtSpeed, fmtElev, MIN_RADIUS_M, isImperial, setImperial } from './format';
import {
  isHideNodes,
  setHideNodes,
  isShowBuilt,
  setShowBuilt,
  isShowIntersections,
  setShowIntersections,
  requestRender,
} from './overlay';

const api = window.SubwayBuilderAPI;
const { Switch, Label, Button } = api.utils.components as Record<string, React.ComponentType<any>>;

/** A small "?" badge with a native hover tooltip. Rendered inline inside a label
 *  so it flows right after the text (and wraps with it). */
function Help({ text }: { text: string }) {
  return (
    <span
      title={text}
      onClick={(e: { preventDefault: () => void }) => e.preventDefault()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '13px',
        height: '13px',
        borderRadius: '50%',
        border: '1px solid currentColor',
        fontSize: '9px',
        fontWeight: 700,
        lineHeight: 1,
        cursor: 'help',
        opacity: 0.5,
        verticalAlign: 'middle',
        marginLeft: '3px',
        flexShrink: 0,
      }}
    >
      ?
    </span>
  );
}

export function TrackVisualizerPanel() {
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);

  const preview = readPreview();

  const imperial = isImperial();
  const unitBtn = (imp: boolean, label: string) => (
    <Button
      key={label}
      size="sm"
      variant={imperial === imp ? 'default' : 'outline'}
      className="h-6 px-2 text-xs"
      onClick={() => {
        setImperial(imp);
        requestRender();
        rerender();
      }}
    >
      {label}
    </Button>
  );

  const toggles = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label>
          Units
          <Help text="Switch the overlay's labels between metric (m, km, km/h) and imperial (ft, mi, mph). Matches the game's own units setting on load." />
        </Label>
        <div className="flex gap-1">
          {unitBtn(false, 'm')}
          {unitBtn(true, 'ft')}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="tv-nodes">
          Show node heights
          <Help text="Label every node of the route you're drawing (and any placed blueprints) with its set elevation, right on the map." />
        </Label>
        <Switch
          id="tv-nodes"
          checked={!isHideNodes()}
          onCheckedChange={(v: boolean) => {
            setHideNodes(!v);
            rerender();
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="tv-built">
          Show built-track heights
          <Help text="Also label the node elevations of your already-constructed tracks — handy for matching heights when extending the network." />
        </Label>
        <Switch
          id="tv-built"
          checked={isShowBuilt()}
          onCheckedChange={(v: boolean) => {
            setShowBuilt(v);
            rerender();
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="tv-crossings">
          Mark same-height crossings
          <Help text="Drop a circle wherever two tracks cross at the same elevation — a potential at-grade conflict you may want to grade-separate. Junctions where tracks simply meet aren't marked." />
        </Label>
        <Switch
          id="tv-crossings"
          checked={isShowIntersections()}
          onCheckedChange={(v: boolean) => {
            setShowIntersections(v);
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
        the {fmtRadius(MIN_RADIUS_M)} minimum.
      </p>
    </div>
  );
}
