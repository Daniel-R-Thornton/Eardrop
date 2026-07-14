/**
 * ChirpPilot — linear-frequency-sweep sync burst generator and detector.
 *
 * Replaces the fixed-frequency sync burst with a chirp (LFM) that sweeps
 * across a configurable bandwidth. A matched-filter cross-correlation at the
 * receiver provides sample-accurate timing and processing gain equal to the
 * time-bandwidth product, punching through frequency-selective nulls.
 */

export interface ChirpConfig {
  /** Chirp start frequency (Hz) */
  fStart: number;
  /** Chirp end frequency (Hz) */
  fEnd: number;
  /** Chirp duration in seconds */
  durationSec: number;
  /** Sample rate (Hz) */
  sampleRate: number;
}

/**
 * Generate a linear chirp signal:  cos(2π (fStart⋅t + k/2 ⋅ t²))
 * Constant envelope (PAPR = 0 dB) — safe to transmit at full amplitude.
 */
export function generateChirp(cfg: ChirpConfig): Float32Array {
  const nSamples = Math.round(cfg.durationSec * cfg.sampleRate);
  const chirp = new Float32Array(nSamples);
  const k = (cfg.fEnd - cfg.fStart) / cfg.durationSec; // chirp rate (Hz/s)

  for (let n = 0; n < nSamples; n++) {
    const t = n / cfg.sampleRate;
    chirp[n] = Math.cos(2 * Math.PI * (cfg.fStart * t + 0.5 * k * t * t));
  }
  return chirp;
}

/**
 * Cross-correlate `signal` with `template` and return the peak value and
 * its index. The peak index is the sample offset where template aligns best.
 *
 * O(signalLen × templateLen) — run once per detection, not per sample.
 * For production, replace with FFT-based fast convolution (IFFT(FFT(a)⋅conj(FFT(b)))).
 */
export function chirpCorrelate(
  signal: Float32Array | number[],
  template: Float32Array,
): { peakValue: number; peakIndex: number } {
  const sig = signal instanceof Float32Array ? signal : new Float32Array(signal);
  const maxLag = sig.length - template.length;
  if (maxLag < 0) return { peakValue: 0, peakIndex: -1 };

  let bestVal = 0;
  let bestIdx = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    for (let j = 0; j < template.length; j++) {
      sum += sig[lag + j] * template[j];
    }
    const absVal = Math.abs(sum);
    if (absVal > bestVal) {
      bestVal = absVal;
      bestIdx = lag;
    }
  }
  return { peakValue: bestVal, peakIndex: bestIdx };
}

/**
 * Energy of a signal segment (mean squared).
 */
export function signalEnergy(signal: Float32Array | number[]): number {
  const sig = signal instanceof Float32Array ? signal : new Float32Array(signal);
  let sumSq = 0;
  for (let i = 0; i < sig.length; i++) sumSq += sig[i] * sig[i];
  return sig.length > 0 ? sumSq / sig.length : 0;
}
