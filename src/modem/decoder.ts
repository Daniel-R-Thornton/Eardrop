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
import { FramedBlockDecoder, BLOCK_TYPE, getSentinel } from "./framing";
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

  // ── Preamble phase tracking ──
  private preamblePhase: 'leader' | 'warble' | 'calibrate' | 'data' = 'leader';
  private dominantTones: number[] = [];
  private calibrateCount: number = 0;

  // ── Framed block decoder (replaces old bitCollector) ──
  public framedDecoder: FramedBlockDecoder;
  public blockProcessor: BlockProcessor;
  public squawkProcessor: SquawkProcessor;

  /** Buffer: 2 frame bytes → pack into 1 block byte for FramedBlockDecoder */
  private bchBuf: number[] = [];
  private bchBufCount = 0;

  /** Previous frame's phase sign per tone for DPSK decoding (0 or 1) */
  private prevPhase: number[] = [];
  /** BPSK phase flip per tone (1 = no flip, -1 = invert). Set by calibration. */
  private calPhaseFlip: [number, number, number, number] = [1, 1, 1, 1];
  /** Calibration: count of phase sign samples per tone */
  private calPhaseSum: [number, number, number, number] = [0, 0, 0, 0];
  private calPhaseCount: [number, number, number, number] = [0, 0, 0, 0];
  private calDone = false;

  /** Debug trace — per-frame BPSK analysis exported to UI */
  public debugTrace: Array<{ sym: number; rawI: number[]; bits: number[]; frameHex: string; blockEvent?: string }> = [];

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

    const s = getSentinel(this.cfg.toneCount);
    this.framedDecoder = new FramedBlockDecoder(s);
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
      const typeNames: Record<number, string> = { 1: 'SQWK', 2: 'CONF', 3: 'DICT', 4: 'PAYD', 255: 'EOF' };
      const evtStr = `${typeNames[event.type] || '?'} ${event.data.length}B`;
      // Push to trace
      if (this.debugTrace.length < 200) {
        const last = this.debugTrace[this.debugTrace.length - 1];
        if (last) last.blockEvent = evtStr;
        else this.debugTrace.push({ sym: 0, rawI: [0,0,0,0], bits: [0,0,0,0], frameHex: '00', blockEvent: evtStr });
      }
      if (event.type !== BLOCK_TYPE.SQUAWK) {
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
    this.preamblePhase = 'leader';
    this.dominantTones = [];
    this.calibrateCount = 0;
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
    this.calPhaseFlip = [1, 1, 1, 1];
    this.calPhaseSum = [0, 0, 0, 0];
    this.calPhaseCount = [0, 0, 0, 0];
    this.calDone = false;
    this.prevPhase = [];
    this.debugTrace = [];
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

    // ── Pilot discovery — use configured frequency, but wait for leader to pass ──
    // Leader is ~12 symbols of pilot-only. We need to be past it before sync can begin.
    // Require at least 12*128=1536 samples before declaring pilot discovered.
    if (!this.pilotDiscovered && !this.inFrame && this.noiseFrames >= 20 && this.samplesSeen > 12 * this.sps) {
      this.pilotDiscovered = true;
      this.pilotFreq = this.cfg.pilotFreqHz;
      this.pilotAmplitude = 0.05;
      const nominalTones = getDataToneFreqs(this.cfg.pilotFreqHz, !!this.cfg.musical);
      this.toneFreqs = nominalTones;
      this.pll = new PilotPLL(this.cfg.pilotFreqHz, 0, 0.05, {
        sampleRate: this.cfg.sampleRate,
      });
      debugLogger.info(STAGE.PILOT_SCAN, {
        freq: this.cfg.pilotFreqHz.toFixed(1),
        amp: 'config',
        confidence: 1,
        samples: 0,
      }, `Pilot set: ${this.cfg.pilotFreqHz} Hz (config)`);
      if (this.logging) {
        console.warn(`[PILOT] Using config freq: ${this.cfg.pilotFreqHz} Hz, tones: ${this.toneFreqs.map(f => f.toFixed(0)).join(',')} Hz`);
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

    // Use raw I/Q directly — the toneIQ reference sin starts at 0, encoder
    // advances one sample ahead (sin(ω*(n+1))), giving a constant ω phase offset
    // per tone. For 0° BPSK: raw.i = A/2*cos(ω) > 0. For 180°: raw.i < 0.
    // No rotation needed — just use raw I component for BPSK decision.
    const relI: [number, number, number, number] = [0, 0, 0, 0];
    const relQ: [number, number, number, number] = [0, 0, 0, 0];
    const energies: [number, number, number, number] = [0, 0, 0, 0];

    for (let t = 0; t < 4; t++) {
      relI[t] = rawIQs[t].i;
      relQ[t] = rawIQs[t].q;
      energies[t] = Math.hypot(rawIQs[t].i, rawIQs[t].q);
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

    // Sync: dynamic threshold based on noise floor or absolute minimum
    const noiseRef = (this.noiseFloor[0] + this.noiseFloor[1] + this.noiseFloor[2] + this.noiseFloor[3]) / 4;
    const minEnergy = Math.max(0.001, noiseRef * 5);
    const anyToneStrong = Math.max(...energies) > minEnergy;
    const totalAboveNoise = total > Math.max(0.001, noiseRef * 5);
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

    // ── Preamble phase detection (pattern-based, not frame-counting) ──
    // Uses absolute energy thresholds to work for both loopback and weak acoustic.
    if (this.pilotDiscovered && !this.inFrame) {
      const hasSignal = total > 0.0005 && Math.max(...energies) > 0.0003;
      const maxTone = hasSignal ? energies.indexOf(Math.max(...energies)) : -1;
      const strongToneCount = energies.filter(e => e > 0.0003).length;

      // Phase calibration during warble + calibrate
      if (!this.calDone && hasSignal && maxTone >= 0 && this.calPhaseCount[maxTone] < 3) {
        this.calPhaseSum[maxTone] += relI[maxTone] >= 0 ? 1 : -1;
        this.calPhaseCount[maxTone]++;
        const totalCounts = this.calPhaseCount.reduce((a,b)=>a+b,0);
        if (totalCounts >= 8) {
          let totalSum = 0;
          for (let t = 0; t < 4; t++) totalSum += this.calPhaseSum[t];
          const globalFlip = totalSum >= 0 ? 1 : -1;
          for (let t = 0; t < 4; t++) this.calPhaseFlip[t] = globalFlip;
          this.calDone = true;
          console.warn(`[CAL] BPSK reference signs: flip=[${this.calPhaseFlip.join(',')}] (global=${globalFlip})`);
        }
      }

      // Track dominant tone history
      if (maxTone >= 0) {
        this.dominantTones.push(maxTone);
        if (this.dominantTones.length > 20) this.dominantTones.shift();
      }

      // Detect preamble phase transitions
      if (this.preamblePhase === 'leader' && hasSignal) {
        this.preamblePhase = 'warble';
        console.warn(`[PREAMBLE] leader→warble at sym ${Math.floor(this.samplesSeen/this.sps)}`);
      }

      if (this.preamblePhase === 'warble' && this.dominantTones.length >= 4) {
        // Warble: tone changes every frame. Calibrate: same tone for 4 consecutive frames.
        // Check last 4 entries — all must be identical (calibrate: 4 frames per tone).
        const recent = this.dominantTones.slice(-4);
        const allSame = recent.length >= 4 && recent.every(t => t === recent[0]);
        if (allSame) {
          this.preamblePhase = 'calibrate';
          this.calibrateCount = 0;
          console.warn(`[PREAMBLE] warble→calibrate at sym ${Math.floor(this.samplesSeen/this.sps)}`);
        }
      }

      if (this.preamblePhase === 'calibrate') {
        this.calibrateCount++;
        // Calibrate is fixed 16 frames. Data starts on frame 17.
        if (this.calibrateCount > 16) {
          this.preamblePhase = 'data';
          this.inFrame = true;
          this.frameSkip = 0;
          this.framesSinceStrong = 0;
          this.dataFramesExecuted = 0;
          this.lastStrongBitsCollected = 0;
          this.framesSinceExit = 0;
          this.framedDecoder.reset();
          this.blockProcessor.reset();
          console.warn(`[PREAMBLE] calibrate→DATA at sym ${Math.floor(this.samplesSeen/this.sps)}`);
        }
      }
    }

    // Legacy debug log (keep for compatibility)
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
        relI: [...relI], relQ: [...relQ], energies, avg,
        ratios: totalEDbg > 1e-12 ? energies.map((e: number) => e / totalEDbg) as [number,number,number,number] : [0,0,0,0],
        noiseAvg,
        strong: isBurst,
        consecutiveSync: this.consecutiveSync,
        inFrame: this.inFrame,
        bitsCollected: totalBits,
        noiseFloor: [...this.noiseFloor], noiseMax: [...this.noiseMax], thresholds,
        noiseFrames: this.noiseFrames, bitPattern: bitPat, signalToNoise: snr,
        burstThreshold: burstThresh,
        framesSinceStrong: this.framesSinceStrong,
        framesSinceExit: this.framesSinceExit,
        frameSkip: this.frameSkip,
        pilotFreq: this.pilotFreq, pilotAmp: this.pilotAmplitude,
        pilotConfidence: this.pilotDiscovered ? 1 : 0,
        rawEnergies: [0,0,0,0],
      });
      if (this.debugLog.length > 200) this.debugLog.shift();
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

      // ── BPSK bit detection: all tones always ON, data in 0°/180° phase ──
      // calPhaseFlip corrects for absolute phase ambiguity learned during calibration.
      // Frame byte: [p0, 1, p1, 1, p2, 1, p3, 1] where p_t = BPSK phase bit

      let frameBits = 0;
      const dbgBits: number[] = [];
      for (let t = 0; t < 4; t++) {
        const correctedI = this.calPhaseFlip[t] < 0 ? -relI[t] : relI[t];
        const bit = t < this.cfg.toneCount ? (correctedI < 0 ? 1 : 0) : 0;
        dbgBits.push(bit);
        frameBits |= (bit) << (7 - t * 2);
        frameBits |= (1) << (6 - t * 2);
      }
      // Console-log first 16 data frames for devtools debugging
      if (this.dataFramesExecuted <= 16) {
        console.warn(`[BPSK] frm=${this.dataFramesExecuted} sym=${Math.floor(this.samplesSeen/this.sps)} bits=${dbgBits.join('')} hex=0x${frameBits.toString(16).padStart(2,'0')} I=[${relI.map(v=>v.toFixed(3)).join(',')}] flip=[${this.calPhaseFlip.join(',')}]`);
      }

      // Calibrate phase (16 symbols) ensures bchBuf starts aligned with data.
      // No need for runtime reset.

      // Pack frame bytes into block bytes.
      // 4-tone: 2 frames × 4 bits → 1 byte.  2-tone: 4 frames × 2 bits → 1 byte.
      this.bchBuf.push(frameBits);
      this.bchBufCount++;
      const tc = this.cfg.toneCount;
      const framesPerByte = 8 / tc;
      if (this.bchBufCount >= framesPerByte) {
        let blockByte = 0;
        if (tc === 2) {
          for (let f = 0; f < 4; f++) {
            const fb = this.bchBuf[f];
            blockByte |= ((fb >> 7) & 1) << (7 - f * 2);
            blockByte |= ((fb >> 5) & 1) << (6 - f * 2);
          }
        } else {
          const hi = ((this.bchBuf[0] >> 7) & 1) << 3 | ((this.bchBuf[0] >> 5) & 1) << 2 |
                     ((this.bchBuf[0] >> 3) & 1) << 1 | ((this.bchBuf[0] >> 1) & 1);
          const lo = ((this.bchBuf[1] >> 7) & 1) << 3 | ((this.bchBuf[1] >> 5) & 1) << 2 |
                     ((this.bchBuf[1] >> 3) & 1) << 1 | ((this.bchBuf[1] >> 1) & 1);
          blockByte = (hi << 4) | lo;
        }
        // One-shot debug: log first 8 bytes decoded in data mode
        if (this.framedDecoder.totalBits <= 64) {
          console.warn(`[DEC_BYTE] byte=0x${blockByte.toString(16).padStart(2,'0')} bits=${this.framedDecoder.totalBits} energies=${energies.map(e=>e.toExponential(2)).join(',')}`);
        }
        this.framedDecoder.feedBytes(new Uint8Array([blockByte]));
        this.bchBuf = [];
        this.bchBufCount = 0;

        // Push debug trace (keep last 200 entries)
        if (this.debugTrace.length < 200) {
          this.debugTrace.push({
            sym: Math.floor(this.samplesSeen / this.sps),
            rawI: [relI[0], relI[1], relI[2], relI[3]],
            bits: [
              (frameBits >> 7) & 1, (frameBits >> 5) & 1,
              (frameBits >> 3) & 1, (frameBits >> 1) & 1,
            ],
            frameHex: frameBits.toString(16).padStart(2, '0'),
          });
        }
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
