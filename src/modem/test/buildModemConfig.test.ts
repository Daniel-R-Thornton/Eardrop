/**
 * buildModemConfig — the ONE place UI state becomes a ModemConfig.
 * Regression fence for the 2026-07-10 toneCount-omission bug.
 */
import { expect, test } from 'vitest';
import { buildModemConfig } from '../../ui/controllers/buildModemConfig';
import { DEFAULT_CONFIG } from '../types';

const UI = {
  useOFDM: true,
  pilotFreqHz: 1900,
  toneCount: 32,
  symbolsPerSec: 50,
  musicalMode: false,
  diversityMode: false,
  hwSampleRate: 48000,
};

test('OFDM: hardware sample rate, explicit toneCount and symbolsPerSec', () => {
  const cfg = buildModemConfig(UI);
  expect(cfg.sampleRate).toBe(48000);
  expect(cfg.toneCount).toBe(32);
  expect(cfg.symbolsPerSec).toBe(50);
  expect(cfg.useOFDM).toBe(true);
  expect(cfg.pilotFreqHz).toBe(1900);
});

test('BPSK: modem native rate', () => {
  const cfg = buildModemConfig({ ...UI, useOFDM: false, pilotFreqHz: 600, toneCount: 4 });
  expect(cfg.sampleRate).toBe(DEFAULT_CONFIG.sampleRate);
  expect(cfg.useOFDM).toBe(false);
  expect(cfg.toneCount).toBe(4);
  expect(cfg.bitsPerFrame).toBe(8);
});
