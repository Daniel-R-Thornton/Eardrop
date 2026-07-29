/**
 * bitLoading.ts — Phase 3 per-tone bit-loading policy.
 *
 * Pure function: given a measured per-tone MER (modulation error ratio, dB —
 * see OFDMQPSKDemodulator.getPerToneMER()), pick each tone's constellation
 * order. Conservative by design — a 3 dB safety margin is subtracted from
 * every threshold before comparing, so a tone sitting right at the nominal
 * boundary is *not* pushed to the denser scheme; only tones with real
 * headroom above it are. A tone that doesn't clear even the QPSK bar still
 * gets QPSK — bit-loading never removes a tone from the transmission.
 *
 * Thresholds (nominal, before the safety margin):
 *   >= 22 dB MER → 64-QAM (6 bits/tone)
 *   >= 16 dB MER → 16-QAM (4 bits/tone)
 *   otherwise    → QPSK   (2 bits/tone, the floor)
 */
import type { QamOrder } from './constellation';

/** Safety margin (dB) subtracted from every threshold before comparing. */
export const BIT_LOADING_SAFETY_MARGIN_DB = 3;

/** Nominal (pre-margin) MER threshold for 64-QAM. */
export const QAM64_THRESHOLD_DB = 22;
/** Nominal (pre-margin) MER threshold for 16-QAM. */
export const QAM16_THRESHOLD_DB = 16;

/**
 * Choose a per-tone QAM order from measured per-tone MER (dB). Never throws;
 * a tone below every threshold (including negative/zero MER, e.g. unmeasured
 * tones reported as 0 dB by getPerToneMER()) falls back to QPSK.
 */
export function chooseBitLoading(perToneMerDb: number[]): QamOrder[] {
  const qam64Cut = QAM64_THRESHOLD_DB - BIT_LOADING_SAFETY_MARGIN_DB;
  const qam16Cut = QAM16_THRESHOLD_DB - BIT_LOADING_SAFETY_MARGIN_DB;
  return perToneMerDb.map((merDb) => {
    if (merDb >= qam64Cut) return 6;
    if (merDb >= qam16Cut) return 4;
    return 2;
  });
}
