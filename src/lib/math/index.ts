/**
 * src/lib/math/index.ts
 *
 * Signal processing and numerical utilities.
 * - dB/linear conversions
 * - RMS calculation
 * - Tone generation with phase continuity
 * - Sample normalization
 * - Audio resampling
 */

/**
 * Convert decibels to linear amplitude (power).
 * Formula: 10^(dB/10)
 */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 10);
}

/**
 * Convert linear amplitude (power) to decibels.
 * Formula: 10 * log10(linear)
 * Returns -Infinity if linear <= 0.
 */
export function linearToDb(linear: number): number {
  return linear > 0 ? 10 * Math.log10(linear) : -Infinity;
}

/**
 * Calculate RMS (root mean square) of a buffer.
 * RMS = sqrt(sum(x_i^2) / N)
 */
export function calculateRMS(buffer: Float32Array): number {
  if (buffer.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i++) {
    const x = buffer[i];
    sumSquares += x * x;
  }
  return Math.sqrt(sumSquares / buffer.length);
}

/**
 * Convert RMS amplitude to dB (SPL reference: 20 µPa ≈ 1.0 in [-1,1] range).
 * Formula: 20 * log10(rms)
 */
export function rmsToDb(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * Normalize amplitude of a buffer to a target peak level.
 * If buffer is silent (all zeros or peak is 0), returns copy unchanged.
 */
export function normalizeAmplitude(samples: Float32Array, targetPeak: number = 0.9): Float32Array {
  // Find peak
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }

  if (peak === 0) {
    // Silent; return copy unchanged
    return new Float32Array(samples);
  }

  // Scale to target peak
  const scale = targetPeak / peak;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] * scale;
  }
  return out;
}

/**
 * Generate a continuous sine tone.
 * Frequency must be positive. Output is in [-1, 1] range.
 *
 * @param freq - Frequency in Hz
 * @param duration - Duration in seconds
 * @param sampleRate - Sample rate in Hz (typically 44100 or 48000)
 * @param startPhase - Starting phase in radians (default 0)
 * @returns Float32Array of samples
 */
export function generateTone(
  freq: number,
  duration: number,
  sampleRate: number,
  startPhase: number = 0,
): Float32Array {
  const numSamples = Math.round(duration * sampleRate);
  const samples = new Float32Array(numSamples);
  const phaseIncrement = (2 * Math.PI * freq) / sampleRate;

  let phase = startPhase;
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.sin(phase);
    phase += phaseIncrement;
    // Keep phase in [-π, π] to avoid numeric drift
    if (phase > Math.PI) phase -= 2 * Math.PI;
  }
  return samples;
}

/**
 * Apply a hann window to samples.
 * Useful for windowing audio segments to reduce spectral leakage.
 */
export function applyHannWindow(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  const N = samples.length;
  for (let i = 0; i < N; i++) {
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    out[i] = samples[i] * window;
  }
  return out;
}

/**
 * Resample audio using linear interpolation.
 * Suitable for simple decimation/interpolation without sophisticated filtering.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) {
    return new Float32Array(input);
  }

  const ratio = fromRate / toRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const floor = Math.floor(srcIndex);
    const ceil = Math.min(floor + 1, input.length - 1);
    const frac = srcIndex - floor;

    // Linear interpolation
    output[i] = input[floor] * (1 - frac) + input[ceil] * frac;
  }

  return output;
}

/**
 * Clip samples to [-1, 1] range to prevent digital distortion.
 */
export function clip(samples: Float32Array, min: number = -1, max: number = 1): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(min, Math.min(max, samples[i]));
  }
  return out;
}

/**
 * Select the optimal FFT size and SPS for a given target symbol rate.
 * Snaps to the nearest power-of-2 FFT size for clean OFDM.
 *
 * @param sampleRate - Audio sample rate (3200 Hz)
 * @param targetSymPerSec - Desired symbol rate from UI (10, 25, 40, 50, 100)
 * @returns Optimal { fft, sps, actualRate }
 */
export function selectOFDMFFT(
  sampleRate: number,
  targetSymPerSec: number,
): { fft: number; sps: number; actualRate: number } {
  const targetSPS = sampleRate / targetSymPerSec;
  let sps = 256;
  if (targetSPS <= 24) sps = 16;
  else if (targetSPS <= 48) sps = 32;
  else if (targetSPS <= 96) sps = 64;
  else if (targetSPS <= 192) sps = 128;
  else sps = 256;
  return { fft: sps, sps, actualRate: sampleRate / sps };
}

/**
 * Compute tone frequency offsets for N tones with given spacing.
 * Returns N offsets starting from `baseOffset` Hz.
 */
export function makeToneOffsets(
  toneCount: number,
  spacingHz: number = 100,
  baseOffset: number = 100,
): Float32Array {
  const offsets = new Float32Array(toneCount);
  for (let t = 0; t < toneCount; t++) {
    offsets[t] = baseOffset + t * spacingHz;
  }
  return offsets;
}

/**
 * Compute absolute tone frequencies from pilot + offsets.
 */
export function makeToneFrequencies(
  pilotFreqHz: number,
  toneOffsets: Float32Array,
): Float32Array {
  const freqs = new Float32Array(toneOffsets.length);
  for (let t = 0; t < toneOffsets.length; t++) {
    freqs[t] = pilotFreqHz + toneOffsets[t];
  }
  return freqs;
}

/**
 * Apply gain (in dB) to samples.
 */
export function applyGain(samples: Float32Array, gainDb: number): Float32Array {
  const scale = dbToLinear(gainDb);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] * scale;
  }
  return out;
}
