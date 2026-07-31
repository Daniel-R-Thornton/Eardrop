/**
 * ofdmGainSag.test.ts — pilot-referenced gain correction regression (see
 * plan-qam-gain-correction.md).
 *
 * Real audio chains (speaker-protection limiter, thermal compression) apply
 * level-dependent gain: the loud constant-envelope training burst gets
 * compressed harder than the quieter, fluctuating QAM data that follows, so
 * the amplitude reference trained on the sync burst is wrong for data
 * symbols by the time the whole file has been sent — magnitude drifts while
 * phase stays clean. This file has two cases:
 *
 *  1. Gain sag: a linear amplitude ramp (1.0 → 2.2) applied across the
 *     WHOLE waveform. Training happens near the start (ramp ~1.0x), so the
 *     trained channel estimate is essentially unaffected, but by the time
 *     the data region is reached, real gain has drifted well beyond what a
 *     fixed training-time amplitude reference tolerates. Without
 *     pilot-referenced per-symbol gain correction, this fails to decode.
 *  2. Unity regression: the same harness with gain 1.0 throughout — must
 *     still decode byte-exact (the fix must not disturb the no-sag case).
 */
import { describe, it, expect } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';
import { ordersToQamMap } from '../protocol/linkProfile';
import type { QamOrder } from '../modulation/constellation';
import { ofdmSamples, OFDM_TUNING } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;
const TONE_COUNT = 4;
const TIMEOUT = 30000;
const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);

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

function symSamplesTail(): Float32Array {
  return new Float32Array(SYM_LEN * 8);
}

/** Apply a linear amplitude ramp from `from` to `to` across the whole buffer. */
function applyGainRamp(audio: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(audio.length);
  const n = audio.length;
  for (let i = 0; i < n; i++) {
    const g = n > 1 ? from + ((to - from) * i) / (n - 1) : from;
    out[i] = audio[i] * g;
  }
  return out;
}

function runRoundtrip(
  tx: TxEngine,
  rx: RxEngine,
  payload: Uint8Array,
  fileName: string,
  gainFrom: number,
  gainTo: number,
): ReceivedFile | null {
  const audio = tx.transmitFile(fileName, payload);
  const gained = applyGainRamp(audio, gainFrom, gainTo);
  for (let i = 0; i < gained.length; i++) rx.feedSample(gained[i]);
  const tail = symSamplesTail();
  for (let i = 0; i < tail.length; i++) rx.feedSample(tail[i]);
  return rx.getFile();
}

/**
 * Multiply every sample AFTER the sync+training preamble by `factor` —
 * a crude model of a level-dependent-gain (expander-like) audio chain that
 * attenuates the quieter, fluctuating post-training content (profile/ref/
 * header/data/tail) relative to the loud, constant-envelope training burst.
 * Attenuating the (QPSK, phase-only) profile frames too is fine — see
 * plan-qam-ref-symbols.md.
 */
function attenuateAfterPreamble(audio: Float32Array, factor: number): Float32Array {
  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  const boundary = (OFDM_TUNING.syncBurstSymbols + OFDM_TUNING.trainingSymbols) * symSamples;
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    out[i] = i < boundary ? audio[i] : audio[i] * factor;
  }
  return out;
}

function randomPayload(n: number, seed = 7): Uint8Array {
  let a = seed;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256);
  return out;
}

describe('OFDM QAM: pilot-referenced per-symbol gain correction', () => {
  it(
    'gain sag (1.0 -> 2.2 ramp across the whole waveform): 16-QAM decodes byte-exact',
    () => {
      const orders: QamOrder[] = new Array(TONE_COUNT).fill(4) as QamOrder[];
      const qamMap = ordersToQamMap(orders);
      const payload = randomPayload(2000, 11);

      const tx = makeTx(qamMap);
      const rx = makeRx();
      const file = runRoundtrip(tx, rx, payload, 'gainsag.bin', 1.0, 2.2);

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
    },
    TIMEOUT,
  );

  it(
    'unity gain (no sag): 16-QAM still decodes byte-exact',
    () => {
      const orders: QamOrder[] = new Array(TONE_COUNT).fill(4) as QamOrder[];
      const qamMap = ordersToQamMap(orders);
      const payload = randomPayload(200, 12);

      const tx = makeTx(qamMap);
      const rx = makeRx();
      const file = runRoundtrip(tx, rx, payload, 'unity.bin', 1.0, 1.0);

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
    },
    TIMEOUT,
  );
});

/**
 * QAM reference-symbol calibration (see plan-qam-ref-symbols.md). Real audio
 * chains apply level-dependent, frequency-dependent gain: QAM data arrives at
 * a different amplitude than the training-derived channel estimate predicts,
 * which the deterministic qamRefScale ratio alone can never correct. The
 * known reference symbols TX inserts after the profile frames let RX re-fit
 * each tone's channel estimate at the ACTUAL data amplitude instead.
 */
describe('OFDM QAM: reference-symbol amplitude calibration', () => {
  it(
    'expander simulation (0.5x attenuation of everything after the preamble): 16-QAM decodes byte-exact',
    () => {
      const orders: QamOrder[] = new Array(TONE_COUNT).fill(4) as QamOrder[];
      const qamMap = ordersToQamMap(orders);
      const payload = randomPayload(2000, 21);

      const tx = makeTx(qamMap);
      const rx = makeRx();
      const audio = tx.transmitFile('expander.bin', payload);
      const attenuated = attenuateAfterPreamble(audio, 0.5);
      for (let i = 0; i < attenuated.length; i++) rx.feedSample(attenuated[i]);
      const tail = symSamplesTail();
      for (let i = 0; i < tail.length; i++) rx.feedSample(tail[i]);
      const file = rx.getFile();

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
    },
    TIMEOUT,
  );

  it(
    'unity gain regression: 16-QAM with the new ref-symbol wire format still decodes byte-exact',
    () => {
      const orders: QamOrder[] = new Array(TONE_COUNT).fill(4) as QamOrder[];
      const qamMap = ordersToQamMap(orders);
      const payload = randomPayload(200, 22);

      const tx = makeTx(qamMap);
      const rx = makeRx();
      const file = runRoundtrip(tx, rx, payload, 'refunity.bin', 1.0, 1.0);

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
    },
    TIMEOUT,
  );

  it('all-QPSK regression: no qamMap means no ref symbols are inserted (waveform length unchanged)', () => {
    const payload = randomPayload(200, 23);
    const tx = makeTx(undefined);
    const audio = tx.transmitFile('allqpsk.bin', payload);

    // Same transmission with an all-QPSK (order 2 on every tone) qamMap
    // must also be byte/length-identical — the plan requires order-2-only
    // maps to be indistinguishable from no qamMap at all.
    const allQpskOrders: QamOrder[] = new Array(TONE_COUNT).fill(2) as QamOrder[];
    const tx2 = makeTx(ordersToQamMap(allQpskOrders));
    const audio2 = tx2.transmitFile('allqpsk.bin', payload);

    expect(audio2.length).toBe(audio.length);
    expect(Array.from(audio2)).toEqual(Array.from(audio));
  });
});
