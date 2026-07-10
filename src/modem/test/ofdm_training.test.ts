/**
 * Test OFDM modulation/demodulation with pilot-phase correction.
 * Each individual QPSK symbol is decoded correctly through FFT + phase detection.
 */
import { expect, test } from 'vitest';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';

const PILOT_FREQ = 600;
const TONE_FREQS = new Float32Array([700, 800, 900, 1000]);

function makeMod() {
  return new OFDMQPSKModulator({
    sampleRate: 3200, toneCount: 4, ifftSize: 256,
    amplitude: 0.5, pilotFreqHz: PILOT_FREQ, pilotAmplitude: 0.4,
    toneFrequencies: TONE_FREQS, cpLength: 0,
  });
}

function makeDemod() {
  return new OFDMQPSKDemodulator({
    sampleRate: 3200, fftSize: 256, toneCount: 4,
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

test('OFDM pilot-phase corrected QPSK — all 0°', () => {
  expect(testOneQPSK([0, 0, 0, 0], 'all-0')).toBe(true);
});

test('OFDM pilot-phase corrected QPSK — all 90°', () => {
  expect(testOneQPSK([1, 1, 1, 1], 'all-1')).toBe(true);
});

test('OFDM pilot-phase corrected QPSK — all 180°', () => {
  expect(testOneQPSK([2, 2, 2, 2], 'all-2')).toBe(true);
});

test('OFDM pilot-phase corrected QPSK — all 270°', () => {
  expect(testOneQPSK([3, 3, 3, 3], 'all-3')).toBe(true);
});

test('OFDM pilot-phase corrected QPSK — mixed', () => {
  expect(testOneQPSK([0, 1, 2, 3], 'mixed')).toBe(true);
  expect(testOneQPSK([3, 2, 1, 0], 'reverse')).toBe(true);
});
