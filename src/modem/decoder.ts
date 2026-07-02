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

import { ModemConfig, DEFAULT_CONFIG } from "./types";
import { PilotScanner, PilotPLL, toneIQ, getDataToneFreqs } from "./pilot";
import { FramedBlockDecoder, BLOCK_TYPE } from "./framing";
import { BlockProcessor } from "./blockProcessor";
import { SquawkProcessor } from "./squawk";
import { bch3116Decode } from "./ecc";
import { debugLogger, STAGE, LOG_LEVEL } from "./debugger";
import { TimingProfiler, BerTracker, ConstellationSampler, buildSnapshot } from "./diag";

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

  // ── Framed block decoder (replaces old bitCollector) ──
  public framedDecoder: FramedBlockDecoder;
  public blockProcessor: BlockProcessor;
  public squawkProcessor: SquawkProcessor;

  // BCH decode buffer: accumulate 4 demodulated bytes → BCH decode → 2 bytes → framedDecoder
  private bchBuf: number[] = [];
  private bchBufCount = 0;

  // Noise profiling
  private noiseFloor: [number, number, number, number] = [0, 0, 0, 0];
  private noiseMax: [number, number, number, number] = [0, 0, 0, 0];
  private noiseFrames = 0;

  // End detection
  private framesSinceStrong = 0;
  private lastStrongBitsCollected = 0;
  private framesSinceExit = 0;
  private dataFramesExecuted = 0;
  private syncPeak: [number, number, number, number] = [2e-10, 2e-10, 2e-10, 2e-10];

  // Debug
  public debugLog: DecoderDebugInfo[] = [];
  public logging = false;
  /** Bypass noise profiling — pre-fills noise floor so decoder is ready instantly */
  public fastSync = false;

  // ── Diagnostics (Phase C) ──
  public timing = new TimingProfiler();
  public berTracker = new BerTracker();
  public constellation = new ConstellationSampler();

  /** Last frame's tone I/Q values (for squawk processing) */
  public lastFrameIQ: Array<{ i: number; q: number }> = [];

  /** Callback for complete file reception (from BlockProcessor) */
  onFrame: ((data: Uint8Array) => void) | null = null;

  constructor(cfg: Partial<ModemConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.sps = this.cfg.sampleRate / this.cfg.symbolsPerSec;
    this.scanner = new PilotScanner({ sampleRate: this.cfg.sampleRate });

    this.framedDecoder = new FramedBlockDecoder();
    this.squawkProcessor = new SquawkProcessor();
    this.blockProcessor = new BlockProcessor({
      onFileComplete: (file) => {
        if (this.logging) {
          console.log(`[BLK] File complete: "${file.name}" ${file.data.length}B`);
        }
        if (this.onFrame) {
          this.onFrame(file.data);
        }
      },
      onPayloadProgress: (soFar, total) => {
        // Progress is tracked via blockProcessor stats
      },
      onSquawk: (squawkId, refI, refQ) => {
        // Handled by framedDecoder.onBlock path below
      },
    });

    this.framedDecoder.onBlock = (event) => {
      if (event.type === BLOCK_TYPE.SQUAWK) {
        // Capture current I/Q measurements for squawk processing
        const measuredIQ = this.lastFrameIQ.map(iq => ({ i: iq.i, q: iq.q }));
        const correction = this.squawkProcessor.processSquawk(event.data, measuredIQ);
        if (correction && this.logging) {
          console.log(`[SQWK] #${correction.squawkId}: drift=${correction.phaseCorrectionDeg.toFixed(1)}deg amp=${correction.ampCorrection.toFixed(3)}`);
        }
      } else {
        const summary = this.blockProcessor.processBlock(event.type, event.data);
        if (this.logging && this.blockProcessor.stats.blocksReceived <= 5) {
          console.log(`[BLK] ${summary}`);
        }
      }
    };
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
    this.noiseFloor = [3e-10, 3e-10, 3e-10, 3e-10];
    this.noiseMax = [3e-10, 3e-10, 3e-10, 3e-10];
    this.noiseFrames = this.fastSync ? 25 : 0;
    this.framesSinceStrong = 0;
    this.lastStrongBitsCollected = 0;
    this.syncPeak = [2e-10, 2e-10, 2e-10, 2e-10];
    this.framesSinceExit = 0;
    this.dataFramesExecuted = 0;
    this.pilotAmplitude = 0;
    this.debugLog = [];
    this.framedDecoder.reset();
    this.blockProcessor.reset();
    this.squawkProcessor.reset();
    this.lastFrameIQ = [];
    this.bchBuf = [];
    this.bchBufCount = 0;
    this.timing.reset();
    this.berTracker.reset();
    this.constellation.reset();
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
        debugLogger.info(STAGE.PILOT_SCAN, {
          freq: result.freq.toFixed(1),
          amp: result.amplitude,
          confidence: result.confidence,
          samples: this.scanner['buf']?.length || 0,
        }, `Pilot discovered: ${result.freq.toFixed(1)} Hz @ amp ${result.amplitude.toExponential(2)}`);
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

    // Store raw I/Q for squawk processing
    this.lastFrameIQ = [];
    for (let t = 0; t < 4; t++) {
      this.lastFrameIQ.push({ i: relI[t], q: relQ[t] });
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
    if (this.logging || debugLogger.getTotalEvents() % 10 === 0) {
      // Log sync state at INFO level every ~10 frames
      if (this.inFrame || strong) {
        debugLogger.info(STAGE.SYNC_DETECT, {
          consecutive: this.consecutiveSync,
          in_frame: this.inFrame,
          strong,
          avg: avg.toExponential(2),
          burst_thr: burstThresh.toExponential(2),
          peak_ratio: energies.map(e => (total > 1e-12 ? (e / total) : 0).toFixed(3)).join('/'),
          noise_frames: this.noiseFrames,
          pilot_freq: this.pilotFreq.toFixed(1),
        }, `SYNC ${strong ? 'STRONG' : 'weak'} consecutive=${this.consecutiveSync} avg=${avg.toExponential(2)}`);
      }
    }
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
      const totalBits = this.framedDecoder.totalBits;
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
        bitsCollected: totalBits,
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
      this.framesSinceStrong = 0;
      this.dataFramesExecuted = 0;
      this.lastStrongBitsCollected = 0;
      this.framesSinceExit = 0;
      this.framedDecoder.reset();
      this.blockProcessor.reset();
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
      if (this.dataFramesExecuted > 150 || this.framedDecoder.totalBits > 10240) {
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
        const ampBit = energies[t] > ampThresh ? 1 : 0;
        const phaseBit = ampBit === 1 && relI[t] > 0 ? 1 : 0;
        frameBits = (frameBits << 2) | (ampBit << 1) | phaseBit;
      }

      // Feed the 8-bit frame pattern through BCH decode buffer,
      // then to the framed block decoder
      this.bchBuf.push(frameBits);
      this.bchBufCount++;
      this.lastStrongBitsCollected = this.framedDecoder.totalBits;

      // Every 4 symbols (32 bits = 4 BCH-encoded bytes), BCH decode to 2 bytes
      if (this.bchBufCount >= 4) {
        // Pack 4 demodulated bytes into BCH decode input
        const bchInput = new Uint8Array(4);
        for (let j = 0; j < 4; j++) bchInput[j] = this.bchBuf[j];
        const decoded = bch3116Decode(bchInput);
        this.bchBuf = [];
        this.bchBufCount = 0;
        this.framedDecoder.feedBytes(decoded.data);
      }

      if (this.logging && this.framedDecoder.totalBits <= 16) {
        console.log(`[DEC] first data frames: totalBits=${this.framedDecoder.totalBits} pat=${frameBits.toString(2).padStart(8,'0')} eng=${energies.map(e=>e.toExponential(2)).join(' ')} relI=${relI.map(v=>v.toFixed(4)).join(' ')}`);
      }

      if (signalToNoise > 1.3) this.lastStrongBitsCollected = this.framedDecoder.totalBits;

      if (this.framesSinceStrong >= 8 && this.framedDecoder.totalBits >= 16) {
        if (this.logging) console.log(`[DEC] end-of-signal after ${this.framedDecoder.totalBits} bits (SNR=${signalToNoise.toFixed(1)})`);
        this.inFrame = false;
        return;
      }
    }
  }

  /** Set expected total byte count for length-based exit (0 = unlimited) */
  setExpectedTotal(n: number) {
    // Handled by BlockProcessor's Config block parsing
  }

  hasData(): boolean {
    return this.blockProcessor.getProgress() !== null;
  }

  flush(): Uint8Array {
    // With framing, data is emitted via onFileComplete callback.
    // flush() is a no-op for the framing path.
    return new Uint8Array(0);
  }

  takeBytes(): Uint8Array {
    return new Uint8Array(0);
  }

  getProgress(): number {
    const prog = this.blockProcessor.getProgress();
    if (prog) return prog.bytesSoFar;
    return this.framedDecoder.totalBits;
  }

  getNoiseFloor(): [number, number, number, number] { return [...this.noiseFloor]; }
  getNoiseMax(): [number, number, number, number] { return [...this.noiseMax]; }
  getPilotFreq(): number { return this.pilotFreq; }
  getPilotAmplitude(): number { return this.pilotAmplitude; }

  // ─── private ───────────────────────────────────────

}
