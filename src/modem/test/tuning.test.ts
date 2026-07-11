/**
 * OFDM_TUNING invariants — the levers file must keep the sync burst long
 * enough to contain detection + alignment slack + training.
 */
import { expect, test } from 'vitest';
import { OFDM_TUNING } from '../types';

test('sync burst covers detection + alignment slack + training', () => {
  const floor = OFDM_TUNING.syncMinFrames + 2 + OFDM_TUNING.trainingSymbols;
  expect(OFDM_TUNING.syncBurstSymbols).toBeGreaterThanOrEqual(floor);
});

test('current default values', () => {
  expect(OFDM_TUNING).toEqual({
    syncBurstSymbols: 24,
    trainingSymbols: 12,
    syncMinFrames: 8,
    tailSilenceSymbols: 6,
  });
});
