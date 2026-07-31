/**
 * channelSweep.ts — measure the real speaker→mic amplitude response, one
 * frequency at a time.
 *
 * WHY a stepped sweep and not the OFDM training profile: `[OFDM-TRAIN] h`
 * only reports the 8/16/32 frequencies the current tone grid happens to sit
 * on. That is far too coarse to tell a narrow acoustic cancellation notch
 * (which can be 20+ dB deep and only a few hundred Hz wide) from a broad
 * speaker rolloff, and it cannot see outside the configured band at all.
 * Diagnosing one from the other by moving the grid around and re-reading 32
 * numbers does not converge — this does.
 *
 * Method: play each frequency alone for stepMs, then measure each one with the
 * SAME single-bin Goertzel the modem uses (toneIQ), so the numbers are
 * directly comparable to `h`. Measurement is MAX-HOLD over a search window
 * around each step's expected position, which makes it insensitive to the
 * unknown (and variable) latency between playback and capture — no sync,
 * chirp, or frame alignment needed. The only alignment assumption is that the
 * steps arrive in the order they were played.
 */

import { toneIQ } from '../pilot';
import { OFDM_SYMBOL_MS } from '../types';

export interface SweepPlan {
  /** The stepped-sine waveform to play. */
  audio: Float32Array;
  /** Frequency of each step, in play order. */
  freqs: number[];
  /** Samples per step (including its fades). */
  stepSamples: number;
  sampleRate: number;
}

export interface SweepOptions {
  sampleRate: number;
  startHz: number;
  endHz: number;
  stepHz: number;
  /** Dwell per frequency. Must comfortably exceed the analysis window. */
  stepMs: number;
  /** Peak amplitude of each (single, pure) tone. */
  amplitude: number;
  /**
   * Optional per-frequency gain (linear), so the sweep can measure the response
   * a CALIBRATED transmission actually produces rather than predicting it from
   * the raw curve plus the gain table. Two measurements beat one measurement
   * and some arithmetic.
   */
  gainForFreq?: (freqHz: number) => number;
}

export const SWEEP_DEFAULTS: SweepOptions = {
  sampleRate: 48000,
  // Spans well past both edges of any band the tone grid can reach, so a
  // notch just outside the current grid is still visible.
  startHz: 1000,
  endHz: 9000,
  // 25 Hz — HALF the tone grid spacing, so every tone lands on a measured
  // point AND the shape between tones is visible. A notch narrower than the
  // grid reads as a single weak tone at 50 Hz resolution, which cannot be told
  // apart from a broad rolloff; at 25 Hz its width and depth are explicit.
  stepHz: 25,
  // Long enough that the 20 ms analysis window fits strictly inside a step with
  // slack for alignment error (see measureSweep), short enough that 321 steps
  // stay near 15 s.
  stepMs: 45,
  // MUST be comparable to the modem's own PER-TONE amplitude, not merely below
  // full scale.
  //
  // This was 0.25, chosen for SNR on the reasoning that one tone needs no
  // headroom for 32 carriers. That is ~20 dB hotter per tone than the grid's
  // qamScale (0.0151 at 40 tones), and the chain compresses sustained tones
  // hard at that level: the envelope probe measured 8x drive returning only
  // 1.55x received, i.e. 14 dB of compression. Two consequences, both bad for a
  // measurement tool:
  //
  //  - A compressor FLATTENS whatever it is fed, because louder frequencies are
  //    squashed harder. A loud sweep therefore under-reports response variation
  //    and can report a band as flat when it is not.
  //  - Pre-emphasis becomes invisible. Applying +9 dB to a tone already in
  //    compression changed the received level by 0-2 dB, which is how a
  //    calibrated sweep came back indistinguishable from the raw one.
  //
  // Callers that know the modem's qamScale should pass it explicitly; this
  // default is a conservative stand-in for the low end of that range.
  amplitude: 0.02,
};

/**
 * Build the stepped-sine sweep. Each step gets a short raised-cosine fade at
 * both ends: an abrupt start/stop would splatter energy across the spectrum
 * and leak into neighbouring steps' measurements, which is exactly the
 * artifact this tool must not manufacture.
 */
export function buildSweep(opts: SweepOptions = SWEEP_DEFAULTS): SweepPlan {
  const { sampleRate, startHz, endHz, stepHz, stepMs, amplitude, gainForFreq } = opts;
  const freqs: number[] = [];
  for (let f = startHz; f <= endHz; f += stepHz) freqs.push(f);

  const stepSamples = Math.round((stepMs / 1000) * sampleRate);
  const fadeSamples = Math.min(Math.round(0.005 * sampleRate), stepSamples >> 2);
  const audio = new Float32Array(freqs.length * stepSamples);

  for (let k = 0; k < freqs.length; k++) {
    const f = freqs[k];
    const base = k * stepSamples;
    for (let n = 0; n < stepSamples; n++) {
      let env = 1;
      if (n < fadeSamples) env = 0.5 - 0.5 * Math.cos((Math.PI * n) / fadeSamples);
      else if (n >= stepSamples - fadeSamples) {
        const m = stepSamples - 1 - n;
        env = 0.5 - 0.5 * Math.cos((Math.PI * m) / fadeSamples);
      }
      const g = gainForFreq ? gainForFreq(f) : 1;
      audio[base + n] = g * amplitude * env * Math.sin((2 * Math.PI * f * n) / sampleRate);
    }
  }

  return { audio, freqs, stepSamples, sampleRate };
}

/**
 * Goertzel magnitude at one frequency over one window, Hann-windowed.
 *
 * The Hann taper is essential here, not cosmetic. Steps are stepHz apart —
 * two bins of the 20 ms analysis window — and a bare rectangular window leaks
 * enough from those neighbours to put a floor around -15 dB on the measured
 * depth of any notch. That floor would make a genuine 26 dB null read as a
 * mild 15 dB dip, understating exactly the thing the tool exists to find.
 * Hann trades a little frequency resolution for far lower sidelobes.
 *
 * The taper costs a fixed 0.5x amplitude, compensated below so results stay in
 * the same units as `[OFDM-TRAIN] h` (it would cancel out of the dB figures
 * either way, but the raw magnitudes are meant to be comparable).
 */
function magAt(
  samples: Float32Array,
  offset: number,
  length: number,
  freq: number,
  sampleRate: number,
  scratch: Float32Array,
  useHann = true,
): number {
  if (!useHann) {
    // RECTANGULAR, for the grid burst only. A rectangular window of exactly
    // one OFDM symbol puts its nulls precisely on every other tone of a
    // 1/symbol-spaced grid — that orthogonality is the entire reason the modem
    // can read 32 simultaneous carriers, and it makes leakage between them
    // exactly zero. Hann would be strictly worse here: its main lobe is ~4
    // bins wide, so at 50 Hz spacing the immediate neighbours fall INSIDE it,
    // and a fully-removed tone still reads about -6 dB instead of nothing.
    const { i, q } = toneIQ(samples.subarray(offset, offset + length), freq, sampleRate);
    return Math.hypot(i, q);
  }
  for (let n = 0; n < length; n++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (length - 1));
    scratch[n] = samples[offset + n] * w;
  }
  const { i, q } = toneIQ(scratch.subarray(0, length), freq, sampleRate);
  return 2 * Math.hypot(i, q);
}

export interface SweepResult {
  freqs: number[];
  /** Max-hold magnitude per frequency, same units as `[OFDM-TRAIN] h`. */
  mags: number[];
  /** dB relative to the strongest frequency measured (so <= 0). */
  db: number[];
  /** Sample offset in the recording where step 0 was found. */
  alignOffset: number;
  /** True when no step stood out — recording is silence or the wrong stream. */
  failed: boolean;
}

/**
 * Measure the response from a recording of buildSweep()'s output.
 *
 * Alignment is recovered from the data, not assumed: pass 1 finds where step 0
 * actually landed by max-holding its own frequency across the whole recording,
 * then every later step is searched only within +/- searchSteps of where the
 * known schedule says it should be. That tolerates constant latency and slow
 * drift while still refusing to pick up a neighbour's energy.
 */
export function measureSweep(recorded: Float32Array, plan: SweepPlan): SweepResult {
  const { freqs, stepSamples, sampleRate } = plan;
  // One OFDM symbol body — same resolution the modem's own h is measured at.
  const winLen = Math.min(Math.round(0.02 * sampleRate), stepSamples);
  const hop = Math.max(1, Math.round(winLen / 4));
  const scratch = new Float32Array(winLen);

  // ── pass 1: find where step 0 STARTS, anywhere in the recording ──
  // Peak-picking alone is not enough. Any window fully inside step 0 reads
  // essentially the same magnitude, so the argmax lands on an arbitrary one of
  // them — in practice the LAST, biasing the estimate late by (step - window)
  // and pushing every subsequent step's window past its own boundary into the
  // next step. Since a boundary overlap is what floors measurable notch depth,
  // that bias silently caps the tool's whole dynamic range. So: find the peak
  // level first, then take the RISING EDGE (first crossing of half that
  // level), which tracks the step's leading fade rather than its interior.
  let bestMag = 0;
  for (let off = 0; off + winLen <= recorded.length; off += hop) {
    const m = magAt(recorded, off, winLen, freqs[0], sampleRate, scratch);
    if (m > bestMag) bestMag = m;
  }
  let alignOffset = 0;
  for (let off = 0; off + winLen <= recorded.length; off += hop) {
    const m = magAt(recorded, off, winLen, freqs[0], sampleRate, scratch);
    if (m >= 0.5 * bestMag) {
      alignOffset = off;
      break;
    }
  }

  const mags = new Array<number>(freqs.length).fill(0);
  // A pure tone at amplitude 0.25 through any working path clears this by
  // orders of magnitude; silence or a dead input does not.
  const failed = bestMag < 1e-6;

  if (!failed) {
    // The analysis window must stay ENTIRELY inside its own step. Every
    // window position that overlaps a neighbour max-holds that neighbour's
    // energy, and since the tool's whole job is measuring how little arrives
    // at one frequency, borrowing a loud neighbour's level puts a hard floor
    // (~15 dB) on any notch it can report. So the search runs only over the
    // slack between the step and the window, never past the step boundary.
    // Back the slack off by a hop at each end: the rising-edge estimate is
    // only accurate to one hop, and the leading fade is not full amplitude.
    const slack = Math.max(0, stepSamples - winLen - 2 * hop);
    for (let k = 0; k < freqs.length; k++) {
      const stepStart = alignOffset + k * stepSamples;
      const from = Math.max(0, stepStart);
      const to = Math.min(recorded.length - winLen, stepStart + slack);
      let peak = 0;
      for (let off = from; off <= to; off += hop) {
        const m = magAt(recorded, off, winLen, freqs[k], sampleRate, scratch);
        if (m > peak) peak = m;
      }
      mags[k] = peak;
    }
  }

  const maxMag = Math.max(...mags, 1e-12);
  const db = mags.map((m) => 20 * Math.log10(Math.max(m, 1e-12) / maxMag));

  return { freqs, mags, db, alignOffset, failed };
}

// ────────────────────────────────────────────────────────────────────────────
// Grid burst — the SAME measurement, but with every tone sounding at once.
//
// The stepped sweep above measures the acoustic path one frequency at a time.
// That is the right way to see the room's response, but it cannot reproduce
// the condition the modem actually transmits under, and the two differ in
// every way that matters here: 32 simultaneous carriers have a high crest
// factor (so the output stage may compress), they intermodulate (and because
// the grid is uniformly spaced, the products land ON other tones), and each
// one carries ~1/32 of the power a lone tone would.
//
// Running both and subtracting isolates exactly that: whatever the grid loses
// which a single tone at the same frequency does not is a MULTI-TONE effect,
// not the room. A digital loopback of the full 32-tone path already measures
// flat with 156 dB MER, so anything this finds is in the analog path.
// ────────────────────────────────────────────────────────────────────────────

export interface GridBurstOptions {
  sampleRate: number;
  /** Absolute tone frequencies — pass the modem's real grid. */
  freqs: number[];
  pilotFreqHz: number;
  pilotAmplitude: number;
  /** Per-tone amplitude. Pass the modem's real qamScale to measure as-shipped. */
  amplitude: number;
  ms: number;
  /**
   * Optional per-tone multipliers (linear), so calibration can measure the
   * response produced by the gains it is testing rather than predicting it.
   */
  toneGains?: number[];
}

export interface GridBurst {
  audio: Float32Array;
  freqs: number[];
  sampleRate: number;
  /** Ramp length at each end — measurement must stay clear of these. */
  fadeSamples: number;
}

/**
 * Continuous multi-tone burst: every tone at constant magnitude, each on a
 * fixed pseudo-random phase.
 *
 * Constant magnitude because this measures a RESPONSE — modulating the tones
 * would make per-tone level vary symbol to symbol and confound the reading.
 * Pseudo-random (rather than equal) phases because aligning all 32 carriers in
 * phase produces a coherent peak ~32x the per-tone amplitude, which would
 * drive the output stage into compression and measure that instead of the
 * channel. This is the same reason modulateQamRefSymbols rotates its points.
 */
export function buildGridBurst(opts: GridBurstOptions): GridBurst {
  const { sampleRate, freqs, pilotFreqHz, pilotAmplitude, amplitude, ms, toneGains } = opts;
  const n = Math.round((ms / 1000) * sampleRate);
  const audio = new Float32Array(n);
  const fadeSamples = Math.min(Math.round(0.01 * sampleRate), n >> 3);

  for (let k = 0; k < freqs.length; k++) {
    // Deterministic quadratic phase spread — same construction as qamRefPhase.
    const phase = (-Math.PI * k * (k - 1)) / Math.max(1, freqs.length);
    const w = (2 * Math.PI * freqs[k]) / sampleRate;
    const g = toneGains?.[k] ?? 1;
    for (let i = 0; i < n; i++) audio[i] += g * amplitude * Math.sin(w * i + phase);
  }
  const wp = (2 * Math.PI * pilotFreqHz) / sampleRate;
  for (let i = 0; i < n; i++) audio[i] += amplitude * pilotAmplitude * Math.sin(wp * i);

  for (let i = 0; i < fadeSamples; i++) {
    const env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeSamples);
    audio[i] *= env;
    audio[n - 1 - i] *= env;
  }
  return { audio, freqs, sampleRate, fadeSamples };
}

/**
 * Measure per-tone level from a recording of buildGridBurst()'s output.
 *
 * Alignment is by broadband energy (every tone sounds throughout, so there is
 * no per-frequency edge to lock to), then each tone is measured over several
 * windows in the burst interior and max-held — away from the fades, where
 * levels are full.
 */
export function measureGridResponse(
  recorded: Float32Array,
  burst: GridBurst,
  /**
   * Frequencies to measure, defaulting to the ones transmitted. Pass a SUPERSET
   * to probe slots the burst deliberately left empty — energy appearing there
   * can only be intermodulation or noise, which is how the linearity of the
   * analog path gets measured rather than argued about.
   */
  measureFreqs?: number[],
): SweepResult {
  const { sampleRate } = burst;
  const freqs = measureFreqs ?? burst.freqs;
  // Exactly one OFDM symbol — see magAt's rectangular branch. Any other length
  // breaks orthogonality and the tones bleed into each other.
  const winLen = Math.round(OFDM_SYMBOL_MS * 0.001 * sampleRate);
  const hop = Math.max(1, Math.round(winLen / 2));
  const scratch = new Float32Array(winLen);

  // Locate the burst by short-term RMS. Two passes, and the second is the one
  // that matters: the loudest window is somewhere in the burst's INTERIOR, so
  // using it as the origin puts the guard band and the end-of-burst limit in
  // the wrong place and lets windows run off the end into silence — partial
  // windows are not integer-cycle, so orthogonality dies and the other tones
  // bleed into every reading. Take the rising edge instead.
  const rmsAt = (off: number): number => {
    let sumSq = 0;
    for (let i = 0; i < winLen; i++) {
      const v = recorded[off + i];
      sumSq += v * v;
    }
    return Math.sqrt(sumSq / winLen);
  };
  let bestRms = 0;
  for (let off = 0; off + winLen <= recorded.length; off += hop) {
    const rms = rmsAt(off);
    if (rms > bestRms) bestRms = rms;
  }
  let alignOffset = 0;
  for (let off = 0; off + winLen <= recorded.length; off += hop) {
    if (rmsAt(off) >= 0.5 * bestRms) {
      alignOffset = off;
      break;
    }
  }

  const mags = new Array<number>(freqs.length).fill(0);
  const failed = bestRms < 1e-6;
  if (!failed) {
    // Every analysis window must sit in the burst's STEADY interior, clear of
    // both fades. A window overlapping a ramp sees amplitude-modulated tones,
    // which are no longer integer-cycle over the window, so the rectangular
    // orthogonality that makes leakage zero no longer holds and the other 31
    // tones bleed in — enough to floor a fully-absent tone at about -18 dB.
    const guard = burst.fadeSamples + winLen;
    const from = alignOffset + guard;
    const to = Math.min(
      recorded.length - winLen,
      alignOffset + burst.audio.length - guard,
    );
    for (let k = 0; k < freqs.length; k++) {
      let peak = 0;
      for (let off = from; off <= to; off += hop) {
        const m = magAt(recorded, off, winLen, freqs[k], sampleRate, scratch, false);
        if (m > peak) peak = m;
      }
      mags[k] = peak;
    }
  }

  const maxMag = Math.max(...mags, 1e-12);
  const db = mags.map((m) => 20 * Math.log10(Math.max(m, 1e-12) / maxMag));
  return { freqs, mags, db, alignOffset, failed };
}

/**
 * Per-tone difference between the grid measurement and the single-tone sweep,
 * both normalized to their own peak, in dB (negative = the grid loses level a
 * lone tone at the same frequency keeps). A flat zero line means simultaneous
 * carriers cost nothing and the response really is just the room.
 */
export function gridVsSweepDelta(
  grid: SweepResult,
  sweep: SweepResult,
): Array<{ freqHz: number; deltaDb: number }> {
  const byFreq = new Map<number, number>();
  sweep.freqs.forEach((f, i) => byFreq.set(f, sweep.db[i]));
  const out: Array<{ freqHz: number; deltaDb: number }> = [];
  grid.freqs.forEach((f, i) => {
    const s = byFreq.get(f);
    if (s == null || grid.mags[i] <= 0) return;
    out.push({ freqHz: f, deltaDb: grid.db[i] - s });
  });
  return out;
}

/**
 * Summarize a measured response: the notches worth knowing about, and whether
 * they look like cancellation (narrow, deep, evenly spaced) or rolloff.
 */
export function summarizeSweep(r: SweepResult): {
  spreadDb: number;
  notches: Array<{ freqHz: number; depthDb: number }>;
  notchSpacingHz: number | null;
} {
  const valid = r.mags.filter((m) => m > 0);
  const spreadDb = valid.length
    ? 20 * Math.log10(Math.max(...valid) / Math.min(...valid))
    : 0;

  // A notch is a local minimum at least 10 dB below the median — deep enough
  // to matter to a 16-QAM decision, shallow enough not to require a null.
  const sorted = r.mags.slice().sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] || 1e-12;
  const notches: Array<{ freqHz: number; depthDb: number }> = [];
  for (let k = 1; k < r.mags.length - 1; k++) {
    const m = r.mags[k];
    if (m <= 0) continue;
    if (m < r.mags[k - 1] && m <= r.mags[k + 1]) {
      const depthDb = 20 * Math.log10(m / median);
      if (depthDb <= -10) notches.push({ freqHz: r.freqs[k], depthDb });
    }
  }

  // Even spacing is the signature of two-path cancellation: nulls land every
  // c/pathDifference Hz. Ragged spacing points at speaker response instead.
  let notchSpacingHz: number | null = null;
  if (notches.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < notches.length; i++) {
      gaps.push(notches[i].freqHz - notches[i - 1].freqHz);
    }
    gaps.sort((a, b) => a - b);
    notchSpacingHz = gaps[gaps.length >> 1];
  }

  return { spreadDb, notches, notchSpacingHz };
}

// ────────────────────────────────────────────────────────────────────────────
// Envelope probe — how the chain's gain moves over TIME.
//
// Everything above measures a steady state. The failures that keep recurring
// are transient: a loud burst compresses the output stage, and the gain then
// releases over hundreds of milliseconds while the receiver is trying to hold
// an amplitude reference. That is invisible to a steady-state sweep and is
// exactly what this measures.
// ────────────────────────────────────────────────────────────────────────────

/** Single constant-amplitude tone, raised-cosine faded, for envelope probing. */
export function buildToneBurst(opts: {
  sampleRate: number;
  freqHz: number;
  amplitude: number;
  ms: number;
}): Float32Array {
  const { sampleRate, freqHz, amplitude, ms } = opts;
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Float32Array(n);
  const fade = Math.min(Math.round(0.005 * sampleRate), n >> 3);
  const w = (2 * Math.PI * freqHz) / sampleRate;
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < fade) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    else if (i >= n - fade) env = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / fade);
    out[i] = amplitude * env * Math.sin(w * i);
  }
  return out;
}

/**
 * Magnitude of `freqHz` in consecutive blocks, from the first block that
 * carries real signal. A flat result means the chain's gain is steady; a rising
 * or falling ramp is compression attack or release, and its shape gives the
 * time constant directly.
 */
export function measureEnvelope(
  recorded: Float32Array,
  freqHz: number,
  sampleRate: number,
  blockMs = 25,
): { blocks: number[]; alignOffset: number } {
  const len = Math.round((blockMs / 1000) * sampleRate);
  const scratch = new Float32Array(len);
  const magOf = (off: number): number =>
    magAt(recorded, off, len, freqHz, sampleRate, scratch, false);

  let best = 0;
  for (let off = 0; off + len <= recorded.length; off += len) {
    const m = magOf(off);
    if (m > best) best = m;
  }
  let alignOffset = 0;
  for (let off = 0; off + len <= recorded.length; off += len) {
    if (magOf(off) >= 0.5 * best) {
      alignOffset = off;
      break;
    }
  }
  const blocks: number[] = [];
  for (let off = alignOffset; off + len <= recorded.length; off += len) {
    blocks.push(magOf(off));
  }
  return { blocks, alignOffset };
}

/**
 * Is the analog path linear over the drive range the modem uses?
 *
 * Takes per-tone responses measured at several drive levels, normalizes each to
 * its own mean, and reports the largest per-tone deviation between levels. A
 * linear path gives the same SHAPE at every level, so this is ~0 dB; a
 * level-dependent one does not, and then no amount of channel estimation at one
 * level predicts behaviour at another.
 */
export function linearityDeviationDb(
  responses: Array<{ amplitude: number; mags: number[] }>,
): { maxDeviationDb: number; perToneDb: number[] } {
  const usable = responses.filter((r) => r.mags.some((m) => m > 0));
  if (usable.length < 2) return { maxDeviationDb: 0, perToneDb: [] };

  const normalized = usable.map((r) => {
    const valid = r.mags.filter((m) => m > 0);
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    return r.mags.map((m) => (m > 0 && mean > 0 ? m / mean : 0));
  });

  const perToneDb: number[] = [];
  for (let t = 0; t < normalized[0].length; t++) {
    const vals = normalized.map((n) => n[t]).filter((v) => v > 0);
    if (vals.length < 2) {
      perToneDb.push(0);
      continue;
    }
    perToneDb.push(20 * Math.log10(Math.max(...vals) / Math.min(...vals)));
  }
  return { maxDeviationDb: Math.max(0, ...perToneDb), perToneDb };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-tone pre-emphasis — flatten the RECEIVED spectrum by pre-distorting TX.
//
// Read the caveat before using this. Flattening what arrives means spending
// transmit power in proportion to how badly the channel attenuates each tone,
// which is the exact opposite of the optimal allocation (water-filling puts
// MORE power where the channel is good). Fully inverting a 20 dB null wastes
// most of the power budget on the one frequency the room deletes.
//
// It earns its place only because this modem currently runs ONE constellation
// order on every tone: a flat received spectrum is what lets a single order
// work everywhere, and it makes the receiver's amplitude reference uniform.
// Per-tone bit loading is the better answer to a non-flat channel and this does
// not replace it. It also cannot help with crest-factor/compression effects,
// which are time-domain.
//
// Two properties keep it safe:
//   - CLAMPED boost, so a null cannot consume the power budget.
//   - MEAN-ZERO in dB, so total transmit power is redistributed, never raised
//     (raising it is what the peak budget in OFDMQPSKModulator forbids).
// ────────────────────────────────────────────────────────────────────────────

export interface PreEmphasisOptions {
  /** Largest deviation from unity any single tone may take, in dB. */
  maxBoostDb: number;
}

export const PRE_EMPHASIS_DEFAULTS: PreEmphasisOptions = {
  // 12 dB spans a 24 dB peak-to-trough correction. The 32-tone/pilot-1850
  // bench channel measures 18.5 dB of smooth low-edge rolloff, which pinned
  // the lowest tones at the previous 9 dB clamp with zero margin; 12 dB
  // covers it while still preventing a deep narrow null from pulling the
  // whole power budget toward one tone.
  maxBoostDb: 12,
};

/**
 * One refinement step: given the gains currently in force and what those gains
 * actually produced, return the gains to use next.
 *
 * Iterative rather than one-shot because the correction is only exact if the
 * channel is linear AND the measurement is noise-free; in practice each pass
 * removes most of the remaining error, so two or three converge.
 *
 * @param currentGainsDb per-tone gains that produced `measuredMags` (dB, 0 = unity)
 * @param measuredMags   per-tone received magnitude under those gains
 */
export function refinePreEmphasis(
  currentGainsDb: number[],
  measuredMags: number[],
  opts: PreEmphasisOptions = PRE_EMPHASIS_DEFAULTS,
): number[] {
  const n = Math.min(currentGainsDb.length, measuredMags.length);
  const usable: number[] = [];
  for (let t = 0; t < n; t++) if (measuredMags[t] > 0) usable.push(t);
  if (usable.length === 0) return currentGainsDb.slice();

  // Work in dB against the mean of what arrived: a tone 6 dB below the mean
  // needs 6 dB more gain than it currently has.
  const measDb = new Array<number>(n).fill(0);
  for (const t of usable) measDb[t] = 20 * Math.log10(measuredMags[t]);
  const meanMeasDb = usable.reduce((a, t) => a + measDb[t], 0) / usable.length;

  const next = new Array<number>(n).fill(0);
  for (let t = 0; t < n; t++) {
    if (measuredMags[t] <= 0) {
      // Nothing arrived — do not chase it. A tone at the noise floor would
      // otherwise demand maximum boost forever and win the whole budget.
      next[t] = currentGainsDb[t];
      continue;
    }
    const errorDb = meanMeasDb - measDb[t];
    next[t] = currentGainsDb[t] + errorDb;
  }

  // Both constraints have to hold at once, and applying them in sequence does
  // not achieve that: clamping then re-centring pushes tones back outside the
  // clamp (measured 10.8 dB against a 9 dB limit on a 40 dB null), while
  // re-centring then clamping leaves a non-zero mean and therefore a changed
  // power budget.
  //
  // So solve for the offset instead. mean(clamp(x - c)) decreases monotonically
  // in c, so a bisection finds the c where it is exactly zero — giving a set
  // that is simultaneously mean-zero and inside the clamp. If every tone pins
  // to the same bound no such c exists, and the search simply returns the
  // closest achievable, which is the right degenerate answer.
  const clampAll = (c: number): number[] =>
    next.map((v) => Math.max(-opts.maxBoostDb, Math.min(opts.maxBoostDb, v - c)));
  const meanOf = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / arr.length;

  let lo = -opts.maxBoostDb * 2 - Math.max(...next.map(Math.abs));
  let hi = opts.maxBoostDb * 2 + Math.max(...next.map(Math.abs));
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (meanOf(clampAll(mid)) > 0) lo = mid;
    else hi = mid;
  }
  return clampAll((lo + hi) / 2);
}

/** dB gains → linear per-tone amplitude multipliers. */
export function gainsDbToLinear(gainsDb: number[]): number[] {
  return gainsDb.map((db) => Math.pow(10, db / 20));
}

/** Spread of a measured response, in dB — the number calibration drives down. */
export function responseSpreadDb(mags: number[]): number {
  const valid = mags.filter((m) => m > 0);
  if (valid.length < 2) return 0;
  return 20 * Math.log10(Math.max(...valid) / Math.min(...valid));
}

/** The flattest window of a sweep wide enough for a given tone grid. */
export interface BestBand {
  startHz: number;
  endHz: number;
  /** max-min dB inside the window — the thing being minimized */
  spreadDb: number;
  /** mean dB inside the window — the tie-breaker (louder wins) */
  meanDb: number;
}

/**
 * Slide a `bandWidthHz`-wide window across the sweep and return the flattest
 * placement; among near-equally flat windows, the loudest wins. This is the
 * "where should TONE START go" question made computable: the operator selects
 * a tone count, the grid needs (toneCount-1)*toneSpacing Hz of usable band,
 * and the sweep already measured which stretch of spectrum behaves.
 *
 * Returns null when the sweep does not cover a full window.
 */
export function findBestBand(
  freqs: number[],
  db: number[],
  bandWidthHz: number,
): BestBand | null {
  if (freqs.length < 2) return null;
  let best: BestBand | null = null;
  for (let i = 0; i < freqs.length; i++) {
    const endHz = freqs[i] + bandWidthHz;
    if (endHz > freqs[freqs.length - 1]) break;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    for (let j = i; j < freqs.length && freqs[j] <= endHz; j++) {
      const v = db[j];
      if (!Number.isFinite(v)) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
      n++;
    }
    if (n < 2) continue;
    const cand: BestBand = { startHz: freqs[i], endHz, spreadDb: max - min, meanDb: sum / n };
    // Primary: flatter. Secondary: within 0.5 dB of equally flat, louder.
    if (
      best === null ||
      cand.spreadDb < best.spreadDb - 0.5 ||
      (Math.abs(cand.spreadDb - best.spreadDb) <= 0.5 && cand.meanDb > best.meanDb)
    ) {
      best = cand;
    }
  }
  return best;
}

/**
 * Pick the measured magnitudes at a specific set of frequencies.
 *
 * Lets a high-resolution stepped sweep seed a per-tone calibration: the sweep
 * sounds one tone at a time, so each point carries the full transmit power
 * instead of 1/N of it, and its SNR is correspondingly better than the grid's.
 * The grid is still the ground truth for how the modem actually transmits, so
 * the sweep seeds and the grid refines.
 *
 * Returns 0 for any frequency the sweep did not measure, which
 * refinePreEmphasis then declines to chase.
 */
export function sampleResponseAt(result: SweepResult, freqs: number[]): number[] {
  const byFreq = new Map<number, number>();
  result.freqs.forEach((f, i) => byFreq.set(Math.round(f), result.mags[i]));
  return freqs.map((f) => byFreq.get(Math.round(f)) ?? 0);
}

/** Magnitudes → dB relative to their own mean, for before/after comparison. */
export function magsToRelativeDb(mags: number[]): number[] {
  const valid = mags.filter((m) => m > 0);
  if (valid.length === 0) return mags.map(() => 0);
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  return mags.map((m) => (m > 0 ? 20 * Math.log10(m / mean) : Number.NaN));
}

/**
 * Per-frequency gain lookup built from a per-TONE calibration.
 *
 * The calibration is defined only on the tone grid, but a sweep steps at finer
 * resolution and also runs outside the band. Interpolating in dB between
 * neighbouring tones (and returning unity beyond the band) gives a continuous
 * curve, so a swept measurement of a calibrated transmission is meaningful at
 * every step rather than only on the grid points.
 */
export function makeGainInterpolator(
  toneFreqs: number[],
  gainsLinear: number[],
): (freqHz: number) => number {
  const n = Math.min(toneFreqs.length, gainsLinear.length);
  if (n === 0) return () => 1;
  const freqs = toneFreqs.slice(0, n);
  const db = gainsLinear.slice(0, n).map((g) => 20 * Math.log10(Math.max(g, 1e-9)));

  return (freqHz: number): number => {
    // Outside the calibrated band the modem transmits nothing, so unity keeps
    // the sweep's out-of-band shape comparable between the two runs.
    if (freqHz <= freqs[0]) return freqHz < freqs[0] ? 1 : Math.pow(10, db[0] / 20);
    if (freqHz >= freqs[n - 1]) return freqHz > freqs[n - 1] ? 1 : Math.pow(10, db[n - 1] / 20);
    let hi = 1;
    while (hi < n && freqs[hi] < freqHz) hi++;
    const lo = hi - 1;
    const span = freqs[hi] - freqs[lo];
    const frac = span > 0 ? (freqHz - freqs[lo]) / span : 0;
    return Math.pow(10, (db[lo] + frac * (db[hi] - db[lo])) / 20);
  };
}
