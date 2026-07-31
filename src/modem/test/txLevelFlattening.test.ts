/**
 * txLevelFlattening.test.ts — Task 8: TX level flattening.
 *
 * Real acoustic logs disproved txEngine.ts's load-bearing assumption that
 * "each OFDM symbol is already peak-normed to 0.95": QPSK training used a
 * per-symbol peak-normalize (data-dependent, so its level varies symbol to
 * symbol) while QAM data used a separate FIXED scale that was not equal to
 * the training level. streamChunks() has no whole-signal analysis, so the
 * player's per-chunk clip guard rescaled each chunk independently — the
 * transmitted level stepped by up to 11 dB between chunks in one real
 * transmission (measured chunk peaks: 6.84, 3.56, 1.87). QPSK survives that
 * (phase-only decisions); QAM's amplitude decisions do not.
 *
 * These tests assert the fix: ONE fixed, deterministic scale for the whole
 * transmission (training, QPSK data, QAM data, QAM ref alike), with a
 * provable (not statistical) worst-case peak <= 0.95.
 */
import { describe, expect, it } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { ordersToQamMap } from '../protocol/linkProfile';
import type { QamOrder } from '../modulation/constellation';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { toneIQ } from '../pilot';
import { ofdmSamples, ofdmToneFrequencies, OFDM_DEFAULTS } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;
const TONE_COUNTS = [8, 16, 32];
const ORDERS: Array<{ label: string; order: QamOrder }> = [
  { label: 'all-QPSK', order: 2 },
  { label: 'all-16QAM', order: 4 },
  { label: 'all-64QAM', order: 6 },
];

function makeTx(toneCount: number, order: QamOrder): TxEngine {
  const qamMap = ordersToQamMap(new Array(toneCount).fill(order) as QamOrder[]);
  return new TxEngine({
    useOFDM: true,
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount,
    emitLinkProfile: true,
    qamMap,
  } as ConstructorParameters<typeof TxEngine>[0]);
}

/** Deterministic PRNG so failures are reproducible. */
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

function randomBytes(n: number, seed: number): Uint8Array {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256);
  return out;
}

describe('TX level flattening — whole-stream peak bound', () => {
  for (const toneCount of TONE_COUNTS) {
    for (const { label, order } of ORDERS) {
      it(`${toneCount} tones, ${label}: full streamed transmission peak <= 0.95`, () => {
        const tx = makeTx(toneCount, order);
        const payload = randomBytes(400, toneCount * 100 + order);
        let peak = 0;
        for (const chunk of tx.streamChunks('t.bin', payload, 4096)) {
          for (const v of chunk) {
            const a = Math.abs(v);
            if (a > peak) peak = a;
          }
        }
        expect(peak).toBeGreaterThan(0); // sanity: actually transmitted something
        expect(peak).toBeLessThanOrEqual(0.95 + 1e-6);
      });
    }
  }
});

describe('TX level flattening — training vs data per-tone amplitude', () => {
  it('a QPSK training symbol and a QPSK/QAM data symbol use the SAME fixed per-tone scale', () => {
    // Direct modulator check: qamScale is computed ONCE from config and is
    // identical no matter what setToneOrders()/setSymbols() are called with
    // afterward — this is what makes training and data land at the same
    // level (the receiver trains its channel estimate on training and
    // applies it to data; any training-vs-data ratio is a systematic error).
    const toneCount = 16;
    const toneFreqs = ofdmToneFrequencies({ toneCount, pilotFreqHz: PILOT_FREQ });
    const mod = new OFDMQPSKModulator({
      sampleRate: SAMPLE_RATE,
      toneFrequencies: toneFreqs,
      pilotFreqHz: PILOT_FREQ,
      pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
    });
    const scaleBeforeTraining = mod.getQamScale();

    // Training symbol (all-zero QPSK, the pattern OFDMEngine uses for sync/training).
    mod.setSymbols(new Array(toneCount).fill(0));
    mod.generateSymbol();
    const scaleDuringTraining = mod.getQamScale();

    // Switch to a QAM data profile and emit a data symbol.
    mod.setToneOrders(new Array(toneCount).fill(4) as QamOrder[]);
    mod.setSymbols(new Array(toneCount).fill(3));
    mod.generateSymbol();
    const scaleDuringData = mod.getQamScale();

    expect(scaleDuringTraining).toBe(scaleBeforeTraining);
    expect(scaleDuringData).toBe(scaleBeforeTraining);
  });

  it('per-tone amplitude recovered by the demodulator is consistent between a training symbol and a QPSK data symbol', () => {
    // End-to-end (mod -> demod) check via the actual toneIQ recovery path
    // (a per-tone matched-filter correlation, the same one demodulate() uses
    // — see OFDMQPSKDemodulator.ts), not just the shared qamScale constant:
    // train on the all-zero pattern, then confirm a data symbol (different
    // phase per tone) recovers the SAME per-tone magnitude — the property
    // requirement (b) actually claims: training and data amplitude must
    // match because the receiver trains its channel estimate on training and
    // applies it to data, so any training-vs-data amplitude ratio other than
    // 1 is a systematic error QPSK's phase-only slicer would never catch.
    const toneCount = 8;
    const toneFreqs = ofdmToneFrequencies({ toneCount, pilotFreqHz: PILOT_FREQ });
    const mod = new OFDMQPSKModulator({
      sampleRate: SAMPLE_RATE,
      toneFrequencies: toneFreqs,
      pilotFreqHz: PILOT_FREQ,
      pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
    });
    const { cpSamples, fftSamples } = ofdmSamples(SAMPLE_RATE);
    const body = (symbol: Float32Array) => symbol.subarray(cpSamples, cpSamples + fftSamples);

    // Training body: all-zero QPSK, the pattern OFDMEngine uses for sync/training.
    mod.setSymbols(new Array(toneCount).fill(0));
    const trainingBody = body(mod.generateSymbol());

    // Data body: QPSK phase 2 on every tone (a different phase than training,
    // so a bug that only cancels at matching phases wouldn't be caught).
    mod.setSymbols(new Array(toneCount).fill(2));
    const dataBody = body(mod.generateSymbol());

    for (let t = 0; t < toneCount; t++) {
      const trainingIQ = toneIQ(trainingBody, toneFreqs[t], SAMPLE_RATE);
      const dataIQ = toneIQ(dataBody, toneFreqs[t], SAMPLE_RATE);
      const trainingMag = Math.hypot(trainingIQ.i, trainingIQ.q);
      const dataMag = Math.hypot(dataIQ.i, dataIQ.q);
      expect(trainingMag).toBeGreaterThan(0);
      expect(dataMag / trainingMag).toBeCloseTo(1, 6);
    }
  });
});
