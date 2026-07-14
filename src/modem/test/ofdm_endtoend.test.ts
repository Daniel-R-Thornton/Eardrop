/**
 * Full end-to-end OFDM test with CP.
 */
import { expect, test } from 'vitest';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { encodeFrame } from '../protocol/atomicFrame';
import { ofdmSamples, ofdmToneFrequencies } from '../types';

const PILOT_FREQ = 1900;
const TONE_FREQS = ofdmToneFrequencies({ toneCount: 4, pilotFreqHz: PILOT_FREQ });
const SAMPLE_RATE = 48000;
const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);
const SYNC_COUNT = 24;

function makeTrainedDemod() {
  const engine = new OFDMEngine({ pilotFreqHz: PILOT_FREQ, sampleRate: SAMPLE_RATE, toneCount: 4 });
  const demod = new OFDMQPSKDemodulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: TONE_FREQS,
    pilotFreqHz: PILOT_FREQ,
  });
  // Train on first 12 sync symbols
  const sync = engine.generateSyncBurst(SYNC_COUNT);
  for (let s = 0; s < 12; s++) {
    const start = s * SYM_LEN;
    demod.trainOnSyncSymbol(sync.slice(start, start + SYM_LEN));
  }
  return { engine, demod, sync };
}

test('E2E: sync → skip → frame decode with CP', () => {
  const { engine, demod, sync } = makeTrainedDemod();

  const payload = new Uint8Array(40);
  payload[0] = 0xde; payload[1] = 0xad; payload[2] = 0xbe; payload[3] = 0xef;
  const header = { type: 0x01 as const, seqNum: 0, totalFrames: 1, crc: 0 };
  const frame = encodeFrame(header, payload);

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
