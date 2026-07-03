/**
 * PilotScanner + PilotPLL — Pilot frequency discovery and phase tracking.
 *
 * Two-phase design:
 *   1. PilotScanner: Buffer ~0.5s of leader audio, run FFT with zero-padding
 *      to 2048 samples (bin spacing ~1.56 Hz), find peak in 40-120 Hz range.
 *      Parabolic interpolation around peak gives <0.1 Hz accuracy.
 *   2. PilotPLL: Second-order PLL locked to the discovered frequency. Tracks phase
 *      and amplitude continuously through the entire transmission.
 *
 * All data-tone measurements are relative to the PLL's tracked phase and amplitude.
 */

import { TONE_OFFSETS } from "./types";

// ─── FFT helpers (radix-2, in-place, power-of-2 only) ──

/**
 * Compute FFT magnitude spectrum for a real-valued input.
 * Input is zero-padded to `fftSize` if shorter. Returns magnitude per bin.
 * Only the first `fftSize/2` bins are valid (Nyquist).
 */
function fftMagnitude(samples: number[], fftSize: number): Float64Array {
  const n = fftSize;
  // Real and imag arrays, zero-filled
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < Math.min(samples.length, n); i++) {
    real[i] = samples[i];
  }

  // Bit-reversal permutation
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let rev = 0;
    for (let j = 0; j < bits; j++) rev = (rev << 1) | ((i >> j) & 1);
    if (rev > i) {
      [real[i], real[rev]] = [real[rev], real[i]];
      [imag[i], imag[rev]] = [imag[rev], imag[i]];
    }
  }

  // Cooley-Tukey radix-2
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wlenR = Math.cos(angle);
    const wlenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wR = 1, wI = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uR = real[i + j];
        const uI = imag[i + j];
        const vR = real[i + j + half] * wR - imag[i + j + half] * wI;
        const vI = real[i + j + half] * wI + imag[i + j + half] * wR;
        real[i + j] = uR + vR;
        imag[i + j] = uI + vI;
        real[i + j + half] = uR - vR;
        imag[i + j + half] = uI - vI;
        const nwR = wR * wlenR - wI * wlenI;
        const nwI = wR * wlenI + wI * wlenR;
        wR = nwR;
        wI = nwI;
      }
    }
  }

  // Magnitude for first half
  const mag = new Float64Array(n >> 1);
  for (let i = 0; i < mag.length; i++) {
    mag[i] = Math.hypot(real[i], imag[i]);
  }
  return mag;
}

/**
 * Parabolic interpolation around a peak bin for sub-bin frequency accuracy.
 * Given magnitude at bins (peak-1, peak, peak+1), fit a parabola and
 * return the fractional offset from the peak bin.
 */
function interpolatePeak(m0: number, m1: number, m2: number): number {
  const denom = m0 - 2 * m1 + m2;
  if (Math.abs(denom) < 1e-12) return 0;
  return (m0 - m2) / (2 * denom);
}

// ─── PilotScanner ─────────────────────────────────────

export interface PilotDiscovery {
  /** Discovered pilot frequency in Hz */
  freq: number;
  /** Estimated pilot amplitude (magnitude at peak, normalized) */
  amplitude: number;
  /** Confidence 0-1 (based on signal-to-noise ratio in FFT) */
  confidence: number;
}

export interface PilotScannerConfig {
  /** Frequency range to scan (Hz) */
  scanRange: [number, number];
  /** Sample rate */
  sampleRate: number;
  /** FFT size (must be power of 2) — default 2048 for ~1.56 Hz bins */
  fftSize: number;
  /** Minimum number of samples to collect before running FFT */
  minSamples: number;
  /** Minimum peak-to-median ratio to accept a discovery */
  minSignalRatio: number;
}

const DEFAULT_SCANNER_CONFIG: PilotScannerConfig = {
  scanRange: [100, 500],
  sampleRate: 3200,
  fftSize: 2048,
  minSamples: 1024,  // ~0.32s at 3200 Hz — enough for a clean spectrum
  minSignalRatio: 6.0,
};

export class PilotScanner {
  private cfg: PilotScannerConfig;
  private buf: number[] = [];
  private done = false;
  private result: PilotDiscovery | null = null;

  constructor(cfg: Partial<PilotScannerConfig> = {}) {
    this.cfg = { ...DEFAULT_SCANNER_CONFIG, ...cfg };
  }

  /** Feed one audio sample. Returns null until discovery is complete. */
  feedSample(sample: number): PilotDiscovery | null {
    if (this.done) return this.result;
    this.buf.push(sample);
    if (this.buf.length >= this.cfg.minSamples) {
      this.runFft();
      this.done = true;
      return this.result;
    }
    return null;
  }

  /** Force discovery with whatever samples we have */
  forceDiscover(): PilotDiscovery | null {
    if (this.done) return this.result;
    if (this.buf.length < 64) return null; // too few samples
    this.runFft();
    this.done = true;
    return this.result;
  }

  isDone(): boolean { return this.done; }
  getResult(): PilotDiscovery | null { return this.result; }
  reset() {
    this.buf = [];
    this.done = false;
    this.result = null;
  }

  private runFft() {
    const { scanRange, sampleRate, fftSize, minSignalRatio } = this.cfg;

    // Zero-padded FFT
    const mag = fftMagnitude(this.buf, fftSize);
    const binWidth = sampleRate / fftSize;

    // Bin range for our scan
    const binLo = Math.max(1, Math.floor(scanRange[0] / binWidth));
    const binHi = Math.min(mag.length - 1, Math.ceil(scanRange[1] / binWidth));

    // Find the peak bin in the scan range
    let peakBin = binLo;
    let peakMag = mag[binLo];
    for (let b = binLo + 1; b <= binHi; b++) {
      if (mag[b] > peakMag) {
        peakMag = mag[b];
        peakBin = b;
      }
    }

    // Compute noise floor as median magnitude across the whole spectrum
    // (excluding the scan range to avoid counting the pilot itself)
    const allMags: number[] = [];
    for (let b = 1; b < mag.length; b++) {
      if (b < binLo - 2 || b > binHi + 2) {
        allMags.push(mag[b]);
      }
    }
    allMags.sort((a, b) => a - b);
    const noiseMedian = allMags[Math.floor(allMags.length / 2)] || 1e-12;

    const signalRatio = peakMag / Math.max(noiseMedian, 1e-14);

    if (signalRatio < minSignalRatio) {
      this.result = null;
      return;
    }

    // Parabolic interpolation for sub-bin accuracy
    const m0 = peakBin > 0 ? mag[peakBin - 1] : 0;
    const m1 = peakMag;
    const m2 = peakBin < mag.length - 1 ? mag[peakBin + 1] : 0;
    const offset = interpolatePeak(m0, m1, m2);

    const freq = (peakBin + offset) * binWidth;
    const roundedFreq = Math.round(freq * 10) / 10; // round to 0.1 Hz
    const amplitude = peakMag / this.buf.length;
    const confidence = Math.min(1, (signalRatio - minSignalRatio) / 20);

    this.result = { freq: roundedFreq, amplitude, confidence };
  }
}

// ─── PilotPLL ─────────────────────────────────────────

export interface PLLConfig {
  /** Proportional gain */
  Kp: number;
  /** Integral gain */
  Ki: number;
  /** Sample rate */
  sampleRate: number;
}

const DEFAULT_PLL_CONFIG: PLLConfig = {
  Kp: 0.1,
  Ki: 0.01,
  sampleRate: 3200,
};

/**
 * Second-order phase-locked loop for continuous pilot tracking.
 *
 * Tracks phase at the discovered pilot frequency. The PLL runs on every sample
 * and provides real-time phase and amplitude estimates for pilot-relative
 * demodulation.
 */
export class PilotPLL {
  private cfg: PLLConfig;

  /** Tracked pilot frequency (Hz) */
  private freq: number;
  /** Internal NCO phase accumulator (cycles, 0..1) */
  private phase: number;
  /** Loop filter state */
  private integrator: number;
  /** Smoothed amplitude estimate */
  private amplitude: number;

  /** Reference sin/cos for the current sample */
  private sinRef = 0;
  private cosRef = 1;

  constructor(freq: number, initialPhase: number, initialAmplitude: number, cfg?: Partial<PLLConfig>) {
    this.cfg = { ...DEFAULT_PLL_CONFIG, ...cfg };
    this.freq = freq;
    this.phase = initialPhase;
    this.integrator = 0;
    this.amplitude = initialAmplitude;
    this.updateRef();
  }

  /** Feed one audio sample. PLL updates phase tracking and amplitude estimate. */
  update(sample: number): void {
    // Phase detector: multiply input by our reference sin
    // DC component of (sample * sinRef) ∝ phase error
    const error = sample * this.sinRef;

    // Loop filter: proportional + integral
    const proportional = this.cfg.Kp * error;
    this.integrator += this.cfg.Ki * error;
    this.integrator = Math.max(-0.5, Math.min(0.5, this.integrator));

    // Update phase
    const freqDelta = proportional + this.integrator;
    this.phase += this.freq / this.cfg.sampleRate + freqDelta;
    if (this.phase >= 1.0) this.phase -= 1.0;
    if (this.phase < 0) this.phase += 1.0;

    // Amplitude: low-pass filter on envelope (I² + Q²)
    const i = sample * this.cosRef;
    const q = sample * this.sinRef;
    const instAmp = Math.hypot(i, q);
    const alpha = 0.01; // slow — rejects data modulation
    this.amplitude = this.amplitude * (1 - alpha) + instAmp * alpha;

    this.updateRef();
  }

  getFrequency(): number { return this.freq; }
  getPhase(): number { return this.phase; }
  getAmplitude(): number { return this.amplitude; }
  getSinRef(): number { return this.sinRef; }
  getCosRef(): number { return this.cosRef; }

  /**
   * Rotate raw I/Q values by the PLL's tracked pilot phase.
   * Returns pilot-relative coordinates.
   */
  rotateToPilotRef(rawI: number, rawQ: number): { i: number; q: number } {
    const cos = this.cosRef;
    const sin = this.sinRef;
    return {
      i: rawI * cos + rawQ * sin,
      q: -rawI * sin + rawQ * cos,
    };
  }

  /** Set frequency directly (e.g., after re-discovery from squawk) */
  setFrequency(f: number) { this.freq = f; }

  private updateRef() {
    const theta = 2 * Math.PI * this.phase;
    this.sinRef = Math.sin(theta);
    this.cosRef = Math.cos(theta);
  }
}

// ─── Convenience functions ─────────────────────────────

/**
 * Compute raw I/Q correlation for a single frequency over a sample buffer.
 */
export function toneIQ(
  samples: readonly number[],
  toneFreq: number,
  sampleRate: number,
): { i: number; q: number } {
  let i = 0, q = 0;
  const n = samples.length;
  for (let idx = 0; idx < n; idx++) {
    const phase = 2 * Math.PI * toneFreq * idx / sampleRate;
    i += samples[idx] * Math.sin(phase);
    q += samples[idx] * Math.cos(phase);
  }
  return { i: i / n, q: q / n };
}

/**
 * Get tone frequencies for all 4 data tones given a pilot frequency.
 */
export function getDataToneFreqs(pilotFreqHz: number): [number, number, number, number] {
  return [
    pilotFreqHz + TONE_OFFSETS[0],
    pilotFreqHz + TONE_OFFSETS[1],
    pilotFreqHz + TONE_OFFSETS[2],
    pilotFreqHz + TONE_OFFSETS[3],
  ] as [number, number, number, number];
}
