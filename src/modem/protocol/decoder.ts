/**
 * Decoder — Pilot-Relative Multi-Tone Modem
 *
 * All tone measurements are pilot-relative:
 *   - Raw I/Q at each data tone frequency (via toneIQ)
 *   - Energy per tone: |I + jQ|
 *   - Phase bit: sign(I)  (BPSK: right half-plane = 1, left = 0)
 *
 * Refactored: PilotTracker, NoiseProfiler, and PreambleDetector handle
 * pilot discovery, noise floor estimation, and preamble phase detection.
 */

import { type ModemConfig, DEFAULT_CONFIG } from '../types';
import { toneIQ } from '../pilot';
import { PilotTracker } from '../pilot/PilotTracker';
import { FramedBlockDecoder, BLOCK_TYPE, getSentinel } from '../protocol/framing';
import { BlockProcessor } from '../protocol/blockProcessor';
import { SquawkProcessor } from '../protocol/squawk';
import { NoiseProfiler } from '../receiver/NoiseProfiler';
import { PreambleDetector } from '../receiver/PreambleDetector';
import { debugLogger, STAGE } from '../debug/debugger';
import { TimingProfiler, BerTracker, ConstellationSampler } from '../debug/diag';
import { bch3116Decode } from '../ecc/ecc';

export interface DecoderDebugInfo {
  peakAmp: number;
  relI: [number, number, number, number];
  relQ: [number, number, number, number];
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
  bitPattern: number;
  rawEnergies: [number, number, number, number];
  signalToNoise: number;
  burstThreshold: number;
  framesSinceStrong: number;
  framesSinceExit: number;
  frameSkip: number;
  pilotFreq: number;
  pilotAmp: number;
  pilotConfidence: number;
}

export class Decoder {
  private cfg: ModemConfig;
  private sps = 128;

  // Buffer for symbol windows
  private buf: number[] = [];

  // Pilot discovery + phase tracking (replaces inline PilotScanner/PilotPLL)
  private pilotTracker: PilotTracker;

  // Dynamic noise floor estimation (replaces inline noise profiling)
  private noiseProfiler: NoiseProfiler;

  // Preamble phase detection: leader→sync→calibrate→data (replaces inline state machine)
  private preambleDetector: PreambleDetector;

  /** Absolute tone frequencies (computed from discovered pilot) */
  private toneFreqs: [number, number, number, number] = [500, 700, 900, 1100];

  // State
  private inFrame = false;
  private consecutiveSync = 0;
  private frameSkip = 0;

  // ── Framed block decoder ──
  public framedDecoder: FramedBlockDecoder;
  public blockProcessor: BlockProcessor;
  public squawkProcessor: SquawkProcessor;

  /** Buffer: 2 frame bytes → pack into 1 block byte for FramedBlockDecoder */
  private bchBuf: number[] = [];
  private bchBufCount = 0;

  /** Coherent integration accumulators (unused currently, kept for future) */
  private accI: [number, number, number, number] = [0, 0, 0, 0];
  private accQ: [number, number, number, number] = [0, 0, 0, 0];
  private accCount = 0;
  private bitConfidence: number[] = [];

  /** Debug trace — per-frame BPSK analysis exported to UI */
  public debugTrace: Array<{
    sym: number;
    rawI: number[];
    bits: number[];
    frameHex: string;
    blockEvent?: string;
  }> = [];

  // End detection
  private framesSinceStrong = 0;
  private lastStrongBitsCollected = 0;
  private framesSinceExit = 0;
  private dataFramesExecuted = 0;
  private syncPeak: [number, number, number, number] = [2e-10, 2e-10, 2e-10, 2e-10];

  // Debug
  public debugLog: DecoderDebugInfo[] = [];
  public logging = false;
  public fastSync = false;

  /** Live-adjustable thresholds (set via UI sliders) */
  public liveAmpThresholdRatio = 0.04;
  public liveSyncStrongMultiplier = 0.3;

  // ── Diagnostics ──
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

    // Initialize extracted components
    this.pilotTracker = new PilotTracker({
      sampleRate: this.cfg.sampleRate,
      pilotFreqHz: this.cfg.pilotFreqHz,
      musical: !!this.cfg.musical,
      fastSync: this.fastSync,
    });
    this.noiseProfiler = new NoiseProfiler();
    this.preambleDetector = new PreambleDetector();

    // Framed block decoder
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
      onPayloadProgress: (_soFar, _total) => {
        // Progress is tracked via blockProcessor stats
      },
      onSquawk: (_squawkId, _refI, _refQ) => {
        // Handled by framedDecoder.onBlock path below
      },
    });

    this.framedDecoder.onBlock = (event) => {
      const typeNames: Record<number, string> = {
        1: 'SQWK',
        2: 'CONF',
        3: 'DICT',
        4: 'PAYD',
        255: 'EOF',
      };
      const evtStr = `${typeNames[event.type] || '?'} ${event.data.length}B`;
      if (this.debugTrace.length < 200) {
        const last = this.debugTrace[this.debugTrace.length - 1];
        if (last) last.blockEvent = evtStr;
        else
          this.debugTrace.push({
            sym: 0,
            rawI: [0, 0, 0, 0],
            bits: [0, 0, 0, 0],
            frameHex: '00',
            blockEvent: evtStr,
          });
      }

      let processData = event.data;
      if (
        (event.type === BLOCK_TYPE.CONFIG || event.type === BLOCK_TYPE.PAYLOAD) &&
        event.data.length >= 4
      ) {
        const eccResult = bch3116Decode(event.data);
        const decodedLen = Math.floor(event.data.length / 4) * 2;
        processData = eccResult.data.slice(0, decodedLen);
        if (eccResult.errors > 0) {
          const last = this.debugTrace[this.debugTrace.length - 1];
          if (last) {
            last.blockEvent = `${evtStr} ECC:${eccResult.errors}err`;
          }
        }
      }

      if (event.type !== BLOCK_TYPE.SQUAWK) {
        const summary = this.blockProcessor.processBlock(event.type, processData);
        if (this.logging && this.blockProcessor.stats.blocksReceived <= 5) {
          console.log(`[BLK] ${summary}`);
        }
      }
    };
  }

  reset() {
    this.buf = [];
    this.pilotTracker.reset();
    this.noiseProfiler.reset();
    this.preambleDetector.reset();

    this.inFrame = false;
    this.consecutiveSync = 0;
    this.frameSkip = 0;
    this.toneFreqs = [500, 700, 900, 1100];
    this.framesSinceStrong = 0;
    this.lastStrongBitsCollected = 0;
    this.syncPeak = [2e-10, 2e-10, 2e-10, 2e-10];
    this.framesSinceExit = 0;
    this.dataFramesExecuted = 0;
    this.debugLog = [];
    this.framedDecoder.reset();
    this.blockProcessor.reset();
    this.squawkProcessor.reset();
    this.lastFrameIQ = [];
    this.bchBuf = [];
    this.bchBufCount = 0;
    this.accI = [0, 0, 0, 0];
    this.accQ = [0, 0, 0, 0];
    this.accCount = 0;
    this.bitConfidence = [];
    this.debugTrace = [];
    this.timing.reset();
    this.berTracker.reset();
    this.constellation.reset();
  }

  /** Feed one audio sample */
  feedSample(sample: number) {
    // Delegate noise learning and sample tracking to PilotTracker
    this.pilotTracker.feedSample(sample);

    this.buf.push(sample);
    if (this.buf.length < this.sps) return;

    // Grab one symbol window (128 samples)
    const window = this.buf.slice(0, this.sps);
    this.buf.splice(0, this.sps);

    // ── Pilot discovery ──
    // Wait for sufficient samples (>12 symbol periods) + noise profiling before discovery
    if (!this.pilotTracker.discovered && !this.inFrame) {
      const samplesPastLeader =
        this.pilotTracker['samplesSeen'] !== undefined
          ? true // approximate — PilotTracker handles timing internally
          : true;
      if (samplesPastLeader) {
        const justDiscovered = this.pilotTracker.tryDiscover(
          this.noiseProfiler.frames,
          this.noiseProfiler.stable,
        );
        if (justDiscovered) {
          this.toneFreqs = this.pilotTracker.toneFreqs;
          debugLogger.info(
            STAGE.PILOT_SCAN,
            {
              freq: this.pilotTracker.pilotFreq.toFixed(1),
              amp: 'config',
              confidence: 1,
              samples: 0,
            },
            `Pilot set: ${this.pilotTracker.pilotFreq} Hz (config)`,
          );
          if (this.logging) {
            console.warn(
              `[PILOT] Using config freq: ${this.pilotTracker.pilotFreq} Hz, ` +
                `tones: ${this.toneFreqs.map((f) => f.toFixed(0)).join(',')} Hz`,
            );
          }
        }
      }
    }

    // ── Compute pilot-relative I/Q for all 4 data tones ──
    const rawIQs = this.toneFreqs.map((f) => toneIQ(window, f, this.cfg.sampleRate));

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
    const noiseFloor = this.noiseProfiler.floor;
    const noiseAvg = (noiseFloor[0] + noiseFloor[1] + noiseFloor[2] + noiseFloor[3]) / 4;
    const {pilotAmplitude} = this.pilotTracker;

    // ── Sync / burst detection ──
    const calibPeak = Math.max(...this.syncPeak);
    const burstThresh = Math.min(noiseAvg * 0.8, Math.max(calibPeak * 0.1, 2e-11));
    const ampThresh = pilotAmplitude * this.liveAmpThresholdRatio;
    const noiseRef = (noiseFloor[0] + noiseFloor[1] + noiseFloor[2] + noiseFloor[3]) / 4;
    const anyToneStrong = Math.max(...energies) > Math.max(0.001, noiseRef * 5);
    const totalAboveNoise = total > Math.max(0.001, noiseRef * 5);
    const isBurst = avg > burstThresh && anyToneStrong && totalAboveNoise;

    // ── Debug trace logging ──
    if (this.pilotTracker.discovered && !this.inFrame) {
      console.warn(
        `[DEC_TRACE] pilotAmp=${pilotAmplitude.toExponential(2)} ` +
          `thresh=${ampThresh.toExponential(2)} avg=${avg.toExponential(2)} ` +
          `e=[${energies.map((e) => e.toExponential(2)).join(',')}] ` +
          `any=${anyToneStrong} totAbove=${totalAboveNoise} cons=${this.consecutiveSync} ` +
          `nf=${this.noiseProfiler.frames} fse=${this.framesSinceExit} ` +
          `pilotFreq=${this.pilotTracker.pilotFreq.toFixed(1)}`,
      );
    }

    // ── Noise profiling (delegated to NoiseProfiler) ──
    if (!this.inFrame) {
      this.framesSinceExit++;
      this.noiseProfiler.update(energies);
    }

    // ── Preamble phase detection (delegated to PreambleDetector) ──
    if (this.pilotTracker.discovered && !this.inFrame) {
      const preambleResult = this.preambleDetector.update({
        totalEnergy: total,
        energies,
        relI,
      });

      if (preambleResult.enteredFrame) {
        this.inFrame = true;
        this.frameSkip = 0;
        this.framesSinceStrong = 0;
        this.dataFramesExecuted = 0;
        this.lastStrongBitsCollected = 0;
        this.framesSinceExit = 0;
        this.framedDecoder.reset();
        this.blockProcessor.reset();
        console.warn(
          `[PREAMBLE] calibrate→DATA at sym ${Math.floor(this.pilotTracker.samplesSeen / this.sps)}`,
        );
      }
    }

    // ── Legacy debug log (keep for compatibility) ──
    if (this.logging) {
      const thresholds: [number, number, number, number] = [0, 0, 0, 0];
      let bitPat = 0;
      const {calPhaseFlip} = this.preambleDetector;
      for (let t = 0; t < 4; t++) {
        thresholds[t] = noiseFloor[t] * 4;
        const ampBit = energies[t] > ampThresh ? 1 : 0;
        const correctedI = calPhaseFlip[t] < 0 ? -relI[t] : relI[t];
        const phaseBit = ampBit === 1 && correctedI < 0 ? 1 : 0;
        bitPat |= ((ampBit << 1) | phaseBit) << (6 - t * 2);
      }
      const endNoiseAvg = (noiseFloor[0] + noiseFloor[1] + noiseFloor[2] + noiseFloor[3]) / 4;
      const snr = endNoiseAvg > 1e-12 ? avg / endNoiseAvg : 999;
      const totalEDbg = energies[0] + energies[1] + energies[2] + energies[3];
      const {totalBits} = this.framedDecoder;
      this.debugLog.push({
        peakAmp: Math.max(...window.map(Math.abs)),
        relI: [...relI],
        relQ: [...relQ],
        energies,
        avg,
        ratios:
          totalEDbg > 1e-12
            ? (energies.map((e: number) => e / totalEDbg) as [number, number, number, number])
            : [0, 0, 0, 0],
        noiseAvg,
        strong: isBurst,
        consecutiveSync: this.consecutiveSync,
        inFrame: this.inFrame,
        bitsCollected: totalBits,
        noiseFloor: [...noiseFloor],
        noiseMax: [...this.noiseProfiler.max],
        thresholds,
        noiseFrames: this.noiseProfiler.frames,
        bitPattern: bitPat,
        signalToNoise: snr,
        burstThreshold: burstThresh,
        framesSinceStrong: this.framesSinceStrong,
        framesSinceExit: this.framesSinceExit,
        frameSkip: this.frameSkip,
        pilotFreq: this.pilotTracker.pilotFreq,
        pilotAmp: pilotAmplitude,
        pilotConfidence: this.pilotTracker.discovered ? 1 : 0,
        rawEnergies: [0, 0, 0, 0],
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

      const endNoiseAvg = (noiseFloor[0] + noiseFloor[1] + noiseFloor[2] + noiseFloor[3]) / 4;
      const signalToNoise = avg / Math.max(endNoiseAvg, 1e-12);

      if (signalToNoise > 2.0) {
        this.framesSinceStrong = 0;
      } else {
        this.framesSinceStrong++;
      }

      this.dataFramesExecuted++;
      if (this.dataFramesExecuted > 20000 || this.framedDecoder.totalBits > 65536) {
        this.inFrame = false;
        return;
      }

      // BPSK bit detection: per-symbol hard decision
      let frameBits = 0;
      const dbgBits: number[] = [];
      const {calPhaseFlip} = this.preambleDetector;

      for (let t = 0; t < 4; t++) {
        const correctedI = calPhaseFlip[t] < 0 ? -relI[t] : relI[t];
        const bit = t < this.cfg.toneCount ? (correctedI < 0 ? 1 : 0) : 0;
        dbgBits.push(bit);
        frameBits |= bit << (7 - t * 2);
        frameBits |= 1 << (6 - t * 2);
        this.bitConfidence.push(Math.abs(correctedI));
      }

      if (this.dataFramesExecuted <= 16) {
        console.warn(
          `[BPSK] frm=${this.dataFramesExecuted} ` +
            `sym=${Math.floor(this.pilotTracker.samplesSeen / this.sps)} ` +
            `bits=${dbgBits.join('')} hex=0x${frameBits.toString(16).padStart(2, '0')} ` +
            `I=[${relI.map((v) => v.toFixed(3)).join(',')}] flip=[${calPhaseFlip.join(',')}]`,
        );
      }

      // Pack frame bytes into block bytes
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
          const hi =
            (((this.bchBuf[0] >> 7) & 1) << 3) |
            (((this.bchBuf[0] >> 5) & 1) << 2) |
            (((this.bchBuf[0] >> 3) & 1) << 1) |
            ((this.bchBuf[0] >> 1) & 1);
          const lo =
            (((this.bchBuf[1] >> 7) & 1) << 3) |
            (((this.bchBuf[1] >> 5) & 1) << 2) |
            (((this.bchBuf[1] >> 3) & 1) << 1) |
            ((this.bchBuf[1] >> 1) & 1);
          blockByte = (hi << 4) | lo;
        }
        if (this.framedDecoder.totalBits <= 64) {
          console.warn(
            `[DEC_BYTE] byte=0x${blockByte.toString(16).padStart(2, '0')} bits=${this.framedDecoder.totalBits}`,
          );
        }
        this.framedDecoder.feedBytes(new Uint8Array([blockByte]));
        this.bchBuf = [];
        this.bchBufCount = 0;

        if (this.debugTrace.length < 200) {
          this.debugTrace.push({
            sym: Math.floor(this.pilotTracker.samplesSeen / this.sps),
            rawI: [relI[0], relI[1], relI[2], relI[3]],
            bits: [
              (frameBits >> 7) & 1,
              (frameBits >> 5) & 1,
              (frameBits >> 3) & 1,
              (frameBits >> 1) & 1,
            ],
            frameHex: frameBits.toString(16).padStart(2, '0'),
          });
        }
      }

      if (this.logging && this.framedDecoder.totalBits <= 16) {
        console.log(
          `[DEC] first data: totalBits=${this.framedDecoder.totalBits} pat=${frameBits.toString(2).padStart(8, '0')}`,
        );
      }

      if (signalToNoise > 1.3) this.lastStrongBitsCollected = this.framedDecoder.totalBits;

      if (this.framesSinceStrong >= 8 && this.framedDecoder.totalBits >= 16) {
        if (this.logging)
          console.log(
            `[DEC] end-of-signal after ${this.framedDecoder.totalBits} bits (SNR=${signalToNoise.toFixed(1)})`,
          );
        this.inFrame = false;
        return;
      }
    }
  }

  setExpectedTotal(_n: number) {
    // Handled by BlockProcessor's Config block parsing
  }

  hasData(): boolean {
    return this.blockProcessor.getProgress() !== null;
  }

  flush(): Uint8Array {
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

  getNoiseFloor(): [number, number, number, number] {
    return [...this.noiseProfiler.floor];
  }

  getNoiseMax(): [number, number, number, number] {
    return [...this.noiseProfiler.max];
  }

  getPilotFreq(): number {
    return this.pilotTracker.pilotFreq;
  }

  getPilotAmplitude(): number {
    return this.pilotTracker.pilotAmplitude;
  }
}
