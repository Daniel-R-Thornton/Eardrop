/**
 * Test OFDM sync burst generation and direct frame decoding (CP enabled).
 */
import { expect, test } from 'vitest';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { encodeFrame } from '../protocol/atomicFrame';

const FFT_SIZE = 256;
const CP_LEN = 16;
const SYM_LEN = FFT_SIZE + CP_LEN;
const PILOT_FREQ = 487.5;

function makeDemod() {
  return new OFDMQPSKDemodulator({
    sampleRate: 3200, fftSize: FFT_SIZE, toneCount: 4,
    pilotFreqHz: PILOT_FREQ,
    toneFrequencies: new Float32Array([587.5, 687.5, 787.5, 887.5]),
    cpLength: CP_LEN,
  });
}

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
  const demod = makeDemod();
  const engine = new OFDMEngine({ pilotFreqHz: PILOT_FREQ, sampleRate: 3200, symbolsPerSec: 12.5 });

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
