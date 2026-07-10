/**
 * OFDM acoustic-path regression tests — native-rate (48 kHz).
 *
 * Uses the new time-domain constants: 40 ms symbol + 5 ms CP.
 * Tone frequencies are absolute Hz on the 25 Hz grid.
 */
import { expect, test } from 'vitest';
import { RxEngine } from '../protocol/rxEngine';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { encodeFrame } from '../protocol/atomicFrame';
import { ofdmSamples } from '../types';

const PILOT_FREQ = 1900;
const SAMPLE_RATE = 48000;
const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);
const SYNC_COUNT = 24;

function buildTransmission(toneCount = 16): { tx: Float32Array; frame: Uint8Array } {
  const engine = new OFDMEngine({ pilotFreqHz: PILOT_FREQ, sampleRate: SAMPLE_RATE, toneCount });
  const payload = new Uint8Array(40);
  payload.set([0xde, 0xad, 0xbe, 0xef]);
  const header = { type: 0x01 as const, seqNum: 0, totalFrames: 1, crc: 0 };
  const frame = encodeFrame(header, payload);

  const sync = engine.generateSyncBurst(SYNC_COUNT);
  const dataAudio = engine.modulateFrame(frame);
  const tx = new Float32Array(sync.length + dataAudio.length);
  tx.set(sync, 0);
  tx.set(dataAudio, sync.length);
  return { tx, frame };
}

function receive(audio: Float32Array, toneCount = 16): Uint8Array | null {
  const rx = new RxEngine({
    pilotFreqHz: PILOT_FREQ,
    sampleRate: SAMPLE_RATE,
    toneCount,
    useOFDM: true,
  } as ConstructorParameters<typeof RxEngine>[0]);

  let received: Uint8Array | null = null;
  const {scanner} = (rx as unknown as { scanner: { onFrame: (f: Uint8Array) => void } });
  scanner.onFrame = (f: Uint8Array) => {
    received ??= f;
  };

  for (const sample of audio) rx.feedSample(sample);
  for (let i = 0; i < SYM_LEN * 6; i++) rx.feedSample(0);
  return received;
}

test('OFDM acoustic path: decodes with misaligned window grid', () => {
  const { tx, frame } = buildTransmission();
  // 1000 leading silence samples → window grid offset 1000 mod symSamples (outside CP)
  const audio = new Float32Array(1000 + tx.length);
  audio.set(tx, 1000);

  const received = receive(audio);
  expect(received, 'frame should decode despite window-grid misalignment').not.toBeNull();
  expect(Array.from(received as Uint8Array)).toEqual(Array.from(frame));
});

test('OFDM acoustic path: decodes with 100-sample delay (inside CP)', () => {
  const { tx, frame } = buildTransmission();
  // 100-sample delay — ~2 ms, well inside the 240-sample CP at 48 kHz
  const audio = new Float32Array(100 + tx.length);
  audio.set(tx, 100);

  const received = receive(audio);
  expect(received, 'frame should decode despite channel delay').not.toBeNull();
  expect(Array.from(received as Uint8Array)).toEqual(Array.from(frame));
});

test('OFDM acoustic path: 32 tones — 4 bytes/symbol', () => {
  const { tx, frame } = buildTransmission(32);
  // 32 tones → 8 blocks → 8 bytes/symbol → frame airtime = ceil(79/8) symbols
  const expectedDataSymbols = Math.ceil(frame.length / 8);
  expect(tx.length).toBe((SYNC_COUNT + expectedDataSymbols) * SYM_LEN);
  const audio = new Float32Array(1000 + tx.length);
  audio.set(tx, 1000);

  const received = receive(audio, 32);
  expect(received, '32-tone frame should decode').not.toBeNull();
  expect(Array.from(received as Uint8Array)).toEqual(Array.from(frame));
});
