/**
 * chirpRingBuffer.test.ts — micro sanity test for the chirpBuf ring buffer
 * (Task 7b). Guards the FIFO semantics of chirpBufPush/At/Clear/TrimToLast
 * against off-by-one errors at wrap — the correlation code depends on
 * chirpBufAt(idx) returning the same values `chirpBuf[idx]` (plain-array
 * push/shift) used to, for idx in [0, chirpBufLen()).
 */
import { describe, it, expect } from 'vitest';
import { RxEngine } from '../protocol/rxEngine';

// Access the private ring-buffer methods/fields directly — this is a
// white-box test of the internal FIFO, not the public RxEngine API.
type RingInternals = {
  chirpBufData: Float32Array;
  chirpBufPush(sample: number): void;
  chirpBufAt(idx: number): number;
  chirpBufLen(): number;
  chirpBufClear(): void;
  chirpBufTrimToLast(n: number): void;
};

function makeRing(cap: number): RingInternals {
  const rx = new RxEngine({ useOFDM: true, sampleRate: 48000, pilotFreqHz: 1900, toneCount: 4 }) as unknown as RingInternals;
  // Force a small, known capacity so wrap-around is easy to test.
  rx.chirpBufData = new Float32Array(cap);
  rx.chirpBufClear();
  return rx;
}

describe('chirpBuf ring buffer', () => {
  it('behaves like plain push/shift-when-over-cap for a partial fill', () => {
    const ring = makeRing(5);
    // Reference: plain array with push + shift-when-over-cap.
    const ref: number[] = [];
    for (let i = 0; i < 3; i++) {
      ring.chirpBufPush(i);
      ref.push(i);
      if (ref.length > 5) ref.shift();
    }
    expect(ring.chirpBufLen()).toBe(ref.length);
    for (let i = 0; i < ref.length; i++) expect(ring.chirpBufAt(i)).toBe(ref[i]);
  });

  it('drops the oldest sample once capacity is exceeded (wrap-around)', () => {
    const cap = 5;
    const ring = makeRing(cap);
    const ref: number[] = [];
    for (let i = 0; i < 13; i++) {
      ring.chirpBufPush(i);
      ref.push(i);
      if (ref.length > cap) ref.shift();
    }
    expect(ring.chirpBufLen()).toBe(cap);
    expect(ref.length).toBe(cap);
    for (let i = 0; i < cap; i++) expect(ring.chirpBufAt(i)).toBe(ref[i]);
    // Oldest visible element should be 13-cap, newest should be 12.
    expect(ring.chirpBufAt(0)).toBe(13 - cap);
    expect(ring.chirpBufAt(cap - 1)).toBe(12);
  });

  it('trimToLast keeps exactly the most recent n elements (slice(-n) equivalent)', () => {
    const cap = 8;
    const ring = makeRing(cap);
    for (let i = 0; i < 8; i++) ring.chirpBufPush(i); // buffer full: 0..7
    ring.chirpBufTrimToLast(3);
    expect(ring.chirpBufLen()).toBe(3);
    expect(ring.chirpBufAt(0)).toBe(5);
    expect(ring.chirpBufAt(1)).toBe(6);
    expect(ring.chirpBufAt(2)).toBe(7);
  });

  it('trimToLast is a no-op when n exceeds the current length', () => {
    const ring = makeRing(8);
    ring.chirpBufPush(1);
    ring.chirpBufPush(2);
    ring.chirpBufTrimToLast(100);
    expect(ring.chirpBufLen()).toBe(2);
    expect(ring.chirpBufAt(0)).toBe(1);
    expect(ring.chirpBufAt(1)).toBe(2);
  });

  it('clear() resets length to 0 and a subsequent push starts fresh', () => {
    const ring = makeRing(4);
    ring.chirpBufPush(9);
    ring.chirpBufPush(9);
    ring.chirpBufClear();
    expect(ring.chirpBufLen()).toBe(0);
    ring.chirpBufPush(42);
    expect(ring.chirpBufLen()).toBe(1);
    expect(ring.chirpBufAt(0)).toBe(42);
  });

  it('survives repeated wrap cycles (push far beyond capacity)', () => {
    const cap = 6;
    const ring = makeRing(cap);
    const ref: number[] = [];
    for (let i = 0; i < 1000; i++) {
      ring.chirpBufPush(i);
      ref.push(i);
      if (ref.length > cap) ref.shift();
    }
    expect(ring.chirpBufLen()).toBe(cap);
    for (let i = 0; i < cap; i++) expect(ring.chirpBufAt(i)).toBe(ref[i]);
  });
});
