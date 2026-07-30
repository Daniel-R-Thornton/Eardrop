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

test('dataQamBits=2 (QPSK, default): no link profile emitted', () => {
  const cfg = buildModemConfig({ ...UI, dataQamBits: 2 });
  expect(cfg.emitLinkProfile).toBeFalsy();
  expect(cfg.qamMap).toBeUndefined();
});

test('dataQamBits omitted: defaults to QPSK, no link profile emitted', () => {
  const cfg = buildModemConfig(UI);
  expect(cfg.emitLinkProfile).toBeFalsy();
  expect(cfg.qamMap).toBeUndefined();
});

test('dataQamBits=4 (16-QAM) with OFDM: emits link profile, qamMap all 1s', () => {
  const cfg = buildModemConfig({ ...UI, dataQamBits: 4 });
  expect(cfg.emitLinkProfile).toBe(true);
  expect(cfg.qamMap).toEqual(new Array(UI.toneCount).fill(1));
});

test('dataQamBits=6 (64-QAM) with OFDM: emits link profile, qamMap all 2s', () => {
  const cfg = buildModemConfig({ ...UI, dataQamBits: 6 });
  expect(cfg.emitLinkProfile).toBe(true);
  expect(cfg.qamMap).toEqual(new Array(UI.toneCount).fill(2));
});

test('dataQamBits=4 without OFDM: never emits link profile', () => {
  const cfg = buildModemConfig({ ...UI, useOFDM: false, dataQamBits: 4 });
  expect(cfg.emitLinkProfile).toBeFalsy();
  expect(cfg.qamMap).toBeUndefined();
});

// ─── toneStartHz snapping (same reasoning as pilotFreqHz above) ───────────

test('toneStartHz omitted: defaults to 2000Hz, already bin-aligned', () => {
  const cfg = buildModemConfig(UI);
  expect(cfg.toneStartHz).toBe(2000);
});

test('toneStartHz off the 50Hz bin grid gets snapped to the nearest bin', () => {
  const cfg = buildModemConfig({ ...UI, toneStartHz: 1025 });
  // 48000/960 = 50Hz bins; 1025 is 0.5 bins off, rounds to the nearest (1050).
  expect(cfg.toneStartHz).toBe(1050);
});

test('toneStartHz below the 600Hz floor is snapped, then floor-clamped', () => {
  const cfg = buildModemConfig({ ...UI, toneStartHz: 100 });
  expect(cfg.toneStartHz).toBe(600);
});

test('toneStartHz snapping is skipped for non-OFDM configs', () => {
  const cfg = buildModemConfig({ ...UI, useOFDM: false, toneStartHz: 1025 });
  // Not OFDM: no FFT-bin invariant to preserve, so the value passes through
  // unsnapped (still floor-clamped against the separation guard).
  expect(cfg.toneStartHz).toBe(1025);
});
