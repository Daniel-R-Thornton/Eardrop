/**
 * Test OFDM modulation/demodulation with pilot-phase correction.
 * Each individual QPSK symbol is decoded correctly through toneIQ + phase detection.
 */
import { expect, test } from 'vitest';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { ofdmToneFrequencies } from '../types';

const PILOT_FREQ = 1900;
const TONE_FREQS = ofdmToneFrequencies({ toneCount: 4 });
const SAMPLE_RATE = 48000;

function makeMod() {
  return new OFDMQPSKModulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: TONE_FREQS,
    pilotFreqHz: PILOT_FREQ,
    pilotAmplitude: 0.4,
  });
}

function makeTrainedDemod() {
  const mod = makeMod();
  const demod = new OFDMQPSKDemodulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: TONE_FREQS,
    pilotFreqHz: PILOT_FREQ,
  });
  // Train with 12 sync symbols (all phase 0)
  mod.setSymbols([0, 0, 0, 0]);
  for (let s = 0; s < 12; s++) demod.trainOnSyncSymbol(mod.generateSymbol());
  return { mod, demod };
}

function testOneQPSK(symbols: number[], label: string): boolean {
  const { mod, demod } = makeTrainedDemod();
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
