/**
 * clipRate.test.ts — the TX scale is now a crest-factor budget, not a proof.
 *
 * The old scale divided by the coherent worst-case peak (sum of |point| over
 * every tone), which guaranteed no sample could ever exceed 0.95 — but cost
 * ~6 dB of per-tone level per doubling of tone count, which is what stopped
 * 16-QAM working above 8 tones. PAPR_CREST replaces that guarantee with a
 * budget, so "does it actually clip?" becomes an empirical question and this
 * file is the answer. If PAPR_CREST changes, these numbers move; that is the
 * point.
 *
 * Measured over random payloads across every tone count and constellation
 * order the modem can be configured with.
 */
import { describe, it, expect } from 'vitest';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { ofdmToneFrequencies, OFDM_DEFAULTS, OFDM_TUNING } from '../types';
import { QAM_ORDERS, type QamOrder } from '../modulation/constellation';
import { gainsDbToLinear, refinePreEmphasis } from '../diag/channelSweep';

const SAMPLE_RATE = 48000;
const TONE_COUNTS = [8, 16, 32, 40, 48];
const SYMBOLS = 300;
/** The player's own guard sits at 1.0; the scale targets 0.95. */
const CLIP_LEVEL = 1.0;

function modulatorFor(toneCount: number, order: QamOrder): OFDMQPSKModulator {
  const m = new OFDMQPSKModulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: ofdmToneFrequencies({
      toneCount,
      pilotFreqHz: 1850,
      startHz: OFDM_DEFAULTS.toneStartHz,
    }),
    pilotFreqHz: 1850,
    pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
  });
  m.setToneOrders(new Array(toneCount).fill(order) as QamOrder[]);
  return m;
}

/** Deterministic PRNG — a fixed seed keeps these numbers reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function measure(toneCount: number, order: QamOrder) {
  const m = modulatorFor(toneCount, order);
  const rnd = prng(0x5eed + toneCount * 31 + order);
  const levels = 1 << order;
  let peak = 0;
  let clipped = 0;
  let total = 0;
  let sumSq = 0;

  for (let s = 0; s < SYMBOLS; s++) {
    m.setSymbols(Array.from({ length: toneCount }, () => Math.floor(rnd() * levels)));
    const sym = m.generateSymbol();
    for (let i = 0; i < sym.length; i++) {
      const a = Math.abs(sym[i]);
      if (a > peak) peak = a;
      if (a > CLIP_LEVEL) clipped++;
      sumSq += sym[i] * sym[i];
      total++;
    }
  }
  const rms = Math.sqrt(sumSq / total);
  return { peak, clipRate: clipped / total, crest: peak / rms };
}

describe('TX scale: clip rate under random payloads', () => {
  for (const toneCount of TONE_COUNTS) {
    for (const order of QAM_ORDERS) {
      it(`${toneCount} tones, order ${order}: does not clip`, () => {
        const { peak, clipRate } = measure(toneCount, order as QamOrder);
        // Zero clipped samples is the bar. The budget is sized so the Gaussian
        // tail beyond it is negligible AND the constellations are bounded, so
        // any clipping at all means PAPR_CREST is too aggressive.
        expect(clipRate).toBe(0);
        expect(peak).toBeLessThanOrEqual(CLIP_LEVEL);
      });
    }
  }

  it('recovers substantial level at high tone counts vs the coherent bound', () => {
    // The regression this fix exists for: per-tone level must no longer fall
    // ~6 dB per doubling of tone count. Compare the scale actually in force
    // against what the old worst-case bound would have produced.
    const MAX_QAM_MAGNITUDE_APPROX = 1.5275; // 64-QAM outer corner, normalized
    for (const toneCount of [32, 48]) {
      const m = modulatorFor(toneCount, 4);
      const scale = (m as unknown as { qamScale: number }).qamScale;
      const oldScale =
        0.95 / (toneCount * MAX_QAM_MAGNITUDE_APPROX + OFDM_DEFAULTS.pilotAmplitude);
      const gainDb = 20 * Math.log10(scale / oldScale);
      // Currently ZERO, deliberately. Coherent PADDING symbols (a short payload
      // zero-fills the frame, putting every tone on the same point) reach the
      // full coherent bound, so that term still binds and the crest budget buys
      // nothing yet. Whitening the payload and de-cohering the sync burst are
      // what unlock it — see OFDMQPSKModulator's scale derivation. Asserted as
      // "no worse than before" so a future regression that quietly RAISES the
      // level into clipping still fails here.
      expect(gainDb).toBeGreaterThan(-0.01);
    }
  });

  // THE PREAMBLE, not just payload. This is the case the first version of this
  // file missed, and missing it shipped a scale that clipped the sync burst on
  // every single transmission: generateSyncBurst puts every tone on the SAME
  // QPSK symbol, so its carriers are phase-aligned by construction (measured
  // crest 6.70 at 32 tones vs ~2.6 for data) and it is guaranteed, not rare.
  // Clipping there is uniquely destructive because the channel estimate is
  // built from exactly those symbols — it turned a flat 6 dB h profile into a
  // 22 dB ramp over the air while every random-data test above still passed.
  for (const toneCount of TONE_COUNTS) {
    it(`${toneCount} tones: the sync/training burst does not clip`, () => {
      const engine = new OFDMEngine({
        sampleRate: SAMPLE_RATE,
        toneCount,
        pilotFreqHz: 1850,
        toneStartHz: OFDM_DEFAULTS.toneStartHz,
      });
      const burst = engine.generateTrainingSymbols(
        OFDM_TUNING.trainingSymbols + OFDM_TUNING.trainingSettleSymbols,
      );
      let peak = 0;
      for (let i = 0; i < burst.length; i++) peak = Math.max(peak, Math.abs(burst[i]));
      expect(peak).toBeLessThanOrEqual(CLIP_LEVEL);
    });
  }

  for (const toneCount of TONE_COUNTS) {
    it(`${toneCount} tones: an all-padding (coherent) data symbol does not clip`, () => {
      // The case that broke a working link and that the random-data tests above
      // cannot produce: symbol index 0 on every tone, which is what zero
      // padding encodes. All carriers phase-align and the sum approaches the
      // coherent bound.
      for (const order of QAM_ORDERS) {
        const m = modulatorFor(toneCount, order as QamOrder);
        m.setSymbols(new Array(toneCount).fill(0));
        const sym = m.generateSymbol();
        let peak = 0;
        for (let i = 0; i < sym.length; i++) peak = Math.max(peak, Math.abs(sym[i]));
        expect(peak).toBeLessThanOrEqual(CLIP_LEVEL);
      }
    });
  }

  // Pre-emphasis must not be able to reintroduce clipping. The gains scale each
  // tone's contribution to the coherent sum, so the peak budget is derived from
  // their sum rather than the tone count — with mean-unity gains that is the
  // same number, which is exactly why refinePreEmphasis keeps them mean-zero
  // in dB. A boosted tone therefore steals headroom from an attenuated one
  // instead of adding any.
  for (const toneCount of TONE_COUNTS) {
    it(`${toneCount} tones: a calibrated pre-emphasis set still does not clip`, () => {
      // Derive a realistic set by calibrating against a 17 dB tilt, the shape
      // measured on a real microphone.
      const channelDb = Array.from(
        { length: toneCount },
        (_u, t) => -17 + (17 * t) / (toneCount - 1),
      );
      let gainsDb = new Array<number>(toneCount).fill(0);
      for (let i = 0; i < 3; i++) {
        const received = gainsDb.map((g, t) => Math.pow(10, (g + channelDb[t]) / 20));
        gainsDb = refinePreEmphasis(gainsDb, received);
      }
      const toneGains = gainsDbToLinear(gainsDb);

      for (const order of QAM_ORDERS) {
        const m = new OFDMQPSKModulator({
          sampleRate: SAMPLE_RATE,
          toneFrequencies: ofdmToneFrequencies({
            toneCount, pilotFreqHz: 1850, startHz: OFDM_DEFAULTS.toneStartHz,
          }),
          pilotFreqHz: 1850,
          pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
          toneGains,
        });
        m.setToneOrders(new Array(toneCount).fill(order) as QamOrder[]);
        // Worst case for the preamble: every tone on the same symbol.
        m.setSymbols(new Array(toneCount).fill(0));
        const sym = m.generateSymbol();
        let peak = 0;
        for (let i = 0; i < sym.length; i++) peak = Math.max(peak, Math.abs(sym[i]));
        expect(peak).toBeLessThanOrEqual(CLIP_LEVEL);
      }
    });
  }

  it('leaves no adversarial overshoot at all while the coherent bound binds', () => {
    // With the coherent term binding, even the fully phase-aligned all-corners
    // symbol lands exactly on the 0.95 target — there is no overshoot to
    // document. If a future change makes paprPeak the binding term (after
    // payload whitening and preamble de-cohering), this becomes a real ratio
    // and the assertion must be relaxed DELIBERATELY, with the new clip rate
    // measured rather than assumed. That is the whole point of it being here.
    const MAX_QAM_MAGNITUDE_APPROX = 1.5275;
    for (const toneCount of TONE_COUNTS) {
      const m = modulatorFor(toneCount, 6);
      const scale = (m as unknown as { qamScale: number }).qamScale;
      const coherentPeak =
        (toneCount * MAX_QAM_MAGNITUDE_APPROX + OFDM_DEFAULTS.pilotAmplitude) * scale;
      expect(coherentPeak).toBeLessThanOrEqual(0.951);
    }
  });
});
