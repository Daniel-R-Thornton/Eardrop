/**
 * useAudioStream.ts — React hook for a rolling audio sample buffer.
 *
 * Maintains a ring buffer of recent audio samples for FFT/spectrum display.
 * Components subscribe to the buffer via this hook.
 */

import { useState, useRef, useCallback } from 'react';

interface AudioStreamState {
  samples: Float32Array;
  pushSample: (s: number) => void;
  pushBuffer: (buf: Float32Array) => void;
  clear: () => void;
}

/**
 * Hook that maintains a rolling buffer of audio samples.
 * Triggers re-render via a counter state update (not on every sample).
 */
export function useAudioStream(maxLen = 4096): AudioStreamState {
  const bufRef = useRef<Float32Array>(new Float32Array(maxLen));
  const writePosRef = useRef(0);
  const filledRef = useRef(false);
  // Use a counter to trigger re-renders (incremented on pushBuffer)
  const [, setTick] = useState(0);
  const tickRef = useRef(0);

  const pushSample = useCallback((s: number) => {
    const buf = bufRef.current;
    const pos = writePosRef.current;
    buf[pos] = s;
    writePosRef.current = (pos + 1) % maxLen;
    if (writePosRef.current === 0) filledRef.current = true;
    // Throttle re-renders: only trigger every 128 samples
    if (pos % 128 === 0) {
      tickRef.current++;
      setTick(tickRef.current);
    }
  }, [maxLen]);

  const pushBuffer = useCallback((buf: Float32Array) => {
    for (let i = 0; i < buf.length; i++) {
      const s = buf[i];
      const pos = writePosRef.current;
      bufRef.current[pos] = s;
      writePosRef.current = (pos + 1) % maxLen;
      if (writePosRef.current === 0) filledRef.current = true;
    }
    tickRef.current++;
    setTick(tickRef.current);
  }, [maxLen]);

  const clear = useCallback(() => {
    bufRef.current = new Float32Array(maxLen);
    writePosRef.current = 0;
    filledRef.current = false;
    tickRef.current++;
    setTick(tickRef.current);
  }, [maxLen]);

  // Build a contiguous view of the buffer
  const samples = (() => {
    const buf = bufRef.current;
    const wp = writePosRef.current;
    if (!filledRef.current) {
      return buf.slice(0, wp);
    }
    // Ring buffer is full: return in chronological order
    const out = new Float32Array(maxLen);
    out.set(buf.slice(wp));  // oldest samples first
    out.set(buf.slice(0, wp), maxLen - wp);  // newest samples last
    return out;
  })();

  return { samples, pushSample, pushBuffer, clear };
}
