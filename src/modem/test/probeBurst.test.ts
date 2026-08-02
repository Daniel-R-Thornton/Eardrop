import { describe, expect, it } from 'vitest';
import {
  buildProbeBurst, decodeProbeId, measureProbeSweep,
  probeChirpTemplate, crc4, reportGridFreqs, REPORT_GRID,
} from '../protocol/probeBurst';
import { chirpCorrelate } from '../protocol/chirp';

const SR = 48000;

function findAnchor(burst: Float32Array): number {
  return chirpCorrelate(burst, probeChirpTemplate(SR)).peakIndex;
}

describe('probe burst', () => {
  it('round-trips the device ID', () => {
    const burst = buildProbeBurst(0xa7, SR);
    expect(decodeProbeId(burst, findAnchor(burst), SR)).toBe(0xa7);
  });

  it('decodes the ID under additive noise', () => {
    const burst = buildProbeBurst(42, SR);
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const noisy = burst.map((s) => s + (rnd() - 0.5) * 0.05);
    expect(decodeProbeId(noisy, findAnchor(noisy), SR)).toBe(42);
  });

  it('rejects a corrupted ID trailer via CRC', () => {
    const burst = buildProbeBurst(42, SR);
    const anchor = findAnchor(burst);
    // Zero out one ID slot → bit flips → CRC mismatch.
    const layoutEnd = burst.length;
    const slot0Start = layoutEnd - 12 * Math.round(0.04 * SR);
    for (let i = slot0Start; i < slot0Start + Math.round(0.04 * SR); i++) burst[i] = 0;
    expect(decodeProbeId(burst, anchor, SR)).toBeNull();
  });

  it('measures a flat channel as a flat report grid', () => {
    const burst = buildProbeBurst(1, SR);
    const grid = measureProbeSweep(burst, findAnchor(burst), SR)!;
    expect(grid).toHaveLength(REPORT_GRID.points);
    const max = Math.max(...grid), min = Math.min(...grid.filter((m) => m > 0));
    expect(max / min).toBeLessThan(3); // loopback ⇒ roughly flat
  });

  it('grid freqs span 1500-7800 at 100 Hz', () => {
    const f = reportGridFreqs();
    expect(f[0]).toBe(1500);
    expect(f[63]).toBe(7800);
  });

  it('crc4 detects single-bit id errors', () => {
    for (let bit = 0; bit < 8; bit++) expect(crc4(0x5a ^ (1 << bit))).not.toBe(crc4(0x5a));
  });
});
