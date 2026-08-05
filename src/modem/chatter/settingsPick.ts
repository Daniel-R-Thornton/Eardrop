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
 *   4. Let W = the chosen window's absolute first-tone frequency. pilotFreqHz
 *      = W - 200 Hz (clamped >= 200, always a multiple of 50 — same "pilot
 *      sits below the tones" convention as OFDM_DEFAULTS / OFDM_HANDSHAKE).
 *      toneStartHz is then W - pilotFreqHz: an OFFSET above the pilot, NOT an
 *      absolute frequency — same semantics as ofdmToneFrequencies() and
 *      BandCard.toneStartHz elsewhere in this codebase (first tone =
 *      pilotFreqHz + toneStartHz).
 *   5. toneGains: TX headroom is capped at unity, so we can't boost weak
 *      tones — we attenuate strong ones instead. Each tone's raw gain is
 *      1/mag; dividing every raw gain by the largest one pins the WEAKEST
 *      tone (which needs the least reduction) at 1 and scales every
 *      stronger tone down from there.
 *   6. qamMap: QPSK on every tone. The grid this negotiates from is
 *      peak-relative, which measures FLATNESS, not signal-to-noise — and
 *      only the latter can justify denser QAM. See the note at the qamMap
 *      assignment for the hardware failure that established this.
 */
import { REPORT_GRID } from '../protocol/probeBurst';
import { BAND_CARD_TONE_COUNTS } from '../protocol/bandCard';

export interface PeerReport {
  deviceId: number;
  /** Linear mags on REPORT_GRID. */
  grid: number[];
}

export interface PickedSettings {
  /** Absolute pilot frequency in Hz. */
  pilotFreqHz: number;
  /** Hz ABOVE the pilot (an offset, not an absolute frequency) — same
   *  semantics as OFDM config / BandCard: first tone = pilotFreqHz + toneStartHz. */
  toneStartHz: number;
  toneCount: number;
  /** bits/symbol per tone: 2 | 4 | 6, length = toneCount */
  qamMap: number[];
  /** linear per-tone TX gains, length = toneCount, max 1 */
  toneGains: number[];
  /** true when no band cleared the threshold and the worst-case floor was used */
  floor: boolean;
}

/** Worst-case floor: QPSK, 4 tones at 6900-7050 Hz. This no longer has
 *  anything to do with OFDM_HANDSHAKE — that band moved to 2600-2950 Hz
 *  precisely because 6900-7250 was found to be the worst part of a phone's
 *  speaker/mic response. This floor's rationale ("proved itself") is now
 *  stale: the room's last-resort fallback sits exactly where the control
 *  plane was evacuated from. Left as-is because changing it is a design
 *  decision needing its own measurement, tracked separately. */
export const FLOOR_SETTINGS: PickedSettings = {
  pilotFreqHz: 6700,
  toneStartHz: 200,
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
/** Pilot sits this far below the first tone (mirrors OFDM_DEFAULTS: pilot
 *  1900 Hz, first tone 2000 Hz — a 100 Hz gap; we use a slightly wider one
 *  here since the picked band can start as low as 1500 Hz). */
const PILOT_OFFSET_HZ = 200;
/** Floor for the clamp below — keeps toneStartHz >= 50 Hz even at the very
 *  bottom of the sweep band, so the offset never collapses to 0 (band-card
 *  bins must be >= 1). */
const PILOT_MIN_HZ = 200;

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
  /** Absolute frequency of the window's FIRST tone (not yet split into
   *  pilot + offset — see step 4 in the header comment). */
  firstToneHz: number;
  score: number;
}

/**
 * Best-scoring (widest-tolerant) window for a given toneCount, or null if no
 * window fits in the sweep band at all.
 *
 * NOTE, UNGUARDED HAZARD — the search range includes the handshake band's sync
 * chirp. OFDM_HANDSHAKE.chirpCenterHz is 4400 Hz with a 200 Hz span, and this
 * search runs 1500-7800 Hz, so any 32-tone window starting between 2850 and
 * 4400 Hz contains it. It precedes the band card that announces the very window
 * chosen here, so a window containing 4400 Hz is one whose band gets compressed
 * by that chirp and released across the frames that follow — the documented
 * 17 dB-swing geometry (see OFDM_TUNING.chirpCenterHz for the measurement, and
 * OFDM_HANDSHAKE.chirpCenterHz for why this is not excluded here rather than
 * simply not noticed).
 *
 * How big the hazard is, honestly: the chirp is 800 ms
 * (OFDM_TUNING.chirpSymbols) at amplitude 0.12 (OFDM_TUNING.chirpAmplitude —
 * 0.6 was tried and detected WORSE, partly because it compressed the chain), so
 * it is NOT the loudest thing in the transmission by peak; the preamble symbols
 * reach ~0.63. What drives the mechanism is concentration, not peak: the chain
 * compresses per band, and a sustained narrow sweep is the shape it adapts to,
 * where a multi-tone grid of the same total power was measured untouched. So the
 * risk is real but far smaller than the 0.6 figure this note first carried
 * would imply — which matters for sizing the measurement below, not just for
 * accuracy.
 *
 * Left unexcluded on purpose: carving 4300-4500 out of the search would
 * disqualify most candidate windows in the 2-4 kHz region phone hardware
 * scores best in, on a hypothesis, while the band position itself is still
 * awaiting its first over-the-air measurement. Flagged for that measurement
 * instead.
 */
function bestWindow(worst: number[], toneCount: number): Window | null {
  // Span from the first tone to the last is (toneCount-1) spacings, not
  // toneCount*50 — a toneCount-tone comb has toneCount-1 gaps between tones.
  const width = (toneCount - 1) * TONE_SPACING_HZ;
  const maxStart = BAND_HIGH_HZ - width;
  if (maxStart < BAND_LOW_HZ) return null;

  let best: Window | null = null;
  for (let start = BAND_LOW_HZ; start <= maxStart; start += SLIDE_STEP_HZ) {
    const score = Math.min(...toneMags(worst, start, toneCount));
    if (!best || score > best.score) best = { firstToneHz: start, score };
  }
  return best;
}

/** Pick one set of TX settings every reporting peer can survive. */
export function pickSettings(reports: PeerReport[]): PickedSettings {
  if (reports.length === 0) return FLOOR_SETTINGS;
  for (const report of reports) {
    if (report.grid.length !== REPORT_GRID.points) {
      throw new Error(
        `settingsPick: report from device ${report.deviceId} has ${report.grid.length} points, expected ${REPORT_GRID.points}`,
      );
    }
  }

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

    const { firstToneHz } = window;
    // pilotFreqHz/toneStartHz split: toneStartHz is an OFFSET above the
    // pilot everywhere else in this codebase (ofdmToneFrequencies,
    // OFDM_HANDSHAKE, BandCard), not an absolute frequency — see step 4.
    const pilotFreqHz = Math.max(PILOT_MIN_HZ, firstToneHz - PILOT_OFFSET_HZ);
    const toneStartHz = firstToneHz - pilotFreqHz;
    const mags = toneMags(worst, firstToneHz, toneCount).map((m) => Math.max(m, MIN_MAG));
    const windowMax = Math.max(...mags);

    const rawGains = mags.map((m) => 1 / m);
    const maxRawGain = Math.max(...rawGains);
    const toneGains = rawGains.map((g) => g / maxRawGain);

    // QPSK everywhere, deliberately, until something measures absolute SNR.
    //
    // This used to read bit density off each tone's level RELATIVE to the
    // window's strongest tone: >= -6 dB got 6 bits, >= -12 got 4. That is a
    // flatness measure, and flatness says nothing about signal-to-noise. A
    // channel can be ruler-flat and still sit 15 dB above the noise, and 64-QAM
    // wants around 26 dB of MER.
    //
    // Hardware showed exactly that failure. A room measured -0.7 dB across the
    // handshake band — beautifully flat — so nearly every tone was assigned 6
    // bits. The receiver then hopped to the right band, locked on with a
    // handoff score of 0.985, heard the transmission at full strength, and
    // decoded not one frame: not the data, not even the link profile.
    // Perfect sync, undecodable constellation.
    //
    // The probe grid we negotiate from is peak-relative by construction (see
    // step 1), so it CANNOT justify anything denser. QPSK is also what the
    // bench path actually succeeds with over the air. Restore per-tone
    // loading when a real MER measurement exists to drive it — the map stays
    // per-tone so that change is local to this function.
    const qamMap = mags.map(() => 2);

    return { pilotFreqHz, toneStartHz, toneCount, qamMap, toneGains, floor: false };
  }

  return FLOOR_SETTINGS;
}
