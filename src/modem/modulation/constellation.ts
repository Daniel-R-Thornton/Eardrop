/**
 * Gray-coded square QAM constellations, normalized to EQUAL AVERAGE POWER
 * across orders — a 16-QAM tone and a QPSK tone carry the same mean energy,
 * so mixed-order OFDM symbols don't need per-tone loudness compensation.
 *
 * `QamOrder` is bits-per-tone (matches the Phase-4 profile's `qamMap` values:
 * 0 → 2 bits (QPSK), 1 → 4 bits (16-QAM), 2 → 6 bits (64-QAM)).
 *
 * Construction: a square constellation with `order` bits splits evenly into
 * `m = order / 2` bits for the I axis and `m` bits for the Q axis. Each axis
 * is an independent Gray-coded PAM ladder with levels
 * { -(2^m - 1), ..., -3, -1, 1, 3, ..., 2^m - 1 } (2^m evenly spaced odd
 * integers, symmetric about 0). The whole-constellation point is
 * (iLevel, qLevel) before normalization.
 *
 * Power normalization: the mean of the squares of an m-bit PAM ladder is
 * (4^m - 1) / 3 (sum of squares of the first 2^m odd integers, averaged) —
 * this is the standard closed form used for PAM/QAM average-power scaling.
 * A square QAM point has independent I/Q draws from that ladder, so the
 * unnormalized mean power is E[I^2] + E[Q^2] = 2 * (4^m - 1) / 3. Dividing
 * every coordinate by sqrt of that makes mean(|point|^2) === 1 for every
 * order — this is `normalizationScale(order)` below.
 *
 *   order=2 (QPSK,   m=1): unnormalized mean power = 2*(4-1)/3  = 2   → scale = 1/sqrt(2)
 *   order=4 (16-QAM, m=2): unnormalized mean power = 2*(16-1)/3 = 10  → scale = 1/sqrt(10)
 *   order=6 (64-QAM, m=3): unnormalized mean power = 2*(64-1)/3 = 42  → scale = 1/sqrt(42)
 */

export type QamOrder = 2 | 4 | 6;

export const QAM_ORDERS: readonly QamOrder[] = [2, 4, 6] as const;

export interface ConstellationPoint {
  re: number;
  im: number;
}

/** Bits per I/Q axis for a given order (order is always even by construction). */
function axisBits(order: QamOrder): number {
  return order / 2;
}

/** Unnormalized mean power (I^2 + Q^2) of the square constellation before scaling. */
function unnormalizedMeanPower(order: QamOrder): number {
  const m = axisBits(order);
  return (2 * (Math.pow(4, m) - 1)) / 3;
}

/** Scale applied to raw (odd-integer) I/Q levels so mean(|point|^2) === 1. */
export function normalizationScale(order: QamOrder): number {
  return 1 / Math.sqrt(unnormalizedMeanPower(order));
}

/**
 * Standard reflected binary Gray-code → binary conversion, generic over bit
 * width (used to turn each axis's Gray-coded index into its ladder position).
 */
function grayToBinary(gray: number): number {
  let b = gray;
  for (let mask = gray >>> 1; mask !== 0; mask >>>= 1) {
    b ^= mask;
  }
  return b;
}

function binaryToGray(binary: number): number {
  return binary ^ (binary >>> 1);
}

/** Raw (unscaled) odd-integer PAM level for a Gray-coded m-bit axis index. */
function grayIndexToLevel(gray: number, m: number): number {
  const levelCount = 1 << m;
  const binary = grayToBinary(gray);
  return 2 * binary - (levelCount - 1);
}

function levelToGrayIndex(level: number, m: number): number {
  const levelCount = 1 << m;
  const binary = (level + (levelCount - 1)) / 2;
  return binaryToGray(binary);
}

/** Max |point| magnitude for an order's normalized constellation (corner points). */
export function maxConstellationMagnitude(order: QamOrder): number {
  const m = axisBits(order);
  const maxLevel = (1 << m) - 1;
  const scale = normalizationScale(order);
  return Math.SQRT2 * maxLevel * scale;
}

/** Largest corner magnitude across every supported order — used by the modulator
 *  to size a fixed, order-independent TX scale (see OFDMQPSKModulator). */
export const MAX_QAM_MAGNITUDE = Math.max(...QAM_ORDERS.map(maxConstellationMagnitude));

/**
 * Gray-coded symbol → constellation point. `bits` is the integer symbol value
 * in [0, 2^order), split evenly into I (high half) and Q (low half) Gray
 * indices onto independent PAM ladders, then jointly power-normalized.
 */
export function mapSymbol(bits: number, order: QamOrder): ConstellationPoint {
  const m = axisBits(order);
  const mask = (1 << m) - 1;
  const qGray = bits & mask;
  const iGray = (bits >>> m) & mask;
  const scale = normalizationScale(order);
  const re = grayIndexToLevel(iGray, m) * scale;
  const im = grayIndexToLevel(qGray, m) * scale;
  return { re, im };
}

/**
 * Nearest-point demapper: recovers the Gray-coded symbol closest to (re, im).
 * Square Gray-coded QAM slices independently per axis (I and Q ladders don't
 * interact), so this quantizes each axis to its nearest ladder level rather
 * than brute-forcing all 2^order points — same result, O(1) instead of O(2^order).
 */
export function sliceSymbol(re: number, im: number, order: QamOrder): number {
  const m = axisBits(order);
  const scale = normalizationScale(order);
  const levelCount = 1 << m;
  const maxLevel = levelCount - 1;
  const quantize = (coord: number): number => {
    // Undo scale, round to nearest odd integer level, clamp to the ladder's range.
    let level = Math.round((coord / scale - 1) / 2) * 2 + 1;
    if (level > maxLevel) level = maxLevel;
    if (level < -maxLevel) level = -maxLevel;
    return level;
  };
  const iGray = levelToGrayIndex(quantize(re), m);
  const qGray = levelToGrayIndex(quantize(im), m);
  return (iGray << m) | qGray;
}

/**
 * Outer-corner symbol for an order — the constellation point with the
 * largest re+im (i.e. the (+max,+max) corner of the square). Used by the
 * QAM reference-symbol scheme (see OFDM_TUNING.qamRefSymbols): TX transmits
 * this exact known point per tone so RX can invert its equalizer against a
 * point it doesn't have to guess. Found by brute-force scan rather than a
 * closed form so it stays correct if the Gray-coding scheme above ever
 * changes — 2^order is tiny (≤64) so the scan is free.
 */
export function outerCornerSymbol(order: QamOrder): number {
  const count = 1 << order;
  let best = 0;
  let bestScore = -Infinity;
  for (let bits = 0; bits < count; bits++) {
    const { re, im } = mapSymbol(bits, order);
    const score = re + im;
    if (score > bestScore) {
      bestScore = score;
      best = bits;
    }
  }
  return best;
}

/** Constellation point for outerCornerSymbol(order) — see its doc. */
export function outerCornerPoint(order: QamOrder): ConstellationPoint {
  return mapSymbol(outerCornerSymbol(order), order);
}

/**
 * Deterministic per-tone phase for de-cohering the QAM reference symbols
 * (see OFDMEngine.modulateQamRefSymbols): without this, every tone transmits
 * the SAME outer-corner point, so all tones land phase-aligned and sum
 * coherently to a waveform peak that hard-clips the DAC (measured 2.5+ at 32
 * tones/16-QAM).
 *
 * A per-tone hash phase (e.g. a golden-ratio integer hash) makes the phases
 * look independent, but independence alone doesn't bound the peak: summing
 * `toneCount` sinusoids with i.i.d.-looking random phases still has a peak
 * that grows with toneCount (measured ~2.0–2.3 at 32 tones — not "well
 * under" the DAC limit). This uses the classic Newman/Schroeder phase
 * schedule instead — φ_t = −π·t·(t−1)/toneCount — a well-known deterministic
 * phase assignment for multicarrier PAPR reduction that spreads energy over
 * the symbol window rather than merely decorrelating it (measured peak
 * ~0.47–0.57 at 32 tones for 16-/64-QAM, comfortably under 1.0). TX and RX
 * both compute this from (toneIndex, toneCount) alone — no table to sync.
 */
export function qamRefPhase(toneIndex: number, toneCount: number): number {
  const raw = (-Math.PI * toneIndex * (toneIndex - 1)) / toneCount;
  const twoPi = 2 * Math.PI;
  return ((raw % twoPi) + twoPi) % twoPi;
}

/** Rotate a constellation point by `phase` (complex multiply by e^{jφ}) — magnitude unchanged. */
export function rotatePoint(point: ConstellationPoint, phase: number): ConstellationPoint {
  const cos = Math.cos(phase);
  const sin = Math.sin(phase);
  return {
    re: point.re * cos - point.im * sin,
    im: point.re * sin + point.im * cos,
  };
}

/** Phase-4 profile qamMap value (0/1/2) → bits-per-tone order. */
export function qamMapValueToOrder(value: 0 | 1 | 2): QamOrder {
  return value === 0 ? 2 : value === 1 ? 4 : 6;
}

/** Inverse of qamMapValueToOrder: bits-per-tone order → Phase-4 profile qamMap value. */
export function orderToQamMapValue(order: QamOrder): 0 | 1 | 2 {
  return order === 2 ? 0 : order === 4 ? 1 : 2;
}
