/**
 * whiten.test.ts — the whitener must be exactly reversible, must actually
 * whiten, and must leave the sentinel alone.
 *
 * The properties matter more than usual because a whitener that is subtly wrong
 * fails in a way that looks like a channel problem: frames pass the sentinel
 * check, then fail BCH/RS, which is indistinguishable from noise.
 */
import { describe, it, expect } from 'vitest';
import { whitenInPlace, whitenFrameBody, fillerByte } from '../protocol/whiten';
import { SENTINEL_SIZE, SENTINEL_BYTES, FRAME_SIZE } from '../protocol/atomicFrame';

function bytes(n: number, fill: (i: number) => number): Uint8Array {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = fill(i);
  return a;
}

describe('whitening: reversibility', () => {
  it('is self-inverse', () => {
    const original = bytes(235, (i) => (i * 7 + 3) & 0xff);
    const work = new Uint8Array(original);
    whitenInPlace(work);
    expect(Array.from(work)).not.toEqual(Array.from(original));
    whitenInPlace(work);
    expect(Array.from(work)).toEqual(Array.from(original));
  });

  it('is self-inverse for all-zero input, which is the case that matters', () => {
    // Zero padding in a short frame is the pathological input: it is what makes
    // every tone carry the same constellation point.
    const work = new Uint8Array(200);
    whitenInPlace(work);
    whitenInPlace(work);
    expect(Array.from(work)).toEqual(Array.from(new Uint8Array(200)));
  });

  it('respects the offset, so a sub-range round-trips at its real position', () => {
    // Whitening a slice with the wrong offset produces garbage that still
    // passes the sentinel check — exactly the failure this guards.
    const original = bytes(64, (i) => i);
    const work = new Uint8Array(original);
    whitenInPlace(work, 17);
    whitenInPlace(work, 17);
    expect(Array.from(work)).toEqual(Array.from(original));

    const wrong = new Uint8Array(original);
    whitenInPlace(wrong, 17);
    whitenInPlace(wrong, 18);
    expect(Array.from(wrong)).not.toEqual(Array.from(original));
  });
});

describe('whitening: statistics', () => {
  it('turns an all-zero run into varied bytes', () => {
    // The point of the exercise: no long runs of one value.
    const work = new Uint8Array(200);
    whitenInPlace(work);
    const distinct = new Set(work);
    expect(distinct.size).toBeGreaterThan(50);
  });

  it('leaves no long run of identical bytes', () => {
    // A run of identical bytes is a run of identical SYMBOLS, which is what
    // produces a coherent peak and a biased power estimate.
    const work = new Uint8Array(FRAME_SIZE);
    whitenInPlace(work);
    let longest = 1;
    let current = 1;
    for (let i = 1; i < work.length; i++) {
      current = work[i] === work[i - 1] ? current + 1 : 1;
      if (current > longest) longest = current;
    }
    expect(longest).toBeLessThan(4);
  });

  it('spreads bit values close to even', () => {
    // Uniform symbol distribution is what makes E[|point|^2] == 1 hold, which
    // is what the blind gain estimator relies on.
    const work = new Uint8Array(400);
    whitenInPlace(work);
    let ones = 0;
    for (const b of work) {
      for (let bit = 0; bit < 8; bit++) if ((b >> bit) & 1) ones++;
    }
    const fraction = ones / (work.length * 8);
    expect(fraction).toBeGreaterThan(0.4);
    expect(fraction).toBeLessThan(0.6);
  });

  it('does not whiten every byte to the same value', () => {
    // Guards a specific implementation slip: if the keystream were not indexed
    // by position, uniform input would stay uniform and every symptom would
    // remain while the tests above (run on varied input) still passed.
    const work = new Uint8Array(64);
    whitenInPlace(work);
    expect(new Set(work).size).toBeGreaterThan(20);
  });
});

describe('post-frame filler', () => {
  it('never synthesizes a sentinel inside the filler itself', () => {
    // Filler occupies the tone slots past a frame's end, and those bytes still
    // pass through the receiver's sentinel search before being discarded. A
    // sentinel WITHIN the filler would be systematic — same keystream, same
    // offsets, every transmission — so it is excluded outright here.
    //
    // A sentinel STRADDLING the boundary (one or two real frame bytes plus
    // filler) is not excludable: it depends on the frame's own last bytes, which
    // are whitened and effectively random. Those odds are ~2^-16 per frame, the
    // same as a false sentinel arising in the inter-frame noise the scanner
    // already runs over, and the consequence is identical — a decode attempt
    // that fails BCH/RS and is dropped.
    const filler: number[] = [];
    for (let offset = 0; offset < 1024; offset++) filler.push(fillerByte(offset));
    for (let i = 0; i + SENTINEL_SIZE <= filler.length; i++) {
      const window = filler.slice(i, i + SENTINEL_SIZE);
      expect(window).not.toEqual(Array.from(SENTINEL_BYTES));
    }
  });

  it('is position-indexed, so both ends can regenerate it', () => {
    expect(fillerByte(7)).toBe(fillerByte(7));
    expect(fillerByte(7)).not.toBe(fillerByte(8));
  });

  it('varies enough to break symbol coherence', () => {
    // The reason it exists: zero fill put every padded tone on the same
    // constellation point. Any filler with long runs would do the same.
    const run: number[] = [];
    for (let offset = 0; offset < 64; offset++) run.push(fillerByte(offset));
    expect(new Set(run).size).toBeGreaterThan(20);
    let longest = 1;
    let current = 1;
    for (let i = 1; i < run.length; i++) {
      current = run[i] === run[i - 1] ? current + 1 : 1;
      if (current > longest) longest = current;
    }
    expect(longest).toBeLessThan(4);
  });
});

describe('whitening: frame body', () => {
  it('leaves the sentinel in the clear', () => {
    // The receiver finds frames by searching raw bytes for the sentinel, before
    // it can de-whiten anything, so the sentinel can never be whitened.
    const frame = new Uint8Array(FRAME_SIZE);
    frame.set(SENTINEL_BYTES, 0);
    whitenFrameBody(frame, SENTINEL_SIZE);
    for (let i = 0; i < SENTINEL_SIZE; i++) {
      expect(frame[i]).toBe(SENTINEL_BYTES[i]);
    }
  });

  it('round-trips the body', () => {
    const frame = bytes(FRAME_SIZE, (i) => (i * 13) & 0xff);
    frame.set(SENTINEL_BYTES, 0);
    const original = new Uint8Array(frame);
    whitenFrameBody(frame, SENTINEL_SIZE);
    expect(Array.from(frame)).not.toEqual(Array.from(original));
    whitenFrameBody(frame, SENTINEL_SIZE);
    expect(Array.from(frame)).toEqual(Array.from(original));
  });

  it('is a no-op on a frame that is all sentinel or shorter', () => {
    const tiny = new Uint8Array(SENTINEL_SIZE);
    tiny.set(SENTINEL_BYTES, 0);
    const copy = new Uint8Array(tiny);
    whitenFrameBody(tiny, SENTINEL_SIZE);
    expect(Array.from(tiny)).toEqual(Array.from(copy));
  });
});
