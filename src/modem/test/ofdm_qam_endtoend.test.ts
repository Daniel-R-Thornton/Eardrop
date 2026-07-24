/**
 * ofdm_qam_endtoend.test.ts — Phase 3 part 2, full pipeline oracle.
 *
 * TxEngine (emitLinkProfile=true + a QAM qamMap) → RxEngine: the profile
 * announces the per-tone map at the base (all-QPSK) rate, RX applies it
 * right after parsing the profile, and header+data+tail — modulated at the
 * announced rate — decode byte-exact. Covers an all-16QAM map and a mixed
 * map, plus confirms the default (no qamMap) path is unaffected.
 */
import { describe, it, expect } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';
import { DEFAULT_LINK_PROFILE, ordersToQamMap } from '../protocol/linkProfile';
import type { QamOrder } from '../modulation/constellation';
import { ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;
const TONE_COUNT = 4;
const TIMEOUT = 30000;
const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);

function makeTx(emitLinkProfile: boolean, qamMap?: number[]) {
  return new TxEngine({
    useOFDM: true,
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: TONE_COUNT,
    emitLinkProfile,
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

function runRoundtrip(
  tx: TxEngine,
  rx: RxEngine,
  payload: Uint8Array,
  fileName: string,
): ReceivedFile | null {
  const audio = tx.transmitFile(fileName, payload);
  for (let i = 0; i < audio.length; i++) rx.feedSample(audio[i]);
  const tail = symSamplesTail();
  for (let i = 0; i < tail.length; i++) rx.feedSample(tail[i]);
  return rx.getFile();
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

describe('Phase 3 part 2: TX qamMap → RX applies it → byte-exact decode', () => {
  it(
    'all-16QAM map: profile announces it, RX applies it, file decodes byte-exact',
    () => {
      const orders: QamOrder[] = new Array(TONE_COUNT).fill(4) as QamOrder[];
      const qamMap = ordersToQamMap(orders);
      const payload = randomPayload(200, 1);

      const tx = makeTx(true, qamMap);
      const rx = makeRx();
      const file = runRoundtrip(tx, rx, payload, 'qam16.bin');

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
      expect(rx.getLinkProfile().qamMap).toEqual(qamMap);
    },
    TIMEOUT,
  );

  it(
    'mixed QPSK/16-QAM/64-QAM map: profile announces it, RX applies it, file decodes byte-exact',
    () => {
      const orders: QamOrder[] = [];
      for (let t = 0; t < TONE_COUNT; t++) orders.push(([2, 4, 6] as const)[t % 3]);
      const qamMap = ordersToQamMap(orders);
      const payload = randomPayload(220, 2);

      const tx = makeTx(true, qamMap);
      const rx = makeRx();
      const file = runRoundtrip(tx, rx, payload, 'mixed.bin');

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
      expect(rx.getLinkProfile().qamMap).toEqual(qamMap);
    },
    TIMEOUT,
  );

  it(
    'all-64QAM map: byte-exact decode',
    () => {
      const orders: QamOrder[] = new Array(TONE_COUNT).fill(6) as QamOrder[];
      const qamMap = ordersToQamMap(orders);
      const payload = randomPayload(180, 3);

      const tx = makeTx(true, qamMap);
      const rx = makeRx();
      const file = runRoundtrip(tx, rx, payload, 'qam64.bin');

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
    },
    TIMEOUT,
  );

  it(
    'emitLinkProfile ON with no qamMap: stays on the all-QPSK default, decodes byte-exact',
    () => {
      const payload = randomPayload(96, 4);
      const tx = makeTx(true, undefined);
      const rx = makeRx();
      const file = runRoundtrip(tx, rx, payload, 'default.bin');

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
      expect(rx.getLinkProfile()).toEqual(DEFAULT_LINK_PROFILE(TONE_COUNT));
    },
    TIMEOUT,
  );
});
