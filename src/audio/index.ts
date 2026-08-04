/**
 * src/audio/index.ts — Barrel export for audio layer.
 */
export { AudioPlayer } from './player';
export { AudioRecorder } from './recorder';
export {
  enumerateDevices,
  DEVICES_CHANGED_EVENT,
  populateSelect,
  resolveInputDevice,
  labelForInputDevice,
} from './devices';
export type { DeviceInfo, DeviceList } from './devices';
export type { ChunkCallback } from './recorder';
