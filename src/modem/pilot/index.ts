/**
 * src/modem/pilot/index.ts
 * Barrel export for pilot discovery and tracking components.
 * Re-exports everything from the existing pilot.ts + PilotTracker.
 */
export { PilotScanner, PilotPLL, toneIQ, getDataToneFreqs } from '../pilot';
export type { PilotDiscovery, PilotScannerConfig, PLLConfig } from '../pilot';

export { PilotTracker } from './PilotTracker';
export type { PilotTrackerConfig } from './PilotTracker';
