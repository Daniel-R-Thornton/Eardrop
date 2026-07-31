/**
 * autoCalibrate.test.ts — the calibration ORCHESTRATION, separated from audio
 * I/O so it can run headless (auto-calibrate on send) and be tested with fake
 * measurement functions.
 *
 * The loop under test: baseline grid → sweep seed → N grid refinement rounds
 * → verification measure with the final gains. Storage and chart display are
 * the callers' business.
 */
import { describe, expect, it } from 'vitest';
import { calibrateGainsCore } from '../../ui/controllers/calibration';

/** A fake channel with a fixed per-tone response; measurements apply gains. */
function fakeChannel(responseDb: number[]) {
  const lin = responseDb.map((db) => Math.pow(10, db / 20));
  return {
    measureGrid: async (gains: number[]): Promise<number[] | null> =>
      lin.map((h, i) => h * gains[i]),
    measureSweepAtTones: async (): Promise<number[] | null> => lin.slice(),
  };
}

describe('calibrateGainsCore', () => {
  const tilted = [0, -2, -4, -6, -8, -10, -12, -14]; // smooth 14 dB tilt

  it('flattens a tilted channel and reports before/after spread', async () => {
    const ch = fakeChannel(tilted);
    const result = await calibrateGainsCore({
      toneCount: 8,
      gridRounds: 2,
      measureGrid: ch.measureGrid,
      measureSweepAtTones: ch.measureSweepAtTones,
    });
    expect(result.failed).toBeUndefined();
    if (result.failed) return;
    expect(result.beforeSpread).toBeGreaterThan(10);
    expect(result.afterSpread).toBeLessThan(3);
    expect(result.gains).toHaveLength(8);
  });

  it('reports failure when the baseline measurement hears nothing', async () => {
    const result = await calibrateGainsCore({
      toneCount: 8,
      gridRounds: 2,
      measureGrid: async () => null,
      measureSweepAtTones: async () => null,
    });
    expect(result.failed).toBe('baseline');
  });

  it('continues without the sweep seed when the sweep fails', async () => {
    const ch = fakeChannel(tilted);
    const result = await calibrateGainsCore({
      toneCount: 8,
      gridRounds: 3,
      measureGrid: ch.measureGrid,
      measureSweepAtTones: async () => null,
    });
    expect(result.failed).toBeUndefined();
    if (result.failed) return;
    expect(result.afterSpread).toBeLessThan(result.beforeSpread);
  });
});
