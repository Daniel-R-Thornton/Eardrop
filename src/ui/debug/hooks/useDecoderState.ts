/**
 * useDecoderState.ts — React hook subscribing to decoder state updates.
 *
 * app.ts can import the eventEmitter singleton and push state updates into it.
 * React components use useDecoderState() to get the latest snapshot.
 */

import { useState, useEffect, useCallback } from 'react';

// ─── Event Emitter ──────────────────────────────────

type StateListener = (state: any) => void;

class DecoderStateEmitter {
  private listeners: Set<StateListener> = new Set();
  private latestState: any = null;

  /** Subscribe to state updates. Returns unsubscribe function. */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    // Immediately deliver latest state if available
    if (this.latestState !== null) {
      try { listener(this.latestState); } catch { /* ignore */ }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit a new state snapshot to all subscribers */
  emit(state: any): void {
    this.latestState = state;
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* ignore */ }
    }
  }

  /** Get the latest state without subscribing */
  getLatest(): any {
    return this.latestState;
  }
}

/** Singleton emitter — import this from app.ts to push decoder state */
export const decoderStateEmitter = new DecoderStateEmitter();

// ─── React Hook ─────────────────────────────────────

/**
 * Subscribe to decoder state updates.
 * Returns the latest decoder snapshot (or null if none yet).
 */
export function useDecoderState(): any {
  const [state, setState] = useState<any>(decoderStateEmitter.getLatest());

  useEffect(() => {
    return decoderStateEmitter.subscribe((newState: any) => {
      setState(newState);
    });
  }, []);

  return state;
}

// ─── Convenience: update from broadcast worker message ──

/**
 * Call this from app.ts when you receive a decoderState message from the worker.
 * It extracts the relevant fields and pushes them to all React subscribers.
 */
export function pushDecoderState(msg: {
  bitsCollected?: number;
  hasData?: boolean;
  debugInfo?: any;
  recentLog?: any[];
  rawBytes?: ArrayBuffer;
}): void {
  decoderStateEmitter.emit({
    bitsCollected: msg.bitsCollected ?? 0,
    hasData: msg.hasData ?? false,
    debugInfo: msg.debugInfo ?? null,
    recentLog: msg.recentLog ?? [],
    rawBytes: msg.rawBytes ? new Uint8Array(msg.rawBytes) : null,
    timestamp: performance.now(),
  });
}
