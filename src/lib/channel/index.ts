/**
 * src/lib/channel/index.ts
 *
 * Channel impairment simulation for testing.
 * Composable effects: AWGN, fading, clipping, jitter, etc.
 */

/**
 * Base interface for a channel effect.
 */
export interface ChannelEffect {
  process(samples: Float32Array): Float32Array;
  reset(): void;
}

/**
 * Additive White Gaussian Noise.
 */
export class AdditiveNoise implements ChannelEffect {
  private sigma: number; // Noise standard deviation
  private seed: number;

  constructor(snrDb: number = 10) {
    // Convert SNR to noise standard deviation
    // SNR = signal_power / noise_power = 1 / sigma^2
    const snrLinear = Math.pow(10, snrDb / 10);
    this.sigma = 1 / Math.sqrt(snrLinear);
    this.seed = 12345;
  }

  private nextGaussian(): number {
    // Box-Muller transform for Gaussian random numbers
    const u1 = this.random();
    const u2 = this.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  private random(): number {
    // Simple LCG for deterministic randomness
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  process(samples: Float32Array): Float32Array {
    const out = new Float32Array(samples);
    for (let i = 0; i < out.length; i++) {
      out[i] += this.sigma * this.nextGaussian();
    }
    return out;
  }

  reset(): void {
    this.seed = 12345;
  }
}

/**
 * Amplitude clipping (nonlinearity).
 */
export class Clipping implements ChannelEffect {
  private threshold: number;

  constructor(threshold: number = 0.9) {
    this.threshold = threshold;
  }

  process(samples: Float32Array): Float32Array {
    const out = new Float32Array(samples);
    for (let i = 0; i < out.length; i++) {
      if (out[i] > this.threshold) out[i] = this.threshold;
      else if (out[i] < -this.threshold) out[i] = -this.threshold;
    }
    return out;
  }

  reset(): void {
    // No state
  }
}

/**
 * Frequency-selective fading (simple notch filter).
 */
export class ChannelFading implements ChannelEffect {
  private fadeFreq: number;
  private fadeDepth: number;

  constructor(fadeFreq: number = 1000, fadeDepth: number = 0.5) {
    this.fadeFreq = fadeFreq;
    this.fadeDepth = fadeDepth;
  }

  process(samples: Float32Array): Float32Array {
    // Simplified: multiply by a slowly-varying gain
    const out = new Float32Array(samples);
    const sampleRate = 44100; // Assumed
    const fadePhaseInc = (2 * Math.PI * this.fadeFreq) / sampleRate;
    let phase = 0;

    for (let i = 0; i < out.length; i++) {
      const gain = 1 - (this.fadeDepth * (Math.sin(phase) + 1)) / 2;
      out[i] *= gain;
      phase += fadePhaseInc;
    }

    return out;
  }

  reset(): void {
    // No state
  }
}

/**
 * Sampling timing jitter (sample clock instability).
 */
export class TimingJitter implements ChannelEffect {
  private jitterAmount: number;
  private seed: number;

  constructor(jitterAmount: number = 0.01) {
    this.jitterAmount = jitterAmount;
    this.seed = 12345;
  }

  private random(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return (this.seed / 0x7fffffff) * 2 - 1; // [-1, 1]
  }

  process(samples: Float32Array): Float32Array {
    // This is a simplified jitter model using linear interpolation
    const out = new Float32Array(samples.buffer, 0, samples.length);
    for (let i = 0; i < samples.length; i++) {
      const jitter = this.jitterAmount * this.random();
      const indexWithJitter = i + jitter;
      const floor = Math.floor(indexWithJitter);
      const ceil = Math.min(floor + 1, samples.length - 1);
      const frac = indexWithJitter - floor;

      if (floor >= 0 && floor < samples.length) {
        const a = samples[floor] ?? 0;
        const b = ceil < samples.length ? (samples[ceil] ?? 0) : (samples[floor] ?? 0);
        out[i] = a * (1 - frac) + b * frac;
      }
    }
    return out;
  }

  reset(): void {
    this.seed = 12345;
  }
}

/**
 * Compose multiple channel effects in sequence.
 */
export class ChannelSimulator {
  private effects: ChannelEffect[] = [];

  addEffect(effect: ChannelEffect): this {
    this.effects.push(effect);
    return this;
  }

  process(samples: Float32Array): Float32Array {
    let result: Float32Array = samples.slice();
    for (const effect of this.effects) {
      result = effect.process(result) as Float32Array;
    }
    return result;
  }

  reset(): void {
    for (const effect of this.effects) {
      effect.reset();
    }
  }
}
