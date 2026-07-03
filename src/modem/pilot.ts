/**
 * PilotScanner + PilotPLL — Pilot frequency discovery and phase tracking.
 */
import { TONE_OFFSETS } from "./types";

function fftMagnitude(samples: number[], fftSize: number): Float64Array {
  const n = fftSize;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < Math.min(samples.length, n); i++) real[i] = samples[i];
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let rev = 0;
    for (let j = 0; j < bits; j++) rev = (rev << 1) | ((i >> j) & 1);
    if (rev > i) { [real[i], real[rev]] = [real[rev], real[i]]; [imag[i], imag[rev]] = [imag[rev], imag[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wlenR = Math.cos(angle), wlenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wR = 1, wI = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uR = real[i + j], uI = imag[i + j];
        const vR = real[i + j + half] * wR - imag[i + j + half] * wI;
        const vI = real[i + j + half] * wI + imag[i + j + half] * wR;
        real[i + j] = uR + vR; imag[i + j] = uI + vI;
        real[i + j + half] = uR - vR; imag[i + j + half] = uI - vI;
        const nwR = wR * wlenR - wI * wlenI, nwI = wR * wlenI + wI * wlenR;
        wR = nwR; wI = nwI;
      }
    }
  }
  const mag = new Float64Array(n >> 1);
  for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(real[i], imag[i]);
  return mag;
}

function interpolatePeak(m0: number, m1: number, m2: number): number {
  const denom = m0 - 2 * m1 + m2;
  return Math.abs(denom) < 1e-12 ? 0 : (m0 - m2) / (2 * denom);
}

export interface PilotDiscovery { freq: number; amplitude: number; confidence: number; }

export interface PilotScannerConfig {
  scanRange: [number, number];
  sampleRate: number;
  fftSize: number;
  minSamples: number;
  minSignalRatio: number;
  targetFreq?: number;
  freqTolerance?: number;
}

const DEFAULT_SCANNER_CONFIG: PilotScannerConfig = {
  scanRange: [30, 500],
  sampleRate: 3200,
  fftSize: 2048,
  minSamples: 1024,
  minSignalRatio: 5.0,
};

const DEFAULT_TOLERANCE = 25; // Hz — wide enough for sample-rate shift (~5%), tight enough to reject room noise 47 Hz away

export class PilotScanner {
  private cfg: PilotScannerConfig;
  private buf: number[] = [];
  private done = false;
  private result: PilotDiscovery | null = null;
  private lastFftAt = 0;
  private scanCounter = 0;
  /** Real-time ring buffer — captures EVERY sample directly, no frame delay */
  private rtBuf: number[] = [];
  /** Noise floor spectrum — learned during silent first ~1s, subtracted to reject room hum */
  private noiseBuf: number[] = [];
  private noiseSpectrum: Float64Array | null = null;
  private noiseLearned = false;

  constructor(cfg: Partial<PilotScannerConfig> = {}) {
    this.cfg = { ...DEFAULT_SCANNER_CONFIG, ...cfg };
  }

  /** Feed samples during the silent noise-profiling phase */
  learnNoise(sample: number, targetSamples: number): void {
    if (this.noiseLearned) return;
    this.noiseBuf.push(sample);
    if (this.noiseBuf.length >= targetSamples) {
      const mag = fftMagnitude(this.noiseBuf, this.cfg.fftSize);
      this.noiseSpectrum = mag;
      this.noiseLearned = true;
      // Log top noise peaks
      const bw = this.cfg.sampleRate / this.cfg.fftSize;
      const lo = Math.max(1, Math.floor(this.cfg.scanRange[0] / bw));
      const hi = Math.min(mag.length - 1, Math.ceil(this.cfg.scanRange[1] / bw));
      const peaks: { freq: number; mag: number }[] = [];
      for (let b = lo; b <= hi; b++) peaks.push({ freq: b * bw, mag: mag[b] });
      peaks.sort((a, b) => b.mag - a.mag);
      console.warn(`[SCAN] Noise floor learned (${targetSamples}samp). Top: ${peaks.slice(0,5).map(p => `${p.freq.toFixed(1)}Hz=${p.mag.toExponential(2)}`).join(', ')}`);
    }
  }

  hasNoiseProfile(): boolean { return this.noiseLearned; }

  /** Feed every sample in real time — called from decoder.feedSample BEFORE frame buffering */
  feedSampleRT(sample: number): void {
    this.rtBuf.push(sample);
    if (this.rtBuf.length > 1024) this.rtBuf.shift();
  }

  feedSample(sample: number): PilotDiscovery | null {
    if (this.done) return this.result;
    this.scanCounter++;
    // Scan every 4th call (~512 samples) using the RT ring buffer
    if (this.scanCounter % 4 !== 0 || this.rtBuf.length < 512) return null;
    const win = this.rtBuf.slice(-512);
      const { sampleRate, targetFreq, freqTolerance = 30, minSignalRatio } = this.cfg;
      console.warn(`[SCAN] Goertzel scan: ${win.length}samp target=${targetFreq}Hz`);

      // Scan target ± tolerance at 5 Hz resolution using Goertzel on recent samples
      let bestFreq = 0, bestMag = 0;
      const results: { f: number; m: number }[] = [];
      const startF = Math.max(30, (targetFreq || 400) - freqTolerance);
      const endF = Math.min(1550, (targetFreq || 400) + freqTolerance);
      for (let f = startF; f <= endF; f += 2) {
        let si = 0, co = 0;
        for (let i = 0; i < win.length; i++) {
          const ph = 2 * Math.PI * f * i / sampleRate;
          si += win[i] * Math.sin(ph);
          co += win[i] * Math.cos(ph);
        }
        const mag = Math.hypot(si, co) / win.length;
        results.push({ f, m: mag });
        if (mag > bestMag) { bestMag = mag; bestFreq = f; }
      }
      results.sort((a, b) => b.m - a.m);
      console.warn(`[SCAN] Goertzel top 5: ${results.slice(0, 5).map(r => `${r.f}Hz=${r.m.toExponential(2)}`).join(', ')}`);

      // Check if best peak is above noise floor
      const allMags = results.map(r => r.m).sort((a, b) => a - b);
      const median = allMags[Math.floor(allMags.length / 2)] || 1e-12;
      const ratio = bestMag / Math.max(median, 1e-14);
      console.warn(`[SCAN] Peak: ${bestFreq}Hz mag=${bestMag.toExponential(2)} median=${median.toExponential(2)} ratio=${ratio.toFixed(1)}`);

      if (ratio >= (minSignalRatio || 5) && targetFreq && Math.abs(bestFreq - targetFreq) <= freqTolerance) {
        const amplitude = bestMag;
        const confidence = Math.min(1, (ratio - (minSignalRatio || 5)) / 20);
        this.result = { freq: bestFreq, amplitude, confidence };
        console.warn(`[SCAN] PILOT LOCKED: ${bestFreq} Hz @ amp ${amplitude.toExponential(2)}`);
        this.done = true;
        return this.result;
      } else if (ratio < (minSignalRatio || 5)) {
        console.warn(`[SCAN] Rejected: ratio ${ratio.toFixed(1)} < ${minSignalRatio || 5}`);
      } else if (targetFreq && Math.abs(bestFreq - targetFreq) > freqTolerance) {
        console.warn(`[SCAN] Rejected: ${bestFreq}Hz is ${Math.abs(bestFreq - targetFreq).toFixed(1)}Hz from target ${targetFreq}Hz`);
      }
    }
    return null;
  }

  forceDiscover(): PilotDiscovery | null {
    return this.result;
  }

  isDone(): boolean { return this.done; }
  getResult(): PilotDiscovery | null { return this.result; }

  reset() {
    this.rtBuf = []; this.buf = []; this.done = false; this.result = null;
    this.lastFftAt = 0; this.scanCounter = 0;
    this.noiseBuf = []; this.noiseSpectrum = null; this.noiseLearned = false;
  }
}

export interface PLLConfig { Kp: number; Ki: number; sampleRate: number; }
const DEFAULT_PLL_CONFIG: PLLConfig = { Kp: 0.1, Ki: 0.01, sampleRate: 3200 };

export class PilotPLL {
  private cfg: PLLConfig; private freq: number; private phase: number;
  private integrator: number; private amplitude: number;
  private sinRef = 0; private cosRef = 1;

  constructor(freq: number, initialPhase: number, initialAmplitude: number, cfg?: Partial<PLLConfig>) {
    this.cfg = { ...DEFAULT_PLL_CONFIG, ...cfg };
    this.freq = freq; this.phase = initialPhase; this.integrator = 0;
    this.amplitude = initialAmplitude; this.updateRef();
  }

  update(sample: number): void {
    const error = sample * this.sinRef;
    const proportional = this.cfg.Kp * error;
    this.integrator += this.cfg.Ki * error;
    this.integrator = Math.max(-0.5, Math.min(0.5, this.integrator));
    this.phase += this.freq / this.cfg.sampleRate + proportional + this.integrator;
    if (this.phase >= 1.0) this.phase -= 1.0;
    if (this.phase < 0) this.phase += 1.0;
    const i = sample * this.cosRef, q = sample * this.sinRef;
    this.amplitude = this.amplitude * 0.99 + Math.hypot(i, q) * 0.01;
    this.updateRef();
  }

  getFrequency(): number { return this.freq; }
  getPhase(): number { return this.phase; }
  getAmplitude(): number { return this.amplitude; }
  getSinRef(): number { return this.sinRef; }
  getCosRef(): number { return this.cosRef; }

  rotateToPilotRef(rawI: number, rawQ: number): { i: number; q: number } {
    return { i: rawI * this.cosRef + rawQ * this.sinRef, q: -rawI * this.sinRef + rawQ * this.cosRef };
  }
  setFrequency(f: number) { this.freq = f; }
  private updateRef() {
    const theta = 2 * Math.PI * this.phase;
    this.sinRef = Math.sin(theta); this.cosRef = Math.cos(theta);
  }
}

export function toneIQ(samples: readonly number[], toneFreq: number, sampleRate: number): { i: number; q: number } {
  let i = 0, q = 0; const n = samples.length;
  for (let idx = 0; idx < n; idx++) {
    const phase = 2 * Math.PI * toneFreq * idx / sampleRate;
    i += samples[idx] * Math.sin(phase); q += samples[idx] * Math.cos(phase);
  }
  return { i: i / n, q: q / n };
}

export function getDataToneFreqs(pilotFreqHz: number, musical = false): [number, number, number, number] {
  const offs = musical
    ? [300, 425, 550, 775]
    : [TONE_OFFSETS[0], TONE_OFFSETS[1], TONE_OFFSETS[2], TONE_OFFSETS[3]];
  return [
    pilotFreqHz + offs[0], pilotFreqHz + offs[1],
    pilotFreqHz + offs[2], pilotFreqHz + offs[3],
  ] as [number, number, number, number];
}
