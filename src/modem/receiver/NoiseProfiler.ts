/**
 * NoiseProfiler — Dynamic noise floor estimation with stability detection.
 *
 * Extracted from Decoder.feedSample(). Profiles per-tone noise energy over
 * successive symbol frames using exponential moving average. Detects when
 * the noise floor has stabilized (std-dev < 20% of mean over 5+ frames).
 *
 * Used by the decoder to determine energy thresholds for signal detection
 * and to know when pilot discovery can safely proceed.
 */

export class NoiseProfiler {
  /** Per-tone noise floor (EMA) */
  public floor: [number, number, number, number] = [3e-10, 3e-10, 3e-10, 3e-10];
  /** Per-tone running max (slow decay) */
  public max: [number, number, number, number] = [3e-10, 3e-10, 3e-10, 3e-10];
  /** Number of frames profiled so far */
  public frames = 0;
  /** Whether the noise floor has stabilized */
  public stable = false;

  /** Ring buffer of average noise magnitudes for stability detection (last 10) */
  private history: Float64Array;
  private historyIdx = 0;

  /** Maximum profiling frames before forcing stable */
  private readonly MAX_FRAMES = 25;
  /** Minimum frames before checking stability */
  private readonly MIN_FRAMES = 5;
  /** Stability threshold: std-dev must be < 20% of mean */
  private readonly STABILITY_RATIO = 0.2;

  constructor() {
    this.history = new Float64Array(10);
  }

  /**
   * Reset to initial state. Call before starting a new reception.
   */
  reset(): void {
    this.floor = [3e-10, 3e-10, 3e-10, 3e-10];
    this.max = [3e-10, 3e-10, 3e-10, 3e-10];
    this.frames = 0;
    this.stable = false;
    this.history = new Float64Array(10);
    this.historyIdx = 0;
  }

  /**
   * Feed per-tone energies for one symbol frame.
   * Only updates noise profile when not in-frame (i.e., during silence/preamble).
   * Returns true when noise floor stabilizes.
   *
   * @param energies Per-tone energy magnitudes [e0, e1, e2, e3]
   * @returns true if noise floor just became stable this frame
   */
  update(energies: [number, number, number, number]): boolean {
    if (this.stable) return false;
    if (this.frames >= this.MAX_FRAMES) {
      this.stable = true;
      return true;
    }

    this.frames++;
    const alpha = 1 / this.frames; // EMA smoothing factor

    // Update per-tone noise floor and max
    for (let t = 0; t < 4; t++) {
      this.floor[t] = this.floor[t] * (1 - alpha) + energies[t] * alpha;
      if (energies[t] > this.max[t]) {
        this.max[t] = energies[t];
      } else {
        this.max[t] *= 0.9999; // Slow decay
      }
    }

    // Stability check: std-dev of average noise over recent history
    if (this.frames >= this.MIN_FRAMES) {
      const avgNoise = (this.floor[0] + this.floor[1] + this.floor[2] + this.floor[3]) / 4;
      this.history[this.historyIdx % 10] = avgNoise;
      this.historyIdx++;

      if (this.historyIdx >= this.MIN_FRAMES) {
        const count = Math.min(this.historyIdx, 10);
        let sum = 0;
        let sumSq = 0;
        for (let i = 0; i < count; i++) {
          const v = this.history[i];
          sum += v;
          sumSq += v * v;
        }
        const mean = sum / count;
        const variance = count > 1 ? (sumSq - (sum * sum) / count) / (count - 1) : 0;
        const stdDev = Math.sqrt(Math.max(0, variance));

        if (mean > 1e-15 && stdDev / mean < this.STABILITY_RATIO) {
          this.stable = true;
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Compute the average noise floor across all tones.
   */
  getAverage(): number {
    return (this.floor[0] + this.floor[1] + this.floor[2] + this.floor[3]) / 4;
  }

  /**
   * Check if profiling has enough data (for pilot discovery gating).
   */
  hasEnoughData(): boolean {
    return this.frames >= this.MIN_FRAMES;
  }
}
