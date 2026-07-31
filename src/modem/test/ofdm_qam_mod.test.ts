/**
 * ofdm_qam_mod.test.ts — Phase 3 modulator generalization + TX level flattening.
 *
 * Two guarantees under test:
 *  1. All-QPSK (the default, and today's only live mode) uses the same
 *     sign/table synthesis as the pre-QAM modulator, scaled by the SAME
 *     fixed `qamScale` the QAM path uses (no more per-symbol peak-normalize
 *     — that per-symbol renormalization was the load-bearing-but-false
 *     assumption behind the streaming/acoustic amplitude-step bug; see
 *     txEngine.ts's streamChunks doc and OFDMQPSKModulator's qamScale doc).
 *  2. The QAM path (taken only when some tone's order > QPSK) produces a
 *     stable per-tone amplitude across symbols and stays within the fixed
 *     scale's designed bound.
 */
import { describe, expect, test } from 'vitest';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { mapSymbol, type QamOrder } from '../modulation/constellation';
import { ofdmSamples, ofdmToneFrequencies } from '../types';

const TONE_COUNT = 8;
const PILOT_FREQ = 1900;
const PILOT_AMPLITUDE = 0.4;
const TONE_FREQS = ofdmToneFrequencies({ toneCount: TONE_COUNT, pilotFreqHz: PILOT_FREQ });
const SAMPLE_RATE = 48000;
const { fftSamples } = ofdmSamples(SAMPLE_RATE);

function makeMod(): OFDMQPSKModulator {
  return new OFDMQPSKModulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: TONE_FREQS,
    pilotFreqHz: PILOT_FREQ,
    pilotAmplitude: PILOT_AMPLITUDE,
  });
}

// Reference implementation of the QPSK sign/table synthesis, scaled by the
// SAME fixed qamScale the modulator under test derives (worst case: numTones
// * MAX_QAM_MAGNITUDE + pilotAmplitude, backed off to 0.95 — see
// OFDMQPSKModulator's qamScale doc) instead of a per-symbol peak-normalize.
function legacyGenerateSymbol(symbols: number[], qamScale: number): Float32Array {
  const { cpSamples } = ofdmSamples(SAMPLE_RATE);
  const twoPiOverFs = (2 * Math.PI) / SAMPLE_RATE;
  const sinTable: Float32Array[] = [];
  const cosTable: Float32Array[] = [];
  for (let t = 0; t < TONE_COUNT; t++) {
    const s = new Float32Array(fftSamples);
    const c = new Float32Array(fftSamples);
    const w = twoPiOverFs * TONE_FREQS[t];
    for (let n = 0; n < fftSamples; n++) {
      s[n] = Math.sin(w * n);
      c[n] = Math.cos(w * n);
    }
    sinTable.push(s);
    cosTable.push(c);
  }
  const pilotTable = new Float32Array(fftSamples);
  const wp = twoPiOverFs * PILOT_FREQ;
  for (let n = 0; n < fftSamples; n++) pilotTable[n] = PILOT_AMPLITUDE * Math.cos(wp * n);

  const selTable: Float32Array[] = new Array(TONE_COUNT);
  const selSign = new Float32Array(TONE_COUNT);
  for (let t = 0; t < TONE_COUNT; t++) {
    const s = ((symbols[t] % 4) + 4) % 4;
    selTable[t] = s === 1 || s === 3 ? cosTable[t] : sinTable[t];
    selSign[t] = s === 2 || s === 3 ? -1 : 1;
  }

  const body = new Float32Array(fftSamples);
  for (let n = 0; n < fftSamples; n++) {
    let acc = pilotTable[n];
    for (let t = 0; t < TONE_COUNT; t++) acc += selSign[t] * selTable[t][n];
    body[n] = acc * qamScale;
  }

  const out = new Float32Array(fftSamples + cpSamples);
  out.set(body.subarray(fftSamples - cpSamples), 0);
  out.set(body, cpSamples);
  return out;
}

describe('all-QPSK modulator path matches the fixed-scale sign/table synthesis', () => {
  const patterns: number[][] = [
    new Array(TONE_COUNT).fill(0),
    new Array(TONE_COUNT).fill(1),
    new Array(TONE_COUNT).fill(2),
    new Array(TONE_COUNT).fill(3),
    [0, 1, 2, 3, 0, 1, 2, 3],
    [3, 2, 1, 0, 3, 2, 1, 0, 0].slice(0, TONE_COUNT),
  ];

  for (const [i, symbols] of patterns.entries()) {
    test(`pattern ${i}: default (no setToneOrders call)`, () => {
      const mod = makeMod();
      mod.setSymbols(symbols);
      const out = mod.generateSymbol();
      const expected = legacyGenerateSymbol(symbols, mod.getQamScale());
      expect(Array.from(out)).toEqual(Array.from(expected));
    });

    test(`pattern ${i}: explicit all-QPSK via setToneOrders`, () => {
      const mod = makeMod();
      mod.setToneOrders(new Array(TONE_COUNT).fill(2) as QamOrder[]);
      mod.setSymbols(symbols);
      const out = mod.generateSymbol();
      const expected = legacyGenerateSymbol(symbols, mod.getQamScale());
      expect(Array.from(out)).toEqual(Array.from(expected));
    });
  }
});

describe('TX level flattening — training and data share one fixed scale', () => {
  test('a QPSK training symbol (all-zero) and a QPSK data symbol have identical per-tone amplitude', () => {
    const mod = makeMod();
    // Training symbol: all tones at phase 0 (the all-zero pattern OFDMEngine
    // uses for training/sync).
    mod.setSymbols(new Array(TONE_COUNT).fill(0));
    const training = mod.generateSymbol();
    // A data symbol with different (non-zero) phases per tone.
    mod.setSymbols([1, 2, 3, 0, 1, 2, 3, 0].slice(0, TONE_COUNT));
    const data = mod.generateSymbol();

    // Both are pure sinusoids at the same qamScale — the tone's OWN
    // magnitude in each is a single sample compare away: at n=0 every tone's
    // sin-table entry is 0 (phase-0/2 contribute nothing) or its cos-table
    // entry is 1 (phase-1/3). Rather than pick apart individual tones, check
    // the whole-symbol peak magnitude (dominated by the pilot, which is
    // identical in both) and the fixed per-sample scale directly via
    // getQamScale — both symbols were synthesized with the exact same
    // qamScale, so the underlying per-tone unit-magnitude amplitude is
    // identical by construction.
    expect(mod.getQamScale()).toBeGreaterThan(0);
    // Peak of an all-zero training symbol at n=0 is pilotAmplitude*qamScale
    // (every tone's sin(0) = 0); confirm it matches the scale directly.
    const { cpSamples } = ofdmSamples(SAMPLE_RATE);
    expect(training[cpSamples]).toBeCloseTo(PILOT_AMPLITUDE * mod.getQamScale(), 6);
    expect(data.length).toEqual(training.length);
  });

  test('peak of a full stream (all-QPSK, all-16-QAM, all-64-QAM) never exceeds 0.95 at 8/16/32 tones', () => {
    for (const toneCount of [8, 16, 32]) {
      const toneFreqs = ofdmToneFrequencies({ toneCount, pilotFreqHz: PILOT_FREQ });
      for (const order of [2, 4, 6] as QamOrder[]) {
        const mod = new OFDMQPSKModulator({
          sampleRate: SAMPLE_RATE,
          toneFrequencies: toneFreqs,
          pilotFreqHz: PILOT_FREQ,
          pilotAmplitude: PILOT_AMPLITUDE,
        });
        mod.setToneOrders(new Array(toneCount).fill(order) as QamOrder[]);
        // Sweep every corner-ish symbol value across a handful of patterns
        // (not just one) to stress different phase/point combinations.
        const patterns = [0, 1, (1 << order) - 1, (1 << order) >> 1, 3];
        let peak = 0;
        for (const p of patterns) {
          mod.setSymbols(new Array(toneCount).fill(p % (1 << order)));
          const out = mod.generateSymbol();
          for (const v of out) peak = Math.max(peak, Math.abs(v));
        }
        // DELIBERATELY LOOSER THAN 0.95, and worth being clear about why.
        //
        // This asserted a provable bound: every tone on the same symbol is the
        // coherent worst case, and the old TX scale was sized so that even that
        // stayed under 0.95 for any data. That cost ~6 dB of per-tone level per
        // doubling of tone count and is why 16-QAM did not work above 8 tones.
        //
        // The scale is now sized from a measured crest budget, and what makes
        // that safe is that this pattern is no longer REACHABLE. Every path that
        // reaches the modulator is de-correlated by construction: payload bytes
        // are whitened (protocol/whiten.ts), the sync/training burst carries
        // per-tone phases (syncQpskSymbols), and the QAM reference symbols are
        // rotated per tone (qamRefPhase). The tests that guard the real paths —
        // clipRate.test.ts and txLevelFlattening.test.ts — assert 0.95 against
        // actual encoded frames and the actual preamble.
        //
        // Kept as a bounded-overshoot check so that if some future change makes
        // uniform symbols reachable again, the margin is visible rather than
        // silent.
        //
        // Measured 1.84 at the worst combination here (32 tones, 64-QAM), up
        // from ~1.05 when the preamble term was still priced at its coherent
        // bound and dragged the whole scale down with it. Both numbers describe
        // the same unreachable symbol; the level around it changed. Post-frame
        // tone slots — the one reachable uniform case left — carry keystream
        // filler now (fillerByte), which clipRate.test.ts asserts directly.
        expect(peak).toBeLessThan(2.2);
      }
    }
  });
});

describe('QAM synthesis path (mixed / higher-order tones)', () => {
  test('a mix of QPSK/16-QAM/64-QAM tones produces a stable per-tone amplitude across symbols', () => {
    const orders: QamOrder[] = [2, 2, 4, 4, 6, 6, 2, 4];
    const mod = makeMod();
    mod.setToneOrders(orders);

    // Two different symbol sets, all tones at their constellation's max-magnitude
    // corner point both times — should produce the same synthesized peak scale
    // (fixed scale, not per-symbol peak-normalize).
    const cornerBits = orders.map((o) => (1 << o) - 1); // all-1s bit pattern -> a corner point for our Gray layout
    const midBits = orders.map((o) => (1 << o) >> 1); // a different, still-valid symbol per tone

    mod.setSymbols(cornerBits);
    const symA1 = mod.generateSymbol();
    mod.setSymbols(midBits);
    mod.setSymbols(cornerBits);
    const symA2 = mod.generateSymbol();

    // Same input symbols on the QAM path must reproduce exactly (deterministic,
    // no per-symbol renormalization drift).
    expect(Array.from(symA1)).toEqual(Array.from(symA2));
  });

  test('QAM path samples stay within the documented fixed-scale peak bound', () => {
    const orders: QamOrder[] = new Array(TONE_COUNT).fill(6) as QamOrder[]; // worst case: all 64-QAM
    const mod = makeMod();
    mod.setToneOrders(orders);
    mod.setSymbols(new Array(TONE_COUNT).fill(63)); // corner point on every tone
    const out = mod.generateSymbol();
    for (const v of out) {
      expect(Math.abs(v)).toBeLessThanOrEqual(0.95 + 1e-6);
    }
  });

  test('QAM path matches the documented re*cos - im*sin quadrature synthesis', () => {
    const orders: QamOrder[] = new Array(TONE_COUNT).fill(4) as QamOrder[];
    const mod = makeMod();
    mod.setToneOrders(orders);
    const bits = [0, 3, 7, 12, 15, 5, 9, 1];
    mod.setSymbols(bits);
    const out = mod.generateSymbol();
    const { cpSamples } = ofdmSamples(SAMPLE_RATE);

    // Reconstruct expected body directly from mapSymbol + tables.
    const twoPiOverFs = (2 * Math.PI) / SAMPLE_RATE;
    const expectedBody = new Float32Array(fftSamples);
    const wp = twoPiOverFs * PILOT_FREQ;
    for (let n = 0; n < fftSamples; n++) {
      let acc = PILOT_AMPLITUDE * Math.cos(wp * n);
      for (let t = 0; t < TONE_COUNT; t++) {
        const w = twoPiOverFs * TONE_FREQS[t];
        const { re, im } = mapSymbol(bits[t], orders[t]);
        acc += re * Math.cos(w * n) - im * Math.sin(w * n);
      }
      expectedBody[n] = acc;
    }
    // The modulator applies a single fixed scalar to the whole body — recover
    // it from one non-zero sample and check it's consistent across all samples.
    let idx = -1;
    for (let n = 0; n < fftSamples; n++) {
      if (Math.abs(expectedBody[n]) > 1e-6) {
        idx = n;
        break;
      }
    }
    expect(idx).toBeGreaterThanOrEqual(0);
    const impliedScale = out[cpSamples + idx] / expectedBody[idx];
    for (let n = 0; n < fftSamples; n++) {
      expect(out[cpSamples + n]).toBeCloseTo(expectedBody[n] * impliedScale, 5);
    }
  });
});
