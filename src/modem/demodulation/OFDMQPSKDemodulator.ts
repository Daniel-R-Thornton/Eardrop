/**
 * OFDMQPSKDemodulator – OFDM/QPSK receiver-side demodulator.
 *
 * Uses FFT to extract subcarrier values, then QPSK quadrant decoding.
 * Supports per-tone channel equalization trained on the OFDM sync burst
 * (24 symbols with all tones at QPSK 0°), which provides known reference
 * symbols to measure per-tone channel frequency response.
 *
 * The sync burst training measures H[k] = Y[k] / X[k] for each tone,
 * where X[k] = 1 (QPSK 0°). Then data symbols are equalized by
 * multiplying by conj(H[k]) / |H[k]|^2 (zero-forcing) or just
 * rotating by -angle(H[k]) (phase-only correction).
 */

import { DSP } from '../dsp/dsp';
import { dlog } from '../../lib/debug/dlog';

export interface OFDMQPSKDemodulatorConfig {
  sampleRate: number;
  fftSize: number;
  toneCount: number;
  pilotFreqHz: number;
  toneFrequencies: Float32Array;
  cpLength: number;
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
  private dsp: DSP;
  private fftSize: number;
  private toneCount: number;
  private pilotBin: number;
  private toneBins: number[];

  // Per-tone channel estimates (trained on sync burst)
  private channelEstRe: number[] = [];
  private channelEstIm: number[] = [];
  private pilotChannelEstRe = 0;
  private pilotChannelEstIm = 0;
  private trained = false;
  private trainingSymbols = 0;
  private readonly TRAINING_SYMBOLS = 12;
  /** Diagnostic counter for QPSK demod */
  private _diagCount = 0; // Use first 16 sync symbols for training

  constructor(config: OFDMQPSKDemodulatorConfig) {
    this.cfg = config;
    this.dsp = new DSP(config.sampleRate);
    this.fftSize = config.fftSize;
    this.toneCount = config.toneCount;

    this.pilotBin = Math.round(
      (config.pilotFreqHz * this.fftSize) / config.sampleRate,
    );
    this.toneBins = [];
    for (let t = 0; t < config.toneCount; t++) {
      const bin = Math.round(
        (config.toneFrequencies[t] * this.fftSize) / config.sampleRate,
      );
      this.toneBins.push(bin);
    }

    // Initialize channel estimates to identity
    this.channelEstRe = new Array(this.toneCount).fill(1);
    this.channelEstIm = new Array(this.toneCount).fill(0);
    this.pilotChannelEstRe = 1;
    this.pilotChannelEstIm = 0;
  }

  /** Reset training state (call when starting new reception) */
  resetTraining(): void {
    this.trained = false;
    this.trainingSymbols = 0;
    this._diagCount = 0;
    this.channelEstRe = new Array(this.toneCount).fill(1);
    this.channelEstIm = new Array(this.toneCount).fill(0);
    this.pilotChannelEstRe = 1;
    this.pilotChannelEstIm = 0;
  }

  /** Check if still in training mode */
  isTraining(): boolean {
    return this.trainingSymbols < this.TRAINING_SYMBOLS;
  }

  /** Run FFT on a window and extract bin values */
  private analyze(window: Float32Array): {
    pilotRe: number; pilotIm: number;
    toneRe: number[]; toneIm: number[];
  } {
    const { real, imag } = this.dsp.fft(window);
    return {
      pilotRe: real[this.pilotBin], pilotIm: imag[this.pilotBin],
      toneRe: this.toneBins.map((b) => real[b]),
      toneIm: this.toneBins.map((b) => imag[b]),
    };
  }

  /**
   * Train channel estimates on a known reference symbol.
   * The sync burst sends QPSK 0° on all tones: X[k] = 1 + j0.
   * So H[k] = Y[k] / 1 = Y[k]. We average over multiple symbols.
   */
  trainOnSyncSymbol(window: Float32Array | number[]): void {
    if (this.trained) return;
    
    const { fftSize, cfg } = this;
    const buf = window instanceof Float32Array ? window : new Float32Array(window);
    const start = cfg.cpLength || 0;
    const symSamples = buf.slice(start, start + fftSize);
    const { pilotRe, pilotIm, toneRe, toneIm } = this.analyze(symSamples);

    // Accumulate channel estimates (H[k] = Y[k] since X[k] = 1)
    if (this.trainingSymbols === 0) {
      this.channelEstRe = toneRe.slice();
      this.channelEstIm = toneIm.slice();
      this.pilotChannelEstRe = pilotRe;
      this.pilotChannelEstIm = pilotIm;
    } else {
      // Running average
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

  /**
   * Demodulate a data symbol using trained channel estimates.
   * Equalization: Y_eq = Y * conj(H) / |H|^2 (zero-forcing)
   * For phase-only: rotate by -angle(H)
   */
  demodulate(window: Float32Array | number[]): OFDMQPSKResult {
    const { fftSize, cfg } = this;
    const buf = window instanceof Float32Array ? window : new Float32Array(window);
    // Skip cyclic prefix (if any), take FFT-size samples
    const start = cfg.cpLength || 0;
    const symSamples = buf.slice(start, start + fftSize);
    const { pilotRe, pilotIm, toneRe, toneIm } = this.analyze(symSamples);

    const pilotAmp = Math.hypot(pilotRe, pilotIm);
    const pilotPhase = Math.atan2(pilotIm, pilotRe);

    // Use trained channel estimates if available, else fall back to pilot-phase correction
    let eqRe: number, eqIm: number;
    const toneIQ: Array<{ i: number; q: number }> = [];
    const bits: number[] = [];
    let frameBits = 0;

    // Use training-based timing drift correction
    if (this.trained) {
      // Estimate timing drift Δτ from pilot phase change since training start.
      // Pilot phase at training: φ0 = -2π*35*τ0/N + ∠H_pilot (constant)
      // Pilot phase now:       φ  = -2π*35*(τ0+Δτ)/N + ∠H_pilot
      // Δφ_pilot = φ - φ0 = -2π*35*Δτ/N → Δτ = -Δφ_pilot * N / (2π*35)
      // Per-tone correction: φ_k(corr) = +2π*k*Δτ/N = -k * Δφ_pilot / 35
      const pilotPhaseRef = Math.atan2(this.pilotChannelEstIm, this.pilotChannelEstRe);
      let pilotDrift = pilotPhase - pilotPhaseRef;
      // Normalize drift to [-π, π]
      while (pilotDrift > Math.PI) pilotDrift -= 2 * Math.PI;
      while (pilotDrift < -Math.PI) pilotDrift += 2 * Math.PI;

      for (let t = 0; t < this.toneCount; t++) {
        const bin = this.toneBins[t];
        // Phase-only equalization: remove the per-tone channel phase measured
        // on the sync burst (covers speaker/mic response AND the constant
        // window-grid offset), then correct pilot-referenced timing drift.
        // Phase-only avoids the magnitude instability of full zero-forcing.
        const chPhase = Math.atan2(this.channelEstIm[t], this.channelEstRe[t]);
        const toneCorr = -chPhase - (pilotDrift * bin) / this.pilotBin;
        const corrCos = Math.cos(toneCorr);
        const corrSin = Math.sin(toneCorr);

        const rawRe = toneRe[t];
        const rawIm = toneIm[t];
        eqRe = rawRe * corrCos - rawIm * corrSin;
        eqIm = rawRe * corrSin + rawIm * corrCos;

        toneIQ.push({ i: eqRe, q: eqIm });

        // QPSK quadrant decoding
        let normalizedPhase = Math.atan2(eqIm, eqRe);
        if (normalizedPhase < 0) normalizedPhase += 2 * Math.PI;
        const sym = Math.round(normalizedPhase / (Math.PI / 2)) % 4;

        const b0 = (sym >> 1) & 1;
        const b1 = sym & 1;
        bits.push(b0, b1);

        frameBits |= b0 << (7 - t * 2);
        frameBits |= 1 << (6 - t * 2);
      }

      // Diagnostic: one line for the first data symbol — all tones
      if (this._diagCount === 0) {
        this._diagCount++;
        const perTone = toneIQ
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

        // Pilot-referenced phase correction
        eqRe = re * cosP - im * sinP;
        eqIm = re * sinP + im * cosP;

        toneIQ.push({ i: eqRe, q: eqIm });

        // QPSK quadrant decoding
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

    return { bits, frameBits, pilotAmplitude: pilotAmp, pilotPhase, toneIQ };
  }
}