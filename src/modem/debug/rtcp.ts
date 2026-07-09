/**
 * rtcp.ts — Real-Time Channel Profiling
 *
 * Processes the 200ms linear sine sweep from the preamble to build a
 * FrequencyResponseMap. The decoder uses this to assess channel quality
 * and suggest optimal ECC parameters.
 *
 * Sweep: 200Hz → 1200Hz over 640 samples (200ms at 3200 Hz).
 * Divided into 10 frequency bands of 64 samples each.
 */

export interface FrequencyResponse {
  /** Frequency bins (Hz) measured */
  frequencies: Float32Array;
  /** Relative amplitude at each frequency (0..1, where 1 = full signal) */
  magnitude: Float32Array;
  /** Phase shift at each frequency (radians) relative to expected */
  phase: Float32Array;
  /** Signal-to-noise estimate at each frequency (dB) */
  snr: Float32Array;
  /** Overall channel quality score 0..1 */
  quality: number;
}

export interface EccSuggestion {
  /** Recommended RS parity bytes (4, 8, or 12) */
  rsParityBytes: number;
  /** Recommended BCH error correction strength (bit errors) */
  bchStrength: number;
}

export class ChannelProfiler {
  private sampleRate: number;
  private sweepBuffer: number[] = [];
  private response: FrequencyResponse | null = null;
  private sweepCollected = false;

  /** Expected sweep parameters (set by feedSweepSamples) */
  private sweepStartFreq = 200;
  private sweepEndFreq = 1200;
  private sweepDuration = 0.2; // 200ms
  private expectedSamples = 640; // 200ms at 3200 Hz

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.expectedSamples = Math.floor(sampleRate * 0.2);
  }

  /**
   * Feed samples from the sweep phase.
   * Returns a FrequencyResponse once the full sweep is collected, or null.
   */
  feedSweepSamples(
    samples: Float32Array,
    sweepStartFreq: number,
    sweepEndFreq: number,
  ): FrequencyResponse | null {
    this.sweepStartFreq = sweepStartFreq;
    this.sweepEndFreq = sweepEndFreq;
    this.expectedSamples = Math.floor(this.sampleRate * 0.2);

    for (let i = 0; i < samples.length; i++) {
      if (!this.sweepCollected) {
        this.sweepBuffer.push(samples[i]);
        if (this.sweepBuffer.length >= this.expectedSamples) {
          this.sweepCollected = true;
          this.response = this.computeResponse();
          return this.response;
        }
      }
    }
    return null;
  }

  /** Get the most recent frequency response */
  getResponse(): FrequencyResponse | null {
    return this.response;
  }

  /**
   * Suggest optimal ECC parameters based on channel quality.
   */
  suggestEccParams(): EccSuggestion {
    if (!this.response) {
      return { rsParityBytes: 12, bchStrength: 6 };
    }
    const q = this.response.quality;
    if (q > 0.9) {
      return { rsParityBytes: 12, bchStrength: 6 };
    } else if (q > 0.7) {
      return { rsParityBytes: 8, bchStrength: 5 };
    } else {
      return { rsParityBytes: 4, bchStrength: 4 };
    }
  }

  reset(): void {
    this.sweepBuffer = [];
    this.response = null;
    this.sweepCollected = false;
  }

  // ── Private ──────────────────────────────────────

  private computeResponse(): FrequencyResponse {
    const buf = this.sweepBuffer;
    const n = buf.length;
    const numBands = 10;
    const sweepWidth = this.sweepEndFreq - this.sweepStartFreq;

    // Generate reference chirp at unit amplitude (same as encoder sends)
    const refChirp = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / this.sampleRate;
      const chirpPhase =
        2 * Math.PI * (this.sweepStartFreq * t + (sweepWidth * t * t) / (2 * this.sweepDuration));
      refChirp[i] = Math.sin(chirpPhase);
    }

    const frequencies = new Float32Array(numBands);
    const magnitude = new Float32Array(numBands);
    const phase = new Float32Array(numBands);
    const snr = new Float32Array(numBands);

    // Pre-compute expected DFT magnitudes from reference chirp for calibration
    const expectedMag = new Float64Array(numBands);
    let maxExpected = 0;
    for (let b = 0; b < numBands; b++) {
      const frac = (b + 0.5) / numBands;
      const freqHz = this.sweepStartFreq + sweepWidth * frac;
      let s = 0,
        c = 0;
      for (let i = 0; i < n; i++) {
        const angle = (2 * Math.PI * freqHz * i) / this.sampleRate;
        s += refChirp[i] * Math.sin(angle);
        c += refChirp[i] * Math.cos(angle);
      }
      expectedMag[b] = Math.hypot(s, c);
      if (expectedMag[b] > maxExpected) maxExpected = expectedMag[b];
    }
    if (maxExpected < 1e-12) maxExpected = 1;

    // Normalize: actual vs expected, where expected is from unit chirp
    let totalMag = 0;
    for (let b = 0; b < numBands; b++) {
      const frac = (b + 0.5) / numBands;
      const freqHz = this.sweepStartFreq + sweepWidth * frac;
      frequencies[b] = freqHz;

      let si = 0,
        sq = 0;
      for (let i = 0; i < n; i++) {
        const angle = (2 * Math.PI * freqHz * i) / this.sampleRate;
        si += buf[i] * Math.sin(angle);
        sq += buf[i] * Math.cos(angle);
      }
      const measured = Math.hypot(si, sq);

      const mag = expectedMag[b] > 1e-12 ? Math.min(2, measured / expectedMag[b]) : 0;
      magnitude[b] = mag;
      phase[b] = Math.atan2(sq, si);
      totalMag += mag;

      // SNR: noise in adjacent bins (average of bins outside sweep)
      let noiseSum = 0;
      let noiseCount = 0;
      for (let adj = -3; adj <= 3; adj++) {
        if (adj === 0) continue;
        const adjFreq = freqHz + adj * 25; // 25 Hz step
        if (adjFreq < this.sweepStartFreq || adjFreq > this.sweepEndFreq) {
          let ni = 0,
            nq = 0;
          for (let i = 0; i < n; i++) {
            const a = (2 * Math.PI * adjFreq * i) / this.sampleRate;
            ni += buf[i] * Math.sin(a);
            nq += buf[i] * Math.cos(a);
          }
          noiseSum += Math.hypot(ni, nq);
          noiseCount++;
        }
      }
      const noiseFloor = noiseCount > 0 ? noiseSum / noiseCount / maxExpected : 1e-12;
      snr[b] =
        noiseFloor > 1e-12 && magnitude[b] > 1e-12 ? 20 * Math.log10(magnitude[b] / noiseFloor) : 0;
    }

    // Quality: average normalized magnitude across all frequency bands
    const quality = Math.min(1, Math.max(0, totalMag / numBands));

    return {
      frequencies,
      magnitude,
      phase,
      snr,
      quality,
    };
  }
}
