/**
 * OFDMQPSKDemodulator — native-rate multitone QPSK demodulator.
 *
 * No FFT: each tone is demodulated with toneIQ (Goertzel single-bin) at its
 * exact absolute frequency. Tone frequencies on the 1/OFDM_SYMBOL_MS grid are
 * orthogonal at any sample rate.
 *
 * Keeps the existing training accumulation, phase-only equalization, and
 * pilot-referenced drift correction — but with rate-agnostic math instead
 * of bin indices.
 */
import { toneIQ } from '../pilot';
import { ofdmSamples, OFDM_TUNING, OFDM_DEFAULTS } from '../types';
import { dlog } from '../../lib/debug/dlog';
import { mapSymbol, sliceSymbol, type QamOrder } from '../modulation/constellation';

export interface OFDMQPSKDemodulatorConfig {
  sampleRate: number;
  toneFrequencies: Float32Array;
  pilotFreqHz: number;
  /** Leaky-integrator gain for decision-directed channel tracking (0 = off, default 0.05) */
  trackingAlpha?: number;
}

export interface OFDMQPSKResult {
  bits: number[];
  frameBits: number;
  pilotAmplitude: number;
  pilotPhase: number;
  toneIQ: Array<{ i: number; q: number }>;
}

export class OFDMQPSKDemodulator {
  private cfg: OFDMQPSKDemodulatorConfig;
  private toneCount: number;

  // Per-tone channel estimates (trained on sync burst)
  private channelEstRe: number[] = [];
  private channelEstIm: number[] = [];
  private pilotChannelEstRe = 0;
  private pilotChannelEstIm = 0;
  private trained = false;
  private trainingSymbols = 0;
  private readonly TRAINING_SYMBOLS = OFDM_TUNING.trainingSymbols;
  private diagCount = 0;
  /** Leaky-integrator gain for per-symbol channel tracking (0 = off) */
  private trackingAlpha: number = 0.003;

  // ── MER / EVM measurement (diagnostic only — never affects decoding) ──
  // Accumulates error power vs the ideal constellation point over a rolling
  // window of data symbols, so we can judge how much SNR headroom exists for
  // a denser constellation (16-QAM etc.).
  //
  // Staged/committed split: demodulate() only knows it is looking at an OFDM
  // data symbol, not whether that symbol will end up inside a frame that
  // decodes successfully (or silence/noise between transmissions, which is
  // demodulated exactly the same way). So every window's stats land in the
  // STAGED accumulators first; the caller (rxEngine) folds staged → committed
  // via commitMER() once the frame the symbols belonged to is confirmed
  // valid, or throws them away via discardMER() when the frame is invalid or
  // sync is lost. getMER()/getPerToneMER() only ever read committed sums, so
  // the reported MER can never include windows that didn't belong to a
  // successfully-decoded frame.
  private stagedErrPow = 0;
  private stagedRefPow = 0;
  private stagedCount = 0;
  private merErrPow = 0;
  private merRefPow = 0;
  private merCount = 0;
  private readonly MER_REPORT_SYMBOLS = 64;

  // Per-tone staged/committed sums, same semantics as above (index = tone).
  private stagedToneErr: number[] = [];
  private stagedToneRef: number[] = [];
  private toneErr: number[] = [];
  private toneRef: number[] = [];

  /** Window sizes computed once from sampleRate */
  private fftSamples: number;
  private cpSamples: number;

  // Per-tone bit-loading (Phase 3). Default: every tone QPSK (order 2), which
  // keeps demodulate() on the untouched legacy hard 4-phase slicer path below
  // — byte-identical to the pre-QAM demodulator. Only set by setToneOrders(),
  // which rxEngine calls exactly ONCE per transmission, right after it parses
  // the base-rate PROFILE (0x04) frame (see rxEngine.processFrame). Training
  // and the profile frame itself are always demodulated at this default.
  private toneOrders: QamOrder[];
  private allQpsk = true;
  /** Track how many post-training symbols we've processed — used to freeze
   *  decision tracking briefly so initial channel estimates don't get
   *  corrupted by decisions made on un-equalized (training-phase-like) data. */
  private postTrainingSymbols = 0;
  /**
   * Correction ratio applied to the QAM path's channel-equalized tone
   * reading before slicing (see computeQamRefScale doc). Recomputed whenever
   * setToneOrders() switches away from all-QPSK; irrelevant (and unused)
   * while allQpsk is true.
   */
  private qamRefScale = 1;
  /**
   * Decision-directed tracking gain for the QAM channel-estimate tracker —
   * deliberately separate from (and much faster than) `trackingAlpha`, which
   * stays untouched for the QPSK path's byte-identical behavior. QAM frames
   * are short (one atomic frame is tens of symbols), so the tracker needs to
   * converge within the first few symbols rather than over a whole session.
   */
  private readonly qamTrackingAlpha = 0.0;

  constructor(config: OFDMQPSKDemodulatorConfig) {
    this.cfg = config;
    this.toneCount = config.toneFrequencies.length;

    const { fftSamples, cpSamples } = ofdmSamples(config.sampleRate);
    this.fftSamples = fftSamples;
    this.cpSamples = cpSamples;
    this.toneOrders = new Array(this.toneCount).fill(2) as QamOrder[];
    if (config.trackingAlpha !== undefined) this.trackingAlpha = config.trackingAlpha;

    // Initialize channel estimates to identity
    this.channelEstRe = new Array(this.toneCount).fill(1);
    this.channelEstIm = new Array(this.toneCount).fill(0);
    this.pilotChannelEstRe = 1;
    this.pilotChannelEstIm = 0;
    this.stagedToneErr = new Array(this.toneCount).fill(0);
    this.stagedToneRef = new Array(this.toneCount).fill(0);
    this.toneErr = new Array(this.toneCount).fill(0);
    this.toneRef = new Array(this.toneCount).fill(0);
    this.postTrainingSymbols = 0;
  }

  resetTraining(): void {
    this.trained = false;
    this.trainingSymbols = 0;
    this.postTrainingSymbols = 0;
    this.diagCount = 0;
    this.channelEstRe = new Array(this.toneCount).fill(1);
    this.channelEstIm = new Array(this.toneCount).fill(0);
    this.pilotChannelEstRe = 1;
    this.pilotChannelEstIm = 0;
    this.stagedErrPow = 0;
    this.stagedRefPow = 0;
    this.stagedCount = 0;
    this.merErrPow = 0;
    this.merRefPow = 0;
    this.merCount = 0;
    this.stagedToneErr = new Array(this.toneCount).fill(0);
    this.stagedToneRef = new Array(this.toneCount).fill(0);
    this.toneErr = new Array(this.toneCount).fill(0);
    this.toneRef = new Array(this.toneCount).fill(0);
  }

  /**
   * Fold the current run's staged MER stats into the committed totals — call
   * once the frame these symbols belonged to is confirmed to have decoded
   * successfully. Emits the existing OFDM-MER dlog report once the committed
   * total reaches MER_REPORT_SYMBOLS worth of data, then zeroes committed.
   */
  commitMER(): void {
    if (this.stagedCount === 0) return;
    this.merErrPow += this.stagedErrPow;
    this.merRefPow += this.stagedRefPow;
    this.merCount += this.stagedCount;
    for (let t = 0; t < this.toneCount; t++) {
      this.toneErr[t] += this.stagedToneErr[t];
      this.toneRef[t] += this.stagedToneRef[t];
    }
    this.stagedErrPow = 0;
    this.stagedRefPow = 0;
    this.stagedCount = 0;
    this.stagedToneErr = new Array(this.toneCount).fill(0);
    this.stagedToneRef = new Array(this.toneCount).fill(0);

    if (this.merCount >= this.toneCount * this.MER_REPORT_SYMBOLS) {
      const evm = Math.sqrt(this.merErrPow / this.merRefPow);
      const merDb = evm > 0 ? -20 * Math.log10(evm) : 99;
      const verdict =
        merDb >= 22 ? '64-QAM ok' : merDb >= 16 ? '16-QAM ok' : merDb >= 9 ? 'QPSK only' : 'marginal';
      dlog('OFDM-MER', {
        merDb: merDb.toFixed(1),
        evmPct: (evm * 100).toFixed(1),
        symbols: Math.round(this.merCount / this.toneCount),
        verdict,
      });
      this.merErrPow = 0;
      this.merRefPow = 0;
      this.merCount = 0;
      this.toneErr = new Array(this.toneCount).fill(0);
      this.toneRef = new Array(this.toneCount).fill(0);
    }
  }

  /**
   * Drop the current run's staged MER stats without committing — call when
   * the frame these symbols belonged to failed to decode, or sync was lost
   * (watchdog reset), so noise/silence never taints the committed report.
   */
  discardMER(): void {
    this.stagedErrPow = 0;
    this.stagedRefPow = 0;
    this.stagedCount = 0;
    this.stagedToneErr = new Array(this.toneCount).fill(0);
    this.stagedToneRef = new Array(this.toneCount).fill(0);
  }

  /**
   * Current rolling MER (modulation error ratio) in dB and EVM as a fraction,
   * measured over the data symbols seen since the last report. Higher MER =
   * tighter constellation = more headroom for a denser scheme. Returns null
   * until enough symbols have accumulated.
   */
  getMER(): { merDb: number; evm: number; symbols: number } | null {
    if (this.merCount === 0 || this.merRefPow === 0) return null;
    const evm = Math.sqrt(this.merErrPow / this.merRefPow);
    const merDb = evm > 0 ? -20 * Math.log10(evm) : 99;
    return { merDb, evm, symbols: Math.round(this.merCount / this.toneCount) };
  }

  isTraining(): boolean {
    return this.trainingSymbols < this.TRAINING_SYMBOLS;
  }

  /**
   * Per-tone MER in dB from committed sums (same phase-EVM math as getMER(),
   * split per tone) — needed by bit-loading to pick a constellation per tone.
   * A tone with no committed reference power yet reports 0 dB (unknown, not
   * "bad") rather than -Infinity.
   */
  getPerToneMER(): number[] {
    return Array.from({ length: this.toneCount }, (_unused, t) => {
      if (this.toneRef[t] === 0) return 0;
      const evm = Math.sqrt(this.toneErr[t] / this.toneRef[t]);
      if (evm <= 0) return 99;
      return -20 * Math.log10(evm);
    });
  }

  /** Trained per-tone channel magnitude (relative gain from the sync burst). */
  getPerToneChannelMagnitude(): number[] {
    return Array.from({ length: this.toneCount }, (_unused, t) =>
      Math.hypot(this.channelEstRe[t], this.channelEstIm[t]));
  }

  /**
   * Per-tone bit-loading (Phase 3): assign each tone's constellation order
   * for demodulation. Default (never called) is all-QPSK, which keeps
   * demodulate() on the legacy byte-identical hard-slicer path. Called
   * exactly once per transmission by rxEngine, right after a base-rate
   * PROFILE frame is parsed — see the class-level doc.
   */
  setToneOrders(orders: QamOrder[]): void {
    if (orders.length !== this.toneCount) {
      throw new Error(`Expected ${this.toneCount} tone orders, got ${orders.length}`);
    }
    this.toneOrders = orders.slice();
    this.allQpsk = orders.every((o) => o === 2);
    if (!this.allQpsk) {
      this.qamRefScale = this.computeQamRefScale();
    }
  }

  /**
   * Derives the correction ratio between the training burst's amplitude and
   * the QAM data path's fixed amplitude — both TX scales are deterministic
   * functions of shared config, not of the channel, so this needs no live
   * measurement.
   *
   * Why a ratio is needed at all: per the plan's architecture, the training
   * burst is ALWAYS synthesized via the legacy all-QPSK path
   * (OFDMQPSKModulator.synthesizeQpsk), which peak-normalizes each symbol to
   * 0.95 — call that per-symbol scale S0 (deterministic, since every training
   * symbol is the same all-zero pattern). QAM data symbols use a different,
   * FIXED scale (OFDMQPSKModulator.qamScale, see 3a) that is NOT equal to S0.
   * The trained `channelEstRe/Im` therefore encodes (channel gain × S0), while
   * a raw QAM tone reading encodes (channel gain × qamScale × point). Dividing
   * the two directly leaves a residual (qamScale / S0) factor that must be
   * corrected before the result can be compared against the constellation's
   * designed (unit mean-power) scale.
   *
   * Derivation (toneIQ() is a linear matched filter: for x(n)=A·sin/cos(wn),
   * it returns (i,q) = A·(∓0.5·[sin coeff], ±0.5·[cos coeff]) — a fixed,
   * tone-independent 0.5 gain):
   *   - Training tone (x(n)=1·sin(wn), scaled by the global S0): clean (no
   *     channel) measurement = (0.5·S0, 0) — real, same for every tone.
   *   - A QAM point (re,im) synthesized as re·cos(wn) − im·sin(wn), scaled
   *     by qamScale: clean measurement = qamScale·(−0.5·im, 0.5·re).
   *   - So: (re,im) = (2·q, −2·i) recovers the point from a CLEAN (channel-
   *     free) measurement of scale 1; with channel + S0/qamScale scaling
   *     folded in, the correction factor to apply before that 2·/−2· step is
   *     κ = |clean training tone reading| / qamScale.
   *
   * The clean training tone reading is computed directly from the same
   * synthesis math as the legacy all-QPSK path, without instantiating a
   * throwaway modulator. It builds the all-zero symbol body, peak-normalizes
   * it to 0.95 (replicating the exact Float32 rounding of the modulator), and
   * applies toneIQ() to the first tone.
   */
  private computeQamRefScale(): number {
    const refAmp = OFDMQPSKDemodulator.qpskTrainingToneAmplitude(
      this.cfg.sampleRate,
      this.cfg.toneFrequencies,
      this.cfg.pilotFreqHz,
      OFDM_DEFAULTS.pilotAmplitude,
      this.fftSamples,
    );
    const numTones = this.toneCount;
    const { pilotAmplitude } = OFDM_DEFAULTS;
    const CREST = 3.5;
    const rms = Math.sqrt(numTones + pilotAmplitude * pilotAmplitude);
    const qamScale = 0.95 / (CREST * rms);
    return refAmp > 0 && qamScale > 0 ? refAmp / qamScale : 1;
  }

  /**
   * Pure helper that computes the amplitude toneIQ() would measure for tone 0
   * of an all-zero legacy QPSK training symbol. The math mirrors
   * OFDMQPSKModulator.synthesizeQpsk exactly, including Float32 rounding, so
   * the result is bit-identical to the throwaway-modulator reference it
   * replaces.
   */
  private static qpskTrainingToneAmplitude(
    sampleRate: number,
    toneFrequencies: Float32Array,
    pilotFreqHz: number,
    pilotAmplitude: number,
    fftSamples: number,
  ): number {
    const twoPiOverFs = (2 * Math.PI) / sampleRate;
    const numTones = toneFrequencies.length;
    const toneW = new Float64Array(numTones);
    for (let t = 0; t < numTones; t++) toneW[t] = twoPiOverFs * toneFrequencies[t];
    const pilotW = twoPiOverFs * pilotFreqHz;

    // Build the unscaled all-zero QPSK symbol body and find its peak.
    const body = new Float32Array(fftSamples);
    let peak = 0;
    for (let n = 0; n < fftSamples; n++) {
      let acc = Math.fround(pilotAmplitude * Math.cos(pilotW * n));
      for (let t = 0; t < numTones; t++) {
        acc += Math.fround(Math.sin(toneW[t] * n));
      }
      body[n] = acc;
      const a = Math.abs(body[n]);
      if (a > peak) peak = a;
    }
    const scale = peak > 0 ? 0.95 / peak : 1;
    for (let n = 0; n < fftSamples; n++) body[n] *= scale;

    // toneIQ() of the first tone on the normalized body.
    const f0 = toneFrequencies[0];
    let i = 0;
    let q = 0;
    for (let n = 0; n < fftSamples; n++) {
      const phase = (2 * Math.PI * f0 * n) / sampleRate;
      i += body[n] * Math.sin(phase);
      q += body[n] * Math.cos(phase);
    }
    i /= fftSamples;
    q /= fftSamples;
    return Math.hypot(i, q);
  }

  /**
   * Analyze a window: toneIQ per tone + pilot.
   */
  private analyze(window: Float32Array): {
    pilotRe: number; pilotIm: number;
    toneRe: number[]; toneIm: number[];
  } {
    const { sampleRate, toneFrequencies, pilotFreqHz } = this.cfg;
    const pilot = toneIQ(window, pilotFreqHz, sampleRate);
    const toneRe: number[] = [];
    const toneIm: number[] = [];
    for (let t = 0; t < this.toneCount; t++) {
      const iq = toneIQ(window, toneFrequencies[t], sampleRate);
      toneRe.push(iq.i);
      toneIm.push(iq.q);
    }
    return {
      pilotRe: pilot.i, pilotIm: pilot.q,
      toneRe, toneIm,
    };
  }

  trainOnSyncSymbol(window: Float32Array | number[]): void {
    if (this.trained) return;

    const buf = window instanceof Float32Array ? window : new Float32Array(window);
    const symSamples = buf.slice(this.cpSamples, this.cpSamples + this.fftSamples);
    const { pilotRe, pilotIm, toneRe, toneIm } = this.analyze(symSamples);

    if (this.trainingSymbols === 0) {
      this.channelEstRe = toneRe.slice();
      this.channelEstIm = toneIm.slice();
      this.pilotChannelEstRe = pilotRe;
      this.pilotChannelEstIm = pilotIm;
    } else {
      const alpha = 1 / (this.trainingSymbols + 1);
      for (let t = 0; t < this.toneCount; t++) {
        this.channelEstRe[t] = (1 - alpha) * this.channelEstRe[t] + alpha * toneRe[t];
        this.channelEstIm[t] = (1 - alpha) * this.channelEstIm[t] + alpha * toneIm[t];
      }
      this.pilotChannelEstRe = (1 - alpha) * this.pilotChannelEstRe + alpha * pilotRe;
      this.pilotChannelEstIm = (1 - alpha) * this.pilotChannelEstIm + alpha * pilotIm;
    }

    this.trainingSymbols++;
    if (this.trainingSymbols >= this.TRAINING_SYMBOLS) {
      this.trained = true;
      const tones = Array.from({ length: this.toneCount }, (_unused, t) => {
        const amp = Math.hypot(this.channelEstRe[t], this.channelEstIm[t]);
        const phase = (Math.atan2(this.channelEstIm[t], this.channelEstRe[t]) * 180) / Math.PI;
        return `${amp.toExponential(1)}@${phase.toFixed(0)}`;
      }).join(' ');
      dlog('OFDM-TRAIN', {
        symbols: this.trainingSymbols,
        pilotAmp: Math.hypot(this.pilotChannelEstRe, this.pilotChannelEstIm),
        h: tones,
      });
    }
  }

  demodulate(window: Float32Array | number[]): OFDMQPSKResult {
    const buf = window instanceof Float32Array ? window : new Float32Array(window);
    const symSamples = buf.slice(this.cpSamples, this.cpSamples + this.fftSamples);
    const { pilotRe, pilotIm, toneRe, toneIm } = this.analyze(symSamples);

    // Count post-training data symbols so we can freeze tracking briefly.
    if (this.trained) {
      this.postTrainingSymbols++;
    }

    const pilotAmp = Math.hypot(pilotRe, pilotIm);
    const pilotPhase = Math.atan2(pilotIm, pilotRe);

    let eqRe: number; let eqIm: number;
    const toneIQOut: Array<{ i: number; q: number }> = [];
    const bits: number[] = [];
    let frameBits = 0;

    if (this.trained) {
      // Pilot-referenced drift correction — linear in frequency, no bins.
      // Drift is Δφ per Hz: pilotDrift / pilotFreqHz.
      const pilotPhaseRef = Math.atan2(this.pilotChannelEstIm, this.pilotChannelEstRe);
      let pilotDrift = pilotPhase - pilotPhaseRef;
      while (pilotDrift > Math.PI) pilotDrift -= 2 * Math.PI;
      while (pilotDrift < -Math.PI) pilotDrift += 2 * Math.PI;
      const driftPerHz = pilotDrift / this.cfg.pilotFreqHz;

      // Note: pilot channel tracking is intentionally omitted. The pilot
      // channel estimate must stay stable as the phase reference for drift
      // correction; updating it creates a feedback loop that amplifies
      // quantization noise. Tone tracking below is sufficient.


      if (this.allQpsk) {
        // ── Legacy hard 4-phase slicer — UNCHANGED, byte-identical to the
        // pre-QAM demodulator (only phase is corrected; amplitude is never a
        // decision axis here, matching the legacy TX per-symbol peak-norm). ──
        for (let t = 0; t < this.toneCount; t++) {
          const chPhase = Math.atan2(this.channelEstIm[t], this.channelEstRe[t]);
          const toneCorr = -chPhase - driftPerHz * this.cfg.toneFrequencies[t];
          const corrCos = Math.cos(toneCorr);
          const corrSin = Math.sin(toneCorr);

          const rawRe = toneRe[t];
          const rawIm = toneIm[t];
          eqRe = rawRe * corrCos - rawIm * corrSin;
          eqIm = rawRe * corrSin + rawIm * corrCos;

          // ── decision-directed channel tracking (confidence-gated) ──
          // Only update on confident decisions (within 22.5° of the nearest
          // QPSK point) — otherwise a single noisy symbol nudges channelEst
          // toward the wrong constellation point and, with no gate, later
          // frames in the same burst inherit and compound that error.
          // FREEZE: skip tracking during first N post-training symbols so
          // initial data demodulation uses pure training-based compensation
          // instead of fighting a tracking loop that collapses all tones.
          const TRACKING_FREEZE = 14; // postTrainingSymbols starts at 1, so freezes symbols 1..14
          const trackingDisabled = this.trained && this.postTrainingSymbols < TRACKING_FREEZE;
          if (this.trackingAlpha > 0 && !trackingDisabled) {
            let normPh = Math.atan2(eqIm, eqRe);
            if (normPh < 0) normPh += 2 * Math.PI;
            const sym = Math.round(normPh / (Math.PI / 2)) % 4;
            const nearestAngle = sym * (Math.PI / 2) + Math.PI / 4;
            const phaseError = Math.abs(normPh - nearestAngle);
            const wrappedError = phaseError > Math.PI ? 2 * Math.PI - phaseError : phaseError;
            if (wrappedError < Math.PI / 8 && !trackingDisabled) {
              const expRe = Math.cos(nearestAngle);
              const expIm = Math.sin(nearestAngle);
              const ratioRe = rawRe * expRe + rawIm * expIm;
              const ratioIm = rawIm * expRe - rawRe * expIm;
              this.channelEstRe[t] += this.trackingAlpha * (ratioRe - this.channelEstRe[t]);
              this.channelEstIm[t] += this.trackingAlpha * (ratioIm - this.channelEstIm[t]);
            }
          }
          // ── end tracking ──

          toneIQOut.push({ i: eqRe, q: eqIm });

          let normalizedPhase = Math.atan2(eqIm, eqRe);
          if (normalizedPhase < 0) normalizedPhase += 2 * Math.PI;
          const sym = Math.round(normalizedPhase / (Math.PI / 2)) % 4;

          // ── MER/EVM accumulation (diagnostic only, staged) ──
          // Phase-EVM: the TX peak-normalizes each OFDM symbol independently, so
          // per-tone amplitude is not constant and QPSK decides on phase alone.
          // Normalize each point to unit magnitude and measure its distance to
          // the ideal unit point sym·90° — i.e. angular tightness (|err| =
          // 2·sin(Δφ/2)). This is the "how dead-center in the quadrant" number.
          // Lands in STAGED only — demodulate() doesn't know yet whether this
          // window belongs to a frame that will decode successfully; the
          // caller commits or discards the whole run via commitMER()/
          // discardMER() once that's known.
          const mag = Math.hypot(eqRe, eqIm);
          if (mag > 0) {
            const idealAngle = sym * (Math.PI / 2);
            const eRe = eqRe / mag - Math.cos(idealAngle);
            const eIm = eqIm / mag - Math.sin(idealAngle);
            const errPow = eRe * eRe + eIm * eIm;
            this.stagedErrPow += errPow;
            this.stagedRefPow += 1; // unit reference power
            this.stagedCount++;
            this.stagedToneErr[t] += errPow;
            this.stagedToneRef[t] += 1;
          }
          // ── end MER ──

          const b0 = (sym >> 1) & 1;
          const b1 = sym & 1;
          bits.push(b0, b1);
          frameBits |= b0 << (7 - t * 2);
          frameBits |= 1 << (6 - t * 2);
        }

        if (this.diagCount === 0) {
          this.diagCount++;
          const perTone = toneIQOut
            .map((iq, t) => {
              let deg = (Math.atan2(iq.q, iq.i) * 180) / Math.PI;
              if (deg < 0) deg += 360;
              return `t${t}:${deg.toFixed(0)}°/${(bits[t * 2] << 1) | bits[t * 2 + 1]}`;
            })
            .join(' ');
          dlog('OFDM-DEMOD', { firstSym: perTone, pilotAmp: pilotAmp.toFixed(4), tones: this.toneCount });
          // ── Deep diagnostics for first symbol: trace phase through each step ──
          const { symSamples } = ofdmSamples(this.cfg.sampleRate);
          const body = buf.slice(this.cpSamples, this.cpSamples + this.fftSamples);
          const rawAnalysis = this.analyze(body);
          const diagLines = [];
          for (let t = 0; t < Math.min(8, this.toneCount); t++) {
            const chP = Math.atan2(this.channelEstIm[t], this.channelEstRe[t]) * 180 / Math.PI;
            const dr = driftPerHz * this.cfg.toneFrequencies[t] * 180 / Math.PI;
            const rawP = Math.atan2(rawAnalysis.toneIm[t], rawAnalysis.toneRe[t]) * 180 / Math.PI;
            const eqP = Math.atan2(toneIQOut[t].q, toneIQOut[t].i) * 180 / Math.PI;
            diagLines.push(`t${t}:raw=${rawP.toFixed(1)}° chP=${chP.toFixed(1)}° drift*freq=${dr.toFixed(1)}° corr=${(-chP-dr).toFixed(1)}° eqP=${eqP.toFixed(1)}°`);
          }
          dlog('OFDM-DEMOD-DIAG', { steps: diagLines.join('; ') }, { level: 'warn' });
        }
      } else {
        // ── Per-tone QAM path (taken only when some tone's order > QPSK) ──
        // Full complex equalization (phase AND magnitude) instead of the
        // legacy phase-only correction — 16/64-QAM need amplitude as a
        // decision axis, which only works because 3a gave the TX a fixed
        // (not per-symbol-renormalized) amplitude. See computeQamRefScale's
        // doc for why a fixed correction ratio is layered on top of the
        // per-tone channel estimate. Decision-directed tracking (confidence-
        // gated, same idea as the QPSK path above but updating the FULL
        // complex channel estimate, not just phase) keeps channelEst from
        // drifting relative to the fixed κ/drift correction over a long
        // QAM-rate run — without it, 16/64-QAM's much tighter decision
        // regions accumulate enough residual error to raise the effective
        // symbol error rate well above what the channel's actual MER
        // supports (phase-only tracking, as QPSK does, isn't enough once
        // amplitude is itself a decision axis).
        for (let t = 0; t < this.toneCount; t++) {
          const order = this.toneOrders[t];
          const chRe = this.channelEstRe[t];
          const chIm = this.channelEstIm[t];
          const chMagSq = chRe * chRe + chIm * chIm;
          const rawRe = toneRe[t];
          const rawIm = toneIm[t];

          // Complex divide raw by the trained channel estimate — corrects
          // both phase and magnitude (unlike the QPSK path above).
          const divRe = chMagSq > 1e-12 ? (rawRe * chRe + rawIm * chIm) / chMagSq : 0;
          const divIm = chMagSq > 1e-12 ? (rawIm * chRe - rawRe * chIm) / chMagSq : 0;

          // Extra pilot-drift rotation beyond the trained snapshot (phase
          // only — drift is a timing artifact, not a per-tone gain change).
          const extraAngle = -driftPerHz * this.cfg.toneFrequencies[t];
          const cosE = Math.cos(extraAngle);
          const sinE = Math.sin(extraAngle);
          const rotRe = divRe * cosE - divIm * sinE;
          const rotIm = divRe * sinE + divIm * cosE;

          // Correct the residual training-scale-vs-qamScale ratio (see
          // computeQamRefScale), then undo the fixed rotation/scale baked
          // into the re·cos − im·sin synthesis + toneIQ(sin,cos) convention:
          // a clean (re,im) point measures as (i,q) = (−0.5·im, 0.5·re), so
          // (re,im) = (2·q, −2·i) recovers it.
          const iCorr = rotRe * this.qamRefScale;
          const qCorr = rotIm * this.qamRefScale;
          const re = 2 * qCorr;
          const im = -2 * iCorr;

          toneIQOut.push({ i: re, q: im });

          const symBits = sliceSymbol(re, im, order);
          for (let b = order - 1; b >= 0; b--) bits.push((symBits >> b) & 1);

          // ── MER/EVM (diagnostic only, staged) — QAM tones compare against
          // the actual nearest constellation point (no unit-magnitude
          // normalization: amplitude is a real decision axis here). ──
          const ideal = mapSymbol(symBits, order);
          const eRe = re - ideal.re;
          const eIm = im - ideal.im;
          const errPow = eRe * eRe + eIm * eIm;
          const refPow = ideal.re * ideal.re + ideal.im * ideal.im;
          this.stagedErrPow += errPow;
          this.stagedRefPow += refPow;
          this.stagedCount++;
          this.stagedToneErr[t] += errPow;
          this.stagedToneRef[t] += refPow;

          // ── decision-directed FULL channel tracking (confidence-gated) ──
          // Only update on confident decisions (error small relative to the
          // point's own power) — reconstruct what `div` (the pre-κ, pre-
          // rotation equalized value) SHOULD have been for the sliced
          // `ideal` point, then channelEstImplied = raw / expectedDiv gives
          // a fresh complex channel estimate directly from this symbol,
          // independent of the current one — blended in with a leaky
          // integrator exactly like the QPSK tracker above.
          if (refPow > 0 && errPow / refPow < 0.09) {
            const i0 = -ideal.im / 2;
            const q0 = ideal.re / 2;
            const expRotRe = i0 / this.qamRefScale;
            const expRotIm = q0 / this.qamRefScale;
            // Undo the drift rotation (inverse of the forward rotRe/rotIm step).
            const expDivRe = expRotRe * cosE + expRotIm * sinE;
            const expDivIm = expRotIm * cosE - expRotRe * sinE;
            const expDivMagSq = expDivRe * expDivRe + expDivIm * expDivIm;
            if (expDivMagSq > 1e-12) {
              const impliedRe = (rawRe * expDivRe + rawIm * expDivIm) / expDivMagSq;
              const impliedIm = (rawIm * expDivRe - rawRe * expDivIm) / expDivMagSq;
              this.channelEstRe[t] += this.qamTrackingAlpha * (impliedRe - this.channelEstRe[t]);
              this.channelEstIm[t] += this.qamTrackingAlpha * (impliedIm - this.channelEstIm[t]);
            }
          }
          // ── end tracking ──
        }
        // frameBits has no meaningful generic encoding across mixed tone
        // orders — the caller (rxEngine) uses `bits` directly for the QAM
        // path instead of the QPSK-only nibble-lane frameBits byte.
      }
    } else {
      // Fallback: pilot-phase correction (same for all tones)
      const cosP = Math.cos(-pilotPhase);
      const sinP = Math.sin(-pilotPhase);

      for (let t = 0; t < this.toneCount; t++) {
        const re = toneRe[t];
        const im = toneIm[t];
        eqRe = re * cosP - im * sinP;
        eqIm = re * sinP + im * cosP;

        toneIQOut.push({ i: eqRe, q: eqIm });

        let normalizedPhase = Math.atan2(eqIm, eqRe);
        if (normalizedPhase < 0) normalizedPhase += 2 * Math.PI;
        const sym = Math.round(normalizedPhase / (Math.PI / 2)) % 4;

        const b0 = (sym >> 1) & 1;
        const b1 = sym & 1;
        bits.push(b0, b1);
        frameBits |= b0 << (7 - t * 2);
        frameBits |= 1 << (6 - t * 2);
      }
    }

    return { bits, frameBits, pilotAmplitude: pilotAmp, pilotPhase, toneIQ: toneIQOut };
  }
}
