/**
 * handshakeGains.ts — per-tone pre-emphasis for the FIXED handshake band.
 *
 * The control plane has a bootstrap problem the file path does not: its band
 * is fixed and must work before anything has been negotiated, so TxEngine
 * deliberately sends it with flat gains. That is fine on a flat channel and
 * bad on a real one — the handshake tones sit at 2600-2950 Hz, and a control
 * frame that dies there takes the whole exchange with it.
 *
 * But the curve is not actually unknown. A peer's WELCOME/REPORT carries the
 * response IT measured from OUR probe sweep (`theirViewOfUs`), which is
 * precisely the path our transmission takes to reach it. This turns that
 * measurement into gains for the eight handshake tones.
 *
 * Direction matters and is easy to get backwards: pre-emphasis must use what
 * the RECEIVER heard of US, never what we heard of them. Those are different
 * channels — different speaker, different mic — which is exactly why one
 * direction of a room can work while the other does not.
 */
import { OFDM_DEFAULTS, OFDM_HANDSHAKE } from '../types';
import { REPORT_GRID } from '../protocol/probeBurst';

/**
 * Never amplify above unity. The handshake band's amplitude is already set to
 * a safe scale for its tone count; boosting a weak tone past that clips the
 * output stage, and a clipped burst is worse than a quiet one. Correction is
 * therefore expressed as attenuating the STRONG tones down toward the weak
 * ones, which costs level but keeps the constellation honest.
 */
const MAX_GAIN = 1;

/**
 * Floor on how far a tone may be pulled down. Without it a single deep notch
 * in the measured curve drags every other tone to near-silence chasing it,
 * throwing away far more level than the notch ever cost.
 */
const MIN_GAIN = 0.25;

/** Linear response at `hz`, interpolated from the 100 Hz report grid. */
function responseAt(grid: number[], hz: number): number {
  // The grid is uniform, so the index is arithmetic — no need to search
  // reportGridFreqs(). Tones sit on a 50 Hz spacing inside a 100 Hz grid, so
  // half of them land between points and must be interpolated.
  const pos = (hz - REPORT_GRID.startHz) / REPORT_GRID.stepHz;
  if (pos <= 0) return grid[0];
  if (pos >= grid.length - 1) return grid[grid.length - 1];
  const i = Math.floor(pos);
  const frac = pos - i;
  return grid[i] * (1 - frac) + grid[i + 1] * frac;
}

/** Frequency of handshake tone `t`. */
export function handshakeToneHz(t: number): number {
  return OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz + t * OFDM_DEFAULTS.toneSpacingHz;
}

/**
 * The measured response AT each of the eight handshake tones, linear.
 *
 * Split out from `handshakeToneGains` because the same eight numbers answer a
 * question the gains cannot: whether one control tone is sitting in a null.
 * The band mean hides exactly that case, and a dead tone is not a level
 * problem — it puts 2 bad bits in EVERY QPSK symbol, ~4 error positions per
 * 63-bit BCH codeword against a t=6 budget, which a 1-chunk ACK survives and
 * a 12-chunk REPORT does not.
 *
 * KNOWN LIMIT: REPORT_GRID is sampled every 100 Hz and the tones are 50 Hz
 * apart, so every second tone here is INTERPOLATED between grid points. A
 * notch narrower than 100 Hz can sit between two samples and not appear at
 * all — a clean profile is therefore weaker evidence than a bad one.
 */
export function handshakeToneMags(grid: number[] | undefined): number[] | undefined {
  if (!grid || grid.length !== REPORT_GRID.points) return undefined;
  const mags: number[] = [];
  for (let t = 0; t < OFDM_HANDSHAKE.toneCount; t++) mags.push(responseAt(grid, handshakeToneHz(t)));
  return mags;
}

/**
 * Per-tone gains for the handshake band from a peer's measured view of us.
 *
 * Returns undefined when the curve cannot support a decision — no grid yet,
 * or a silent one — so the caller keeps the flat behaviour rather than
 * inventing a correction from nothing.
 */
export function handshakeToneGains(theirViewOfUs: number[] | undefined): number[] | undefined {
  const mags = handshakeToneMags(theirViewOfUs);
  if (!mags) return undefined;

  const strongest = Math.max(...mags);
  if (!(strongest > 0)) return undefined;

  // Inverse response, normalised so the loudest tone keeps unity gain: every
  // other tone is attenuated to match it, never boosted past it.
  const weakest = Math.max(Math.min(...mags), strongest * MIN_GAIN);
  return mags.map((m) => {
    const usable = Math.max(m, weakest);
    return Math.min(MAX_GAIN, Math.max(MIN_GAIN, weakest / usable));
  });
}
