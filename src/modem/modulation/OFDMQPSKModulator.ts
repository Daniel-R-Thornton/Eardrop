/**
 * OFDMQPSKModulator – OFDM modulator matching the 256-SPS atomic-frame protocol.
 *
 * Uses a 256-point IFFT so one OFDM symbol occupies exactly one protocol symbol
 * period (256 samples at 3200 Hz). QPSK symbols are placed at the IFFT bins
 * corresponding to the configured absolute tone frequencies. A cyclic prefix
 * provides multipath protection.
 *
 * The pilot carrier is placed at the pilot frequency bin with a fixed phase
 * (real-only, 0° phase reference) so the demodulator can use it for phase
 * alignment.
 */

import { DSP } from '../dsp/dsp';

export interface OFDMQPSKModulatorConfig {
  /** Sample rate (e.g., 3200 Hz) */
  sampleRate: number;
  /** Number of sub‑carriers (tone count, e.g., 4) */
  toneCount: number;
  /** IFFT size — must be a power of two (e.g., 256 to match SPS) */
  ifftSize: number;
  /** Overall amplitude scaling applied to the time‑domain output */
  amplitude: number;
  /** Pilot carrier frequency (Hz) — placed at its bin with fixed phase */
  pilotFreqHz: number;
  /** Pilot carrier amplitude (used directly in the bin) */
  pilotAmplitude: number;
  /** Absolute tone frequencies (pilot + offsets), one per tone */
  toneFrequencies: Float32Array;
  /** Cyclic prefix length in samples (e.g., 16 → ~5 ms at 3200 Hz) */
  cpLength: number;
}

/** Map 2‑bit QPSK value (0‑3) to a complex unit phasor */
function qpskMap(symbol: number): { re: number; im: number } {
  const phase = (symbol % 4) * (Math.PI / 2); // 0, π/2, π, 3π/2
  return { re: Math.cos(phase), im: Math.sin(phase) };
}

export class OFDMQPSKModulator {
  private cfg: OFDMQPSKModulatorConfig;
  private dsp: DSP;
  private ifftSize: number;
  private toneCount: number;

  /** Pre‑computed FFT bin index for the pilot carrier */
  private pilotBin: number;
  /** Pre‑computed FFT bin indices for each tone */
  private toneBins: number[];

  /** Frequency‑domain buffers (complex) */
  private freqDomainRe: Float64Array;
  private freqDomainIm: Float64Array;

  constructor(config: OFDMQPSKModulatorConfig) {
    this.cfg = config;
    this.dsp = new DSP(config.sampleRate);
    this.ifftSize = config.ifftSize;
    this.toneCount = config.toneCount;

    if ((this.ifftSize & (this.ifftSize - 1)) !== 0) {
      throw new Error('ifftSize must be a power of two');
    }

    // Compute bin indices from absolute frequencies
    this.pilotBin = Math.round(
      (config.pilotFreqHz * this.ifftSize) / config.sampleRate,
    );
    this.toneBins = [];
    for (let t = 0; t < config.toneCount; t++) {
      const bin = Math.round(
        (config.toneFrequencies[t] * this.ifftSize) / config.sampleRate,
      );
      // Don't let a tone land on DC or on the pilot bin
      if (bin === 0 || bin >= this.ifftSize / 2) {
        throw new Error(
          `Tone ${t} frequency ${config.toneFrequencies[t]} Hz maps to bin ${bin}, out of valid range`,
        );
      }
      this.toneBins.push(bin);
    }

    this.freqDomainRe = new Float64Array(this.ifftSize);
    this.freqDomainIm = new Float64Array(this.ifftSize);
  }

  /** Set QPSK symbols for the upcoming OFDM symbol.
   *  `symbols` length must equal `toneCount`. Each entry is 0‑3 (2‑bit value).
   *  Also places the pilot carrier at its bin with a fixed real‑only amplitude.
   */
  setSymbols(symbols: number[]): void {
    if (symbols.length !== this.toneCount) {
      throw new Error(`Expected ${this.toneCount} symbols, got ${symbols.length}`);
    }

    // Clear all bins
    this.freqDomainRe.fill(0);
    this.freqDomainIm.fill(0);

    // Place pilot carrier (real-only, 0° phase reference for demodulator)
    if (this.pilotBin > 0 && this.pilotBin < this.ifftSize / 2) {
      this.freqDomainRe[this.pilotBin] = this.cfg.pilotAmplitude;
      this.freqDomainIm[this.pilotBin] = 0;
    }

    // Place data tones at their frequency bins with QPSK modulation
    for (let i = 0; i < this.toneCount; i++) {
      const bin = this.toneBins[i];
      const { re, im } = qpskMap(symbols[i]);
      this.freqDomainRe[bin] = re;
      this.freqDomainIm[bin] = im;
    }

    // Enforce Hermitian symmetry for a real‑valued IFFT output.
    // Only mirror bins that we populated (pilot + tones).
    // For Hermitian symmetry: X[N‑k] = conj(X[k])
    if (this.pilotBin > 0 && this.pilotBin < this.ifftSize / 2) {
      const mirrorPilot = this.ifftSize - this.pilotBin;
      this.freqDomainRe[mirrorPilot] = this.freqDomainRe[this.pilotBin];
      this.freqDomainIm[mirrorPilot] = -this.freqDomainIm[this.pilotBin];
    }
    for (const bin of this.toneBins) {
      const mirror = this.ifftSize - bin;
      this.freqDomainRe[mirror] = this.freqDomainRe[bin];
      this.freqDomainIm[mirror] = -this.freqDomainIm[bin];
    }
  }

  /** Perform IFFT via conjugate‑FFT technique.
   *  Returns a Float32Array of `ifftSize` time‑domain samples.
   */
  private ifft(): Float32Array {
    const n = this.ifftSize;
    const bits = Math.log2(n);

    // Step 1: conjugate the input
    const real = new Float64Array(this.freqDomainRe);
    const imag = new Float64Array(this.freqDomainIm);
    for (let i = 0; i < n; i++) imag[i] = -imag[i];

    // Bit reversal
    for (let i = 0; i < n; i++) {
      let rev = 0;
      for (let j = 0; j < bits; j++) rev = (rev << 1) | ((i >> j) & 1);
      if (rev > i) {
        [real[i], real[rev]] = [real[rev], real[i]];
        [imag[i], imag[rev]] = [imag[rev], imag[i]];
      }
    }

    // Cooley‑Tukey FFT (forward: -2π)
    for (let len = 2; len <= n; len <<= 1) {
      const angle = (-2 * Math.PI) / len;
      const wlenReal = Math.cos(angle);
      const wlenImag = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let wReal = 1, wImag = 0;
        for (let j = 0; j < len / 2; j++) {
          const uReal = real[i + j];
          const uImag = imag[i + j];
          const vReal = real[i + j + len / 2] * wReal - imag[i + j + len / 2] * wImag;
          const vImag = real[i + j + len / 2] * wImag + imag[i + j + len / 2] * wReal;
          real[i + j] = uReal + vReal;
          imag[i + j] = uImag + vImag;
          real[i + j + len / 2] = uReal - vReal;
          imag[i + j + len / 2] = uImag - vImag;
          const nwR = wReal * wlenReal - wImag * wlenImag;
          const nwI = wReal * wlenImag + wImag * wlenReal;
          wReal = nwR;
          wImag = nwI;
        }
      }
    }

    // Step 2: conjugate output and scale by 1/N
    const out = new Float32Array(n);
    const scale = 1 / n;
    for (let i = 0; i < n; i++) {
      // Conjugate (negate imag of FFT output) and scale
      out[i] = (real[i] * scale) as unknown as number;
    }
    return out;
  }

  /** Generate a single OFDM symbol with cyclic prefix.
   *  Returns a Float32Array of length `ifftSize + cpLength`.
   *  Automatically normalizes the time‑domain output so the peak is near 1.0.
   */
  generateSymbol(): Float32Array {
    const timeDomain = this.ifft();

    // Find peak amplitude in the raw IFFT output
    let peak = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const abs = Math.abs(timeDomain[i]);
      if (abs > peak) peak = abs;
    }

    // Scale so peak ≈ 0.95 (leave 5% headroom to prevent clipping)
    const normScale = peak > 0 ? (0.95 / peak) : 1.0;
    for (let i = 0; i < timeDomain.length; i++) {
      timeDomain[i] *= normScale;
    }

    // Add cyclic prefix
    const {cpLength} = this.cfg;
    const output = new Float32Array(timeDomain.length + cpLength);
    // Copy last cpLength samples to the start
    for (let i = 0; i < cpLength; i++) {
      output[i] = timeDomain[timeDomain.length - cpLength + i];
    }
    output.set(timeDomain, cpLength);
    return output;
  }
}

