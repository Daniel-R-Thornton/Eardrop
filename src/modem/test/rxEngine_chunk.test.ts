/**
 * feedChunk must be byte-for-byte equivalent to per-sample feeding,
 * and getProgress must expose frame-assembly state for telemetry.
 */
import { expect, test } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';
import { ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;

function makeRx() {
  return new RxEngine({
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: 16,
    useOFDM: true,
  } as ConstructorParameters<typeof RxEngine>[0]);
}

test('feedChunk decodes a transfer identically to feedSample', () => {
  const data = new Uint8Array(200);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 1) & 0xff;
  const tx = new TxEngine({
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: 16,
    useOFDM: true,
  } as ConstructorParameters<typeof TxEngine>[0]);
  const audio = tx.transmitFile('chunk.bin', data);
  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  const tail = new Float32Array(symSamples * 8);

  const rx = makeRx();
  // Feed in worklet-sized chunks (128 samples)
  for (let off = 0; off < audio.length; off += 128) {
    rx.feedChunk(audio.subarray(off, Math.min(off + 128, audio.length)));
  }
  rx.feedChunk(tail);

  const file = (rx as unknown as { completedFile: ReceivedFile | null }).completedFile;
  expect(file).not.toBeNull();
  expect(Array.from(file!.data)).toEqual(Array.from(data));
});

test('getProgress reports state and frame counts', () => {
  const rx = makeRx();
  const p = rx.getProgress();
  expect(p.state).toBe(0); // RxState.WAITING
  expect(p.framesReceived).toBe(0);
  expect(p.totalFrames).toBe(0);
  expect(p.fileName).toBe('');
  expect(p.fileSize).toBe(0);
  expect(p.bytesAssembled).toBe(0);
});
