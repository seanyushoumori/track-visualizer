/**
 * Track Visualizer
 * Live on-map readout while you build: segment length, curve radius, speed, and
 * elevation as you draw, plus persistent per-node height labels for the route
 * you're laying and (optionally) your already-built tracks.
 */

import { TrackVisualizerPanel } from './tv/TrackVisualizerPanel';
import { startOverlay } from './tv/overlay';

const MOD_ID = 'track-visualizer';
const MOD_VERSION = '1.2.1';
const TAG = '[TrackVisualizer]';

const api = window.SubwayBuilderAPI;

if (!api) {
  console.error(`${TAG} SubwayBuilderAPI not found!`);
} else {
  console.log(`${TAG} v${MOD_VERSION} | API v${api.version}`);

  let initialized = false;

  api.hooks.onMapReady(async (_map) => {
    if (initialized) return;
    initialized = true;

    try {
      api.ui.addFloatingPanel({
        id: 'track-visualizer-panel',
        title: 'Track Visualizer',
        icon: 'Ruler',
        defaultWidth: 280,
        render: TrackVisualizerPanel,
      });

      startOverlay(api);

      console.log(`${TAG} Initialized successfully.`);
    } catch (err) {
      console.error(`${TAG} Failed to initialize:`, err);
      api.ui.showNotification(`${MOD_ID} failed to load. Check console for details.`, 'error');
    }
  });
}
