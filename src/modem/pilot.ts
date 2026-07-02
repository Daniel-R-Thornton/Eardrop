/**
 * PilotScanner + PilotPLL — Pilot frequency discovery and phase tracking.
 *
 * Two-phase design:
 *   1. PilotScanner: During leader/initial listening, sweep candidate frequencies
 *      to find the dominant continuous tone. Returns discovered frequency + amplitude.
 *   2. PilotPLL: Second-order PLL locked to the discovered frequency. Tracks phase
 *      and amplitude continuously through the entire transmission.
 *
 * All data-tone measurements are relative to the PLL's tracked phase and amplitude.
 */

import { TONE_OFFSETS } from "./types";

// ─── PilotScanner ─────────────────────────────────────

export interface PilotDiscovery {
  /** Discovered pilot frequency in Hz */
  freq: number;
  /** Estimated pilot amplitude (for AGC normalization) */
  amplitude: number;
  /** Confidence 0-1 (based on stability and SNR) */
  confidence: number;
}

export interface PilotScannerConfig {
  /** Frequency range to scan (Hz) */
  scanRange: [number, number];
  /** Step size between candidate frequencies (Hz) */
  scanStep: number;
  /** How many frames to accumulate before deciding */
  scanDurationFrames: number;
  /** Minimum energy ratio above noise floor to accept a candidate */
  minSignalRatio: number;
  /** Maximum amplitude variance across frames to accept (0-1) */
  maxVariance: number;
  /** Sample rate */
  sampleRate: number;
  /** Samples per frame (symbol window) */
  sps: number;
}

const DEFAULT_SCANNER_CONFIG: PilotScannerConfig = {
  scanRange: [40, 120],
  scanStep: 5,
  scanDurationFrames: 6,     // ~0.3s at 25 sym/s — enough for Goertzel on each candidate
  minSignalRatio: 3.0,
  maxVariance: 0.2,
  sampleRate: 3200,
  sps: 128,
};

export class PilotScanner {
  private cfg: PilotScannerConfig;
  private buf: number[] = [];
  private frameCount = 0;
  /** Per-frequency energy accumulators: freq → frame energies[] */
  private candidates: Map<number, number[]> = new Map();
  private done = false;
  private result: PilotDiscovery | null = null;

  constructor(cfg: Partial<PilotScannerConfig> = {}) {
    this.cfg = { ...DEFAULT_SCANNER_CONFIG, ...cfg };
    // Build candidate frequency list
    const { scanRange, scanStep } = this.cfg;
    for (let f = scanRange[0]; f <= scanRange[1]; f += scanStep) {
      this.candidates.set(Math.round(f * 10) / 10, []);
    }
  }

  /** Feed one audio sample. Returns null until discovery is complete. */
  feedSample(sample: number): PilotDiscovery | null {
    if (this.done) return this.result;

    this.buf.push(sample);
    if (this.buf.length < this.cfg.sps) return null;

    // We have one frame
    const window = this.buf.slice(0, this.cfg.sps);
    this.buf.splice(0, this.cfg.sps);
    this.frameCount++;

    // Compute energy at every candidate frequency
    for (const [freq, energies] of this.candidates) {
      const e = this.goertzel(window, freq);
      energies.push(e);
    }

    if (this.frameCount >= this.cfg.scanDurationFrames) {
      this.result = this.selectBest();
      this.done = true;
    }
    return null;
  }

  /** Force discovery with whatever frames we have (call on time-out) */
  forceDiscover(): PilotDiscovery | null {
    if (this.done) return this.result;
    if (this.frameCount < 2) return null;
    this.result = this.selectBest();
    this.done = true;
    return this.result;
  }

  isDone(): boolean { return this.done; }
  getResult(): PilotDiscovery | null { return this.result; }
  reset() {
    this.buf = [];
    this.frameCount = 0;
    this.done = false;
    this.result = null;
    for (const [, energies] of this.candidates) energies.length = 0;
  }

  // ─── private ───────────────────────────────────────

  /** Goertzel magnitude for a single frequency over the buffer */
  private goertzel(samples: number[], targetFreq: number): number {
    const n = samples.length;
    if (n === 0) return 0;
    const k = Math.round((targetFreq * n) / this.cfg.sampleRate);
    const omega = (2 * Math.PI * k) / n;
    const coeff = 2 * Math.cos(omega);
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      s0 = samples[i] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const real = s1 - s2 * Math.cos(omega);
    const imag = s2 * Math.sin(omega);
    return Math.hypot(real, imag) / n;
  }

  private selectBest(): PilotDiscovery | null {
    let bestFreq = 0;
    let bestMean = 0;
    let bestVariance = Infinity;

    for (const [freq, energies] of this.candidates) {
      if (energies.length < 2) continue;
      const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
      const variance = energies.reduce((a, b) => a + (b - mean) ** 2, 0) / energies.length;
      const normalizedVariance = mean > 1e-12 ? Math.sqrt(variance) / mean : 1;

      if (mean > bestMean && normalizedVariance < this.cfg.maxVariance) {
        bestFreq = freq;
        bestMean = mean;
        bestVariance = normalizedVariance;
      }
    }

    if (bestFreq === 0) return null;

    // Check signal ratio: best freq vs noise floor (median of all other candidates)
    const allMeans: number[] = [];
    for (const [freq, energies] of this.candidates) {
      if (freq === bestFreq) continue;
      allMeans.push(energies.reduce((a, b) => a + b, 0) / energies.length);
    }
    allMeans.sort((a, b) => a - b);
    const noiseMedian = allMeans[Math.floor(allMeans.length / 2)] || 1e-12;
    const ratio = bestMean / Math.max(noiseMedian, 1e-14);

    if (ratio < this.cfg.minSignalRatio) return null;

    const confidence = Math.min(1, (ratio - this.cfg.minSignalRatio) / 10);

    return {
      freq: bestFreq,
      amplitude: bestMean,
      confidence,
    };
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

  /** Tracked pilot frequency (Hz) — set once on lock, can drift slightly */
  private freq: number;
  /** Internal NCO phase accumulator (cycles, 0..1) */
  private phase: number;
  /** Loop filter state */
  private integrator: number;
  /** Smoothed amplitude estimate */
  private amplitude: number;

  /** Reference sin/cos for the current sample — updated on each feedSample call */
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

  /**
   * Feed one audio sample. The PLL updates its phase tracking and amplitude estimate.
   * Call getPhase() / getAmplitude() / getSinRef() / getCosRef() afterward.
   */
  update(sample: number): void {
    // Simple phase detector: multiply input by our reference sin
    // The DC component of (input * sinRef) is proportional to phase error
    const error = sample * this.sinRef;

    // Loop filter: proportional + integral
    const proportional = this.cfg.Kp * error;
    this.integrator += this.cfg.Ki * error;
    // Clamp integrator to prevent windup
    this.integrator = Math.max(-0.5, Math.min(0.5, this.integrator));

    // Update phase
    const freqDelta = proportional + this.integrator;
    this.phase += this.freq / this.cfg.sampleRate + freqDelta;
    if (this.phase >= 1.0) this.phase -= 1.0;
    if (this.phase < 0) this.phase += 1.0;

    // Amplitude estimation: low-pass filter on squared envelope
    // Use cosRef as the quadrature component for full amplitude measurement
    const i = sample * this.cosRef;
    const q = sample * this.sinRef;
    const instAmp = Math.hypot(i, q);
    const alpha = 0.01; // slow tracking — rejects data modulation
    this.amplitude = this.amplitude * (1 - alpha) + instAmp * alpha;

    this.updateRef();
  }

  /** Get current tracked pilot frequency (may drift from initial) */
  getFrequency(): number { return this.freq; }

  /** Get current tracked pilot phase in cycles (0..1) */
  getPhase(): number { return this.phase; }

  /** Get current tracked pilot amplitude (smoothed) */
  getAmplitude(): number { return this.amplitude; }

  /** Get reference sin(2π * phase) for the current sample */
  getSinRef(): number { return this.sinRef; }

  /** Get reference cos(2π * phase) for the current sample */
  getCosRef(): number { return this.cosRef; }

  /**
   * Get pilot-relative I/Q for a given tone frequency.
   * Given raw I/Q correlation values, rotate by the PLL's tracked phase
   * to get pilot-relative coordinates.
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

// ─── Convenience: detect energy of a tone, return pilot-relative I/Q ───

/**
 * Compute raw I/Q correlation for a single frequency over a sample buffer.
 * Returns { i, q } where i = sin correlation, q = cos correlation.
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
