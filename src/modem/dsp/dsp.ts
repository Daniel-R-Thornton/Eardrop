/**
 * Lightweight DSP utilities for debug visualization.
 * Ported from TapewormFS debug-suite DSPEngine.
 */

export class DSP {
  sampleRate: number;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
  }

  /** FFT — returns magnitude per bin */
  fft(samples: Float32Array): { magnitude: Float32Array; real: Float64Array; imag: Float64Array } {
    const n = samples.length;
    const real = new Float64Array(n);
    const imag = new Float64Array(n);
    for (let i = 0; i < n; i++) real[i] = samples[i];

    // Bit reversal
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let rev = 0;
      for (let j = 0; j < bits; j++) rev = (rev << 1) | ((i >> j) & 1);
      if (rev > i) {
        [real[i], real[rev]] = [real[rev], real[i]];
        [imag[i], imag[rev]] = [imag[rev], imag[i]];
      }
    }

    // Cooley-Tukey
    for (let len = 2; len <= n; len <<= 1) {
      const angle = (-2 * Math.PI) / len;
      const wlenReal = Math.cos(angle);
      const wlenImag = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let wReal = 1,
          wImag = 0;
        for (let j = 0; j < len / 2; j++) {
          const uReal = real[i + j],
            uImag = imag[i + j];
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

    const magnitude = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) magnitude[i] = Math.hypot(real[i], imag[i]);
    return { magnitude, real, imag };
  }

  /** Window function (Hann) */
  applyWindow(samples: Float32Array): Float32Array {
    const n = samples.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = samples[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    return out;
  }

  /** Build spectrogram: list of magnitude frames */
  spectrogram(samples: Float32Array, fftSize = 1024, hopSize = 256): Float32Array[] {
    const frames: Float32Array[] = [];
    const windowed = this.applyWindow(new Float32Array(fftSize));
    for (let start = 0; start + fftSize <= samples.length; start += hopSize) {
      const frame = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) frame[i] = samples[start + i] * windowed[i];
      const { magnitude } = this.fft(frame);
      frames.push(magnitude);
    }
    return frames;
  }

  /** Goertzel magnitude for a single frequency */
  goertzel(samples: Float32Array, targetFreq: number): number {
    const n = samples.length;
    if (n === 0) return 0;
    const k = Math.round((targetFreq * n) / this.sampleRate);
    const omega = (2 * Math.PI * k) / n;
    const coeff = 2 * Math.cos(omega);
    // eslint-disable-next-line no-useless-assignment -- Goertzel IIR state variables; s0 is overwritten before first read
    let s0 = 0,
      s1 = 0,
      s2 = 0;
    for (let i = 0; i < n; i++) {
      // eslint-disable-next-line no-useless-assignment -- Goertzel IIR: s0 is intermediate, s1/s2 hold final state
      s0 = samples[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const real = s1 - s2 * Math.cos(omega);
    const imag = s2 * Math.sin(omega);
    return Math.hypot(real, imag);
  }
}
