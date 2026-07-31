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
import { encodeFrame } from '../protocol/atomicFrame';
import { ofdmToneFrequencies, ofdmSamples, OFDM_DEFAULTS, OFDM_TUNING } from '../types';
import { QAM_ORDERS, maxConstellationMagnitude, type QamOrder } from '../modulation/constellation';
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
      // Measured 6.8 dB at 32 tones and 8.6 dB at 48, in two steps: whitening
      // removed the coherent-padding case, then the preamble term stopped being
      // priced at a coherent bound the de-cohered burst does not reach. The bar
      // sits at 6 so losing the second step fails here rather than showing up as
      // an over-the-air MER regression (it did once: 4.2 dB, 16-QAM at 32 tones).
      expect(gainDb).toBeGreaterThan(6);
    }
  });

  // THE PREAMBLE, not just payload. This is the case the first version of this
  // file missed, and missing it shipped a scale that clipped the sync burst on
  // every single transmission: back then generateSyncBurst put every tone on the
  // SAME QPSK symbol, so its carriers were phase-aligned by construction
  // (measured crest 6.70 at 32 tones vs ~2.6 for data) and it is guaranteed, not
  // rare. syncQpskSymbols de-cohered it since, and the modulator now measures
  // that burst instead of assuming the coherent peak — so this asserts the
  // measurement is honest, not that a conservative bound is holding.
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

  // The REAL path, replacing a hand-built all-padding symbol. That symbol used
  // to be reachable — a short payload zero-filled the frame, every tone landed
  // on the same constellation point, and the peak hit 1.19 at the player's clip
  // guard. Payload whitening (protocol/whiten.ts) removed it for frame bytes and
  // fillerByte removed it for the tone slots PAST the frame, which whitening
  // never covered (those are not frame bytes: measured 1.29 here at 48
  // tones/64-QAM once the scale stopped being conservative enough to hide it).
  // So what matters is whether an ACTUAL encoded frame clips, not whether a
  // symbol the encoder can no longer produce would.
  for (const toneCount of TONE_COUNTS) {
    it(`${toneCount} tones: a real short-payload frame does not clip`, () => {
      // 12 bytes of payload in a 160-byte field: mostly padding, the worst case
      // for symbol statistics and the one that broke this before.
      const payload = new Uint8Array(160);
      for (let i = 0; i < 12; i++) payload[i] = i * 17;
      const frame = encodeFrame({ type: 0x02, seqNum: 0, totalFrames: 1, crc: 0 }, payload);

      for (const order of QAM_ORDERS) {
        const engine = new OFDMEngine({
          sampleRate: SAMPLE_RATE,
          toneCount,
          pilotFreqHz: 1850,
          toneStartHz: OFDM_DEFAULTS.toneStartHz,
        });
        engine.setToneOrders(new Array(toneCount).fill(order) as QamOrder[]);
        const audio = engine.modulateFrame(frame);
        let peak = 0;
        for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
        expect(peak).toBeLessThanOrEqual(CLIP_LEVEL);
      }
    });
  }

  it('whitening leaves no long run of identical bytes on the wire', () => {
    // The property the scale budget now depends on. Without it, padding makes
    // runs of identical symbols, those sum coherently, and the crest budget is
    // invalid — which is what forced the conservative bound before.
    const payload = new Uint8Array(160);
    for (let i = 0; i < 12; i++) payload[i] = i * 17;
    const frame = encodeFrame({ type: 0x02, seqNum: 0, totalFrames: 1, crc: 0 }, payload);
    let longest = 1;
    let current = 1;
    for (let i = 1; i < frame.length; i++) {
      current = frame[i] === frame[i - 1] ? current + 1 : 1;
      if (current > longest) longest = current;
    }
    expect(longest).toBeLessThan(4);
  });

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

      // Real encoded frame, and the de-cohered preamble, both under the
      // calibrated gains. A hand-built all-tones-same-symbol case is no longer
      // reachable — whitening removed it from the payload and syncQpskSymbols
      // removed it from the preamble — and asserting on it would hold the scale
      // down for a waveform the encoder cannot produce.
      const payload = new Uint8Array(160);
      for (let i = 0; i < 12; i++) payload[i] = i * 17;
      const frame = encodeFrame({ type: 0x02, seqNum: 0, totalFrames: 1, crc: 0 }, payload);

      for (const order of QAM_ORDERS) {
        const engine = new OFDMEngine({
          sampleRate: SAMPLE_RATE,
          toneCount,
          pilotFreqHz: 1850,
          toneStartHz: OFDM_DEFAULTS.toneStartHz,
          toneGains,
        });
        engine.setToneOrders(new Array(toneCount).fill(order) as QamOrder[]);
        const peakOf = (a: Float32Array): number => {
          let p = 0;
          for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
          return p;
        };
        expect(peakOf(engine.modulateFrame(frame))).toBeLessThanOrEqual(CLIP_LEVEL);
        expect(peakOf(engine.generateTrainingSymbols(4))).toBeLessThanOrEqual(CLIP_LEVEL);
      }
    });
  }

  it('bounds how far an adversarial symbol could overshoot full scale', () => {
    // paprPeak is now the binding term at every tone count (the preamble term is
    // measured off the de-cohered burst and comes out below it), so a
    // hypothetical fully phase-aligned all-corners symbol WOULD overshoot. This
    // is the deliberate relaxation the previous version of this comment asked
    // for, with the numbers measured rather than assumed:
    //
    //   N=8 1.00, N=16 1.44, N=32 2.07, N=40 2.32, N=48 2.55
    //
    // The overshoot is bounded by construction, not by luck: it is exactly
    // worstCasePeak/paprPeak = (N·1.5275 + pilot) / (5.5·sqrt((N + pilot²)/2)),
    // which grows only as sqrt(N) and reaches 2.69 at the highest tone count the
    // modem supports. Hence 3.0 here.
    //
    // What makes it safe is UNREACHABILITY, and every route to the modulator is
    // de-correlated by construction: payload bytes are whitened, post-frame tone
    // slots carry keystream filler (fillerByte — zero fill was the last coherent
    // case and it clipped at 2.31 in the final symbol), the sync/training burst
    // carries per-tone phases (syncQpskSymbols), and the QAM reference symbols
    // are rotated per tone (qamRefPhase). The real-path tests above are what
    // actually guard against clipping; this only keeps the margin visible if
    // some future change makes uniform symbols reachable again.
    const MAX_QAM_MAGNITUDE_APPROX = 1.5275;
    for (const toneCount of TONE_COUNTS) {
      const m = modulatorFor(toneCount, 6);
      const scale = (m as unknown as { qamScale: number }).qamScale;
      const coherentPeak =
        (toneCount * MAX_QAM_MAGNITUDE_APPROX + OFDM_DEFAULTS.pilotAmplitude) * scale;
      expect(coherentPeak).toBeLessThan(3.0);
    }
  });

  /**
   * The preamble's budget must be MEASURED off the burst, not assumed coherent.
   *
   * This is the regression that cost 4.2 dB at 32 tones and stopped 16-QAM
   * working there. The burst was de-cohered (syncQpskSymbols) but the scale kept
   * charging the analytic coherent bound for it — 34 units against the real
   * 9.94 — and because that term exceeds paprPeak at 16 tones and above, the
   * stale number SET the transmitted level for the whole session.
   *
   * Asserted as an inequality against that bound rather than against a scale
   * constant, so it fails if the term is ever reinstated and passes for any
   * budget honestly derived from the waveform.
   */
  it('does not price the preamble at the coherent bound it no longer reaches', () => {
    for (const toneCount of [16, 32, 40, 48]) {
      const m = modulatorFor(toneCount, 6);
      const scale = (m as unknown as { qamScale: number }).qamScale;
      // The old term: gainSum · maxMagnitude(QPSK) + pilot, unity gains.
      const staleCoherentTerm =
        toneCount * maxConstellationMagnitude(2) + OFDM_DEFAULTS.pilotAmplitude;
      // Strict inequality only, no margin: how much is won depends on the tone
      // count, because the stale term overtakes paprPeak right around 16 tones
      // (0.3 dB there, 3.3 dB at 32, 5.0 dB at 48). The size of the win is
      // asserted by the level-recovery test above; this one asserts the term is
      // not what sets the scale.
      expect(scale).toBeGreaterThan(0.95 / staleCoherentTerm);
    }
  });

  /**
   * A frame's LAST symbol is the one that used to clip, and nothing about it is
   * special except its fill.
   *
   * Padding is not frame data, so whitening never covered it: zero fill put every
   * padded tone on constellation index 0 — the same point — and they summed
   * phase-aligned. Measured on frames identical but for whether the last symbol
   * was full: 0.52-0.68 exact-fit against 1.06-2.31 padded, worst at 48
   * tones/64-QAM. One symbol per frame was enough to force the scale down for
   * every symbol in the transmission.
   */
  it('a partially-filled final symbol is no louder than a full one', () => {
    const { symSamples } = ofdmSamples(SAMPLE_RATE);
    const symbolPeaks = (audio: Float32Array): number[] => {
      const peaks: number[] = [];
      for (let s = 0; s * symSamples < audio.length; s++) {
        let p = 0;
        const end = Math.min((s + 1) * symSamples, audio.length);
        for (let i = s * symSamples; i < end; i++) p = Math.max(p, Math.abs(audio[i]));
        peaks.push(p);
      }
      return peaks;
    };

    for (const toneCount of TONE_COUNTS) {
      for (const order of QAM_ORDERS) {
        const bytesPerSymbol = (toneCount * order) / 8;
        const rnd = prng(0xf111 + toneCount * 13 + order);
        const bytesFor = (len: number): Uint8Array => {
          const b = new Uint8Array(len);
          for (let i = 0; i < len; i++) b[i] = Math.floor(rnd() * 256);
          return b;
        };
        const engineFor = (): OFDMEngine => {
          const e = new OFDMEngine({
            sampleRate: SAMPLE_RATE,
            toneCount,
            pilotFreqHz: 1850,
            toneStartHz: OFDM_DEFAULTS.toneStartHz,
          });
          e.setToneOrders(new Array(toneCount).fill(order) as QamOrder[]);
          return e;
        };

        // Same symbol count; the second is one byte into its final symbol, so
        // that symbol is almost entirely filler.
        const exact = symbolPeaks(engineFor().modulateFrame(bytesFor(bytesPerSymbol * 6)));
        const padded = symbolPeaks(engineFor().modulateFrame(bytesFor(bytesPerSymbol * 5 + 1)));

        const lastPadded = padded[padded.length - 1];
        const worstFull = Math.max(...exact);
        // Filler is statistically data, so the padded tail must sit inside the
        // spread of ordinary symbols rather than above it.
        expect(lastPadded).toBeLessThan(worstFull * 1.25);
        expect(lastPadded).toBeLessThanOrEqual(CLIP_LEVEL);
      }
    }
  });
});
