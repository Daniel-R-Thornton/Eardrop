/**
 * ofdmTrackerRobustness.test.ts — regression tests for the demodulator's
 * decision-directed trackers (see acoustic-fixes-plan.md Task 2).
 *
 * Two scenarios:
 *
 *  1. QPSK long-payload with a persistent per-tone phase offset (channel
 *     texture the pilot-only drift model can't represent) plus noise floor.
 *     The legacy QPSK tracker (trackingAlpha > 0) must not corrupt decoding
 *     over a long run: BER must stay low and must not grow across the run.
 *     Exercises 2a (confidence-gate grid alignment) and 2b (drift leaking
 *     into channelEst via an un-rotated expected point).
 *
 *  2. A slow, PER-TONE-DIFFERENT gain ramp applied after QAM ref-symbol
 *     calibration completes. Pilot-referenced common-mode gain correction
 *     can't fix per-tone-differential drift; only the QAM decision-directed
 *     tracker (2c: qamTrackingAlpha re-enabled with an amplitude-class-
 *     independent gate) can. Full TxEngine/RxEngine loopback, byte-exact.
 */
import { describe, it, expect } from 'vitest';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import type { QamOrder } from '../modulation/constellation';
import { ofdmToneFrequencies, ofdmSamples, OFDM_TUNING, OFDM_DEFAULTS } from '../types';
import { toneIQ } from '../pilot';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';
import { ordersToQamMap } from '../protocol/linkProfile';

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

function makeGaussian(seed: number): () => number {
  const rng = mulberry32(seed);
  return () => {
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
}

describe('OFDM QPSK tracker: per-tone phase offset + noise (2a/2b)', () => {
  it('does not degrade across a long payload', () => {
    const SAMPLE_RATE = 48000;
    const PILOT_FREQ = 1900;
    const TONE_COUNT = 6;
    const TONE_FREQS = ofdmToneFrequencies({ toneCount: TONE_COUNT, pilotFreqHz: PILOT_FREQ });
    const N_SYMBOLS = 600;

    const mod = new OFDMQPSKModulator({
      sampleRate: SAMPLE_RATE,
      toneFrequencies: TONE_FREQS,
      pilotFreqHz: PILOT_FREQ,
      pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
    });
    // trackingAlpha overridden well above the production default (0.003) so
    // a corrupting tracker visibly diverges within a few hundred symbols
    // instead of needing an impractically long test run to show up.
    const demod = new OFDMQPSKDemodulator({
      sampleRate: SAMPLE_RATE,
      toneFrequencies: TONE_FREQS,
      pilotFreqHz: PILOT_FREQ,
      trackingAlpha: 0.05,
    });

    const gauss = makeGaussian(1234);
    // Noise floor large enough that the confidence gate actually gets
    // exercised on a meaningful fraction of symbols (too little noise and
    // the tracker rarely fires either way, proving nothing) — empirically,
    // 0.2 (measured against a ~1.0-scale training-burst sample) is where the
    // broken gate (2a) starts corrupting channelEst within a few hundred
    // symbols, while the fixed gate stays clean.
    const noiseStd = 0.2;
    const addNoise = (a: Float32Array): Float32Array => {
      const out = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = a[i] + noiseStd * gauss();
      return out;
    };

    // Clean training — establishes the true (zero-offset) per-tone channel.
    mod.setSymbols(new Array(TONE_COUNT).fill(0));
    for (let s = 0; s < 12; s++) demod.trainOnSyncSymbol(addNoise(mod.generateSymbol()));

    // Persistent per-tone phase offset applied to every data symbol,
    // simulating channel texture (e.g. multipath) beyond what the single
    // pilot-referenced drift slope can represent — a fixed, tone-dependent
    // rotation of each ideal QPSK point. Switching the MODULATOR (not the
    // demodulator) into its QAM synthesis path lets us feed it arbitrary
    // off-grid-phase points while the demodulator stays on its default
    // all-QPSK legacy slicer/tracker path (toneOrders never set) — exactly
    // the branch under test.
    mod.setToneOrders(new Array(TONE_COUNT).fill(4) as QamOrder[]);
    const offsetRad = Array.from({ length: TONE_COUNT }, (_unused, t) =>
      ((t % 3) - 1) * (Math.PI / 36), // -5°, 0°, +5° repeating per tone
    );

    const rng = mulberry32(0x9e3779b9);
    let bitErrorsFirstHalf = 0;
    let bitErrorsSecondHalf = 0;

    for (let s = 0; s < N_SYMBOLS; s++) {
      const syms = Array.from({ length: TONE_COUNT }, () => Math.floor(rng() * 4));
      // Legacy QPSK tone contribution is sin(wn + sym*90°) (see
      // OFDMQPSKModulator.setSymbols's sin/cos-selector comment), which in
      // the QAM path's re·cos(wn) − im·sin(wn) synthesis convention is
      // (re, im) = (sin(phi), -cos(phi)) for total phase phi — NOT
      // (cos(phi), sin(phi)), which is the QAM re/im convention for a
      // DIFFERENT (cos-based) basis. Using the wrong convention here would
      // desync the injected offset from what the demodulator actually sees.
      const points = syms.map((sym, t) => {
        const phi = sym * (Math.PI / 2) + offsetRad[t];
        return { re: Math.sin(phi), im: -Math.cos(phi) };
      });
      mod.setPoints(points);
      const res = demod.demodulate(addNoise(mod.generateSymbol()));

      for (let t = 0; t < TONE_COUNT; t++) {
        const expected = syms[t];
        const actual = (res.bits[t * 2] << 1) | res.bits[t * 2 + 1];
        const errors = expected === actual ? 0 : 1;
        if (s < N_SYMBOLS / 2) bitErrorsFirstHalf += errors;
        else bitErrorsSecondHalf += errors;
      }
    }

    const totalSymbols = N_SYMBOLS * TONE_COUNT;
    const totalErrors = bitErrorsFirstHalf + bitErrorsSecondHalf;
    // The tracker must not corrupt decoding: overall error rate stays small...
    expect(totalErrors / totalSymbols).toBeLessThan(0.02);
    // ...and must not grow across the run (a corrupting tracker compounds
    // error over time, so the second half would be markedly worse than the
    // first if channelEst were drifting toward the wrong reference).
    expect(bitErrorsSecondHalf).toBeLessThanOrEqual(bitErrorsFirstHalf + 2);
  });
});

/**
 * Decompose an OFDM symbol window into its per-tone (re, im) contributions
 * (exact, since the tone grid is orthogonal over one window — see toneIQ's
 * doc) and rebuild it with each tone's contribution scaled by an
 * independent, per-tone gain factor. Used to simulate a channel whose gain
 * drifts differently per frequency (e.g. multipath/comb filtering) — pilot-
 * referenced common-mode gain correction alone cannot track this; only the
 * QAM tracker's own per-tone channel estimate can.
 */
function applyPerToneGain(
  window: Float32Array,
  toneFrequencies: Float32Array,
  sampleRate: number,
  cpSamples: number,
  fftSamples: number,
  gainForTone: (t: number) => number,
): Float32Array {
  const body = window.slice(cpSamples, cpSamples + fftSamples);
  const newBody = body.slice();
  const twoPiOverFs = (2 * Math.PI) / sampleRate;
  for (let t = 0; t < toneFrequencies.length; t++) {
    const { i, q } = toneIQ(body, toneFrequencies[t], sampleRate);
    const reAmp = 2 * q;
    const imAmp = -2 * i;
    const gain = gainForTone(t);
    const delta = gain - 1;
    if (delta === 0) continue;
    const w = twoPiOverFs * toneFrequencies[t];
    for (let n = 0; n < fftSamples; n++) {
      newBody[n] += delta * (reAmp * Math.cos(w * n) - imAmp * Math.sin(w * n));
    }
  }
  const out = new Float32Array(window.length);
  out.set(newBody.subarray(fftSamples - cpSamples), 0);
  out.set(newBody, cpSamples);
  return out;
}

describe('OFDM QAM tracker: per-tone gain ramp after calibration (2c)', () => {
  it('a slow per-tone-differential gain ramp after ref-symbol calibration still decodes byte-exact', () => {
    const SAMPLE_RATE = 48000;
    const PILOT_FREQ = 1900;
    const TONE_COUNT = 4;
    const { fftSamples, cpSamples, symSamples } = ofdmSamples(SAMPLE_RATE);
    const toneFreqs = ofdmToneFrequencies({ toneCount: TONE_COUNT, pilotFreqHz: PILOT_FREQ });

    const orders: QamOrder[] = new Array(TONE_COUNT).fill(4) as QamOrder[];
    const qamMap = ordersToQamMap(orders);
    const payload = (() => {
      let a = 31;
      const rnd = () => {
        a = (a * 1664525 + 1013904223) >>> 0;
        return a / 4294967296;
      };
      const out = new Uint8Array(1500);
      for (let i = 0; i < out.length; i++) out[i] = Math.floor(rnd() * 256);
      return out;
    })();

    const tx = new TxEngine({
      useOFDM: true,
      sampleRate: SAMPLE_RATE,
      pilotFreqHz: PILOT_FREQ,
      toneCount: TONE_COUNT,
      emitLinkProfile: true,
      qamMap,
    } as ConstructorParameters<typeof TxEngine>[0]);
    const rx = new RxEngine({
      useOFDM: true,
      sampleRate: SAMPLE_RATE,
      pilotFreqHz: PILOT_FREQ,
      toneCount: TONE_COUNT,
    } as ConstructorParameters<typeof RxEngine>[0]);

    const audio = tx.transmitFile('pertone-ramp.bin', payload);

    // Only distort symbols after the sync+training preamble (matches
    // ofdmGainSag.test.ts's attenuateAfterPreamble boundary) — profile, ref,
    // header, and data symbols all sit on the same OFDM tone grid, so the
    // per-tone decomposition/reconstruction is exact for all of them.
    const boundary = (OFDM_TUNING.syncBurstSymbols + OFDM_TUNING.trainingSymbols) * symSamples;
    const out = new Float32Array(audio.length);
    out.set(audio.subarray(0, boundary), 0);

    let symIdx = 0;
    for (let start = boundary; start + symSamples <= audio.length; start += symSamples) {
      const window = audio.subarray(start, start + symSamples);
      // Distinct, slowly-diverging per-tone gain: tone t drifts at a rate
      // proportional to (t+1), so tones separate from each other over the
      // run — a case pilot-referenced common-mode gain correction cannot
      // fix, only per-tone tracking.
      const RAMP_PER_SYMBOL = 0.0015;
      const idx = symIdx;
      const transformed = applyPerToneGain(
        new Float32Array(window),
        toneFreqs,
        SAMPLE_RATE,
        cpSamples,
        fftSamples,
        (t) => 1 + RAMP_PER_SYMBOL * idx * (t + 1),
      );
      out.set(transformed, start);
      symIdx++;
    }
    // Copy any short trailing remainder verbatim.
    const consumed = boundary + symIdx * symSamples;
    if (consumed < audio.length) out.set(audio.subarray(consumed), consumed);

    for (let i = 0; i < out.length; i++) rx.feedSample(out[i]);
    const tail = new Float32Array(symSamples * 8);
    for (let i = 0; i < tail.length; i++) rx.feedSample(tail[i]);
    const file: ReceivedFile | null = rx.getFile();

    expect(file).not.toBeNull();
    expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
  });
});
