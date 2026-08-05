import { describe, expect, it } from 'vitest';
import {
  buildProbeBurst, decodeProbeId, measureProbeSweep,
  probeChirpTemplate, crc4, reportGridFreqs, REPORT_GRID,
  PROBE_LAYOUT, PROBE_PURPOSE,
} from '../protocol/probeBurst';
import { chirpCorrelate } from '../protocol/chirp';

const SR = 48000;

function findAnchor(burst: Float32Array): number {
  return chirpCorrelate(burst, probeChirpTemplate(SR)).peakIndex;
}

describe('probe burst', () => {
  it('round-trips the device ID and a joining purpose', () => {
    const burst = buildProbeBurst(0xa7, SR, PROBE_PURPOSE.joining);
    expect(decodeProbeId(burst, findAnchor(burst), SR)).toEqual({
      deviceId: 0xa7,
      purpose: PROBE_PURPOSE.joining,
    });
  });

  it('round-trips a roll-call purpose', () => {
    const burst = buildProbeBurst(0xa7, SR, PROBE_PURPOSE.rollCall);
    expect(decodeProbeId(burst, findAnchor(burst), SR)).toEqual({
      deviceId: 0xa7,
      purpose: PROBE_PURPOSE.rollCall,
    });
  });

  it('defaults to a joining purpose', () => {
    const burst = buildProbeBurst(12, SR);
    expect(decodeProbeId(burst, findAnchor(burst), SR)?.purpose).toBe(PROBE_PURPOSE.joining);
  });

  it('round-trips the id/purpose extremes', () => {
    // The pulse threshold is a largest-gap split over the slot magnitudes, so
    // it has to hold for every on/off ratio the 13-bit word can produce.
    // These ids cover the extremes: all-zero and all-one id bits, and the
    // single-bit-set and single-bit-clear cases either side of them.
    //
    // Anchor is computed, not correlated: findAnchor runs an O(burst x
    // template) correlation — roughly 1.3 billion multiplies for a ~3.7 s
    // burst — which is fine once but not once per case. The chirp starts after
    // the fixed 100 ms lead-in (LEAD_IN_MS in probeBurst.ts), and the
    // correlation path is already covered by the round-trip tests above.
    const ANCHOR = Math.round(0.1 * SR);
    for (const purpose of [PROBE_PURPOSE.joining, PROBE_PURPOSE.rollCall] as const) {
      for (const id of [1, 2, 0x55, 0xaa, 0x7f, 0x80, 0xfe, 0xff]) {
        const burst = buildProbeBurst(id, SR, purpose);
        expect(decodeProbeId(burst, ANCHOR, SR)).toEqual({ deviceId: id, purpose });
      }
    }
  });

  it('decodes the ID under additive noise', () => {
    const burst = buildProbeBurst(42, SR, PROBE_PURPOSE.rollCall);
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const noisy = burst.map((s) => s + (rnd() - 0.5) * 0.05);
    expect(decodeProbeId(noisy, findAnchor(noisy), SR)).toEqual({
      deviceId: 42,
      purpose: PROBE_PURPOSE.rollCall,
    });
  });

  it('rejects a corrupted ID trailer via CRC', () => {
    const burst = buildProbeBurst(42, SR);
    const anchor = findAnchor(burst);
    // Zero out one ID slot → bit flips → CRC mismatch. Pick the
    // highest-magnitude slot programmatically, rather than hardcoding an
    // index, and assert it is actually a pulse before corrupting it — a
    // hardcoded slot index is exactly how this test silently became a
    // no-op the first time the packing changed: slot 0 (the CRC's own
    // LSB) happened to already be silent for id 42's default-purpose word,
    // so zeroing it did nothing and the test passed for the wrong reason.
    // Asserting the precondition means a future repacking fails loudly
    // instead of quietly passing again.
    const slotSamples = Math.round(PROBE_LAYOUT.idSlotMs / 1000 * SR);
    const slotsStart = burst.length - PROBE_LAYOUT.idSlots * slotSamples;
    let loudestSlot = 0;
    let loudestMag = -1;
    for (let k = 0; k < PROBE_LAYOUT.idSlots; k++) {
      const s = slotsStart + k * slotSamples;
      let mag = 0;
      for (let i = s; i < s + slotSamples; i++) mag = Math.max(mag, Math.abs(burst[i]));
      if (mag > loudestMag) { loudestMag = mag; loudestSlot = k; }
    }
    expect(loudestMag).toBeGreaterThan(0); // precondition: a pulse slot exists to corrupt
    const targetStart = slotsStart + loudestSlot * slotSamples;
    for (let i = targetStart; i < targetStart + slotSamples; i++) burst[i] = 0;
    expect(decodeProbeId(burst, anchor, SR)).toBeNull();
  });

  it('a flipped purpose bit fails CRC rather than sending the wrong reply type', () => {
    // The purpose bit decides WELCOME vs REPORT. A silent flip would make a
    // joining device receive a REPORT and never learn the room is occupied,
    // so the CRC must cover it.
    const burst = buildProbeBurst(42, SR, PROBE_PURPOSE.joining);
    const anchor = findAnchor(burst);
    const slotSamples = Math.round(PROBE_LAYOUT.idSlotMs / 1000 * SR);
    const slotsStart = burst.length - PROBE_LAYOUT.idSlots * slotSamples;
    // Slot 4 is the purpose bit: the word is (deviceId << 1) | purpose,
    // shifted left 4 for the CRC, so purpose lands at packed bit 4.
    const flipStart = slotsStart + 4 * slotSamples;
    const ref = buildProbeBurst(42, SR, PROBE_PURPOSE.rollCall);
    for (let i = 0; i < slotSamples; i++) {
      burst[flipStart + i] = ref[flipStart + i];
    }
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
