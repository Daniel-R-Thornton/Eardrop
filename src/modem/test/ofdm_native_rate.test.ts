import { expect, test } from 'vitest';
import {
  OFDM_SYMBOL_MS,
  OFDM_CP_MS,
  ofdmSamples,
  ofdmToneFrequencies,
  OFDM_DEFAULTS,
} from '../types';

test('ofdmSamples derives integer windows at both common hardware rates', () => {
  expect(ofdmSamples(48000)).toEqual({ fftSamples: 1920, cpSamples: 240, symSamples: 2160 });
  expect(ofdmSamples(44100)).toEqual({ fftSamples: 1764, cpSamples: 221, symSamples: 1985 });
});

test('tone frequencies are absolute, on the symbol-duration grid', () => {
  const freqs = ofdmToneFrequencies({ toneCount: 16 });
  expect(freqs.length).toBe(16);
  expect(freqs[0]).toBe(2000);
  expect(freqs[15]).toBe(2750);
  const grid = 1000 / OFDM_SYMBOL_MS; // 25 Hz
  for (const f of freqs) expect(f % grid).toBe(0);
});

test('defaults: pilot below tone band, on grid', () => {
  expect(OFDM_DEFAULTS.pilotFreqHz).toBe(1900);
  expect(OFDM_DEFAULTS.pilotFreqHz % (1000 / OFDM_SYMBOL_MS)).toBe(0);
  expect(OFDM_DEFAULTS.pilotAmplitude).toBe(2.0);
  expect(OFDM_CP_MS).toBe(5);
});
