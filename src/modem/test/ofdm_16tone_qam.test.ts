import { describe, it, expect } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';
import { ordersToQamMap } from '../protocol/linkProfile';
import type { QamOrder } from '../modulation/constellation';
import { ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;
const TONE_COUNT = 16;
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
) {
  const audio = tx.transmitFile(fileName, payload);
  for (let i = 0; i < audio.length; i++) rx.feedSample(audio[i]);
  const tail = symSamplesTail();
  for (let i = 0; i < tail.length; i++) rx.feedSample(tail[i]);
  return rx.getFile();
}

function runStreamingRoundtrip(
  tx: TxEngine,
  rx: RxEngine,
  payload: Uint8Array,
  fileName: string,
) {
  for (const chunk of tx.streamChunks(fileName, payload, SAMPLE_RATE / 2)) {
    rx.feedChunk(chunk);
  }
  rx.feedChunk(symSamplesTail());
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

describe('16-tone QAM end-to-end', () => {
  it('all-16QAM map: profile announces it, RX applies it, file decodes byte-exact', () => {
    const orders: QamOrder[] = new Array(TONE_COUNT).fill(4) as QamOrder[];
    const qamMap = ordersToQamMap(orders);
    const payload = new Uint8Array(200);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 11) & 0xff;

    const tx = makeTx(true, qamMap);
    const rx = makeRx();
    const file = runRoundtrip(tx, rx, payload, 'qam16.bin');

    expect(file).not.toBeNull();
    expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
  });

  it('streaming Send File path decodes byte-exact across chunk boundaries', () => {
    const orders: QamOrder[] = new Array(TONE_COUNT).fill(4) as QamOrder[];
    const payload = randomPayload(400, 19);
    const tx = makeTx(true, ordersToQamMap(orders));
    const rx = makeRx();
    const file = runStreamingRoundtrip(tx, rx, payload, 'stream-qam16.bin');

    expect(file).not.toBeNull();
    expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
  });
});
