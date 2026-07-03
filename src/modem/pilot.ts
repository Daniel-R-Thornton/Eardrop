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

  feedSample(sample: number): PilotDiscovery | null {
    if (this.done) return this.result;
    this.buf.push(sample);
    // Keep only the most recent 4096 samples (sliding window — ~1.3s)
    if (this.buf.length > 4096) {
      this.buf.splice(0, this.buf.length - 2048);
    }
    if (this.buf.length >= this.cfg.minSamples && this.buf.length >= this.lastFftAt + 512) {
      this.lastFftAt = this.buf.length;
      console.warn(`[SCAN] FFT run: ${this.buf.length}samp noise=${this.noiseLearned}`);
      this.runFft();
      if (this.result) {
        console.warn(`[SCAN] PILOT LOCKED: ${this.result.freq} Hz @ amp ${this.result.amplitude.toExponential(2)}`);
        this.done = true;
        return this.result;
      } else {
        console.warn(`[SCAN] No valid pilot yet (buf=${this.buf.length})`);
      }
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
    this.buf = []; this.done = false; this.result = null; this.lastFftAt = 0;
    this.noiseBuf = []; this.noiseSpectrum = null; this.noiseLearned = false;
  }

  private runFft() {
    const { scanRange, sampleRate, fftSize, minSignalRatio, targetFreq, freqTolerance = 50 } = this.cfg;
    const rawMag = fftMagnitude(this.buf, fftSize);
    let mag = rawMag;

    // Subtract learned noise spectrum to suppress room hum
    if (this.noiseSpectrum) {
      const sub = new Float64Array(mag.length);
      for (let i = 0; i < mag.length; i++) {
        sub[i] = Math.max(0, mag[i] - this.noiseSpectrum[i]);
      }
      const binMax = Math.round(400 / (sampleRate / fftSize));
      console.warn(`[SCAN] Noise-subtracted: noise@365Hz=${this.noiseSpectrum[Math.round(365/sampleRate*fftSize)]?.toExponential(2)} rawFFT=${rawMag[Math.round(365/sampleRate*fftSize)]?.toExponential(2)} after=${sub[Math.round(365/sampleRate*fftSize)]?.toExponential(2)}`);
      mag = sub;
    }
    const binWidth = sampleRate / fftSize;
    const binLo = Math.max(1, Math.floor(scanRange[0] / binWidth));
    const binHi = Math.min(mag.length - 1, Math.ceil(scanRange[1] / binWidth));

    // Find top 3 peaks for diagnostics
    interface Peak { bin: number; mag: number; freq: number; }
    const peaks: Peak[] = [];
    for (let b = binLo; b <= binHi; b++) {
      // Local maximum check
      if ((b === binLo || mag[b] > mag[b - 1]) && (b === binHi || mag[b] > mag[b + 1] || mag[b] >= mag[b - 1])) {
        continue; // simple approach — just find the global max
      }
    }
    // Actually just find the top value
    let peakBin = binLo, peakMag = mag[binLo];
    for (let b = binLo + 1; b <= binHi; b++) {
      if (mag[b] > peakMag) { peakMag = mag[b]; peakBin = b; }
    }

    // Log top 5 magnitude bins for debugging
    const topBins: { bin: number; freq: number; mag: number }[] = [];
    for (let b = binLo; b <= binHi; b++) {
      topBins.push({ bin: b, freq: b * binWidth, mag: mag[b] });
    }
    topBins.sort((a, b) => b.mag - a.mag);
    console.warn(`[SCAN] Top 5 bins: ${topBins.slice(0, 5).map(p => `${p.freq.toFixed(1)}Hz=${p.mag.toExponential(2)}`).join(', ')}`);

    const allMags: number[] = [];
    for (let b = 1; b < mag.length; b++) {
      if (b < binLo - 2 || b > binHi + 2) allMags.push(mag[b]);
    }
    allMags.sort((a, b) => a - b);
    const noiseMedian = allMags[Math.floor(allMags.length / 2)] || 1e-12;
    const signalRatio = peakMag / Math.max(noiseMedian, 1e-14);
    console.warn(`[SCAN] Peak: ${(peakBin * binWidth).toFixed(1)}Hz mag=${peakMag.toExponential(2)} noiseMedian=${noiseMedian.toExponential(2)} ratio=${signalRatio.toFixed(1)}`);

    if (signalRatio < minSignalRatio) {
      console.warn(`[SCAN] Rejected: signalRatio ${signalRatio.toFixed(1)} < ${minSignalRatio}`);
      return;
    }

    const m0 = peakBin > 0 ? mag[peakBin - 1] : 0;
    const m1 = peakMag;
    const m2 = peakBin < mag.length - 1 ? mag[peakBin + 1] : 0;
    const offset = interpolatePeak(m0, m1, m2);
    const freq = Math.round((peakBin + offset) * binWidth * 10) / 10;
    const amplitude = peakMag / this.buf.length;
    const confidence = Math.min(1, (signalRatio - minSignalRatio) / 20);

    if (targetFreq && Math.abs(freq - targetFreq) > freqTolerance) {
      console.warn(`[SCAN] Rejected: ${freq}Hz is ${Math.abs(freq - targetFreq).toFixed(1)}Hz from target ${targetFreq}Hz (tolerance ${freqTolerance}Hz)`);
      console.warn(`[SCAN]   Top 5: ${topBins.slice(0, 5).map(p => `${p.freq.toFixed(1)}Hz`).join(', ')}`);
      this.result = null;
      return;
    }
    console.warn(`[SCAN] ACCEPTED: ${freq}Hz amp=${amplitude.toExponential(2)} confidence=${confidence.toFixed(2)}`);
    this.result = { freq, amplitude, confidence };
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
