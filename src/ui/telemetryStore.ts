/**
 * telemetryStore — high-rate display data (20 Hz), OUTSIDE the app Store:
 * no localStorage writes, no persistence, plain useSyncExternalStore.
 */
import { useSyncExternalStore } from 'react';
import type { ModemTelemetry } from '../workers/modemSchema';

let current: ModemTelemetry | null = null;
const listeners = new Set<() => void>();

export function setTelemetry(t: ModemTelemetry): void {
  current = t;
  listeners.forEach((fn) => fn());
}

export function getTelemetry(): ModemTelemetry | null {
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTelemetry<T>(selector: (t: ModemTelemetry | null) => T): T {
  return useSyncExternalStore(subscribe, () => selector(current), () => selector(null));
}
