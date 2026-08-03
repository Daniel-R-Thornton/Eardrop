/**
 * Settings intersection — one set of TX settings every receiver in the
 * chatter room can survive.
 *
 * Before broadcasting, the sender has collected a probe-sweep report
 * (REPORT_GRID, see probeBurst.ts) from every peer in the room: 64 linear
 * magnitudes describing how that peer's mic+speaker+room hears 1500-7800 Hz.
 * Picking a band that only suits the loudest peer would strand the quietest
 * one; this module intersects ALL of them into a single band/QAM/gain plan,
 * pessimistically, before a single symbol goes out.
 *
 * Algorithm:
 *   1. Worst-peer grid: normalize each report to its OWN max first (absolute
 *      levels differ per mic/gain), then take the per-point MIN across
 *      reports. A point is only as good as its worst listener.
 *   2. Candidate bands: try toneCount 32, 16, 8, 4 in that order (widest —
 *      most bits/symbol headroom — first) and slide a toneCount*50Hz window
 *      across 1500-7800 Hz in 100 Hz steps. A window's score is its worst
 *      tone (grid is 100 Hz, tones 50 Hz apart, so nearest-grid-point lookup
 *      is within the grid's own resolution).
 *   3. Accept the first (widest) toneCount with any window scoring above
 *      -18 dB relative to full scale (1.0 — each report's own peak, post
 *      normalization), using that toneCount's best-scoring window. If
 *      nothing clears -18 dB at any width, the room has no band everyone
 *      can hear well enough — fall back to FLOOR_SETTINGS.
 *   4. toneStartHz = window start; pilotFreqHz sits 100 Hz below it (clamped
 *      >= 1500), same "pilot just under the tones" convention as
 *      OFDM_DEFAULTS.
 *   5. toneGains: TX headroom is capped at unity, so we can't boost weak
 *      tones — we attenuate strong ones instead. Each tone's raw gain is
 *      1/mag; dividing every raw gain by the largest one pins the WEAKEST
 *      tone (which needs the least reduction) at 1 and scales every
 *      stronger tone down from there.
 *   6. qamMap: each tone's margin, in dB relative to the selected window's
 *      own strongest tone, sets bit density — dense QAM only where the
 *      worst peer clearly has margin to spare.
 */
import { REPORT_GRID } from '../protocol/probeBurst';
import { BAND_CARD_TONE_COUNTS } from '../protocol/bandCard';

export interface PeerReport {
  deviceId: number;
  /** Linear mags on REPORT_GRID. */
  grid: number[];
}

export interface PickedSettings {
  pilotFreqHz: number;
  toneStartHz: number;
  toneCount: number;
  /** bits/symbol per tone: 2 | 4 | 6, length = toneCount */
  qamMap: number[];
  /** linear per-tone TX gains, length = toneCount, max 1 */
  toneGains: number[];
  /** true when no band cleared the threshold and the worst-case floor was used */
  floor: boolean;
}

/** Worst-case floor: QPSK, 4 tones, right where the handshake band already
 *  proved itself (OFDM_HANDSHAKE tones start at 6900 Hz). */
export const FLOOR_SETTINGS: PickedSettings = {
  pilotFreqHz: 6800,
  toneStartHz: 6900,
  toneCount: 4,
  qamMap: [2, 2, 2, 2],
  toneGains: [1, 1, 1, 1],
  floor: true,
};

const WIDEST_FIRST_TONE_COUNTS = [...BAND_CARD_TONE_COUNTS].sort((a, b) => b - a);
const SLIDE_STEP_HZ = 100;
const BAND_LOW_HZ = REPORT_GRID.startHz;
const BAND_HIGH_HZ = REPORT_GRID.startHz + (REPORT_GRID.points - 1) * REPORT_GRID.stepHz;
const TONE_SPACING_HZ = 50;
const THRESHOLD_DB = -18;
const MIN_MAG = 1e-9;

function dbToLinearRatio(db: number): number {
  return Math.pow(10, db / 20);
}

function nearestGridIndex(freqHz: number): number {
  const idx = Math.round((freqHz - REPORT_GRID.startHz) / REPORT_GRID.stepHz);
  return Math.min(Math.max(idx, 0), REPORT_GRID.points - 1);
}

/** Per-point min of each report normalized to its own max first. */
function worstPeerGrid(reports: PeerReport[]): number[] {
  const worst = new Array(REPORT_GRID.points).fill(Infinity);
  for (const report of reports) {
    const max = Math.max(...report.grid, MIN_MAG);
    for (let i = 0; i < REPORT_GRID.points; i++) {
      const normalized = report.grid[i] / max;
      if (normalized < worst[i]) worst[i] = normalized;
    }
  }
  return worst;
}

/** Tone magnitudes for a window (toneStartHz, toneCount), nearest-grid-point. */
function toneMags(worst: number[], toneStartHz: number, toneCount: number): number[] {
  const mags: number[] = [];
  for (let i = 0; i < toneCount; i++) {
    mags.push(worst[nearestGridIndex(toneStartHz + i * TONE_SPACING_HZ)]);
  }
  return mags;
}

interface Window {
  toneStartHz: number;
  score: number;
}

/** Best-scoring (widest-tolerant) window for a given toneCount, or null if
 *  no window fits in the sweep band at all. */
function bestWindow(worst: number[], toneCount: number): Window | null {
  const width = (toneCount - 1) * TONE_SPACING_HZ;
  const maxStart = BAND_HIGH_HZ - width;
  if (maxStart < BAND_LOW_HZ) return null;

  let best: Window | null = null;
  for (let start = BAND_LOW_HZ; start <= maxStart; start += SLIDE_STEP_HZ) {
    const score = Math.min(...toneMags(worst, start, toneCount));
    if (!best || score > best.score) best = { toneStartHz: start, score };
  }
  return best;
}

/** Pick one set of TX settings every reporting peer can survive. */
export function pickSettings(reports: PeerReport[]): PickedSettings {
  if (reports.length === 0) return FLOOR_SETTINGS;

  const worst = worstPeerGrid(reports);
  // Reference is 1.0, not max(worst): every report was normalized to its OWN
  // max, so 1.0 is "as good as it gets" for a single listener. Re-deriving
  // the reference from the already-intersected worst grid would make the
  // threshold self-relative and trivially satisfied even when every point is
  // uniformly terrible (e.g. two peers with disjoint audible ranges).
  const threshold = dbToLinearRatio(THRESHOLD_DB);

  for (const toneCount of WIDEST_FIRST_TONE_COUNTS) {
    const window = bestWindow(worst, toneCount);
    if (!window || window.score < threshold) continue;

    const { toneStartHz } = window;
    const pilotFreqHz = Math.max(BAND_LOW_HZ, toneStartHz - SLIDE_STEP_HZ);
    const mags = toneMags(worst, toneStartHz, toneCount).map((m) => Math.max(m, MIN_MAG));
    const windowMax = Math.max(...mags);

    const rawGains = mags.map((m) => 1 / m);
    const maxRawGain = Math.max(...rawGains);
    const toneGains = rawGains.map((g) => g / maxRawGain);

    const qamMap = mags.map((m) => {
      const relativeDb = 20 * Math.log10(m / windowMax);
      if (relativeDb >= -6) return 6;
      if (relativeDb >= -12) return 4;
      return 2;
    });

    return { pilotFreqHz, toneStartHz, toneCount, qamMap, toneGains, floor: false };
  }

  return FLOOR_SETTINGS;
}
