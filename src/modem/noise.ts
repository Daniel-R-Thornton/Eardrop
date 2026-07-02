/**
 * noise.ts — Noise cancellation and adaptive AGC for the decoder.
 *
 * Spectral subtraction: maintains per-bin noise estimates during silence
 * and subtracts them from the signal spectrum during data reception.
 *
 * AGC: normalizes signal amplitude based on tracked pilot amplitude.
 *
 * Adaptive thresholding: per-tone thresholds based on noise floor + pilot SNR.
 */

import { debugLogger, STAGE, LOG_LEVEL } from "./debugger";

// ─── Spectral Subtraction ────────────────────────────

export interface SpectralSubtractorConfig {
  /** FFT size for spectral analysis */
  fftSize: number;
  /** Sample rate */
  sampleRate: number;
  /** Noise floor learning rate (0-1, higher = faster adaptation) */
  learningRate: number;
  /** Noise floor decay rate during signal (0-1) */
  decayRate: number;
  /** Minimum noise floor (prevents division by zero) */
  floorMin: number;
}

const DEFAULT_SUBTRACTOR_CONFIG: SpectralSubtractorConfig = {
  fftSize: 256,
  sampleRate: 3200,
  learningRate: 0.05,
  decayRate: 0.9995,
  floorMin: 1e-10,
};

export class SpectralSubtractor {
  private cfg: SpectralSubtractorConfig;
  /** Per-bin noise floor estimate */
  private noiseFloor: Float64Array;
  /** Number of frames used for initialization */
  private initFrames = 0;
  private readonly initTarget = 10;

  constructor(cfg?: Partial<SpectralSubtractorConfig>) {
    this.cfg = { ...DEFAULT_SUBTRACTOR_CONFIG, ...cfg };
    this.noiseFloor = new Float64Array(this.cfg.fftSize / 2);
    this.noiseFloor.fill(1e-8);
  }

  /**
   * Update noise floor estimate during silence (no signal detected).
   */
  updateNoiseFloor(magnitudes: Float64Array): void {
    const n = Math.min(magnitudes.length, this.noiseFloor.length);
    this.initFrames++;

    for (let i = 0; i < n; i++) {
      if (magnitudes[i] < this.cfg.floorMin) continue;

      if (this.initFrames <= this.initTarget) {
        // Initialization: running average
        this.noiseFloor[i] += (magnitudes[i] - this.noiseFloor[i]) / this.initFrames;
      } else {
        // Adaptive: leaky integrator
        this.noiseFloor[i] += this.cfg.learningRate * (magnitudes[i] - this.noiseFloor[i]);
      }
    }
  }

  /**
   * Decay noise floor during signal (slowly forget old noise estimates).
   */
  decayNoiseFloor(): void {
    for (let i = 0; i < this.noiseFloor.length; i++) {
      this.noiseFloor[i] *= this.cfg.decayRate;
      if (this.noiseFloor[i] < this.cfg.floorMin) {
        this.noiseFloor[i] = this.cfg.floorMin;
      }
    }
  }

  /**
   * Apply spectral subtraction to a magnitude spectrum.
   * Returns cleaned magnitudes.
   */
  subtract(magnitudes: Float64Array): Float64Array {
    const n = Math.min(magnitudes.length, this.noiseFloor.length);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // Spectral subtraction with oversubtraction factor
      const cleaned = magnitudes[i] - this.noiseFloor[i] * 1.5;
      out[i] = Math.max(cleaned, this.cfg.floorMin);
    }
    return out;
  }

  /**
   * Get noise floor estimate for a specific frequency bin.
   */
  getNoiseAtBin(bin: number): number {
    if (bin < 0 || bin >= this.noiseFloor.length) return this.cfg.floorMin;
    return this.noiseFloor[bin];
  }

  /**
   * Get noise floor estimate for a specific frequency (interpolated).
   */
  getNoiseAtFreq(freqHz: number): number {
    const bin = Math.round(freqHz * this.cfg.fftSize / this.cfg.sampleRate);
    return this.getNoiseAtBin(bin);
  }

  reset(): void {
    this.noiseFloor.fill(1e-8);
    this.initFrames = 0;
  }

  isInitialized(): boolean {
    return this.initFrames >= this.initTarget;
  }
}

// ─── AGC ─────────────────────────────────────────────

export interface AGCConfig {
  /** Target RMS level (normalized) */
  targetRms: number;
  /** Maximum gain to apply */
  maxGain: number;
  /** Minimum gain to apply */
  minGain: number;
  /** Attack time constant (0-1, higher = faster) */
  attack: number;
  /** Release time constant (0-1, higher = faster) */
  release: number;
}

const DEFAULT_AGC_CONFIG: AGCConfig = {
  targetRms: 0.1,
  maxGain: 10.0,
  minGain: 0.1,
  attack: 0.1,
  release: 0.01,
};

export class AGC {
  private cfg: AGCConfig;
  private currentGain = 1.0;
  private smoothedRms = 0;

  constructor(cfg?: Partial<AGCConfig>) {
    this.cfg = { ...DEFAULT_AGC_CONFIG, ...cfg };
  }

  /**
   * Process a frame of samples, applying AGC.
   */
  process(samples: number[]): number[] {
    // Compute RMS of this frame
    let sumSq = 0;
    for (const s of samples) sumSq += s * s;
    const rms = Math.sqrt(sumSq / samples.length);

    // Smooth RMS
    const alpha = rms > this.smoothedRms ? this.cfg.attack : this.cfg.release;
    this.smoothedRms += alpha * (rms - this.smoothedRms);

    // Compute desired gain
    let desiredGain = this.smoothedRms > 1e-12
      ? this.cfg.targetRms / this.smoothedRms
      : this.currentGain;

    // Clamp
    desiredGain = Math.max(this.cfg.minGain, Math.min(this.cfg.maxGain, desiredGain));
    this.currentGain += 0.1 * (desiredGain - this.currentGain);

    // Apply gain
    return samples.map(s => s * this.currentGain);
  }

  getGain(): number { return this.currentGain; }

  reset(): void {
    this.currentGain = 1.0;
    this.smoothedRms = 0;
  }
}

// ─── Pilot-Relative AGC ──────────────────────────────

/**
 * AGC that normalizes signal based on tracked pilot amplitude.
 * This is the primary gain control for the pilot-relative modem.
 *
 * gain = targetPilotAmplitude / measuredPilotAmplitude
 */
export class PilotAGC {
  private targetAmp: number;
  private gain = 1.0;
  private alpha = 0.05;

  constructor(targetPilotAmplitude = 0.125) {
    this.targetAmp = targetPilotAmplitude;
  }

  /**
   * Update gain based on measured pilot amplitude.
   */
  update(measuredPilotAmplitude: number): void {
    const desired = measuredPilotAmplitude > 1e-12
      ? this.targetAmp / measuredPilotAmplitude
      : this.gain;
    this.gain += this.alpha * (desired - this.gain);
    this.gain = Math.max(0.1, Math.min(10, this.gain));
  }

  /**
   * Apply gain to a sample or value.
   */
  apply(value: number): number {
    return value * this.gain;
  }

  getGain(): number { return this.gain; }

  reset(): void {
    this.gain = 1.0;
  }
}

// ─── Adaptive Threshold ──────────────────────────────

/**
 * Compute per-tone adaptive thresholds based on noise floor and pilot SNR.
 * Each tone gets its own threshold that adapts to the current channel conditions.
 */
export function computeToneThresholds(
  noiseFloor: [number, number, number, number],
  pilotAmplitude: number,
  amplitudeThresholdRatio: number,
  snr: number,
): [number, number, number, number] {
  const thresholds: [number, number, number, number] = [0, 0, 0, 0];
  const pilotThreshold = pilotAmplitude * amplitudeThresholdRatio;

  for (let t = 0; t < 4; t++) {
    // Base threshold from noise floor
    const noiseThreshold = noiseFloor[t] * 3.0;

    // Adjust based on SNR: lower SNR → rely more on noise floor
    const snrWeight = snr > 10 ? 0.8 : 0.2;
    const noiseWeight = 1 - snrWeight;

    thresholds[t] = noiseThreshold * noiseWeight + pilotThreshold * snrWeight;

    // Absolute floor
    if (thresholds[t] < 1e-12) thresholds[t] = 1e-12;
  }

  return thresholds;
}

/**
 * Integrate noise cancellation into the decoder pipeline.
 * Logs to debugLogger at STAGE.DEBUG.
 */
export function logNoiseStats(
  subtractor: SpectralSubtractor,
  agc: AGC,
  pilotAgc: PilotAGC,
): void {
  debugLogger.info(STAGE.DEBUG, {
    noise_floor_avg: subtractor['noiseFloor']?.reduce((a: number, b: number) => a + b, 0) /
      (subtractor['noiseFloor']?.length || 1),
    agc_gain: agc.getGain().toFixed(3),
    pilot_agc_gain: pilotAgc.getGain().toFixed(3),
    initialized: subtractor.isInitialized(),
  }, `Noise: AGC=${agc.getGain().toFixed(2)}x PilotAGC=${pilotAgc.getGain().toFixed(2)}x`);
}
