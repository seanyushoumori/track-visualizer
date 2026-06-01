# Track Visualizer

A build-assist mod for **Subway Builder**. It overlays the geometry you can't easily eyeball while laying track — segment length, curve radius, curve-limited speed, and elevation — and keeps a height label on every node of your route.

## What it does

- **Live readout while drawing.** A tooltip follows your cursor showing the in-progress track's **length**, **minimum curve radius** (red if tighter than the game's minimum turn radius), **max speed**, and **elevation** — all from the game's own values.
- **Metric & imperial.** A **Units: m / ft** toggle in the panel. It auto-matches the game's own units setting on load (metric — m / km / km/h — by default, or imperial — ft / mi / mph), and you can flip it anytime. (The game doesn't expose its *live* units toggle to mods, so the auto-match runs on load/reload; flip the toggle for an in-session switch.)
- **Per-node height labels.** Every node of the route you're laying is labelled with its set elevation, on the map, and stays put as you keep building. Coincident nodes (parallel rails, station ends) collapse to a single label.
- **Built-track heights (toggle).** Optionally label the node heights of your already-constructed tracks too — handy for matching elevations when extending the network.
- **Panel.** A small floating panel with the live stats and toggles for the on-map labels.

## Usage

1. Enable **Track Visualizer** in **Settings → Mods** (restart if it doesn't appear).
2. Open the **Track Visualizer** panel (ruler icon).
3. Start building track — the tooltip and node heights appear automatically. Use the panel toggles to show/hide node heights and built-track heights.

## Install (from source)

Requires **Node 20+** and **pnpm**.

```bash
pnpm install
pnpm build        # outputs dist/index.js
pnpm dev:link     # symlinks dist/ into the game's mods folder
pnpm dev          # watch + launch the game with logging
```

Mods folder: `~/Library/Application Support/metro-maker4/mods/` (macOS),
`%APPDATA%\metro-maker4\mods\` (Windows), `~/.config/metro-maker4/mods/` (Linux).

## Notes

- Targets Modding API v1.0.0.
- Read-only: it visualizes the game's data and never modifies your network.
