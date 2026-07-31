/**
 * bestBand.test.ts — findBestBand picks the flattest window of the sweep wide
 * enough for the currently selected tone grid.
 *
 * Motivation: the operator reads the single-tone sweep to decide where to
 * drag TONE START. "Where is the flattest stretch wide enough for N tones"
 * is exactly computable, so the chart should mark it rather than making the
 * operator eyeball it.
 */
import { describe, it, expect } from 'vitest';
import { findBestBand } from '../diag/channelSweep';

describe('findBestBand', () => {
  // 1000-9000 Hz in 50 Hz steps, flat at -10 dB except a tilted low end and
  // a notch region up high.
  const freqs: number[] = [];
  const db: number[] = [];
  for (let f = 1000; f <= 9000; f += 50) {
    freqs.push(f);
    let v = -10;
    if (f < 3000) v = -10 - (3000 - f) / 100; // rising tilt below 3 kHz
    if (f >= 7000 && f < 7500) v = -35;       // notch at 7.0-7.5 kHz
    db.push(v);
  }

  it('finds a flat window avoiding the tilt and the notch', () => {
    const band = findBestBand(freqs, db, 1550); // 32 tones at 50 Hz
    expect(band).not.toBeNull();
    expect(band!.startHz).toBeGreaterThanOrEqual(3000);
    // window must not overlap the notch
    expect(band!.endHz).toBeLessThan(7000);
    expect(band!.spreadDb).toBeLessThan(1);
  });

  it('band width matches the request', () => {
    const band = findBestBand(freqs, db, 1550)!;
    expect(band.endHz - band.startHz).toBeCloseTo(1550, 0);
  });

  it('returns null when the sweep is narrower than the requested band', () => {
    expect(findBestBand([1000, 1050, 1100], [-10, -10, -10], 1550)).toBeNull();
  });

  it('prefers the louder of two equally flat windows', () => {
    const f2: number[] = [];
    const d2: number[] = [];
    for (let f = 1000; f <= 5000; f += 50) {
      f2.push(f);
      d2.push(f < 3000 ? -20 : -8); // both halves dead flat, right half louder
    }
    const band = findBestBand(f2, d2, 500)!;
    expect(band.startHz).toBeGreaterThanOrEqual(3000);
  });
});
