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
import { FramedBlockDecoder, BLOCK_TYPE } from "./framing";
import { BlockProcessor } from "./blockProcessor";
import { SquawkProcessor } from "./squawk";
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
  /** Raw (pre-rotation) I/Q energies per tone */
  rawEnergies: [number, number, number, number];
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
  /** Frame counter for phase tracking: each frame adds PI to pilot-relative phase (offset * 128/3200 = 0.5 cycles = PI for all tones) */
  private dataFrameCount = 0;
  private samplesSeen = 0;

  // State
  private inFrame = false;
  private consecutiveSync = 0;
  private frameSkip = 0;

  // ── Framed block decoder (replaces old bitCollector) ──
  public framedDecoder: FramedBlockDecoder;
  public blockProcessor: BlockProcessor;
  public squawkProcessor: SquawkProcessor;

  /** Buffer: 2 frame bytes → pack into 1 block byte for FramedBlockDecoder */
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

  /** Live-adjustable thresholds (set via UI sliders) */
  public liveAmpThresholdRatio = 0.04;
  public liveSyncStrongMultiplier = 0.3;

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
    this.liveAmpThresholdRatio = this.cfg.amplitudeThresholdRatio;
    this.scanner = new PilotScanner({
      sampleRate: this.cfg.sampleRate,
      targetFreq: this.cfg.pilotFreqHz,
      freqTolerance: 30,
    });

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
      if (event.type !== BLOCK_TYPE.SQUAWK) {
        const summary = this.blockProcessor.processBlock(event.type, event.data);
        if (this.logging && this.blockProcessor.stats.blocksReceived <= 5) {
          console.log(`[BLK] ${summary}`);
        }
      }
      // Squawk processing captured at wrong time (after block decode, not during symbol)
      // Skipping — squawk-based recalibration will be fixed in a follow-up
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
    this.dataFrameCount = 0;
    this.samplesSeen = 0;
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
    // Learn noise spectrum on samples 1024-2048 (skip initial silence, let mic warm up)
    if (!this.scanner.hasNoiseProfile() && this.samplesSeen >= 1024) {
      this.scanner.learnNoise(sample, 1024);
    }
    this.samplesSeen++;
    this.scanner.feedSampleRT(sample);
    this.buf.push(sample);
    if (this.buf.length < this.sps) return;

    // Grab one symbol window (128 samples)
    const window = this.buf.slice(0, this.sps);
    this.buf.splice(0, this.sps);

    // ── Pilot discovery (runs during leader / before data mode) ──
    if (!this.pilotDiscovered && !this.inFrame) {
      // Feed ALL 128 samples in this window to the scanner, not just one
      let result: import("./pilot").PilotDiscovery | null = null;
      for (const s of window) {
        result = this.scanner.feedSample(s);
        if (result) break;
      }
      if (result) {
        this.pilotDiscovered = true;
        this.pilotFreq = result.freq;
        this.pilotAmplitude = result.amplitude;
        // The found peak IS the pilot. Tones are at pilot + TONE_OFFSETS.
        // IMPORTANT: sample-rate mismatch scales ALL frequencies by the same factor.
        // We must apply the correction factor (discovered/nominal) to the NOMINAL tone
        // frequencies, not just add raw offsets to the (already-shifted) pilot.
        const correction = result.freq / this.cfg.pilotFreqHz;
        const nominalTones = getDataToneFreqs(this.cfg.pilotFreqHz, !!this.cfg.musical);
        this.toneFreqs = nominalTones.map(f => f * correction) as [number, number, number, number];
        this.pll = new PilotPLL(result.freq, 0, result.amplitude, {
          sampleRate: this.cfg.sampleRate,
        });
        debugLogger.info(STAGE.PILOT_SCAN, {
          freq: result.freq.toFixed(1),
          amp: result.amplitude,
          confidence: result.confidence,
          samples: this.scanner.isDone() ? 1024 : 0,
        }, `Pilot discovered: ${result.freq.toFixed(1)} Hz @ amp ${result.amplitude.toExponential(2)}`);
        if (this.logging) {
          console.warn(`[PILOT] Discovered: ${result.freq.toFixed(1)} Hz @ amp ${result.amplitude.toExponential(2)} confidence=${result.confidence.toFixed(2)} correction=${correction.toFixed(4)}`);
          console.warn(`[PILOT] Old tone freqs (no correction): ${getDataToneFreqs(result.freq, !!this.cfg.musical).map(f => f.toFixed(1)).join(', ')}`);
          console.warn(`[PILOT] New tone freqs (with correction): ${this.toneFreqs.map(f => f.toFixed(1)).join(', ')}`);
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

    // Pilot-relative phase detection.
    // The encoder increments phase by freq/rate before the first sample of
    // each frame, creating a one-sample offset. Combined with the toneIQ
    // correlation midpoint (sps/2), the rotation angle for tone t is:
    //   θ_rot[t] = 2π * f_t * (sps/2 + 1) / sampleRate
    // This is CONSTANT per tone because f_t * sps / rate is an integer.
    // No per-frame parity correction is needed — the rotation is frame-invariant.
    if (this.pll) {
      for (let t = 0; t < 4; t++) {
        const raw = rawIQs[t];
        // Constant rotation for this tone (mod 2π to avoid float precision loss)
        const cycles = this.toneFreqs[t] * (this.sps / 2 + 1) / this.cfg.sampleRate;
        const theta = 2 * Math.PI * (cycles - Math.floor(cycles));
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        relI[t] = raw.i * cos + raw.q * sin;
        relQ[t] = -raw.i * sin + raw.q * cos;
        // DEBUG: also store raw (pre-rotation) energy
        energies[t] = Math.hypot(raw.i, raw.q);
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
    const ampThresh = this.pilotAmplitude * this.liveAmpThresholdRatio;

    // Sync: at least 1 strong tone + total energy above noise
    // (4-tone mod not feasible — speaker roll-off kills tones above 1 kHz)
    const anyToneStrong = this.pll
      ? Math.max(...energies) > ampThresh * this.liveSyncStrongMultiplier
      : total > 1e-12 && Math.max(...energies) / total > 0.08;
    const totalAboveNoise = total > 0.005;
    const isBurst = (avg > burstThresh) && anyToneStrong && totalAboveNoise;

    // ── Post-pilot trace logging ──
    if (this.pilotDiscovered && !this.inFrame) {
      console.warn(`[DEC_TRACE] pilotAmp=${this.pilotAmplitude.toExponential(2)} thresh=${ampThresh.toExponential(2)} avg=${avg.toExponential(2)} e=[${energies.map(e=>e.toExponential(2)).join(',')}] any=${anyToneStrong} totAbove=${totalAboveNoise} cons=${this.consecutiveSync} nf=${this.noiseFrames} fse=${this.framesSinceExit} pilotFreq=${this.pilotFreq.toFixed(1)}`);
    }

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
        }, `SYNC ${strong ? 'STRONG' : 'weak'} consecutive=${this.consecutiveSync} avg=${avg.toExponential(2)} nf=${this.noiseFrames} fse=${this.framesSinceExit}`);
      }
    }
    if (this.logging) {
      const thresholds: [number, number, number, number] = [0, 0, 0, 0];
      let bitPat = 0;
      for (let t = 0; t < 4; t++) {
        thresholds[t] = this.noiseFloor[t] * 4;
        const ampBit = energies[t] > ampThresh ? 1 : 0;
        const phaseBit = (ampBit === 1 && relI[t] < 0) ? 1 : 0;
        bitPat |= ((ampBit << 1) | phaseBit) << (6 - t * 2);
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
        rawEnergies: [0, 0, 0, 0],
      });
      if (this.debugLog.length > 200) this.debugLog.shift();
    }

    // ── Enter data mode ──
    // Two paths: sync-based (anyToneStrong + totalAboveNoise) or pilot-based (strong pilot + energy present)
    const syncPath = this.consecutiveSync >= 8 && this.noiseFrames >= 25;
    const pilotPath = this.pilotDiscovered && this.noiseFrames >= 25 &&
      this.pilotAmplitude > 0.02 && total > 0.01;
    // Debug: log enter-data-mode conditions every 50 frames
    if ((this.samplesSeen / this.sps | 0) % 50 === 0 && !this.inFrame) {
      console.warn(`[CAN_ENTER] cons=${this.consecutiveSync} nf=${this.noiseFrames} fse=${this.framesSinceExit} pilot=${this.pilotDiscovered} pilotAmp=${this.pilotAmplitude.toExponential(2)} total=${total.toExponential(2)} noiseFloorSum=${this.noiseFloor.reduce((a,b)=>a+b,0).toExponential(2)}`);
    }
    const canEnter = this.fastSync
      ? (this.consecutiveSync >= 8 && this.noiseFrames >= 25)
      : (syncPath && (this.framesSinceExit >= 50 || this.consecutiveSync >= 10)) || pilotPath;
    if (canEnter && !this.inFrame) {
      this.inFrame = true;
      this.framesSinceStrong = 0;
      this.dataFramesExecuted = 0;
      this.lastStrongBitsCollected = 0;
      this.framesSinceExit = 0;
      this.framedDecoder.reset();
      this.blockProcessor.reset();
      // Skip remaining sync frames (includes the entry frame itself)
      this.frameSkip = Math.max(0, this.cfg.syncSymbols - this.consecutiveSync) + 1;
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
        console.warn(`[DEC_TRACE] frameSkip=${this.frameSkip}`);
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
      if (this.dataFramesExecuted > 2000 || this.framedDecoder.totalBits > 65536) {
        this.inFrame = false;
        return;
      }

      // ── BPSK bit detection (4 amp + 4 phase = 8 bits/frame) ──
      // Packed: [amp0, phase0, amp1, phase1, amp2, phase2, amp3, phase3]
      // Amplitude: energy > pilotAmp * thresholdRatio → 1, else 0
      // Phase: relI > 0 → 0 (right half-plane), relI < 0 → 1 (left half-plane)
      const ampThresh = this.pilotAmplitude * this.liveAmpThresholdRatio;

      let frameBits = 0;
      // Pack: [a0,0,a1,0,a2,0,a3,0] — phase bits always 0 (encoder sends 0° BPSK)
      for (let t = 0; t < 4; t++) {
        const ampBit = energies[t] > ampThresh ? 1 : 0;
        // Phase bit is always 0 (encoder uses 0° BPSK for reliability)
        frameBits |= (ampBit << 1) << (6 - t * 2);
      }

      // Pack 2 frame nybbles into 1 block byte before feeding to FramedBlockDecoder
      // Each frame byte = [a0,0,a1,0,a2,0,a3,0]. Extract hi nibble from each.
      this.bchBuf.push(frameBits);
      this.bchBufCount++;
      if (this.bchBufCount >= 2) {
        // Extract amp bits (positions 7,5,3,1) from each frame byte
        const hi = ((this.bchBuf[0] >> 7) & 1) << 3 | ((this.bchBuf[0] >> 5) & 1) << 2 |
                   ((this.bchBuf[0] >> 3) & 1) << 1 | ((this.bchBuf[0] >> 1) & 1);
        const lo = ((this.bchBuf[1] >> 7) & 1) << 3 | ((this.bchBuf[1] >> 5) & 1) << 2 |
                   ((this.bchBuf[1] >> 3) & 1) << 1 | ((this.bchBuf[1] >> 1) & 1);
        const blockByte = (hi << 4) | lo;
        this.framedDecoder.feedBytes(new Uint8Array([blockByte]));
        this.bchBuf = [];
        this.bchBufCount = 0;
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
