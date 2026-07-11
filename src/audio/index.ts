/**
 * src/audio/index.ts — Barrel export for audio layer.
 */
export { AudioPlayer } from './player';
export { AudioRecorder } from './recorder';
export { enumerateDevices, populateSelect } from './devices';
export type { DeviceInfo, DeviceList } from './devices';
export type { ChunkCallback } from './recorder';
