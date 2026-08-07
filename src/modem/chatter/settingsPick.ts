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
 *   4. The pilot is part of a candidate, not derived after one wins (see
 *      `pilotFor`). For a window whose first tone is W, pilotFreqHz =
 *      W - MIN_TONE_START_HZ, and the window is admissible only if that
 *      pilot lands inside the swept grid and within MAX_PILOT_RATIO of the
 *      window's top tone. Inadmissible windows are skipped, so an unusable
 *      band is never scored — and step 3's toneCount ladder falls back to a
 *      narrower band rather than emitting one that cannot be demodulated.
 *      toneStartHz is then W - pilotFreqHz = MIN_TONE_START_HZ: an OFFSET
 *      above the pilot, NOT an absolute frequency — same semantics as
 *      ofdmToneFrequencies() and BandCard.toneStartHz elsewhere (first tone
 *      = pilotFreqHz + toneStartHz). Being exactly the global floor is what
 *      makes ofdmToneFrequencies' clamp a no-op on both TX and RX, so the
 *      band this module scores is the band that goes on the air.
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
import { MIN_TONE_START_HZ } from '../types';

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
  // 6300 + 600, not 6700 + 200: the old pair carried the same defect the
  // picked path did — an offset below MIN_TONE_START_HZ, clamped up by
  // ofdmToneFrequencies, putting the tones at 7300-7450 rather than the
  // 6900-7050 this comment claims. Same first tone, legal offset.
  pilotFreqHz: 6300,
  toneStartHz: MIN_TONE_START_HZ,
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
/**
 * Ceiling on topTone / pilot.
 *
 * The pilot is the phase reference every tone is demodulated against, and
 * the phase error it leaves scales with how far above it a tone sits — see
 * OFDM_HANDSHAKE's comment in types.ts for the measurement. Known points:
 * 1.48 (the handshake band, chosen deliberately, works over the air), 2.65
 * (a 32-tone window this module picked at the bottom of the sweep band —
 * receiver locked on at handoff score 0.904 and decoded nothing), and 3.9
 * (the original control band, never demodulated a single frame over the
 * air).
 *
 * Set at the only known-good point rather than somewhere between it and the
 * first known-bad one: the two failures bracket nothing useful, and a bound
 * guessed in the gap would be a third untested band. This is deliberately
 * conservative and costs bandwidth — a wide window low in the band stops
 * being admissible and the toneCount ladder drops to a narrower one. Widen
 * it when a real over-the-air MER measurement justifies a specific number,
 * the same discipline qamMap is held to below.
 */
export const MAX_PILOT_RATIO = 1.5;

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
  /** Absolute frequency of the window's FIRST tone. */
  firstToneHz: number;
  /** Absolute pilot frequency for this window. Part of the candidate, not
   *  derived after the choice — see `pilotFor`. */
  pilotFreqHz: number;
  score: number;
}

/**
 * The pilot for a window starting at `firstToneHz`, or null if this window
 * cannot carry a legal one — in which case it is not a candidate at all.
 *
 * The pilot used to be derived AFTER a window won, from a local 200 Hz
 * offset constant. Two things then went wrong silently. The offset was below
 * the modem's global MIN_TONE_START_HZ, so ofdmToneFrequencies raised it on
 * both TX and RX and slid every tone 400 Hz up, off the window that was
 * actually measured. And nothing checked the pilot at all: it could land
 * below the swept grid (never measured — 1300 Hz was observed) or far enough
 * under the top tone to make the constellation undecodable. Deriving it here,
 * as part of the candidate, is what makes those states unreachable rather
 * than merely unlikely.
 */
function pilotFor(firstToneHz: number, toneCount: number): number | null {
  // Exactly the floor, never below it: a smaller offset gets clamped up (see
  // above), a larger one buys nothing and only worsens the ratio.
  const pilotFreqHz = firstToneHz - MIN_TONE_START_HZ;
  // Below the sweep's low edge the pilot sits outside every report, so no
  // peer has measured whether it can even hear its own phase reference.
  if (pilotFreqHz < BAND_LOW_HZ) return null;
  const topToneHz = firstToneHz + (toneCount - 1) * TONE_SPACING_HZ;
  if (topToneHz / pilotFreqHz > MAX_PILOT_RATIO) return null;
  return pilotFreqHz;
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
    // Admissibility before scoring: a window that cannot hold a legal pilot
    // is not a worse candidate, it is not a candidate.
    const pilotFreqHz = pilotFor(start, toneCount);
    if (pilotFreqHz === null) continue;
    const score = Math.min(...toneMags(worst, start, toneCount));
    if (!best || score > best.score) best = { firstToneHz: start, pilotFreqHz, score };
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

    const { firstToneHz, pilotFreqHz } = window;
    // toneStartHz is an OFFSET above the pilot everywhere in this codebase
    // (ofdmToneFrequencies, OFDM_HANDSHAKE, BandCard), not an absolute
    // frequency. It equals MIN_TONE_START_HZ by construction — pilotFor
    // placed the pilot exactly that far below — which is what guarantees
    // ofdmToneFrequencies' clamp is a no-op and the band scored below is the
    // band transmitted.
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
