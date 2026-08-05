import { describe, expect, it } from 'vitest';
import { shapeForPlayback } from '../../audio/player';

describe('shapeForPlayback', () => {
  it('normalises so the loudest sample lands at 0.95 after volume', () => {
    // The whole point of the auto-norm: peak * volume * scale === 0.95, so a
    // transmission uses the full output range without clipping.
    const samples = new Float32Array([0.5, -0.25, 0.1]);
    const out = new Float32Array(3);
    const { peak, scale, clips } = shapeForPlayback(samples, out, 2.0, false);

    expect(peak).toBeCloseTo(0.5, 6);
    expect(0.5 * 2.0 * scale).toBeCloseTo(0.95, 6);
    expect(out[0]).toBeCloseTo(0.95, 6);
    expect(out[1]).toBeCloseTo(-0.475, 6);
    expect(clips).toBe(0);
  });

  it('passes samples through untouched when clean', () => {
    // The musical/clean path must not be pre-amplified at all.
    const samples = new Float32Array([0.5, -0.25]);
    const out = new Float32Array(2);
    shapeForPlayback(samples, out, 6.0, true);
    expect(Array.from(out)).toEqual([0.5, -0.25]);
  });

  it('caps the scale at 5x so a near-silent buffer is not blown up', () => {
    const samples = new Float32Array([0.001]);
    const out = new Float32Array(1);
    const { scale } = shapeForPlayback(samples, out, 1.0, false);
    expect(scale).toBe(5.0);
  });

  it('never exceeds 0.95 after volume, at any volume', () => {
    // The clamp branch in shapeForPlayback exists to catch samples that
    // overshoot unity after scaling, but it is unreachable by construction
    // given the current formula:
    //   - if the 5x cap doesn't bind, scale = 0.95/(peak*volume), so
    //     peak*volume*scale = 0.95 exactly;
    //   - if the cap does bind (peak*volume < 0.19), scale = 5.0, so
    //     peak*volume*scale = peak*volume*5 < 0.19*5 = 0.95.
    // Either way the largest-magnitude output sample tops out at 0.95, so
    // clips is always 0. This test proves that invariant holds across the
    // cap boundary (peak*volume = 0.19) rather than exercising a clamp that
    // can never actually fire.
    const peaks = [0.001, 0.01, 0.05, 0.1, 0.19, 0.2, 0.5, 1.0];
    const volumes = [0.01, 0.1, 0.19, 0.2, 1.0, 2.0, 6.0, 100.0];

    for (const peak of peaks) {
      for (const volume of volumes) {
        const samples = new Float32Array([peak, -peak, peak * 0.3]);
        const out = new Float32Array(3);
        const { clips } = shapeForPlayback(samples, out, volume, false);

        for (const sample of out) {
          expect(Math.abs(sample)).toBeLessThanOrEqual(0.95 + 1e-6);
        }
        expect(clips).toBe(0);
      }
    }
  });

  it('survives an all-zero buffer without dividing by zero', () => {
    const samples = new Float32Array([0, 0, 0]);
    const out = new Float32Array(3);
    const { peak, scale, clips } = shapeForPlayback(samples, out, 2.0, false);
    expect(peak).toBe(0);
    expect(scale).toBe(1.0);
    expect(clips).toBe(0);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});
