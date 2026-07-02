/**
 * Decoder — Pilot-Relative Multi-Tone Modem
 *
 * Two-phase pilot discovery:
 *   1. PilotScanner: scans 40-120 Hz during leader to find the dominant tone
 *   2. PilotPLL: second-order PLL locked to discovered frequency
 *
 * All tone measurements are pilot-relative:
 *   - Raw I/Q at each data tone frequency
 *   - Rotated by PLL's tracked pilot phase → pilot-relative I'/Q'
 *   - Amplitude bit: |I' + jQ'| > pilotAmp * thresholdRatio
 *   - Phase bit: sign(I')  (BPSK: right half-plane = 1, left = 0)
 *
 * Falls back to absolute-energy detection if pilot discovery fails.
 */

import { ModemConfig, TONE_OFFSETS, DEFAULT_CONFIG } from "./types";
import { PilotScanner, PilotPLL, toneIQ, getDataToneFreqs } from "./pilot";
import { hammingDecode } from "../hamming";

export interface DecoderDebugInfo {
  peakAmp: number;
  /** Per-tone pilot-relative I' values */
  relI: [number, number, number, number];
  /** Per-tone pilot-relative Q' values */
  relQ: [number, number, number, number];
  /** Pilot-relative energy magnitude per tone */
  energies: [number, number, number, number];
  avg: number;
  noiseAvg: number;
  strong: boolean;
  consecutiveSync: number;
  inFrame: boolean;
  bitsCollected: number;
  noiseFloor: [number, number, number, number];
  noiseMax: [number, number, number, number];
  thresholds: [number, number, number, number];
  ratios: [number, number, number, number];
  noiseFrames: number;
  /** 8-bit pattern: [amp0 phase0 amp1 phase1 amp2 phase2 amp3 phase3] */
  bitPattern: number;
  signalToNoise: number;
  burstThreshold: number;
  framesSinceStrong: number;
  framesSinceExit: number;
  frameSkip: number;
  /** Discovered pilot frequency (0 = not yet discovered) */
  pilotFreq: number;
  /** Tracked pilot amplitude (for AGC reference) */
  pilotAmp: number;
  /** Pilot confidence 0-1 */
  pilotConfidence: number;
}

export class Decoder {
  private cfg: ModemConfig;
  private sps = 128;

  // Buffer
  private buf: number[] = [];

  // ── Pilot discovery ──
  private scanner: PilotScanner;
  private pll: PilotPLL | null = null;
  private pilotDiscovered = false;
  private pilotFreq = 0;
  private pilotAmplitude = 0;
  /** Absolute tone frequencies (computed from discovered pilot) */
  private toneFreqs: [number, number, number, number] = [500, 700, 900, 1100];

  // State
  private inFrame = false;
  private consecutiveSync = 0;
  private frameSkip = 0;
  private bitCollector: number[] = [];
  private bitsCollected = 0;

  // Noise profiling
  private noiseFloor: [number, number, number, number] = [0, 0, 0, 0];
  private noiseMax: [number, number, number, number] = [0, 0, 0, 0];
  private noiseFrames = 0;

  // Accumulated decoded bytes
  private decodedBytes: number[] = [];

  // End detection
  private framesSinceStrong = 0;
  private lastStrongBits = 0;
  private framesSinceExit = 0;
  private dataFramesExecuted = 0;
  private expectedTotalBytes = 0;
  private totalBytesEmitted = 0;
  private syncPeak: [number, number, number, number] = [2e-10, 2e-10, 2e-10, 2e-10];

  // Debug
  public debugLog: DecoderDebugInfo[] = [];
  public logging = false;
  /** Bypass noise profiling — pre-fills noise floor so decoder is ready instantly */
  public fastSync = false;

  onFrame: ((data: Uint8Array) => void) | null = null;

  constructor(cfg: Partial<ModemConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.sps = this.cfg.sampleRate / this.cfg.symbolsPerSec;
    this.scanner = new PilotScanner({ sampleRate: this.cfg.sampleRate, sps: this.sps });
  }

  reset() {
    this.buf = [];
    this.scanner.reset();
    this.pll = null;
    this.pilotDiscovered = false;
    this.pilotFreq = 0;
    this.pilotAmplitude = 0;
    this.inFrame = false;
    this.consecutiveSync = 0;
    this.frameSkip = 0;
    this.bitCollector = [];
    this.bitsCollected = 0;
    this.noiseFloor = [3e-10, 3e-10, 3e-10, 3e-10];
    this.noiseMax = [3e-10, 3e-10, 3e-10, 3e-10];
    this.noiseFrames = this.fastSync ? 25 : 0;
    this.decodedBytes = [];
    this.framesSinceStrong = 0;
    this.lastStrongBits = 0;
    this.syncPeak = [2e-10, 2e-10, 2e-10, 2e-10];
    this.framesSinceExit = 0;
    this.dataFramesExecuted = 0;
    this.expectedTotalBytes = 0;
    this.pilotAmplitude = 0;
    this.debugLog = [];
  }

  /** Feed one audio sample */
  feedSample(sample: number) {
    this.buf.push(sample);
    if (this.buf.length < this.sps) return;

    // Grab one symbol window (128 samples)
    const window = this.buf.slice(0, this.sps);
    this.buf.splice(0, this.sps);

    // ── Pilot discovery (runs during leader / before data mode) ──
    if (!this.pilotDiscovered && !this.inFrame) {
      const result = this.scanner.feedSample(sample);
      if (result) {
        this.pilotDiscovered = true;
        this.pilotFreq = result.freq;
        this.pilotAmplitude = result.amplitude;
        this.toneFreqs = getDataToneFreqs(result.freq);
        this.pll = new PilotPLL(result.freq, 0, result.amplitude, {
          sampleRate: this.cfg.sampleRate,
        });
        if (this.logging) {
          console.log(`[PILOT] Discovered: ${result.freq.toFixed(1)} Hz @ amp ${result.amplitude.toExponential(2)} confidence=${result.confidence.toFixed(2)}`);
          console.log(`[PILOT] Tone freqs: ${this.toneFreqs.map(f => f.toFixed(1)).join(', ')}`);
        }
      }
    }

    // Feed every sample to the PLL (for continuous phase tracking)
    if (this.pll) {
      this.pll.update(sample);
      this.pilotAmplitude = this.pll.getAmplitude();
    }

    // ── Compute pilot-relative I/Q for all 4 data tones ──
    // Raw I/Q at each tone frequency
    const rawIQs = this.toneFreqs.map(f => toneIQ(window, f, this.cfg.sampleRate));

    // Rotate by pilot phase to get pilot-relative I'/Q'
    const relI: [number, number, number, number] = [0, 0, 0, 0];
    const relQ: [number, number, number, number] = [0, 0, 0, 0];
    const energies: [number, number, number, number] = [0, 0, 0, 0];

    if (this.pll) {
      for (let t = 0; t < 4; t++) {
        const rotated = this.pll.rotateToPilotRef(rawIQs[t].i, rawIQs[t].q);
        relI[t] = rotated.i;
        relQ[t] = rotated.q;
        energies[t] = Math.hypot(rotated.i, rotated.q);
      }
    } else {
      // Fallback: absolute energy (no pilot lock yet)
      for (let t = 0; t < 4; t++) {
        relI[t] = rawIQs[t].i;
        relQ[t] = rawIQs[t].q;
        energies[t] = Math.hypot(rawIQs[t].i, rawIQs[t].q);
      }
    }

    const total = energies.reduce((a, b) => a + b, 0);
    const avg = total / 4;
    const noiseAvg =
      (this.noiseFloor[0] + this.noiseFloor[1] + this.noiseFloor[2] + this.noiseFloor[3]) / 4;

    // ── Sync / burst detection ──
    const calibPeak = Math.max(...this.syncPeak);
    const burstThresh = Math.min(noiseAvg * 0.8, Math.max(calibPeak * 0.10, 2e-11));

    // With pilot-relative detection, use the amplitudeThresholdRatio from config
    // A tone is ON if its pilot-relative energy > pilotAmplitude * thresholdRatio
    const ampThresh = this.pilotAmplitude * this.cfg.amplitudeThresholdRatio;

    // Sync: all 4 tones should show strong pilot-relative energy
    const allFourStrong = this.pll
      ? (energies[0] > ampThresh * 0.5 &&
         energies[1] > ampThresh * 0.5 &&
         energies[2] > ampThresh * 0.5 &&
         energies[3] > ampThresh * 0.5)
      : (total > 1e-12 &&
         (energies[0] / total) > 0.08 &&
         (energies[1] / total) > 0.08 &&
         (energies[2] / total) > 0.08 &&
         (energies[3] / total) > 0.08);

    const isBurst = (avg > burstThresh) && allFourStrong;

    // ── Noise profiling ──
    if (!this.inFrame) {
      this.framesSinceExit++;
      if (this.noiseFrames < 25) {
        this.noiseFrames++;
        const alpha = 1 / this.noiseFrames;
        for (let t = 0; t < 4; t++) {
          this.noiseFloor[t] = this.noiseFloor[t] * (1 - alpha) + energies[t] * alpha;
          if (energies[t] > this.noiseMax[t]) {
            this.noiseMax[t] = energies[t];
          } else {
            this.noiseMax[t] *= 0.9999;
          }
        }
      }
    }

    // ── Sync tracking ──
    const strong = isBurst;

    if (strong && !this.inFrame && this.consecutiveSync >= 3) {
      for (let t = 0; t < 4; t++) {
        if (energies[t] > this.syncPeak[t]) this.syncPeak[t] = energies[t];
      }
    } else if (!strong && !this.inFrame) {
      const noiseRef = Math.max(...this.noiseMax) * 2;
      for (let t = 0; t < 4; t++) {
        this.syncPeak[t] = Math.max(this.syncPeak[t] * 0.95, noiseRef);
      }
    }

    if (strong) {
      this.consecutiveSync++;
    } else {
      this.consecutiveSync = 0;
      if (!this.inFrame) this.frameSkip = 0;
    }

    // ── Debug log ──
    if (this.logging) {
      const thresholds: [number, number, number, number] = [0, 0, 0, 0];
      let bitPat = 0;
      for (let t = 0; t < 4; t++) {
        thresholds[t] = this.noiseFloor[t] * 4;
        if (energies[t] > this.noiseFloor[t] * 4) bitPat |= (1 << (3 - t));
      }
      const endNoiseAvg = (this.noiseFloor[0] + this.noiseFloor[1] + this.noiseFloor[2] + this.noiseFloor[3]) / 4;
      const snr = endNoiseAvg > 1e-12 ? avg / endNoiseAvg : 999;
      const totalEDbg = energies[0] + energies[1] + energies[2] + energies[3];
      this.debugLog.push({
        peakAmp: Math.max(...window.map(Math.abs)),
        relI: [...relI],
        relQ: [...relQ],
        energies,
        avg,
        ratios: totalEDbg > 1e-12
          ? energies.map((e: number) => e / totalEDbg) as [number, number, number, number]
          : [0, 0, 0, 0],
        noiseAvg,
        strong,
        consecutiveSync: this.consecutiveSync,
        inFrame: this.inFrame,
        bitsCollected: this.bitsCollected,
        noiseFloor: [...this.noiseFloor],
        noiseMax: [...this.noiseMax],
        thresholds,
        noiseFrames: this.noiseFrames,
        bitPattern: bitPat,
        signalToNoise: snr,
        burstThreshold: burstThresh,
        framesSinceStrong: this.framesSinceStrong,
        framesSinceExit: this.framesSinceExit,
        frameSkip: this.frameSkip,
        pilotFreq: this.pilotFreq,
        pilotAmp: this.pilotAmplitude,
        pilotConfidence: this.pilotDiscovered ? 1 : 0,
      });
      if (this.debugLog.length > 200) this.debugLog.shift();
    }

    // ── Enter data mode ──
    const canEnter = this.fastSync
      ? (this.consecutiveSync >= 8 && this.noiseFrames >= 25)
      : (this.consecutiveSync >= 8 && this.noiseFrames >= 25 && (this.framesSinceExit >= 50 || this.consecutiveSync >= 10));
    if (canEnter && !this.inFrame) {
      this.inFrame = true;
      this.bitCollector = [];
      this.bitsCollected = 0;
      this.framesSinceStrong = 0;
      this.dataFramesExecuted = 0;
      this.totalBytesEmitted = 0;
      this.lastStrongBits = 0;
      this.framesSinceExit = 0;
      this.frameSkip = Math.max(0, this.cfg.syncSymbols - this.consecutiveSync) + 2;
      if (this.frameSkip % 2 !== 0) this.frameSkip++;
      if (this.logging) {
        console.log("[DEC] SYNC DETECTED — entering data mode", {
          pilotFreq: this.pilotFreq.toFixed(1),
          pilotAmp: this.pilotAmplitude.toExponential(2),
          toneFreqs: this.toneFreqs.map(f => f.toFixed(1)),
          noiseFrames: this.noiseFrames,
          consecutiveSync: this.consecutiveSync,
          frameSkip: this.frameSkip,
          energies: energies.map(e => e.toExponential(2)),
        });
      }
    }

    // ── Decode bits ──
    if (this.inFrame) {
      if (this.frameSkip > 0) {
        this.frameSkip--;
        return;
      }

      const endNoiseAvg = (this.noiseFloor[0] + this.noiseFloor[1] + this.noiseFloor[2] + this.noiseFloor[3]) / 4;
      const signalToNoise = avg / Math.max(endNoiseAvg, 1e-12);

      if (signalToNoise > 2.0) {
        this.framesSinceStrong = 0;
      } else {
        this.framesSinceStrong++;
      }

      this.dataFramesExecuted++;
      if (this.dataFramesExecuted > 150 || this.bitsCollected > 10240) {
        this.emitFrame();
        this.inFrame = false;
        return;
      }

      // ── Pilot-relative bit detection ──
      // For each tone: 2 bits = [amplitude, phase]
      // amplitude: 1 if pilot-relative energy > threshold
      // phase: 1 if relI > 0 (right half-plane), 0 if relI < 0 (left half-plane)
      const ampThresh = this.pilotAmplitude * this.cfg.amplitudeThresholdRatio;

      let frameBits = 0;
      for (let t = 0; t < 4; t++) {
        // Amplitude bit: tone ON if energy > ampThresh
        const ampBit = energies[t] > ampThresh ? 1 : 0;
        // Phase bit: sign of relI (BPSK). When tone is OFF, phase is undefined — default 0.
        const phaseBit = ampBit === 1 && relI[t] > 0 ? 1 : 0;

        this.bitCollector.push(ampBit);
        this.bitCollector.push(phaseBit);
        this.bitsCollected += 2;
        frameBits = (frameBits << 2) | (ampBit << 1) | phaseBit;
      }

      if (this.logging && this.bitsCollected <= 16) {
        console.log(`[DEC] first data frame: bits=${this.bitsCollected-8}-${this.bitsCollected-1} pat=${frameBits.toString(2).padStart(8,'0')} eng=${energies.map(e=>e.toExponential(2)).join(' ')} relI=${relI.map(v=>v.toFixed(4)).join(' ')}`);
      }

      if (signalToNoise > 1.3) this.lastStrongBits = this.bitsCollected;

      if (this.framesSinceStrong >= 8 && this.bitsCollected >= 8) {
        if (this.logging) console.log(`[DEC] end-of-signal after ${this.bitsCollected} bits (SNR=${signalToNoise.toFixed(1)})`);
        if (this.lastStrongBits > 0 && this.lastStrongBits < this.bitCollector.length) {
          this.bitCollector.length = this.lastStrongBits;
          this.bitsCollected = this.lastStrongBits;
        }
        this.emitFrame();
        this.inFrame = false;
        return;
      }
    }
  }

  /** Set expected total byte count for length-based exit (0 = unlimited) */
  setExpectedTotal(n: number) { this.expectedTotalBytes = n; }

  hasData(): boolean { return this.decodedBytes.length > 0; }

  flush(): Uint8Array {
    let result = new Uint8Array(0);
    if (this.inFrame && this.bitsCollected >= 8) {
      if (this.lastStrongBits > 0 && this.lastStrongBits < this.bitCollector.length) {
        this.bitCollector.length = this.lastStrongBits;
        this.bitsCollected = this.lastStrongBits;
      }
      result = this.emitFrame();
      this.inFrame = false;
    }
    const remaining = this.takeBytes();
    if (remaining.length > 0) {
      const combined = new Uint8Array(result.length + remaining.length);
      combined.set(result, 0);
      combined.set(remaining, result.length);
      return combined;
    }
    return result;
  }

  takeBytes(): Uint8Array {
    const bytes = new Uint8Array(this.decodedBytes);
    this.decodedBytes = [];
    return bytes;
  }

  getProgress(): number { return this.bitsCollected; }

  getNoiseFloor(): [number, number, number, number] { return [...this.noiseFloor]; }
  getNoiseMax(): [number, number, number, number] { return [...this.noiseMax]; }
  getPilotFreq(): number { return this.pilotFreq; }
  getPilotAmplitude(): number { return this.pilotAmplitude; }

  // ─── private ───────────────────────────────────────

  private emitFrame() {
    // Hamming(7,4) decode: group 8-bit pairs into codewords.
    // Current bit layout: [amp0 phase0 amp1 phase1 amp2 phase2 amp3 phase3] × N symbols
    // For Hamming(7,4), each 8-bit codeword = 1 nibble of data.
    // We collect 8 bits at a time (2 symbols × 4 tones).
    let codeword = 0;
    let cwBits = 0;
    let nibbleBuf = 0;
    let nibbleBits = 0;
    let consumed = 0;
    for (const b of this.bitCollector) {
      codeword = (codeword << 1) | (b & 1);
      cwBits++;
      consumed++;
      if (cwBits >= 8) {
        const nibble = hammingDecode(codeword);
        nibbleBuf = (nibbleBuf << 4) | (nibble & 0xf);
        nibbleBits += 4;
        if (nibbleBits >= 8) {
          this.decodedBytes.push((nibbleBuf >> 4) & 0xff);
          this.totalBytesEmitted++;
          if (this.expectedTotalBytes > 0 && this.totalBytesEmitted >= this.expectedTotalBytes) {
            this.inFrame = false;
            break;
          }
          nibbleBits -= 8;
          nibbleBuf &= 0xf;
        }
        codeword = 0;
        cwBits = 0;
      }
    }
    this.bitCollector.splice(0, consumed);
    this.bitsCollected = this.bitCollector.length;

    const data = new Uint8Array(this.decodedBytes);
    this.decodedBytes = [];
    if (this.onFrame) this.onFrame(data);
    return data;
  }
}
