/**
 * OFDM loopback test — verify modulation → demodulation without audio channel.
 */
import { expect, test } from 'vitest';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { encodeFrame } from '../protocol/atomicFrame';

const TONE_COUNT = 4;
const FFT_SIZE = 256; const SYM_PER_SEC = 12.5;
const PILOT_FREQ = 487.5;
const TONE_FREQS = new Float32Array([587.5, 687.5, 787.5, 887.5]);

function makeMod() {
  return new OFDMQPSKModulator({
    sampleRate: 3200, toneCount: TONE_COUNT, ifftSize: FFT_SIZE,
    amplitude: 1.0, pilotFreqHz: PILOT_FREQ, pilotAmplitude: 0.4,
    toneFrequencies: TONE_FREQS, cpLength: 0,
  });
}

function makeDemod() {
  return new OFDMQPSKDemodulator({
    sampleRate: 3200, fftSize: FFT_SIZE, toneCount: TONE_COUNT,
    pilotFreqHz: PILOT_FREQ, toneFrequencies: TONE_FREQS, cpLength: 0,
  });
}

function testOneQPSK(symbols: number[], label: string): boolean {
  const mod = makeMod();
  const demod = makeDemod();
  mod.setSymbols(symbols);
  const audio = mod.generateSymbol();
  const result = demod.demodulate(audio);
  const expected: number[] = [];
  for (const s of symbols) {
    expected.push((s >> 1) & 1);
    expected.push(s & 1);
  }
  return result.bits.every((b, i) => b === expected[i]);
}

test('OFDM single symbol QPSK decoding — all 0°', () => {
  expect(testOneQPSK([0, 0, 0, 0], 'all-0')).toBe(true);
});

test('OFDM single symbol QPSK decoding — all 90°', () => {
  expect(testOneQPSK([1, 1, 1, 1], 'all-1')).toBe(true);
});

test('OFDM single symbol QPSK decoding — all 180°', () => {
  expect(testOneQPSK([2, 2, 2, 2], 'all-2')).toBe(true);
});

test('OFDM single symbol QPSK decoding — all 270°', () => {
  expect(testOneQPSK([3, 3, 3, 3], 'all-3')).toBe(true);
});

test('OFDM single symbol QPSK decoding — mixed', () => {
  expect(testOneQPSK([0, 1, 2, 3], 'mixed')).toBe(true);
  expect(testOneQPSK([3, 2, 1, 0], 'reverse')).toBe(true);
});

test('OFDM multi-symbol frame loopback', () => {
  const mod = makeMod();
  const demod = makeDemod();

  // Build a real atomic frame
  const payload = new Uint8Array(40);
  payload[0] = 0xde; payload[1] = 0xad; payload[2] = 0xbe; payload[3] = 0xef;
  const header = { type: 0x01 as const, seqNum: 0, totalFrames: 1, crc: 0 };
  const frame = encodeFrame(header, payload);

  // Modulate using nibble-based packing (matching OFDMEngine.modulateFrame)
  const totalSymbols = frame.length; // 1 byte per OFDM symbol
  const allAudio: Float32Array[] = [];
  for (let i = 0; i < totalSymbols; i++) {
    const byte = i < frame.length ? frame[i] : 0;
    const upper = (byte >> 4) & 0xf;
    const lower = byte & 0xf;
    const symbols: number[] = [];
    for (let t = 0; t < TONE_COUNT; t++) {
      const b0 = (upper >> (3 - t)) & 1;
      const b1 = (lower >> (3 - t)) & 1;
      symbols.push((b0 << 1) | b1);
    }
    mod.setSymbols(symbols);
    allAudio.push(mod.generateSymbol());
  }

  // Concatenate
  const totalLen = allAudio.reduce((a, b) => a + b.length, 0);
  const fullAudio = new Float32Array(totalLen);
  let off = 0;
  for (const p of allAudio) { fullAudio.set(p, off); off += p.length; }

  // Demodulate all symbols
  const decodedBits: number[] = [];
  for (let i = 0; i < totalSymbols; i++) {
    const start = i * FFT_SIZE;
    const window = fullAudio.slice(start, start + FFT_SIZE);
    const result = demod.demodulate(window);
    decodedBits.push(...result.bits);
  }

  // Expected bits using nibble-based packing
  const expectedBits: number[] = [];
  for (const byte of frame) {
    const upper = (byte >> 4) & 0xf;
    const lower = byte & 0xf;
    for (let t = 0; t < 4; t++) {
      expectedBits.push((upper >> (3 - t)) & 1);
      expectedBits.push((lower >> (3 - t)) & 1);
    }
  }
  const trimmed = decodedBits.slice(0, expectedBits.length);
  expect(trimmed).toEqual(expectedBits);
});
