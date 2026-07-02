/**
 * useDecoderState.ts — React hook that subscribes to decoder state updates
 * from the broadcast worker via a shared event emitter or callback.
 *
 * For now, this provides a simple interface that the app.ts can feed
 * data into. In the future it will subscribe to a shared state bus.
 */

import { useEffect, useState } from 'react';

export interface DecoderStateSnapshot {
  inFrame: boolean;
  bitsCollected: number;
  consecutiveSync: number;
  pilotFreq: number;
  pilotAmplitude: number;
  signalToNoise: number;
  noiseFloor: [number, number, number, number];
  energies: [number, number, number, number];
  relI: [number, number, number, number];
  relQ: [number, number, number, number];
  blocksDecoded: number;
  blocksCrcFailed: number;
}

const defaultState: DecoderStateSnapshot = {
  inFrame: false,
  bitsCollected: 0,
  consecutiveSync: 0,
  pilotFreq: 0,
  pilotAmplitude: 0,
  signalToNoise: 0,
  noiseFloor: [0, 0, 0, 0],
  energies: [0, 0, 0, 0],
  relI: [0, 0, 0, 0],
  relQ: [0, 0, 0, 0],
  blocksDecoded: 0,
  blocksCrcFailed: 0,
};

export function useDecoderState(): DecoderStateSnapshot {
  const [state, setState] = useState<DecoderStateSnapshot>(defaultState);

  useEffect(() => {
    // In the future, subscribe to a shared event bus.
    // For now, the app.ts will call setDecoderState() which
    // will be wired to a global event.
    const handler = (e: CustomEvent) => {
      if (e.detail && e.detail.type === 'decoderState') {
        setState(e.detail.snapshot);
      }
    };
    window.addEventListener('eardrop-decoder-state' as any, handler as any);
    return () => {
      window.removeEventListener('eardrop-decoder-state' as any, handler as any);
    };
  }, []);

  return state;
}
