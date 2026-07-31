/**
 * qamWarmup.test.ts — TX warm-up symbols before the QAM reference symbols.
 *
 * Motivation (bench, 2026-07-31): the Meteor Lake DMIC's driver-level DSP
 * re-adapts when payload-statistics audio replaces the training burst. The
 * received gain sags ~3 dB over the first ~16 payload symbols (QD g
 * 0.93 → 0.75), so the qamRef calibration measures a gain the payload no
 * longer arrives at (KC mean ≈ 82) and the first frames straddle the drift
 * and fail RS decode (MER 13.2 → 14.2 → 15.0 → 15.6, only the last frame
 * decoding). Warm-up symbols carry expendable payload-statistics audio so
 * the DSP settles BEFORE the reference symbols and the header frame.
 *
 * Placement: after modulateQamRefSymbols, BEFORE the header frame — the
 * droop starts AT the ref burst regardless of what precedes it (three bench
 * runs), so the warm-up absorbs the transient rather than trying to preempt
 * it. Emitted only when some tone is above QPSK (same condition as the ref
 * symbols); an all-QPSK transmission stays byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';
import { OFDM_TUNING, ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;
const TONE_COUNT = 16;
const TIMEOUT = 30000;
const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);

// value 1 ⇒ 16-QAM (see qamMapValueToOrder)
const QAM16_MAP = new Array(TONE_COUNT).fill(1);

function makeEngine(): OFDMEngine {
  return new OFDMEngine({
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: TONE_COUNT,
  } as ConstructorParameters<typeof OFDMEngine>[0]);
}

function makeTx(qamMap?: number[]) {
  return new TxEngine({
    useOFDM: true,
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: TONE_COUNT,
    emitLinkProfile: true,
    qamMap,
  } as ConstructorParameters<typeof TxEngine>[0]);
}

function makeRx() {
  return new RxEngine({
    useOFDM: true,
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: TONE_COUNT,
  } as ConstructorParameters<typeof RxEngine>[0]);
}

describe('QAM warm-up symbols', () => {
  it('modulateQamWarmupSymbols emits qamWarmupSymbols symbols of varying, clip-safe audio', () => {
    const engine = makeEngine();
    engine.setToneOrders(new Array(TONE_COUNT).fill(4));

    const audio = engine.modulateQamWarmupSymbols();
    expect(audio.length).toBe(OFDM_TUNING.qamWarmupSymbols * SYM_LEN);

    // Non-stationary: consecutive symbols must differ, or the mic DSP adapts
    // to (then attenuates) a stationary multi-tone — the same failure the
    // settle symbols exist to avoid.
    let identicalPairs = 0;
    for (let s = 1; s < OFDM_TUNING.qamWarmupSymbols; s++) {
      let same = true;
      for (let i = 0; i < SYM_LEN; i++) {
        if (audio[(s - 1) * SYM_LEN + i] !== audio[s * SYM_LEN + i]) {
          same = false;
          break;
        }
      }
      if (same) identicalPairs++;
    }
    expect(identicalPairs).toBe(0);

    // Same clip budget as every other symbol on the wire.
    let peak = 0;
    for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
    expect(peak).toBeLessThanOrEqual(0.95);
  });

  it('warm-up matches PAYLOAD loudness, not the louder ref burst', () => {
    // Bench (2026-07-31, 40 tones): corner-loud warm-up settled the chain
    // ~1.5 dB HOTTER than the payload that followed it, so the gain
    // re-adapted downward across the header frames (QD g 0.84 -> 0.73) and
    // the first header failed FLAT (SM spr=4 — a pure level error). The
    // warm-up sits between the refs and the data, and its job is to leave
    // the chain in the state the DATA will see — so it must sound like data.
    const engine = makeEngine();
    engine.setToneOrders(new Array(TONE_COUNT).fill(4));

    const rms = (a: Float32Array): number => {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i] * a[i];
      return Math.sqrt(s / a.length);
    };
    const payloadBytes = new Uint8Array(160);
    let seed = 12345;
    for (let i = 0; i < payloadBytes.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      payloadBytes[i] = (seed >>> 16) & 0xff;
    }
    const warmup = engine.modulateQamWarmupSymbols();
    const payload = engine.modulateFrame(payloadBytes);
    const ratioDb = 20 * Math.log10(rms(warmup) / rms(payload));
    expect(Math.abs(ratioDb)).toBeLessThan(1.0);
  });

  it(
    'TX inserts a warm-up segment for a QAM map, and none when all-QPSK',
    () => {
      const payload = new Uint8Array(64);
      for (let i = 0; i < 64; i++) payload[i] = i;

      const warmupLen = OFDM_TUNING.qamWarmupSymbols * SYM_LEN;

      // frameSegments is private; reach in deliberately — segment boundaries
      // are exactly what this test is about, and the public APIs concatenate
      // them away.
      const segmentsOf = (tx: TxEngine): Float32Array[] =>
        Array.from(
          (tx as unknown as { frameSegments(n: string, d: Uint8Array): Generator<Float32Array> })
            .frameSegments('a.bin', payload),
        );

      expect(segmentsOf(makeTx(QAM16_MAP)).some((seg) => seg.length === warmupLen)).toBe(true);
      expect(segmentsOf(makeTx(undefined)).some((seg) => seg.length === warmupLen)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'roundtrip with a 16-QAM map still decodes byte-exact (RX skips the warm-up)',
    () => {
      const payload = new Uint8Array(128);
      for (let i = 0; i < 128; i++) payload[i] = (i * 7 + 3) & 0xff;

      const tx = makeTx(QAM16_MAP);
      const rx = makeRx();
      const audio = tx.transmitFile('w.bin', payload);
      for (let i = 0; i < audio.length; i++) rx.feedSample(audio[i]);
      const tail = new Float32Array(SYM_LEN * 8);
      for (let i = 0; i < tail.length; i++) rx.feedSample(tail[i]);

      const file = rx.getFile();
      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
    },
    TIMEOUT,
  );
});
