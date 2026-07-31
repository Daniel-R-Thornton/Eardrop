/**
 * The objective the auto-tune sweep maximises, and the one place the meaning of
 * "better link" lives. Both the hunt (which climbs it) and the final "best"
 * pick use this, so they can never disagree.
 */
import type { SpeedTestResult } from '../Store';

/** Floor for a trial that delivered the whole file. No failure can reach it. */
const SUCCESS_BASE = 2e6;
/**
 * Throughput weight for successes. Large enough that a real throughput
 * difference can never be outvoted by the MER tiebreak below (kbps differences
 * of 0.05 are worth 500 points; MER spans at most ~99).
 */
const KBPS_WEIGHT = 1e4;

/**
 * Score a trial; higher is better.
 *
 * Two regimes, and the split matters:
 *
 * SUCCESS — the file arrived, so signal quality has already done its job and is
 * no longer the goal; delivered bits are. Ranking successes by MER was a real
 * bug: a working 16-QAM link measured 15.8 dB while a working QPSK link measured
 * 30 dB, and because both rounded to the same throughput the MER term decided
 * and the sweep discarded the faster constellation. MER now only breaks ties
 * between successes of equal throughput, and cannot overturn one.
 *
 * FAILURE — nothing to rank by throughput, so rank by how close it got:
 * data frames decoded, then how far sync progressed, then MER as the finest
 * continuous gradient. PROFILE frames are excluded upstream (they ride at QPSK
 * whatever the data constellation is, so they decode even when nothing works).
 */
export function scoreTrial(r: SpeedTestResult): number {
  // getMER() returns 99 as an "immeasurably clean" sentinel; clamp so it cannot
  // distort the tiebreak.
  const mer = Math.min(r.merDb ?? r.rawMerDb ?? 0, 99);

  if (r.success) {
    return SUCCESS_BASE + r.throughputKbps * KBPS_WEIGHT + mer;
  }

  return (r.dataFramesOk ?? r.framesOk) * 1e3 + (r.syncLevel ?? 0) * 50 + mer;
}
