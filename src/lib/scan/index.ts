/**
 * src/lib/scan/index.ts
 *
 * Pattern detection and scanning utilities.
 * - Bit pattern scanning (for sentinel/sync markers)
 * - Tone/frequency detection (Goertzel-like)
 * - Peak detection
 */

/**
 * Scan a bit stream for a specific sentinel pattern.
 * Returns the bit position of the first match, or -1 if not found.
 */
export function scanBitPattern(bits: number[], pattern: number[], startIndex: number = 0): number {
  if (pattern.length === 0) return -1;

  for (let i = startIndex; i <= bits.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) {
      if (bits[i + j] !== pattern[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Detect a specific tone frequency in audio samples.
 * Uses a simplified Goertzel algorithm for efficient tone detection.
 *
 * @param samples - Audio samples
 * @param freq - Target frequency in Hz
 * @param sampleRate - Sample rate in Hz
 * @returns Magnitude of the tone (0-1 range approx)
 */
export function detectToneEnergy(samples: Float32Array, freq: number, sampleRate: number): number {
  // Goertzel algorithm: single-bin DFT via second-order IIR filter.
  // Variable naming follows standard DSP convention:
  //   sampleCount = number of samples in analysis window
  //   omega = normalized angular frequency (radians/sample)
  //   coefficient = 2*cos(omega), the feedback coefficient
  //   state0/1/2 = filter state registers (current, prev-1, prev-2)
  const sampleCount = samples.length;
  if (sampleCount === 0) return 0;

  const omega = (2 * Math.PI * freq) / sampleRate;
  const coefficient = 2 * Math.cos(omega);

  let state1 = 0; // y[n-1]
  let state2 = 0; // y[n-2]

  // Apply difference equation: y[n] = x[n] + coeff*y[n-1] - y[n-2]
  for (let index = 0; index < sampleCount; index++) {
    const state0 = samples[index] + coefficient * state1 - state2;
    state2 = state1;
    state1 = state0;
  }

  // Compute magnitude from final filter states
  const sinOmega = Math.sin(omega);
  const realPart = state1 - state2 * Math.cos(omega);
  const imagPart = state2 * sinOmega;
  const magnitude = Math.sqrt(realPart * realPart + imagPart * imagPart) / sampleCount;

  return magnitude;
}

/**
 * Find the peak (maximum absolute value) in a buffer.
 * Returns { index, value }.
 */
export function findPeak(buffer: Float32Array): { index: number; value: number } {
  let maxIndex = 0;
  let maxValue = 0;

  for (let i = 0; i < buffer.length; i++) {
    const abs = Math.abs(buffer[i]);
    if (abs > maxValue) {
      maxValue = abs;
      maxIndex = i;
    }
  }

  return { index: maxIndex, value: maxValue };
}

/**
 * Find the first crossing of a threshold in a buffer.
 * Returns index, or -1 if not found.
 */
export function findThresholdCrossing(
  buffer: Float32Array,
  threshold: number,
  startIndex: number = 0,
): number {
  for (let i = startIndex; i < buffer.length; i++) {
    if (Math.abs(buffer[i]) > threshold) return i;
  }
  return -1;
}

/**
 * Detect energy level changes (simple edge detection).
 * Returns index of first significant rise above baseline.
 */
export function detectEnergyRise(
  buffer: Float32Array,
  baselineDb: number,
  riseThresholdDb: number = 3,
  windowSize: number = 256,
): number {
  // RMS over sliding window
  for (let i = 0; i <= buffer.length - windowSize; i++) {
    let sumSq = 0;
    for (let j = 0; j < windowSize; j++) {
      const x = buffer[i + j];
      sumSq += x * x;
    }
    const rms = Math.sqrt(sumSq / windowSize);
    const dbLevel = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

    if (dbLevel > baselineDb + riseThresholdDb) {
      return i;
    }
  }
  return -1;
}
