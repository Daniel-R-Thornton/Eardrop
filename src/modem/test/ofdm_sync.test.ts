/**
 * Test OFDM sync burst generation and direct frame decoding (CP enabled).
 */
import { expect, test } from 'vitest';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { encodeFrame } from '../protocol/atomicFrame';
import { ofdmSamples, ofdmToneFrequencies } from '../types';

const SAMPLE_RATE = 48000;
const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);
const PILOT_FREQ = 1900;
const TONE_FREQS = ofdmToneFrequencies({ toneCount: 4 });
const SYNC_COUNT = 24;

function nibbleBits(byte: number): number[] {
  const upper = (byte >> 4) & 0xf;
  const lower = byte & 0xf;
  const bits: number[] = [];
  for (let t = 0; t < 4; t++) {
    bits.push((upper >> (3 - t)) & 1);
    bits.push((lower >> (3 - t)) & 1);
  }
  return bits;
}

test('OFDM sync burst + frame decodes correctly with CP', () => {
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

  const payload = new Uint8Array(40);
  payload[0] = 0xde; payload[1] = 0xad;
  payload[2] = 0xbe; payload[3] = 0xef;
  const header = { type: 0x01 as const, seqNum: 0, totalFrames: 1, crc: 0 };
  const frame = encodeFrame(header, payload);

  const dataAudio = engine.modulateFrame(frame);
  const totalSymbols = Math.ceil(frame.length);

  const decodedBits: number[] = [];
  for (let sym = 0; sym < totalSymbols; sym++) {
    const start = sym * SYM_LEN;
    const win = dataAudio.slice(start, start + SYM_LEN);
    const result = demod.demodulate(win);
    decodedBits.push(...result.bits);
  }

  const expectedBits: number[] = [];
  for (const byte of frame) {
    expectedBits.push(...nibbleBits(byte));
  }

  const trimmed = decodedBits.slice(0, expectedBits.length);
  expect(trimmed).toEqual(expectedBits);
});
