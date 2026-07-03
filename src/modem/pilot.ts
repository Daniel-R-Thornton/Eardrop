/**
 * PilotScanner + PilotPLL — Pilot frequency discovery and phase tracking.
 *
 * Two-phase design:
 *   1. PilotScanner: Buffer ~0.5s of leader audio, run FFT with zero-padding
 *      to 2048 samples (bin spacing ~1.56 Hz), find the strongest peak
 *      in the scan range. That peak IS the pilot — tones are relative to it.
 *      Parabolic interpolation around peak gives <0.1 Hz accuracy.
 *   2. PilotPLL: Second-order PLL locked to the discovered frequency. Tracks phase
 *      and amplitude continuously through the entire transmission.
 */

import { TONE_OFFSETS } from "./types";

// ─── FFT helpers ──────────────────────────────────────

function fftMagnitude(samples: number[], fftSize: number): Float64Array {
  const n = fftSize;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < Math.min(samples.length, n); i++) {
    real[i] = samples[i];
  }
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let rev = 0;
    for (let j = 0; j < bits; j++) rev = (rev << 1) | ((i >> j) & 1);
    if (rev > i) {
      [real[i], real[rev]] = [real[rev], real[i]];
      [imag[i], imag[rev]] = [imag[rev], imag[i]];
    }
  }
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
  const mag = new Float64Array(n >> 1);
  for (let i = 0; i < mag.length; i++) {
    mag[i] = Math.hypot(real[i], imag[i]);
  }
  return mag;
}

function interpolatePeak(m0: number, m1: number, m2: number): number {
  const denom = m0 - 2 * m1 + m2;
  if (Math.abs(denom) < 1e-12) return 0;
  return (m0 - m2) / (2 * denom);
}

// ─── PilotScanner ─────────────────────────────────────

export interface PilotDiscovery {
  freq: number;
  amplitude: number;
  confidence: number;
}

export interface PilotScannerConfig {
  scanRange: [number, number];
  sampleRate: number;
  fftSize: number;
  minSamples: number;
  minSignalRatio: number;
}

const DEFAULT_SCANNER_CONFIG: PilotScannerConfig = {
  scanRange: [30, 500],
  sampleRate: 3200,
  fftSize: 2048,
  minSamples: 1024,
  minSignalRatio: 5.0,
};

export class PilotScanner {
  private cfg: PilotScannerConfig;
  private buf: number[] = [];
  private done = false;
  private result: PilotDiscovery | null = null;

  constructor(cfg: Partial<PilotScannerConfig> = {}) {
    this.cfg = { ...DEFAULT_SCANNER_CONFIG, ...cfg };
  }

  feedSample(sample: number): PilotDiscovery | null {
    if (this.done) return this.result;
    this.buf.push(sample);
    if (this.buf.length >= this.cfg.minSamples && !this.result) {
      this.runFft();
      if (this.result) {
        this.done = true;
        return this.result;
      }
    }
    if (this.buf.length >= this.cfg.minSamples * 4) {
      // Final attempt — run FFT one more time
      if (!this.result) this.runFft();
      this.done = true;
      return this.result;
    }
    return null;
  }

  forceDiscover(): PilotDiscovery | null {
    if (this.buf.length < 64) return null;
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
    const mag = fftMagnitude(this.buf, fftSize);
    const binWidth = sampleRate / fftSize;
    const binLo = Math.max(1, Math.floor(scanRange[0] / binWidth));
    const binHi = Math.min(mag.length - 1, Math.ceil(scanRange[1] / binWidth));

    let peakBin = binLo;
    let peakMag = mag[binLo];
    for (let b = binLo + 1; b <= binHi; b++) {
      if (mag[b] > peakMag) { peakMag = mag[b]; peakBin = b; }
    }

    const allMags: number[] = [];
    for (let b = 1; b < mag.length; b++) {
      if (b < binLo - 2 || b > binHi + 2) allMags.push(mag[b]);
    }
    allMags.sort((a, b) => a - b);
    const noiseMedian = allMags[Math.floor(allMags.length / 2)] || 1e-12;
    const signalRatio = peakMag / Math.max(noiseMedian, 1e-14);
    if (signalRatio < minSignalRatio) {
      this.result = null;
      return;
    }

    const m0 = peakBin > 0 ? mag[peakBin - 1] : 0;
    const m1 = peakMag;
    const m2 = peakBin < mag.length - 1 ? mag[peakBin + 1] : 0;
    const offset = interpolatePeak(m0, m1, m2);
    const freq = Math.round((peakBin + offset) * binWidth * 10) / 10;
    const amplitude = peakMag / this.buf.length;
    const confidence = Math.min(1, (signalRatio - minSignalRatio) / 20);

    this.result = { freq, amplitude, confidence };
  }
}

// ─── PilotPLL ─────────────────────────────────────────

export interface PLLConfig {
  Kp: number;
  Ki: number;
  sampleRate: number;
}

const DEFAULT_PLL_CONFIG: PLLConfig = {
  Kp: 0.1,
  Ki: 0.01,
  sampleRate: 3200,
};

export class PilotPLL {
  private cfg: PLLConfig;
  private freq: number;
  private phase: number;
  private integrator: number;
  private amplitude: number;
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

  update(sample: number): void {
    const error = sample * this.sinRef;
    const proportional = this.cfg.Kp * error;
    this.integrator += this.cfg.Ki * error;
    this.integrator = Math.max(-0.5, Math.min(0.5, this.integrator));
    const freqDelta = proportional + this.integrator;
    this.phase += this.freq / this.cfg.sampleRate + freqDelta;
    if (this.phase >= 1.0) this.phase -= 1.0;
    if (this.phase < 0) this.phase += 1.0;
    const i = sample * this.cosRef;
    const q = sample * this.sinRef;
    const instAmp = Math.hypot(i, q);
    const alpha = 0.01;
    this.amplitude = this.amplitude * (1 - alpha) + instAmp * alpha;
    this.updateRef();
  }

  getFrequency(): number { return this.freq; }
  getPhase(): number { return this.phase; }
  getAmplitude(): number { return this.amplitude; }
  getSinRef(): number { return this.sinRef; }
  getCosRef(): number { return this.cosRef; }

  rotateToPilotRef(rawI: number, rawQ: number): { i: number; q: number } {
    return {
      i: rawI * this.cosRef + rawQ * this.sinRef,
      q: -rawI * this.sinRef + rawQ * this.cosRef,
    };
  }

  setFrequency(f: number) { this.freq = f; }

  private updateRef() {
    const theta = 2 * Math.PI * this.phase;
    this.sinRef = Math.sin(theta);
    this.cosRef = Math.cos(theta);
  }
}

// ─── Convenience functions ─────────────────────────────

export function toneIQ(samples: readonly number[], toneFreq: number, sampleRate: number): { i: number; q: number } {
  let i = 0, q = 0;
  const n = samples.length;
  for (let idx = 0; idx < n; idx++) {
    const phase = 2 * Math.PI * toneFreq * idx / sampleRate;
    i += samples[idx] * Math.sin(phase);
    q += samples[idx] * Math.cos(phase);
  }
  return { i: i / n, q: q / n };
}

export function getDataToneFreqs(pilotFreqHz: number): [number, number, number, number] {
  return [
    pilotFreqHz + TONE_OFFSETS[0],
    pilotFreqHz + TONE_OFFSETS[1],
    pilotFreqHz + TONE_OFFSETS[2],
    pilotFreqHz + TONE_OFFSETS[3],
  ] as [number, number, number, number];
}
