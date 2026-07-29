/**
 * bitLoading.test.ts — Phase 3 bit-loading threshold table.
 */
import { describe, expect, test } from 'vitest';
import { chooseBitLoading, QAM64_THRESHOLD_DB, QAM16_THRESHOLD_DB, BIT_LOADING_SAFETY_MARGIN_DB } from '../modulation/bitLoading';

describe('chooseBitLoading', () => {
  test('empty input yields empty output', () => {
    expect(chooseBitLoading([])).toEqual([]);
  });

  test('safety margin is subtracted from the nominal thresholds', () => {
    const qam64Cut = QAM64_THRESHOLD_DB - BIT_LOADING_SAFETY_MARGIN_DB;
    const qam16Cut = QAM16_THRESHOLD_DB - BIT_LOADING_SAFETY_MARGIN_DB;

    // Just below the 64-QAM cut → 16-QAM, not 64-QAM.
    expect(chooseBitLoading([qam64Cut - 0.01])).toEqual([4]);
    // Exactly at the cut → 64-QAM.
    expect(chooseBitLoading([qam64Cut])).toEqual([6]);
    // Just below the 16-QAM cut → QPSK.
    expect(chooseBitLoading([qam16Cut - 0.01])).toEqual([2]);
    // Exactly at the 16-QAM cut → 16-QAM.
    expect(chooseBitLoading([qam16Cut])).toEqual([4]);
  });

  test('high MER tones get 64-QAM', () => {
    expect(chooseBitLoading([30, 25, 19])).toEqual([6, 6, 6]);
  });

  test('mid MER tones get 16-QAM', () => {
    expect(chooseBitLoading([13, 15, 18.99])).toEqual([4, 4, 4]);
  });

  test('low/negative/zero MER tones fall back to QPSK, never dropped', () => {
    expect(chooseBitLoading([0, -5, 5, 12.99])).toEqual([2, 2, 2, 2]);
  });

  test('mixed per-tone map', () => {
    expect(chooseBitLoading([25, 14, 2, 20])).toEqual([6, 4, 2, 6]);
  });

  test('never returns an order below QPSK (2) or above 64-QAM (6)', () => {
    const orders = chooseBitLoading([-100, 0, 10, 15, 19, 25, 99]);
    for (const o of orders) {
      expect(o).toBeGreaterThanOrEqual(2);
      expect(o).toBeLessThanOrEqual(6);
    }
  });
});
