/**
 * PilotScanner + PilotPLL — Pilot frequency discovery and phase tracking.
 */
import { TONE_OFFSETS } from './types';
import { dlog } from '../lib/debug/dlog';

function fftMagnitude(samples: number[], fftSize: number): Float64Array {
  const n = fftSize;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < Math.min(samples.length, n); i++) real[i] = samples[i];
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
    const angle = (-2 * Math.PI) / len,
      wlenR = Math.cos(angle),
      wlenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wR = 1,
        wI = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uR = real[i + j],
          uI = imag[i + j];
        const vR = real[i + j + half] * wR - imag[i + j + half] * wI;
        const vI = real[i + j + half] * wI + imag[i + j + half] * wR;
        real[i + j] = uR + vR;
        imag[i + j] = uI + vI;
        real[i + j + half] = uR - vR;
        imag[i + j + half] = uI - vI;
        const nwR = wR * wlenR - wI * wlenI,
          nwI = wR * wlenI + wI * wlenR;
        wR = nwR;
        wI = nwI;
      }
    }
  }
  const mag = new Float64Array(n >> 1);
  for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(real[i], imag[i]);
  return mag;
}

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
  minAmplitude?: number;
  targetFreq?: number;
  freqTolerance?: number;
}

const DEFAULT_SCANNER_CONFIG: PilotScannerConfig = {
  scanRange: [30, 500],
  sampleRate: 3200,
  fftSize: 2048,
  minSamples: 1024,
  minSignalRatio: 5.0,
  minAmplitude: 0.005,
};

export class PilotScanner {
  private cfg: PilotScannerConfig;
  private rtBuf: number[] = [];
  private done = false;
  private result: PilotDiscovery | null = null;
  private scanCount = 0;
  private noiseBuf: number[] = [];
  private noiseLearned = false;

  constructor(cfg: Partial<PilotScannerConfig> = {}) {
    this.cfg = { ...DEFAULT_SCANNER_CONFIG, ...cfg };
  }

  learnNoise(sample: number, target: number): void {
    if (this.noiseLearned) return;
    this.noiseBuf.push(sample);
    if (this.noiseBuf.length >= target) {
      this.noiseLearned = true;
      dlog('SCAN', { noiseFloorSamples: target });
    }
  }
  hasNoiseProfile(): boolean {
    return this.noiseLearned;
  }

  /** Feed every sample in real time (bypasses decoder frame buffer) */
  feedSampleRT(s: number): void {
    this.rtBuf.push(s);
    if (this.rtBuf.length > 1024) this.rtBuf.shift();
  }

  feedSample(_sample: number): PilotDiscovery | null {
    this.scanCount++;
    if (this.scanCount % 4 !== 0 || this.rtBuf.length < 512) return this.result;
    const win = this.rtBuf.slice(-512);
    const { sampleRate, targetFreq, freqTolerance = 30, minSignalRatio, minAmplitude } = this.cfg;

    // Scan target ± tolerance at 2 Hz resolution
    let bestF = 0,
      bestM = 0;
    const results: { f: number; m: number }[] = [];
    const lo = Math.max(30, (targetFreq || 400) - freqTolerance);
    const hi = Math.min(1550, (targetFreq || 400) + freqTolerance);
    for (let f = lo; f <= hi; f += 2) {
      let si = 0,
        co = 0;
      for (let i = 0; i < win.length; i++) {
        const ph = (2 * Math.PI * f * i) / sampleRate;
        si += win[i] * Math.sin(ph);
        co += win[i] * Math.cos(ph);
      }
      const m = Math.hypot(si, co) / win.length;
      results.push({ f, m });
      if (m > bestM) {
        bestM = m;
        bestF = f;
      }
    }
    results.sort((a, b) => b.m - a.m);
    const top5 = results
      .slice(0, 5)
      .map((r) => `${r.f}Hz=${r.m.toExponential(2)}`)
      .join(', ');
    const median =
      results.map((r) => r.m).sort((a, b) => a - b)[Math.floor(results.length / 2)] || 1e-12;
    const ratio = bestM / Math.max(median, 1e-14);
    dlog('SCAN', { peak: bestF, ratio, top5 }, { every: 200 });

    if (
      ratio >= (minSignalRatio || 5) &&
      bestM >= (minAmplitude || 0.005) &&
      targetFreq &&
      Math.abs(bestF - targetFreq) <= freqTolerance
    ) {
      this.result = {
        freq: bestF,
        amplitude: bestM,
        confidence: Math.min(1, (ratio - (minSignalRatio || 5)) / 20),
      };
      this.done = true;
      dlog('SCAN', { locked: bestF, amp: bestM });
    }
    return this.result;
  }

  forceDiscover(): PilotDiscovery | null {
    return this.result;
  }
  isDone(): boolean {
    return this.done;
  }
  getResult(): PilotDiscovery | null {
    return this.result;
  }

  reset() {
    this.rtBuf = [];
    this.done = false;
    this.result = null;
    this.scanCount = 0;
    this.noiseBuf = [];
    this.noiseLearned = false;
  }
}

// ─── PilotPLL ─────────────────────────────────────────
export interface PLLConfig {
  Kp: number;
  Ki: number;
  sampleRate: number;
}
const DEFAULT_PLL_CONFIG: PLLConfig = { Kp: 0.1, Ki: 0.01, sampleRate: 3200 };
export class PilotPLL {
  private cfg: PLLConfig;
  private freq: number;
  private phase: number;
  private integrator: number;
  private amplitude: number;
  private sinRef = 0;
  private cosRef = 1;
  constructor(
    freq: number,
    initialPhase: number,
    initialAmplitude: number,
    cfg?: Partial<PLLConfig>,
  ) {
    this.cfg = { ...DEFAULT_PLL_CONFIG, ...cfg };
    this.freq = freq;
    this.phase = initialPhase;
    this.integrator = 0;
    this.amplitude = initialAmplitude;
    this.updateRef();
  }
  update(sample: number): void {
    // Scale Kp/Ki to maintain constant loop bandwidth regardless of sample rate.
    // Defaults (0.1, 0.01) are tuned for 3200Hz. At higher rates, each sample
    // contributes proportionally less, so the gains are reduced accordingly.
    const rateScale = DEFAULT_PLL_CONFIG.sampleRate / this.cfg.sampleRate;
    const scaledKp = this.cfg.Kp * rateScale;
    const scaledKi = this.cfg.Ki * rateScale;
    const error = sample * this.sinRef,
      prop = scaledKp * error;
    this.integrator += scaledKi * error;
    this.integrator = Math.max(-0.5, Math.min(0.5, this.integrator));
    this.phase += this.freq / this.cfg.sampleRate + prop + this.integrator;
    if (this.phase >= 1.0) this.phase -= 1.0;
    if (this.phase < 0) this.phase += 1.0;
    const i = sample * this.cosRef,
      q = sample * this.sinRef;
    this.amplitude = this.amplitude * 0.99 + Math.hypot(i, q) * 0.01;
    this.updateRef();
  }
  getFrequency(): number {
    return this.freq;
  }
  getPhase(): number {
    return this.phase;
  }
  getAmplitude(): number {
    return this.amplitude;
  }
  getSinRef(): number {
    return this.sinRef;
  }
  getCosRef(): number {
    return this.cosRef;
  }
  rotateToPilotRef(rawI: number, rawQ: number): { i: number; q: number } {
    return {
      i: rawI * this.cosRef + rawQ * this.sinRef,
      q: -rawI * this.sinRef + rawQ * this.cosRef,
    };
  }
  setFrequency(f: number) {
    this.freq = f;
  }
  private updateRef() {
    const theta = 2 * Math.PI * this.phase;
    this.sinRef = Math.sin(theta);
    this.cosRef = Math.cos(theta);
  }
}

export function toneIQ(
  samples: readonly number[],
  toneFreq: number,
  sampleRate: number,
): { i: number; q: number } {
  let i = 0,
    q = 0;
  const n = samples.length;
  for (let idx = 0; idx < n; idx++) {
    const phase = (2 * Math.PI * toneFreq * idx) / sampleRate;
    i += samples[idx] * Math.sin(phase);
    q += samples[idx] * Math.cos(phase);
  }
  return { i: i / n, q: q / n };
}

export function getDataToneFreqs(
  pilotFreqHz: number,
  musical = false,
): [number, number, number, number] {
  const offs = musical
    ? [300, 425, 550, 775]
    : [TONE_OFFSETS[0], TONE_OFFSETS[1], TONE_OFFSETS[2], TONE_OFFSETS[3]];
  return [
    pilotFreqHz + offs[0],
    pilotFreqHz + offs[1],
    pilotFreqHz + offs[2],
    pilotFreqHz + offs[3],
  ] as [number, number, number, number];
}
