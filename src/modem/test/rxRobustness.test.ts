/**
 * rxRobustness.test.ts — Task 3 (rxEngine protocol robustness) regression
 * coverage: seq-placed assembly (3a), the sliding sync-loss watchdog (3b),
 * chirp-handoff state resets (3c), COMPLETE→WAITING (3d), and switching the
 * profile on the first valid decode (3e).
 *
 * Scenarios:
 *  (i)   A multi-frame transfer with ONE payload frame's seq missing must
 *        NOT be delivered as a "complete" file (no silent byte-shift
 *        corruption). Exercised via direct processFrame() calls (encodeFrame
 *        + RxEngine's private processFrame), the same technique
 *        linkProfile_integration.test.ts already uses — this isolates the
 *        file-assembly logic from demodulation.
 *  (ii)  Two sequential, complete OFDM transmissions through ONE RxEngine
 *        instance must BOTH decode (today: the engine goes deaf/stuck after
 *        the first). Exercised via real feedSample() audio, since it
 *        exercises the chirp-handoff/COMPLETE state-machine resets.
 *  (iii) A profile whose second (redundant) copy never reaches the receiver
 *        intact must still let the transfer decode at the announced (non-
 *        default) QAM rate. Exercised via real feedSample() audio with the
 *        second profile copy's sample range zeroed in place (same wire
 *        duration, no information) — see the report for why "zeroed" was
 *        used instead of "excised/truncated": excising would desync the
 *        generic bit-serializer's frame-boundary tracking for the (fully
 *        intact) common case, which the 3e fix deliberately avoids by
 *        reserving exactly one base-rate profile-frame's worth of windows
 *        before committing the switch (see rxEngine.ts's
 *        profileSwitchCountdown).
 */
import { describe, it, expect } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';
import { ordersToQamMap } from '../protocol/linkProfile';
import type { QamOrder } from '../modulation/constellation';
import {
  encodeFrame,
  FRAME_TYPE_HEADER,
  FRAME_TYPE_PAYLOAD,
  FRAME_TYPE_TAIL,
  PAYLOAD_DATA_SIZE,
  FRAME_SIZE,
} from '../protocol/atomicFrame';
import { ofdmSamples, OFDM_TUNING } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;
const TONE_COUNT = 4;
const TIMEOUT = 30000;
const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);

function makeRx() {
  return new RxEngine({
    useOFDM: true,
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: TONE_COUNT,
  } as ConstructorParameters<typeof RxEngine>[0]);
}

function makeTx(emitLinkProfile = false, qamMap?: number[]) {
  return new TxEngine({
    useOFDM: true,
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: TONE_COUNT,
    emitLinkProfile,
    qamMap,
  } as ConstructorParameters<typeof TxEngine>[0]);
}

function tailRunoff(): Float32Array {
  return new Float32Array(SYM_LEN * 8);
}

function feed(rx: RxEngine, audio: Float32Array) {
  for (let i = 0; i < audio.length; i++) rx.feedSample(audio[i]);
}

function randomPayload(n: number, seed: number): Uint8Array {
  let a = seed;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256);
  return out;
}

/** Header payload matching processHeader's expected wire format (see rxEngine.ts). */
function buildHeaderPayload(fileName: string, totalSize: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(fileName);
  const payload = new Uint8Array(PAYLOAD_DATA_SIZE);
  let off = 0;
  // fileID (arbitrary, non-zero so it doesn't collide with the "no header yet" 0 default)
  payload[off++] = 0;
  payload[off++] = 0;
  payload[off++] = 0;
  payload[off++] = 0x2a;
  payload[off++] = totalSize & 0xff;
  payload[off++] = (totalSize >> 8) & 0xff;
  payload[off++] = (totalSize >> 16) & 0xff;
  payload[off++] = (totalSize >> 24) & 0xff;
  const nameLen = Math.min(nameBytes.length, PAYLOAD_DATA_SIZE - 9 - 5);
  payload[off++] = nameLen & 0xff;
  for (let i = 0; i < nameLen; i++) payload[off++] = nameBytes[i];
  payload[off++] = 0; // schemeId (raw)
  payload[off++] = totalSize & 0xff;
  payload[off++] = (totalSize >> 8) & 0xff;
  payload[off++] = (totalSize >> 16) & 0xff;
  payload[off++] = (totalSize >> 24) & 0xff;
  return payload;
}

function splitIntoPayloadFrames(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const n = Math.max(1, Math.ceil(data.length / PAYLOAD_DATA_SIZE));
  for (let i = 0; i < n; i++) {
    const chunk = data.slice(i * PAYLOAD_DATA_SIZE, (i + 1) * PAYLOAD_DATA_SIZE);
    const padded = new Uint8Array(PAYLOAD_DATA_SIZE);
    padded.set(chunk, 0);
    frames.push(padded);
  }
  return frames;
}

/** Drive a full header→payloads→tail sequence directly through processFrame(), skipping `dropSeq` if given. */
function runDirectTransfer(
  rx: RxEngine,
  fileName: string,
  data: Uint8Array,
  dropSeq?: number,
): void {
  const processFrame = (rx as unknown as { processFrame: (f: Uint8Array) => void }).processFrame.bind(rx);
  const dataFrames = splitIntoPayloadFrames(data);
  const totalFrames = dataFrames.length + 2;

  processFrame(
    encodeFrame({ type: FRAME_TYPE_HEADER, seqNum: 0, totalFrames, crc: 0 }, buildHeaderPayload(fileName, data.length)),
  );
  for (let i = 0; i < dataFrames.length; i++) {
    const seqNum = i + 1;
    if (seqNum === dropSeq) continue; // simulate a lost payload frame
    processFrame(
      encodeFrame({ type: FRAME_TYPE_PAYLOAD, seqNum, totalFrames, crc: 0 }, dataFrames[i]),
    );
  }
  processFrame(
    encodeFrame(
      { type: FRAME_TYPE_TAIL, seqNum: totalFrames - 1, totalFrames, crc: 0 },
      new Uint8Array(PAYLOAD_DATA_SIZE),
    ),
  );
}

describe('rxEngine robustness (Task 3)', () => {
  it('(i) a dropped payload frame must NOT be delivered as a complete file (3a)', () => {
    const rx = makeRx();
    const data = randomPayload(PAYLOAD_DATA_SIZE * 3 + 10, 11);

    runDirectTransfer(rx, 'drop.bin', data, /* dropSeq */ 2);

    // Must not silently deliver a corrupt (byte-shifted) file.
    expect(rx.getFile()).toBeNull();
  });

  it('(i control) the same multi-frame transfer with nothing dropped decodes byte-exact', () => {
    const rx = makeRx();
    const data = randomPayload(PAYLOAD_DATA_SIZE * 3 + 10, 11);

    runDirectTransfer(rx, 'nodrop.bin', data);

    const file = rx.getFile();
    expect(file).not.toBeNull();
    expect(Array.from(file!.data.slice(0, data.length))).toEqual(Array.from(data));
  });

  it(
    '(ii) two sequential transmissions through one RxEngine instance both decode (3c/3d)',
    () => {
      const tx = makeTx();
      const rx = makeRx();

      const payloadA = randomPayload(96, 21);
      const audioA = tx.transmitFile('first.bin', payloadA);
      feed(rx, audioA);
      feed(rx, tailRunoff());

      const fileA = rx.getFile();
      expect(fileA).not.toBeNull();
      expect(fileA!.fileName).toBe('first.bin');
      expect(Array.from(fileA!.data.slice(0, payloadA.length))).toEqual(Array.from(payloadA));

      // A little inter-transmission silence, as a real acoustic channel would have.
      feed(rx, new Float32Array(SYM_LEN * 4));

      const payloadB = randomPayload(140, 22);
      const audioB = tx.transmitFile('second.bin', payloadB);
      feed(rx, audioB);
      feed(rx, tailRunoff());

      const fileB = rx.getFile();
      expect(fileB).not.toBeNull();
      expect(fileB!.fileName).toBe('second.bin');
      expect(Array.from(fileB!.data.slice(0, payloadB.length))).toEqual(Array.from(payloadB));
    },
    TIMEOUT,
  );

  it(
    '(iii) profile decodes from only its first copy (second copy zeroed) — transfer still decodes at the announced rate (3e)',
    () => {
      const orders: QamOrder[] = new Array(TONE_COUNT).fill(4) as QamOrder[]; // all-16QAM
      const qamMap = ordersToQamMap(orders);
      const payload = randomPayload(200, 23);

      const tx = makeTx(true, qamMap);
      const rx = makeRx();

      const audio = tx.transmitFile('profile-once.bin', payload);

      // Locate + zero the SECOND profile copy's sample range in place (same
      // wire duration — see file header comment for why "zeroed" rather
      // than "excised"). Both copies are sent back-to-back, immediately
      // after the chirp+training preamble, at the base (all-QPSK) rate —
      // see txEngine's frameSegments.
      const preambleSamples = (OFDM_TUNING.syncBurstSymbols + OFDM_TUNING.trainingSymbols) * SYM_LEN;
      const blockCount = Math.max(1, Math.floor(TONE_COUNT / 4));
      const baseRateFrameSamples = Math.ceil(FRAME_SIZE / blockCount) * SYM_LEN;
      const copy2Start = preambleSamples + baseRateFrameSamples;
      const copy2End = copy2Start + baseRateFrameSamples;
      expect(copy2End).toBeLessThan(audio.length);
      for (let i = copy2Start; i < copy2End; i++) audio[i] = 0;

      feed(rx, audio);
      feed(rx, tailRunoff());

      const file = rx.getFile();
      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
      expect(rx.getLinkProfile().qamMap).toEqual(qamMap);
    },
    TIMEOUT,
  );
});
