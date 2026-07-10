/**
 * Full end-to-end OFDM test with CP.
 */
import { expect, test } from 'vitest';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { encodeFrame } from '../protocol/atomicFrame';

const PILOT_FREQ = 600;
const TONE_FREQS = new Float32Array([700, 800, 900, 1000]);
const FFT_SIZE = 256;
const CP_LEN = 16;
const SYM_LEN = FFT_SIZE + CP_LEN;
const SYNC_COUNT = 24;

function makeDemod() {
  return new OFDMQPSKDemodulator({
    sampleRate: 3200, fftSize: FFT_SIZE, toneCount: 4,
    pilotFreqHz: PILOT_FREQ, toneFrequencies: TONE_FREQS, cpLength: CP_LEN,
  });
}

test('E2E: sync → skip → frame decode with CP', () => {
  const engine = new OFDMEngine({ pilotFreqHz: PILOT_FREQ, sampleRate: 3200 });
  const demod = makeDemod();

  const payload = new Uint8Array(40);
  payload[0] = 0xde; payload[1] = 0xad; payload[2] = 0xbe; payload[3] = 0xef;
  const header = { type: 0x01 as const, seqNum: 0, totalFrames: 1, crc: 0 };
  const frame = encodeFrame(header, payload);

  const sync = engine.generateSyncBurst(SYNC_COUNT);
  const data = engine.modulateFrame(frame);
  const tx = new Float32Array(sync.length + data.length);
  tx.set(sync, 0);
  tx.set(data, sync.length);

  // Skip sync, decode data (each symbol is SYM_LEN samples)
  const pos = SYNC_COUNT * SYM_LEN;
  const totalDataSymbols = Math.ceil(frame.length);
  const decodedBits: number[] = [];
  for (let sym = 0; sym < totalDataSymbols; sym++) {
    const start = pos + sym * SYM_LEN;
    const win = tx.slice(start, start + SYM_LEN);
    const result = demod.demodulate(win);
    decodedBits.push(...result.bits);
  }

  const expectedBits: number[] = [];
  for (const byte of frame) {
    const upper = (byte >> 4) & 0xf;
    const lower = byte & 0xf;
    for (let t = 0; t < 4; t++) {
      expectedBits.push((upper >> (3 - t)) & 1);
      expectedBits.push((lower >> (3 - t)) & 1);
    }
  }
  expect(decodedBits.slice(0, expectedBits.length)).toEqual(expectedBits);
});
