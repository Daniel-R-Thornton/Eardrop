/**
 * OFDM acoustic-path regression tests.
 *
 * The in-memory OFDM tests decode with hand-aligned symbol windows and a
 * clean channel, which never exercises the real RX path. These tests feed
 * a full transmission (sync burst + atomic frame) through RxEngine
 * sample-by-sample, reproducing the two acoustic failure modes:
 *
 *  1. Arbitrary window-grid offset — the receiver starts listening at a
 *     random point, so its 272-sample window grid is misaligned with the
 *     TX symbol grid (only ~6% of offsets land within the cyclic prefix).
 *  2. Per-tone channel phase — even with an aligned grid, a real channel
 *     rotates each tone's constellation by a different phase (here a pure
 *     8-sample delay: −2π·bin·8/256 per bin).
 */
import { expect, test } from 'vitest';
import { RxEngine } from '../protocol/rxEngine';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { encodeFrame } from '../protocol/atomicFrame';

const PILOT_FREQ = 600;
const SAMPLE_RATE = 3200;
const SYM_LEN = OFDMEngine.FFT_SIZE + OFDMEngine.CP_LENGTH;
const SYNC_COUNT = 24;

function buildTransmission(toneCount = 4): { tx: Float32Array; frame: Uint8Array } {
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

/** Feed audio through RxEngine, capture any frame the sentinel scanner emits. */
function receive(audio: Float32Array, toneCount = 4): Uint8Array | null {
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
  // Trailing silence so any buffered windows flush through
  for (let i = 0; i < SYM_LEN * 4; i++) rx.feedSample(0);
  return received;
}

test('OFDM acoustic path: decodes with misaligned window grid', () => {
  const { tx, frame } = buildTransmission();
  // 100 leading silence samples → window grid offset 100 mod 272 (outside CP)
  const audio = new Float32Array(100 + tx.length);
  audio.set(tx, 100);

  const received = receive(audio);
  expect(received, 'frame should decode despite window-grid misalignment').not.toBeNull();
  expect(Array.from(received as Uint8Array)).toEqual(Array.from(frame));
});

test('OFDM acoustic path: 8 tones — 2 bytes/symbol, misaligned grid + delay', () => {
  const { tx, frame } = buildTransmission(8);
  // 8 tones must carry 2 bytes per OFDM symbol: frame airtime halves.
  const expectedDataSymbols = Math.ceil(frame.length / 2);
  expect(tx.length).toBe((SYNC_COUNT + expectedDataSymbols) * SYM_LEN);
  // Worst case: arbitrary grid offset AND channel delay
  const audio = new Float32Array(100 + tx.length);
  audio.set(tx, 100);

  const received = receive(audio, 8);
  expect(received, '8-tone frame should decode').not.toBeNull();
  expect(Array.from(received as Uint8Array)).toEqual(Array.from(frame));
});

test('OFDM acoustic path: decodes with per-tone channel phase (8-sample delay)', () => {
  const { tx, frame } = buildTransmission();
  // Grid-aligned start, but the channel delays the signal by 8 samples —
  // inside the CP, so timing is fine, yet every tone's constellation
  // rotates by a different phase (−bin·11.25°).
  const audio = new Float32Array(8 + tx.length);
  audio.set(tx, 8);

  const received = receive(audio);
  expect(received, 'frame should decode despite per-tone channel phase').not.toBeNull();
  expect(Array.from(received as Uint8Array)).toEqual(Array.from(frame));
});
