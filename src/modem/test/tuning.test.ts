/**
 * OFDM_TUNING invariants — the levers file must keep the sync burst long
 * enough to contain detection + alignment slack + training.
 */
import { expect, test } from 'vitest';
import { OFDM_TUNING } from '../types';

test('sync burst covers detection + alignment slack + settle + training', () => {
  // See OFDM_TUNING's INVARIANT. The settle term is easy to forget and its
  // absence does not fail loudly — the receiver silently trains on data
  // symbols and the frame just never decodes.
  const floor =
    OFDM_TUNING.syncMinFrames
    + 2
    + OFDM_TUNING.trainingSettleSymbols
    + OFDM_TUNING.trainingSymbols;
  // chirpSymbols is excluded on purpose: the chirp is the loudest part of the
  // transmission and the settle period exists to recover from it, so coupling
  // the two would lengthen the chirp every time the settle period grew.
  // The energy-sync path reads training out of the sync burst itself, so the
  // burst must also cover the slack the chirp path gets as extra symbols.
  expect(OFDM_TUNING.syncBurstSymbols).toBeGreaterThanOrEqual(floor);
});

test('current default values', () => {
  expect(OFDM_TUNING).toEqual({
    syncBurstSymbols: 40,
    chirpSymbols: 32,
    chirpCenterHz: 1850,
    trainingSymbols: 12,
    trainingSettleSymbols: 16,
    syncMinFrames: 8,
    tailSilenceSymbols: 6,
    cpCorrelationMinScore: 0.35,
    cpCorrelationMinSharpness: 1.1,
    qamRefSymbols: 4,
    qamWarmupSymbols: 40,
    chirpAmplitude: 0.12,
  });
});
