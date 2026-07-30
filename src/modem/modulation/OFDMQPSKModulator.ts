/**
 * OFDMQPSKModulator — native-rate multitone QPSK synthesis.
 *
 * No IFFT: tone frequencies are absolute Hz on the 1/OFDM_SYMBOL_MS grid, so
 * each completes an integer number of cycles per window and the set is
 * orthogonal at ANY sample rate. Direct cosine synthesis; the cyclic prefix
 * is the tail of the window copied to the front, exactly as before.
 */
import { ofdmSamples } from '../types';
import {
  mapSymbol,
  MAX_QAM_MAGNITUDE,
  maxConstellationMagnitude,
  type ConstellationPoint,
  type QamOrder,
} from './constellation';
import { dlog } from '../../lib/debug/dlog';

export interface OFDMQPSKModulatorConfig {
  /**
   * Optional per-tone amplitude multipliers (linear, 1 = unity) — pre-emphasis
   * that pre-distorts the transmitted spectrum so the RECEIVED one comes out
   * flat. Expected to be mean-unity in dB (see refinePreEmphasis), because the
   * peak budget below is derived from the gains and a set that raises mean
   * power raises the peak with it.
   *
   * MUST be applied identically to preamble and data. The receiver trains its
   * channel estimate on the preamble and applies it to data, so a gain present
   * in one and not the other is indistinguishable from a channel that changed
   * between them — the exact failure mode that has broken this link repeatedly.
   * Holding them in one place here guarantees that.
   */
  toneGains?: number[];
  sampleRate: number;
  toneFrequencies: Float32Array;
  pilotFreqHz: number;
  pilotAmplitude: number;
  /**
   * Fixed per-tone TX scale used for EVERY OFDM symbol this modulator emits —
   * training, QPSK data, QAM data, and QAM reference symbols alike (see
   * `qamScale` field doc below). Default: derived in the constructor from
   * the true worst-case fully-aligned sum of every tone at the largest
   * supported constellation's corner point plus the pilot, backed off to a
   * 0.95 peak target. Override only for tuning against real hardware
   * headroom — clamped to that same safe default as an upper bound (an
   * override now scales the WHOLE transmission, training included, so an
   * unclamped value above the safe scale would reinstate the per-chunk
   * clipping this modulator exists to eliminate).
   */
  qamScaleOverride?: number;
}

function qpskPhase(symbol: number): number {
  return (symbol % 4) * (Math.PI / 2);
}

/**
 * Peak-to-RMS budget (crest factor, linear) the fixed TX scale is sized for.
 *
 * 5.5 ~= 14.8 dB. NOTE this is not what sets the scale at 16 tones and above —
 * the phase-aligned sync burst's peak is larger there and wins (see the
 * syncCoherentPeak block). It still governs at low tone counts and would govern
 * everywhere if the preamble were ever de-cohered.
 *
 * Chosen from measurement, not theory: over 600 random symbols
 * at every supported tone count and constellation order, the highest crest
 * factor actually produced was 4.98 (48 tones, QPSK), rising slowly with tone
 * count from 3.80 at 8 tones — the max of an approximately-Gaussian sum creeps
 * up as more carriers and more samples are involved. 3.5 was tried first and
 * clipped at 5e-6 to 3e-5 of samples, so the Gaussian intuition alone sizes
 * this too tight.
 *
 * At 5.5 a symbol has to reach crest 5.79 before any sample exceeds 1.0, ~16%
 * above the worst yet observed. Raising this reclaims nothing (it only lowers
 * the scale); lowering it trades clipping for level. clipRate.test.ts measures
 * what this actually produces across tone counts and orders — change this and
 * that test tells you what it cost.
 */
const PAPR_CREST = 5.5;

export class OFDMQPSKModulator {
  private cfg: OFDMQPSKModulatorConfig;
  private phases: number[];
  private fftSamples: number;
  private cpSamples: number;

  // Precomputed per-tone basis samples: sinTable[t][n] = sin(2π·f[t]·n/Fs),
  // cosTable[t][n] = cos(...). Tones and pilot are identical across every
  // symbol; only the QPSK phase (a multiple of π/2) varies, so each tone's
  // contribution is ±sin or ±cos of the same argument. Precomputing these
  // once turns the per-sample inner loop from a Math.sin call per (n,t) into
  // a table read + sign — the dominant encode cost.
  private sinTable: Float32Array[];
  private cosTable: Float32Array[];
  private pilotTable: Float32Array;
  // Per-symbol selectors (rebuilt in setSymbols): which table to read and the
  // sign to apply, derived from the QPSK symbol value 0..3.
  private selTable: Float32Array[];
  private selSign: Float32Array;

  // Per-tone bit-loading (Phase 3). Default: every tone QPSK (order 2), which
  // keeps generateSymbol on the sign/table selection path below (the fixed
  // TX scale — see qamScale doc — is now shared with the QAM path, so this
  // is no longer byte-identical to the pre-flattening modem, only to the
  // pre-QAM one's tone-selection logic). Only set by setToneOrders().
  private toneOrders: QamOrder[];
  private allQpsk: boolean;
  // Per-tone (re, im) constellation points for the current symbol, used ONLY
  // by the QAM synthesis path (allQpsk === false). Kept as flat Float32Arrays
  // to mirror sinTable/cosTable's access pattern.
  private symRe: Float32Array;
  private symIm: Float32Array;
  // Fixed per-tone TX scale, applied uniformly to EVERY symbol this modulator
  // emits (training, QPSK data, QAM data, QAM ref) — see config doc + constructor.
  private readonly qamScale: number;
  /** Per-tone pre-emphasis multipliers (linear); all 1 when uncalibrated. */
  private readonly toneGains: number[];

  constructor(config: OFDMQPSKModulatorConfig) {
    this.cfg = config;
    const numTones = config.toneFrequencies.length;
    this.phases = new Array(numTones).fill(0);
    const { fftSamples, cpSamples } = ofdmSamples(config.sampleRate);
    this.fftSamples = fftSamples;
    this.cpSamples = cpSamples;
    this.toneOrders = new Array(numTones).fill(2) as QamOrder[];
    this.allQpsk = true;
    this.symRe = new Float32Array(numTones);
    this.symIm = new Float32Array(numTones);
    // Fixed TX scale, identical for every symbol this modulator emits — the
    // whole transmission (chirp aside, which is scaled independently) sits at
    // ONE constant, deterministic amplitude. This used to be a per-symbol
    // peak-normalize (QPSK path) mixed with a separate statistical CREST·RMS
    // bound (QAM path); measured acoustic logs showed real transmissions
    // stepping by up to 11 dB between chunks because per-symbol normalization
    // makes the transmitted level depend on THAT symbol's data, and the
    // player's clip guard then rescales each streamed chunk independently to
    // its own local peak. QAM's amplitude decisions can't survive that; QPSK
    // (phase-only decisions) happened to. A single fixed scale removes the
    // dependency entirely, and — just as important — makes the training
    // burst's per-tone amplitude identical to data's, which the receiver's
    // channel estimate (trained on training, applied to data) requires.
    //
    // Derivation — TRUE worst case, not a statistical percentile: this
    // modulator's tone frequencies are exact integer multiples of 1/window,
    // so at n=0 every tone's cos table reads exactly 1 (sin reads 0) — i.e.
    // the coherent-worst-case alignment is actually reachable, not just a
    // tail event, so a CLT/percentile bound is not safe here. The peak of
    // Σ_t (re_t·cos − im_t·sin) + pilot·cos is bounded (triangle inequality)
    // by Σ_t |point_t| + pilotAmplitude. This is a safe UPPER bound, not a
    // tight one: at n=0 each tone actually contributes only its point's real
    // part (max Re = maxLevel·scale, e.g. 1.0801 for 64-QAM), not |point_t|
    // (1.5275) — nothing forces every tone's imaginary part to vanish AND
    // its real part to hit the corner simultaneously at the same n. Measured
    // achievable-vs-bound slack: ~0.2 dB for all-64-QAM (nearly tight — the
    // outer corner is mostly real already) but 3.0-3.5 dB for all-QPSK
    // (unit-magnitude points, so the n=0 real part is a much smaller
    // fraction of |point_t|) — i.e. the training/sync portion is leaving
    // ~3 dB of headroom on the table against this bound. Left unexploited
    // here deliberately (documenting it honestly, not chasing it) — each
    // tone's |point_t| is at most MAX_QAM_MAGNITUDE (the largest corner
    // magnitude across every constellation order this modulator can be
    // asked to carry — see constellation.ts; QPSK's unit-magnitude points
    // are smaller, so this bound stays safe for a QPSK-only symbol too, and
    // for any per-tone bit-loading mix). So:
    //   worstCasePeak = numTones · MAX_QAM_MAGNITUDE + pilotAmplitude
    //   qamScale = 0.95 / worstCasePeak
    // would guarantee |sample| <= 0.95 for every symbol this modulator can ever
    // produce, for any data, any per-tone order assignment, any tone count.
    // That guarantee is DELIBERATELY NOT TAKEN any more — see the PAPR block
    // below for what replaced it and why.
    // ── PAPR-based scale, NOT the coherent worst case ──
    // The bound derived above is real but ruinously conservative, and its cost
    // GROWS WITH TONE COUNT: sum_t |point_t| scales as N, so per-tone amplitude
    // scales as 1/N and per-tone level falls ~6 dB per doubling. That is why
    // 8 tones worked at 16-QAM while 32 did not — not any property of the
    // channel. Measured: at 32 tones the bound clamps a requested 0.16 down to
    // 0.0187, so every tone is ~22 dB below the level a single tone reaches in
    // the channel sweep, and the operator compensates with system volume,
    // which is what drives the output chain into compression.
    //
    // A real OFDM sum does not reach the coherent peak: with de-correlated
    // per-tone data its crest factor is only weakly dependent on N (measured
    // 3.80 at 8 tones rising to 4.98 at 48), so the peak scales essentially as
    // sqrt(N) via RMS rather than as N. Scaling to a crest budget instead
    // recovers real level at every tone count, and unlike cutting the tone
    // count it costs nothing. In practice the preamble budget below, not this
    // one, sets the scale at 16 tones and above — see there.
    //
    // THIS IS NO LONGER A PROOF. The old bound guaranteed |sample| <= 0.95 for
    // any data whatsoever; this one guarantees it only up to PAPR_CREST
    // standard deviations, so it is a MEASURED property and clipRate.test.ts
    // exists to keep it measured across tone counts and constellation orders.
    // The residual risk is bounded and one-sided: an exceptional symbol clips a
    // few samples against the player's guard, where the old behaviour was a
    // permanent ~9 dB level penalty on every symbol.
    //
    // RMS of the synthesized sum: each tone contributes a sinusoid whose
    // amplitude is |point_t| (mean square 1 after normalizationScale), so its
    // mean power is 1/2; the pilot contributes pilotAmplitude^2/2. Hence
    // rms = sqrt((numTones + pilotAmplitude^2) / 2), and the peak budget is
    // PAPR_CREST times that.
    // Per-tone pre-emphasis, defaulted to unity and length-checked so a stale
    // calibration for a different tone count cannot silently apply to some
    // tones and not others.
    this.toneGains =
      config.toneGains && config.toneGains.length === numTones
        ? config.toneGains.slice()
        : new Array<number>(numTones).fill(1);
    const gainSumSq = this.toneGains.reduce((a, g) => a + g * g, 0);
    const gainSum = this.toneGains.reduce((a, g) => a + Math.abs(g), 0);

    const rmsSum = Math.sqrt(
      (gainSumSq + config.pilotAmplitude * config.pilotAmplitude) / 2,
    );
    const paprPeak = PAPR_CREST * rmsSum;

    // ── the sync/training burst is NOT random data, and must be budgeted ──
    // A crest budget derived from random payload does not cover the preamble.
    // generateSyncBurst sets EVERY tone to the same QPSK symbol, so its
    // carriers are phase-aligned by construction and it hits very nearly the
    // coherent peak — measured crest 6.70 at 32 tones against ~2.6 for data.
    // It is also transmitted on every single transmission, so it is a
    // guaranteed event, not a tail one.
    //
    // Sizing to random data alone put its peak at 1.248 at 32 tones: the
    // preamble clipped on every transmission, which distorted the very symbols
    // the channel estimate is built from and turned a flat 6 dB h profile into
    // a 22 dB ramp. Take whichever budget is LARGER so both cases fit.
    // Gains scale each tone's contribution to the coherent sum, so the budget
    // uses their SUM rather than the tone count. With unity gains this is
    // identical to numTones and the pre-emphasis path costs nothing.
    const syncCoherentPeak =
      gainSum * maxConstellationMagnitude(2) + config.pilotAmplitude;

    // ── and PAYLOAD symbols can be coherent too, which forces the full bound ──
    // A crest budget assumes de-correlated per-tone data. Padding breaks that:
    // a short payload leaves most of the frame zero-filled, every tone maps to
    // the SAME constellation point, and the symbol is as phase-aligned as the
    // preamble. Measured on a 12-byte payload at 32 tones/16-QAM: the player's
    // guard saw a 1.19 peak, i.e. ~42.7 of the 44.9 units the fully coherent
    // case allows.
    //
    // So the binding term is the coherent bound after all, and this scale is
    // currently identical to the pre-PAPR one. The machinery is kept because
    // the terms name exactly what has to change to unlock the level: WHITEN THE
    // PAYLOAD (so padding is not a constant symbol) and de-cohere the sync
    // burst. With both done, paprPeak becomes the binding term and the crest
    // budget is worth ~7 dB at 32 tones and ~9 dB at 48. Until then, raising
    // the scale only converts headroom into clipping — and clipping the
    // preamble is what corrupts the channel estimate every transmission.
    const dataCoherentPeak = gainSum * MAX_QAM_MAGNITUDE + config.pilotAmplitude;

    // Never exceed the true worst case — at very low tone counts the coherent
    // bound is TIGHTER than the crest budget, and taking the looser of the two
    // there would clip deterministically rather than exceptionally.
    const worstCasePeak = gainSum * MAX_QAM_MAGNITUDE + config.pilotAmplitude;
    const budget = Math.min(
      Math.max(paprPeak, syncCoherentPeak, dataCoherentPeak),
      worstCasePeak,
    );
    const safeScale = 0.95 / Math.max(budget, 1e-9);
    // qamScaleOverride is a user/tuning knob, not a way to bypass the safety
    // bound above — it now scales the WHOLE transmission (training included,
    // not just QAM data), so an unclamped override above safeScale would
    // silently reinstate the per-chunk clip-guard rescaling this task exists
    // to eliminate (e.g. override=0.2 at 32 tones -> peak ~10.0). Clamp to
    // the safe ceiling; only a SMALLER override (deliberately quieter than
    // the safe default) has any effect.
    if (config.qamScaleOverride !== undefined && config.qamScaleOverride > safeScale) {
      dlog('OFDM-SCALE', {
        warn: 'qamScaleOverride clamped to safe scale',
        requested: config.qamScaleOverride,
        clampedTo: safeScale,
      }, { level: 'warn' });
    }
    this.qamScale = Math.min(config.qamScaleOverride ?? safeScale, safeScale);

    const twoPiOverFs = (2 * Math.PI) / config.sampleRate;
    // Precomputed sin/cos tables: each is a Float32Array of fftSamples.
    // Memory footprint is approximately 2 * toneCount * fftSamples * 4 bytes
    // (plus one pilotTable of fftSamples * 4 bytes).
    this.sinTable = new Array(numTones);
    this.cosTable = new Array(numTones);
    for (let t = 0; t < numTones; t++) {
      const s = new Float32Array(fftSamples);
      const c = new Float32Array(fftSamples);
      const w = twoPiOverFs * config.toneFrequencies[t];
      for (let n = 0; n < fftSamples; n++) {
        s[n] = Math.sin(w * n);
        c[n] = Math.cos(w * n);
      }
      this.sinTable[t] = s;
      this.cosTable[t] = c;
    }
    this.pilotTable = new Float32Array(fftSamples);
    const wp = twoPiOverFs * config.pilotFreqHz;
    for (let n = 0; n < fftSamples; n++) {
      this.pilotTable[n] = config.pilotAmplitude * Math.cos(wp * n);
    }
    // Default selectors: symbol 0 (0° ⇒ +sin) on every tone.
    this.selTable = this.sinTable.slice();
    this.selSign = new Float32Array(numTones).fill(1);
  }

  /**
   * Fixed TX scale (see the `qamScale` field/config doc above) — exposed so
   * callers/tests can inspect the exact per-tone amplitude this modulator
   * uses for every symbol it emits (training, QPSK data, QAM data, QAM ref).
   * Now that training and data share this same scale, the demodulator no
   * longer needs a correction ratio between them (see
   * OFDMQPSKDemodulator — the old `computeQamRefScale`/`qamRefScale` mirror
   * was removed; the ratio is trivially 1).
   */
  getQamScale(): number {
    return this.qamScale;
  }

  /**
   * Per-tone bit-loading (Phase 3): assign each tone's constellation order.
   * Default (never called) is all-QPSK. Length must match toneFrequencies.
   */
  setToneOrders(orders: QamOrder[]): void {
    if (orders.length !== this.cfg.toneFrequencies.length) {
      throw new Error(
        `Expected ${this.cfg.toneFrequencies.length} tone orders, got ${orders.length}`,
      );
    }
    this.toneOrders = orders.slice();
    this.allQpsk = orders.every((o) => o === 2);
  }

  setSymbols(symbols: number[]): void {
    if (symbols.length !== this.cfg.toneFrequencies.length) {
      throw new Error(
        `Expected ${this.cfg.toneFrequencies.length} symbols, got ${symbols.length}`,
      );
    }
    if (this.allQpsk) {
      // Legacy path: symbols are QPSK phase indices 0..3. Tone-selection
      // logic UNCHANGED from the pre-QAM modem; synthesizeQpsk now applies
      // the shared fixed qamScale instead of a per-symbol peak-normalize.
      this.phases = symbols.map(qpskPhase);
      // sin(base + k·π/2): 0→+sin, 1→+cos, 2→−sin, 3→−cos
      for (let t = 0; t < symbols.length; t++) {
        const s = ((symbols[t] % 4) + 4) % 4;
        this.selTable[t] = s === 1 || s === 3 ? this.cosTable[t] : this.sinTable[t];
        this.selSign[t] = s === 2 || s === 3 ? -1 : 1;
      }
      return;
    }
    // QAM path: each symbols[t] is the integer constellation index (0..2^order-1)
    // for that tone's assigned order. Map to a (re, im) point once per symbol;
    // generateSymbol synthesizes re·cos − im·sin per tone from these.
    for (let t = 0; t < symbols.length; t++) {
      const { re, im } = mapSymbol(symbols[t], this.toneOrders[t]);
      this.symRe[t] = re;
      this.symIm[t] = im;
    }
  }

  /**
   * Set per-tone constellation points directly, bypassing the Gray-index
   * mapSymbol lookup — used ONLY by the QAM reference-symbol path (see
   * OFDMEngine.modulateQamRefSymbols), which needs points rotated off the
   * Gray lattice by a per-tone phase to de-cohere the sum. Requires the
   * modulator already be in QAM mode (setToneOrders with a non-all-QPSK
   * assignment); synthesis is otherwise identical to setSymbols's QAM
   * branch — same qamScale, pilot, and cyclic prefix.
   */
  setPoints(points: ConstellationPoint[]): void {
    if (points.length !== this.cfg.toneFrequencies.length) {
      throw new Error(
        `Expected ${this.cfg.toneFrequencies.length} points, got ${points.length}`,
      );
    }
    for (let t = 0; t < points.length; t++) {
      this.symRe[t] = points[t].re;
      this.symIm[t] = points[t].im;
    }
  }

  generateSymbol(): Float32Array {
    const body = this.allQpsk ? this.synthesizeQpsk() : this.synthesizeQam();
    // Cyclic prefix
    const out = new Float32Array(this.fftSamples + this.cpSamples);
    out.set(body.subarray(this.fftSamples - this.cpSamples), 0);
    out.set(body, this.cpSamples);
    return out;
  }

  /**
   * All-QPSK synthesis. Uses the SAME fixed `qamScale` as synthesizeQam (see
   * the constructor doc) instead of a per-symbol peak-normalize — this is
   * what makes training and QPSK/QAM data land at identical per-tone
   * amplitude, and keeps the whole transmission at one constant level. NOT
   * byte-identical to the pre-flattening modem (that per-symbol
   * peak-normalize to 0.95 is exactly the bug this replaces).
   */
  private synthesizeQpsk(): Float32Array {
    const { toneFrequencies } = this.cfg;
    const numTones = toneFrequencies.length;
    const body = new Float32Array(this.fftSamples);
    const { pilotTable, selTable, selSign, qamScale, toneGains } = this;
    for (let n = 0; n < this.fftSamples; n++) {
      let acc = pilotTable[n];
      for (let t = 0; t < numTones; t++) {
        // Same gains as the QAM path — the preamble and the profile frame go
        // out through here, and the receiver's channel estimate comes from the
        // preamble. Applying pre-emphasis to only one of the two paths would
        // make the estimate disagree with the data it is applied to.
        acc += toneGains[t] * selSign[t] * selTable[t][n];
      }
      body[n] = acc * qamScale;
    }
    return body;
  }

  /**
   * Mixed/higher-order synthesis — taken only when some tone's order > QPSK.
   * Standard quadrature synthesis re·cos(2πfn) − im·sin(2πfn) per tone, reusing
   * the same precomputed sin/cos tables as the legacy path. Uses the FIXED
   * qamScale (not per-symbol peak-normalize) so every tone's amplitude is
   * stable across symbols — required for amplitude to be a usable decision
   * axis on 16/64-QAM.
   */
  private synthesizeQam(): Float32Array {
    const { toneFrequencies } = this.cfg;
    const numTones = toneFrequencies.length;
    const body = new Float32Array(this.fftSamples);
    const { pilotTable, sinTable, cosTable, symRe, symIm, qamScale, toneGains } = this;
    for (let n = 0; n < this.fftSamples; n++) {
      let acc = pilotTable[n];
      for (let t = 0; t < numTones; t++) {
        acc += toneGains[t] * (symRe[t] * cosTable[t][n] - symIm[t] * sinTable[t][n]);
      }
      body[n] = acc * qamScale;
    }
    return body;
  }
}
