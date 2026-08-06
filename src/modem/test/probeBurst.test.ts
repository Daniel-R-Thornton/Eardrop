import { describe, expect, it } from 'vitest';
import {
  buildProbeBurst, decodeProbeId, measureProbeSweep,
  probeChirpTemplate, crc4, reportGridFreqs, REPORT_GRID,
  PROBE_LAYOUT, PROBE_PURPOSE, buildProbeMultitone, multitoneFreqs,
} from '../protocol/probeBurst';
import { chirpCorrelate } from '../protocol/chirp';
import { handshakeToneHz } from '../chatter/handshakeGains';
import { OFDM_HANDSHAKE } from '../types';

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

/**
 * The probe's channel measurement: a multitone burst, not a stepped sweep.
 *
 * A stepped sweep measures one frequency at a time, so its duration is
 * (points x step time) — 64 x 45 ms = 2.9 s, which was 78% of the whole probe
 * burst. A multitone measures every frequency AT ONCE: all tones are integer
 * multiples of the grid spacing, so one analysis window of 1/spacing seconds
 * separates them exactly, and repeating that window buys coherent processing
 * gain instead of buying more frequencies.
 *
 * This matters beyond probe length. The reply to a roll call is transmitted
 * into the decaying reverb of the prober's own burst, and hardware logs show
 * exactly that reply handing off at 0.68-0.83 where a message arriving into a
 * quiet room scores 0.93-0.97. Less energy pumped into the room means less
 * tail sitting on top of the REPORT.
 */
describe('probe multitone', () => {
  it('measures every handshake tone directly, not by interpolation', () => {
    // The 100 Hz REPORT_GRID could only ever measure every OTHER control tone
    // (they sit 50 Hz apart), so a notch on an odd tone was invisible — the
    // limitation recorded in handshakeToneMags. The multitone grid is 50 Hz,
    // so every control tone lands on a measured frequency.
    const freqs = multitoneFreqs();
    for (let t = 0; t < OFDM_HANDSHAKE.toneCount; t++) {
      expect(freqs).toContain(handshakeToneHz(t));
    }
  });

  it('keeps its crest factor low enough to drive the output stage hard', () => {
    // The whole point of Schroeder phasing. In phase, N tones stack to a crest
    // of ~sqrt(N) or worse and the burst has to be attenuated to fit, which is
    // how the OLD sweep ended up at -28 dBFS. This codebase already has the
    // scars: CHATTER_SWEEP's amplitude doc records a sustained tone
    // compressing by 14 dB at 0.25.
    const tone = buildProbeMultitone(SR);
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < tone.length; i++) {
      peak = Math.max(peak, Math.abs(tone[i]));
      sumSq += tone[i] * tone[i];
    }
    const crest = peak / Math.sqrt(sumSq / tone.length);
    expect(crest).toBeLessThan(3); // a coherent 126-tone sum would be ~11
  });

  it('cuts the probe burst to about a second', () => {
    const burst = buildProbeBurst(1, SR);
    const seconds = burst.length / SR;
    expect(seconds).toBeLessThan(1.3); // was 3.84
  });

  it('recovers a notched channel on the report grid', () => {
    // The measurement has to survive the thing it exists to find. Apply a
    // one-bin null and check the grid actually reports it — a measurement that
    // smears a notch into its neighbours is what makes a band pick land on a
    // dead spot.
    const burst = buildProbeBurst(1, SR);
    const anchor = findAnchor(burst);
    const notchHz = 3500;

    const flat = measureProbeSweep(burst, anchor, SR)!;
    const notched = measureProbeSweep(notchAt(burst, notchHz), anchor, SR)!;

    const idx = reportGridFreqs().indexOf(notchHz);
    expect(idx).toBeGreaterThanOrEqual(0);
    // Deep at the notch...
    expect(notched[idx] / flat[idx]).toBeLessThan(0.4);
    // ...and largely intact clear of it. 500 Hz, not 200: a Q=8 notch at
    // 3500 Hz is ~437 Hz wide, so 200 Hz off is still inside its own skirt
    // (the filter's analytic response there is 0.67 — measuring 0.67 means the
    // measurement is right and a tighter assertion would have been testing the
    // biquad, not the probe). At 500 Hz the filter is back to ~0.91.
    expect(notched[idx + 5] / flat[idx + 5]).toBeGreaterThan(0.8);
  });

  it('returns null on silence rather than inventing a curve', () => {
    expect(measureProbeSweep(new Float32Array(SR), 0, SR)).toBeNull();
  });
});

/** Narrow notch at `hz`, applied as an RBJ notch biquad — a stand-in for the
 *  room/speaker null the probe exists to find. */
function notchAt(x: Float32Array, hz: number): Float32Array {
  const w0 = (2 * Math.PI * hz) / SR;
  const alpha = Math.sin(w0) / (2 * 8); // Q = 8
  const cw = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = 1 / a0, b1 = (-2 * cw) / a0, b2 = 1 / a0;
  const a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const out = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = out; y[i] = out;
  }
  return y;
}
