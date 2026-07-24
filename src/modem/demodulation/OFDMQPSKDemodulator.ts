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
import { ofdmSamples, OFDM_TUNING } from '../types';
import { dlog } from '../../lib/debug/dlog';

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

  constructor(config: OFDMQPSKDemodulatorConfig) {
    this.cfg = config;
    this.toneCount = config.toneFrequencies.length;

    const { fftSamples, cpSamples } = ofdmSamples(config.sampleRate);
    this.fftSamples = fftSamples;
    this.cpSamples = cpSamples;
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
  }

  resetTraining(): void {
    this.trained = false;
    this.trainingSymbols = 0;
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
   * Analyze a window: toneIQ per tone + pilot.
   */
  private analyze(window: Float32Array): {
    pilotRe: number; pilotIm: number;
    toneRe: number[]; toneIm: number[];
  } {
    const { sampleRate, toneFrequencies, pilotFreqHz } = this.cfg;
    const samples = Array.from(window);
    const pilot = toneIQ(samples, pilotFreqHz, sampleRate);
    const toneRe: number[] = [];
    const toneIm: number[] = [];
    for (let t = 0; t < this.toneCount; t++) {
      const iq = toneIQ(samples, toneFrequencies[t], sampleRate);
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
        if (this.trackingAlpha > 0) {
          let normPh = Math.atan2(eqIm, eqRe);
          if (normPh < 0) normPh += 2 * Math.PI;
          const sym = Math.round(normPh / (Math.PI / 2)) % 4;
          const nearestAngle = sym * (Math.PI / 2) + Math.PI / 4;
          const phaseError = Math.abs(normPh - nearestAngle);
          const wrappedError = phaseError > Math.PI ? 2 * Math.PI - phaseError : phaseError;
          if (wrappedError < Math.PI / 8) {
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
        dlog('OFDM-DEMOD', { firstSym: perTone });
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
