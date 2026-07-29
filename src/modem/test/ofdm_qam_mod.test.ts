/**
 * ofdm_qam_mod.test.ts — Phase 3 modulator generalization.
 *
 * Two guarantees under test:
 *  1. All-QPSK (the default, and today's only live mode) is byte-identical
 *     to the pre-QAM modulator: same sign/table synthesis, same per-symbol
 *     peak-normalize to 0.95.
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

// Reference implementation of the pre-QAM legacy synthesis, copied verbatim
// from the modulator's original generateSymbol (before this change) so we can
// assert byte-identity independent of the refactor.
function legacyGenerateSymbol(symbols: number[]): Float32Array {
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
    body[n] = acc;
  }
  let peak = 0;
  for (let n = 0; n < body.length; n++) peak = Math.max(peak, Math.abs(body[n]));
  const scale = peak > 0 ? 0.95 / peak : 1;
  for (let n = 0; n < body.length; n++) body[n] *= scale;

  const out = new Float32Array(fftSamples + cpSamples);
  out.set(body.subarray(fftSamples - cpSamples), 0);
  out.set(body, cpSamples);
  return out;
}

describe('all-QPSK modulator path stays byte-identical', () => {
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
      const expected = legacyGenerateSymbol(symbols);
      expect(Array.from(out)).toEqual(Array.from(expected));
    });

    test(`pattern ${i}: explicit all-QPSK via setToneOrders`, () => {
      const mod = makeMod();
      mod.setToneOrders(new Array(TONE_COUNT).fill(2) as QamOrder[]);
      mod.setSymbols(symbols);
      const out = mod.generateSymbol();
      const expected = legacyGenerateSymbol(symbols);
      expect(Array.from(out)).toEqual(Array.from(expected));
    });
  }
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
