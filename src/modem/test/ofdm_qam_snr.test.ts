/**
 * ofdm_qam_snr.test.ts — diagnostic: what SNR does the QAM path actually need?
 *
 * The acoustic tests were inconclusive because the link sat right at the
 * 16-QAM threshold. This measures the implementation's threshold directly:
 * modulate at a given per-tone order, add AWGN at a known data-SNR, train the
 * demod on the (noisy) preamble, demodulate, and report the bit-error rate.
 *
 * Theory (uncoded, for a target BER ~1e-3): QPSK ~9 dB, 16-QAM ~16 dB,
 * 64-QAM ~22 dB. If this impl hits ~those, it's correct and the acoustic link
 * just needs margin (louder / fewer tones). If it needs far more, there's an
 * equalization/scale bug to fix.
 */
import { describe, expect, test } from 'vitest';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { mapSymbol, type QamOrder } from '../modulation/constellation';
import { ofdmToneFrequencies } from '../types';

const TONE_COUNT = 8;
const PILOT_FREQ = 1900;
const PILOT_AMPLITUDE = 2.0;
const SAMPLE_RATE = 48000;
const TONE_FREQS = ofdmToneFrequencies({ toneCount: TONE_COUNT, pilotFreqHz: PILOT_FREQ });

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller gaussian from a uniform PRNG. */
function makeGaussian(seed: number): () => number {
  const rng = mulberry32(seed);
  return () => {
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}

/**
 * Add noise at `noiseStd × dataRms`, demod `nSym` symbols, return the BER AND
 * the demod's own reported post-equalization MER (decision-domain SNR — the
 * same number the acoustic runs print). This makes the sweep directly
 * comparable to "acoustic MER 16 dB → 16-QAM failed".
 */
function berVsMer(order: QamOrder, noiseMul: number, nSym: number, seed: number): { ber: number; mer: number } {
  const mod = new OFDMQPSKModulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: TONE_FREQS,
    pilotFreqHz: PILOT_FREQ,
    pilotAmplitude: PILOT_AMPLITUDE,
  });
  const demod = new OFDMQPSKDemodulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: TONE_FREQS,
    pilotFreqHz: PILOT_FREQ,
  });
  const orders = new Array(TONE_COUNT).fill(order) as QamOrder[];

  // Noise std set relative to the QAM DATA rms at the target data-SNR. The
  // (louder) QPSK preamble therefore trains at a higher SNR — mirrors reality.
  mod.setToneOrders(orders);
  const probe = new Array(TONE_COUNT).fill(1);
  mod.setSymbols(probe);
  const dataRms = rms(mod.generateSymbol());
  const noiseStd = dataRms * noiseMul;
  const gauss = makeGaussian(seed);
  const addNoise = (a: Float32Array): Float32Array => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + noiseStd * gauss();
    return out;
  };

  // Train on noisy preamble (all-QPSK 0°).
  mod.setToneOrders(new Array(TONE_COUNT).fill(2) as QamOrder[]);
  mod.setSymbols(new Array(TONE_COUNT).fill(0));
  for (let s = 0; s < 12; s++) demod.trainOnSyncSymbol(addNoise(mod.generateSymbol()));

  // Switch both sides to the data order map.
  mod.setToneOrders(orders);
  demod.setToneOrders(orders);

  const rng = mulberry32(seed ^ 0x9e3779b9);
  let bitErrors = 0;
  let bitTotal = 0;
  for (let s = 0; s < nSym; s++) {
    const syms = Array.from({ length: TONE_COUNT }, () => Math.floor(rng() * (1 << order)));
    mod.setSymbols(syms);
    const res = demod.demodulate(addNoise(mod.generateSymbol()));
    // res.bits is the flat per-tone bit sequence (tone-major, MSB-first).
    let bi = 0;
    for (let t = 0; t < TONE_COUNT; t++) {
      for (let b = order - 1; b >= 0; b--) {
        const expected = (syms[t] >> b) & 1;
        if (res.bits[bi] !== expected) bitErrors++;
        bitTotal++;
        bi++;
      }
    }
    demod.commitMER();
  }
  const merInfo = demod.getMER();
  return { ber: bitTotal ? bitErrors / bitTotal : 1, mer: merInfo ? merInfo.merDb : 99 };
}

describe('QAM BER vs measured MER (AWGN)', () => {
  test('16-QAM: BER at each MER — comparable to acoustic MER', () => {
    const rows: string[] = [];
    let clean = 1;
    for (const mul of [3.0, 2.0, 1.2, 0.7, 0.4, 0.2, 0.05]) {
      const { ber, mer } = berVsMer(4, mul, 60, 1234);
      rows.push(`  16QAM  MER=${mer.toFixed(1)}dB  BER=${ber.toExponential(2)}`);
      if (mul === 0.05) clean = ber;
    }
    console.log('\n' + rows.join('\n'));
    // Near-clean must be error-free — else it's a logic bug, not SNR.
    expect(clean).toBeLessThan(1e-3);
  });

  test('64-QAM: BER at each MER', () => {
    const rows: string[] = [];
    let clean = 1;
    for (const mul of [1.2, 0.7, 0.4, 0.2, 0.1, 0.03]) {
      const { ber, mer } = berVsMer(6, mul, 60, 99);
      rows.push(`  64QAM  MER=${mer.toFixed(1)}dB  BER=${ber.toExponential(2)}`);
      if (mul === 0.03) clean = ber;
    }
    console.log('\n' + rows.join('\n'));
    expect(clean).toBeLessThan(5e-3);
  });
});
