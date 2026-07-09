/**
 * rxEngine.ts — Complete receive engine for the Eardrop modem.
 *
 * State machine: WAITING → (preamble detected) → collecting frames
 *   → HEADER frame (type=0x01) → DATA frames (type=0x02) → TAIL (type=0x03) → COMPLETE
 *
 * Demodulation:
 *   - toneIQ() over 128-sample windows for per-tone I/Q
 *   - PilotPLL for continuous phase tracking
 *   - BPSK: correctedI < 0 ? 1 : 0 (hard decision)
 *   - 2 frames = 1 byte → feed to sentinel scanner
 *
 * Preamble detection: fixed timing (detect energy, wait ~620ms, start frame scan)
 * Frame format: 79-byte atomic frame (sentinel + BCH header + RS payload)
 */

import { ModemConfig, TONE_OFFSETS, DEFAULT_CONFIG } from './types';
import { PilotPLL, toneIQ, getDataToneFreqs } from './pilot';
import { decodeFrame, FRAME_SIZE, PAYLOAD_DATA_SIZE, RAW_HEADER_SIZE } from './atomicFrame';

// ─── Constants ───────────────────────────────────────

/** Samples per symbol */
const SPS = 256;
/** Bits per symbol (4 = 1 phase bit × 4 tones) */
const BITS_PER_SYMBOL = 4;
/** Tones count */
const TONE_COUNT = 4;
/** Preamble duration in samples (560ms at 3200Hz = 1792 samples) */
const PREAMBLE_SAMPLES = 1792;
/** Skip the preamble (1984 samples). The first frame symbol starts at
 *  sample 1984. Symbol boundaries are at 1984 + n*128. */
const SKIP_SAMPLES = PREAMBLE_SAMPLES; // 1984
/** Energy threshold for signal detection */
const ENERGY_THRESHOLD = 0.0003;

// ─── RxState ─────────────────────────────────────────

export enum RxState {
  WAITING,        // Waiting for signal energy
  PREAMBLE,       // Receiving preamble (waiting for it to pass)
  FRAMES,         // Scanning for atomic frames
  COMPLETE,       // File received
  ERROR,          // Error state
}

// ─── Types ───────────────────────────────────────────

export interface ReceivedFile {
  fileName: string;
  data: Uint8Array;
  totalBytes: number;
}

// ─── Sliding Window Sentinel Scanner ─────────────────

class SentinelScanner {
  private shiftReg = 0;
  private bitCount = 0;
  private collecting = false;
  /** Global phase inversion detected from inverted sentinel */
  private phaseInverted = false;
  
  /** Byte accumulator for collection phase */
  private byteAccum = 0;
  private byteBits = 0;
  private buf: number[] = [];
  private bitsCollected = 0;

  private readonly sentinel = 0xE79FE7;
  private readonly sentinelInv = 0x186018;
  private readonly collectBytes = FRAME_SIZE - 3; // 76

  // DEBUG: byte-level debug log ring buffer (last 256)
  public byteLog: Array<{ byte: number; phase: string; bitOffset: number }> = [];
  private maxByteLog = 256;

  // DEBUG: shift register history ring buffer for visualization (last 64)
  public shiftRegHistory: Array<{ bit: number; shiftReg: number; matched: boolean; phase: string }> = [];
  private maxRegHistory = 64;

  /** Hamming distance threshold for sentinel matching (allows bit errors) */
  private readonly sentinelHammingThreshold = 8;

  onFrame: ((frameBytes: Uint8Array) => void) | null = null;

  reset(): void {
    this.shiftReg = 0;
    this.bitCount = 0;
    this.collecting = false;
    this.phaseInverted = false;
    this.byteAccum = 0;
    this.byteBits = 0;
    this.buf = [];
    this.bitsCollected = 0;
  }

  feedByte(byte: number): void {
    const b = this.phaseInverted ? (~byte) & 0xFF : byte;
    for (let i = 7; i >= 0; i--) {
      this.feedBit((b >> i) & 1);
    }
  }

  feedBit(bit: number): void {
    this.shiftReg = ((this.shiftReg << 1) | (bit & 1)) & 0xFFFFFF;
    this.bitCount++;

    // DEBUG: record shift register state (sample every other bit to reduce noise)
    if (this.bitCount % 2 === 0 || this.collecting) {
      this.shiftRegHistory.push({
        bit,
        shiftReg: this.shiftReg,
        matched: !this.collecting && this.bitCount >= 24 && (this.shiftReg === this.sentinel || this.shiftReg === this.sentinelInv),
        phase: this.collecting ? 'COLLECT' : 'SCAN',
      });
      if (this.shiftRegHistory.length > this.maxRegHistory) this.shiftRegHistory.shift();
    }

    if (this.collecting) {
      this.byteAccum = (this.byteAccum << 1) | (bit & 1);
      this.byteBits++;
      this.bitsCollected++;
      
      if (this.byteBits >= 8) {
        this.buf.push(this.byteAccum);
        // DEBUG: log collected byte
        this.byteLog.push({ byte: this.byteAccum, phase: 'DATA', bitOffset: this.bitCount });
        if (this.byteLog.length > this.maxByteLog) this.byteLog.shift();
        this.byteAccum = 0;
        this.byteBits = 0;
      }
      
      if (this.buf.length >= this.collectBytes) {
        this.collecting = false;
        const fullFrame = new Uint8Array(FRAME_SIZE);
        fullFrame[0] = 0xE7;
        fullFrame[1] = 0x9F;
        fullFrame[2] = 0xE7;
        for (let i = 0; i < this.buf.length && i < FRAME_SIZE - 3; i++) {
          fullFrame[3 + i] = this.buf[i];
        }
        console.warn(`[RX-SCAN] Frame collected: ${this.buf.length}B (expect ${FRAME_SIZE-3})`);
        if (this.onFrame) {
          this.onFrame(fullFrame);
        }
        // DEBUG: log frame complete
        this.byteLog.push({ byte: 0x00, phase: 'FRAME', bitOffset: this.bitCount });
        if (this.byteLog.length > this.maxByteLog) this.byteLog.shift();
        this.buf = [];
      }
    } else if (this.bitCount >= 24) {
      // Hamming distance-based sentinel matching (tolerant to bit errors)
      const dist = this.popcount(this.shiftReg ^ this.sentinel);
      const distInv = this.popcount(this.shiftReg ^ this.sentinelInv);
      if (dist <= this.sentinelHammingThreshold) {
        // DEBUG: log sentinel detection
        this.byteLog.push({ byte: 0xFF, phase: 'SENTINEL', bitOffset: this.bitCount });
        if (this.byteLog.length > this.maxByteLog) this.byteLog.shift();
        this.collecting = true;
        this.byteAccum = 0;
        this.phaseInverted = false;
      } else if (distInv <= this.sentinelHammingThreshold) {
        this.collecting = true;
        this.phaseInverted = true;
        this.byteAccum = 0;
        this.byteBits = 0;
        this.buf = [];
        this.bitsCollected = 0;
        // DEBUG: log inverted sentinel detection
        this.byteLog.push({ byte: 0xF0, phase: 'SENTINEL', bitOffset: this.bitCount });
        if (this.byteLog.length > this.maxByteLog) this.byteLog.shift();
        console.warn(`[RX-SCAN] Inverted sentinel at bit ${this.bitCount}`);
      }
    }
    
    // Debug: log every 1000 bits scanned without hit
    if (this.bitCount > 0 && this.bitCount % 1000 === 0 && !this.collecting) {
      console.warn(`[RX-SCAN] ${this.bitCount} bits scanned, no sentinel (sr=0x${this.shiftReg.toString(16)})`);
    }
  }

  getState(): string {
    return this.collecting ? 'COLLECTING' : 'SCANNING';
  }

  getByteLog(): Array<{ byte: number; phase: string; bitOffset: number }> {
    return this.byteLog.slice(-this.maxByteLog);
  }

  getShiftRegHistory(): Array<{ bit: number; shiftReg: number; matched: boolean; phase: string }> {
    return this.shiftRegHistory.slice(-this.maxRegHistory);
  }

  /** Count set bits in a 24-bit integer */
  private popcount(x: number): number {
    x = (x & 0xFFFFFF) >>> 0;
    let count = 0;
    while (x) { count += x & 1; x >>>= 1; }
    return count;
  }
}

// ─── RxEngine ────────────────────────────────────────

export class RxEngine {
  private cfg: ModemConfig;
  private sps = SPS;

  // Demodulation buffer
  private buf: number[] = [];

  // PLL
  private pll: PilotPLL | null = null;
  private pilotAmplitude = 0;
  private toneFreqs: [number, number, number, number] = [650, 900, 1150, 1500];

  // Accumulators for BPSK bit -> byte packing
  private bchBuf: number[] = [];
  private bchBufCount = 0;
  private samplesSeen = 0;

  // State machine
  private state: RxState = RxState.WAITING;
  private warbleFrames = 0;
  private preambleFrames = 0;
  private warbleThreshold = 0.025;
  private warbleTimeoutCount = 0;
  private markerPeakE = 0;

  // File assembly
  private fileID = 0;
  private fileName = '';
  private fileSize = 0;
  private fileData: number[] = [];
  private totalFrames = 0;
  private framesReceived = 0;

  // Frame scanner
  private scanner: SentinelScanner;

  // Completed file
  private completedFile: ReceivedFile | null = null;

  // Per-tone I/Q calibration references (from Gray code calibration)
  /** Reference vectors for bit=0 (ref0I/Q) and bit=1 (ref1I/Q) per tone */
  private ref0I: number[] = [1, 1, 1, 1];
  private ref0Q: number[] = [0, 0, 0, 0];
  private ref1I: number[] = [-1, -1, -1, -1];
  private ref1Q: number[] = [0, 0, 0, 0];
  /** Previous frame I/Q values for differential BPSK detection */
  private prevFrameI: number[] = [0, 0, 0, 0];
  private prevFrameQ: number[] = [0, 0, 0, 0];
  /** Absolute phase state tracker for DBPSK→absolute conversion */
  private absBits: number[] = [0, 0, 0, 0];
  /** Calibration frame counter (0..15 for Gray code) */
  private calFrameCount = 0;
  /** Previous calibration frame I/Q values for difference computation (per-tone) */
  private prevCalIQs: Array<Array<{ i: number; q: number }>> = [];
  /** Gray code sequence shared with transmitter */
  private readonly grayCodes = [0,1,3,2,6,7,5,4,12,13,15,14,10,11,9,8];
  /** Marker flag */
  private markerSeen = false;
  /** Guard counter */
  private guardFrames = 0;

  // Warble-based symbol alignment
  private warbleSubEnergies: number[] = [0, 0, 0, 0];
  private warbleSubFrames = 0;
  private symbolAlignOffset = 0;
  /** Sample offset still to skip for symbol alignment */
  private pendingAlignSamples = 0;
  /** Ring buffer of decoded warble code bits (0=low freq, 1=high freq) */
  private warbleCodeBits: number[] = [];
  /** Expected 16-bit warble code from types.ts (imported via config or local const) */
  private readonly WARBLE_CODE = 0xAC94;
  private readonly WARBLE_CODE_THRESHOLD = 9;

  constructor(cfg: Partial<ModemConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.toneFreqs = getDataToneFreqs(this.cfg.pilotFreqHz, !!this.cfg.musical);
    this.scanner = new SentinelScanner();

    this.scanner.onFrame = (frame: Uint8Array) => {
      console.warn(`[RX] Frame received from scanner (${frame.length}B), processing...`);
      this.processFrame(frame);
    };
  }

  // ─── Public API ──────────────────────────────────────
  private dbgFrameCount = 0;

  feedSample(sample: number): void {
    this.samplesSeen++;

    // Initialize PLL on first sample
    if (!this.pll) {
      this.pll = new PilotPLL(this.cfg.pilotFreqHz, 0, 0.05, {
        sampleRate: this.cfg.sampleRate,
      });
      console.warn(`[RX] PLL init: pilotFreq=${this.cfg.pilotFreqHz}Hz`);
    }

    // Feed EVERY sample to the PLL for continuous phase tracking
    this.pll.update(sample);
    this.pilotAmplitude = this.pll.getAmplitude();
    
    // ── Skip samples for symbol alignment ──
    if (this.pendingAlignSamples > 0) {
      this.pendingAlignSamples--;
      return;
    }
    
    // ── Buffer samples and process by state ──
    this.buf.push(sample);
    if (this.buf.length < this.sps) return;
    const window = this.buf.slice(0, this.sps);
    this.buf.splice(0, this.sps);
    // Save current pilot phase reference (start of NEXT window)
    // Used to rotate raw tone I/Q from pilot-relative to absolute
    this.pilotCosRef = this.pll?.getCosRef() ?? 1;
    this.pilotSinRef = this.pll?.getSinRef() ?? 0;
    const rawIQs = this.toneFreqs.map(f => toneIQ(window, f, this.cfg.sampleRate));
    const totalE = rawIQs.reduce((a, r) => a + Math.hypot(r.i, r.q), 0);
    
    // ── WAITING: detect warble — sustained energy at pilot±50Hz ──
    if (this.state === RxState.WAITING) {
      // --- Track sub-frame warble energies FIRST for alternation check ---
      const qRatios: number[] = [0, 0, 0, 0];
      for (let q = 0; q < 4; q++) {
        const qStart = q * 32;
        const qWindow = window.slice(qStart, qStart + 32);
        if (qWindow.length >= 32) {
          const qLow = toneIQ(qWindow, this.cfg.pilotFreqHz - 50, this.cfg.sampleRate);
          const qHigh = toneIQ(qWindow, this.cfg.pilotFreqHz + 50, this.cfg.sampleRate);
          const qELow = Math.hypot(qLow.i, qLow.q);
          const qEHigh = Math.hypot(qHigh.i, qHigh.q);
          qRatios[q] = qEHigh > 1e-12 ? qELow / qEHigh : 0;
          this.warbleSubEnergies[q] += qRatios[q];
        }
      }
      this.warbleSubFrames++;
      
      // --- Warble code correlation ---
      // Decode each sub-window as a bit: 0 = low freq dominant, 1 = high freq dominant
      for (let q = 0; q < 4; q++) {
        const bit = qRatios[q] > 1.0 ? 0 : 1;
        this.warbleCodeBits.push(bit);
        if (this.warbleCodeBits.length > 32) this.warbleCodeBits.shift();
      }
      
      // Compute code correlation: try all 16 alignments (16 possible bit phases)
      let bestCodeCorr = 0;
      let bestCodeOffset = 0;
      if (this.warbleCodeBits.length >= 16) {
        for (let offset = 0; offset < 16; offset++) {
          let corr = 0;
          for (let b = 0; b < 16; b++) {
            const rxBit = this.warbleCodeBits[this.warbleCodeBits.length - 16 + b];
            const txBit = (this.WARBLE_CODE >> (15 - ((b + offset) % 16))) & 1;
            if (rxBit === txBit) corr++;
          }
          if (corr > bestCodeCorr) { bestCodeCorr = corr; bestCodeOffset = offset; }
        }
      }
      
      const wLow = toneIQ(window, this.cfg.pilotFreqHz - 50, this.cfg.sampleRate);
      const wHigh = toneIQ(window, this.cfg.pilotFreqHz + 50, this.cfg.sampleRate);
      const eLow = Math.hypot(wLow.i, wLow.q);
      const eHigh = Math.hypot(wHigh.i, wHigh.q);
      const eTot = eLow + eHigh;
      
      // Energy check (per-frame) + code correlation (final validation only)
      const ratio = eLow > eHigh ? eLow / eHigh : eHigh / eLow;
      // Use energy + approximate ratio check for per-frame warble detection
      const isWarbleFrame = eTot > this.warbleThreshold && ratio < 3.0 && eLow > 0.005 && eHigh > 0.005;
      if (isWarbleFrame) {
        this.warbleFrames++;
        if (this.warbleFrames === 1) console.warn(`[WARBLE] frame 0 eLow=${eLow.toExponential(2)} eHigh=${eHigh.toExponential(2)} codeCorr=${bestCodeCorr}/16`);
        if (this.warbleFrames === 2) console.warn(`[WARBLE] frame 1 eLow=${eLow.toExponential(2)} eHigh=${eHigh.toExponential(2)} codeCorr=${bestCodeCorr}/16`);
        if (this.warbleFrames >= 5) {
          // Final validation: check code correlation before declaring warble detected
          const codeOk = this.warbleCodeBits.length >= 16 && bestCodeCorr >= this.WARBLE_CODE_THRESHOLD;
          if (!codeOk) {
            console.warn(`[WARBLE] Final reject: codeCorr=${bestCodeCorr}/16 < ${this.WARBLE_CODE_THRESHOLD}`);
            this.warbleFrames = 0;
          } else {
            console.warn(`[WARBLE] Detected after ${this.warbleFrames} frames (codeCorr=${bestCodeCorr}/16)`);
              // Compute warble sub-frame alignment for symbol sync
              if (this.warbleSubFrames > 0) {
                const avgRatios = this.warbleSubEnergies.map(e => e / this.warbleSubFrames);
                let maxIdx = 0;
                for (let i = 1; i < 4; i++) {
                  if (avgRatios[i] > avgRatios[maxIdx]) maxIdx = i;
                }
                const rawOffset = maxIdx * 32;
                const minR = Math.min(...avgRatios);
                const maxR = Math.max(...avgRatios);
                if (maxR > minR * 2.0) {
                  this.symbolAlignOffset = rawOffset;
                  console.warn(`[WARBLE] Sub-frame ratios: [${avgRatios.map(r => r.toFixed(2)).join(',')}] maxQuarter=${maxIdx} offset=${this.symbolAlignOffset} (alternation OK)`);
                } else {
                  this.symbolAlignOffset = 0;
                  console.warn(`[WARBLE] Sub-frame ratios: [${avgRatios.map(r => r.toFixed(2)).join(',')}] maxQuarter=${maxIdx} offset=0 (no alternation)`);
                }
              }
            this.state = RxState.PREAMBLE;
            this.markerPeakE = 0;
            // Skip alignment-offset samples so all subsequent frames are aligned
            this.pendingAlignSamples = this.symbolAlignOffset;
            if (this.symbolAlignOffset > 0) {
              console.warn(`[ALIGN] Skipping ${this.symbolAlignOffset} samples from PREAMBLE entry`);
            }
          }
        }
      } else {
        if (this.warbleFrames > 0 || (eTot > 0.01 && ratio < 3.0)) {
          console.warn(`[WARBLE] reject: eTot=${eTot.toExponential(2)} codeCorr=${bestCodeCorr}/16 thr=${this.WARBLE_CODE_THRESHOLD} eLow=${eLow.toExponential(2)} eHigh=${eHigh.toExponential(2)}`);
        }
        this.warbleFrames = 0;
      }
      
      return;
    }
    
    // ── PREAMBLE: state machine driven by energy signatures ──
    if (this.state === RxState.PREAMBLE) {
      const signs = rawIQs.map(r => r.i >= 0 ? '+' : '-').join('');
      if (totalE > this.markerPeakE) this.markerPeakE = totalE;
      this.preambleFrames++;
      // Timeout: if no marker found within 80 frames (~3.2s), reset to WAITING
      if (this.preambleFrames > 80) {
        this.warbleTimeoutCount++;
        const newThreshold = 0.025 * Math.pow(1.5, this.warbleTimeoutCount);
        console.warn(`[PREAMBLE] Timeout #${this.warbleTimeoutCount}, raising threshold to ${newThreshold.toExponential(2)}`);
        this.warbleThreshold = newThreshold;
        this.state = RxState.WAITING;
        this.warbleFrames = 0;
        this.markerSeen = false;
        this.preambleFrames = 0;
        this.markerPeakE = 0;
        this.guardFrames = 0;
        this.buf = [];
        return;
      }
      
      // Detect marker: all 4 tones ON produces distinctly high energy
      if (totalE > 0.15 && !this.markerSeen) {
        this.markerSeen = true;
        console.warn(`[MARKER] E=${totalE.toExponential(2)} signs=[${signs}]`);
        this.calFrameCount = 0;
        this.prevCalIQs = [];
        return;
      }
      // After marker: 16 Gray code calibration frames
      if (this.markerSeen && this.calFrameCount < 16) {
        const gc = this.grayCodes[this.calFrameCount];
        const bits = [(gc >> 3) & 1, (gc >> 2) & 1, (gc >> 1) & 1, gc & 1];
        console.warn(`[CAL] frame ${this.calFrameCount} gc=0x${gc.toString(2).padStart(4,'0')} bits=[${bits.join(',')}] I=${rawIQs.map(r=>r.i.toFixed(3)).join(',')}`);
        // Accumulate this frame's I/Q per tone into the correct bit bucket
        // Store per-tone I/Q for difference-based reference computation
        this.prevCalIQs.push(rawIQs.map(r => ({ i: r.i, q: r.q })));
        this.calFrameCount++;
        if (this.calFrameCount >= 16) {
          // Direct centroid averaging: for each tone, separate calibration frames
          // by their bit value (0 or 1) and average the I/Q per bin.
          const cal0I: number[] = [0,0,0,0]; const cal0Q: number[] = [0,0,0,0];
          const cal1I: number[] = [0,0,0,0]; const cal1Q: number[] = [0,0,0,0];
          const cnt0: number[] = [0,0,0,0]; const cnt1: number[] = [0,0,0,0];
          
          for (let f = 0; f < 16; f++) {
            const gc = this.grayCodes[f];
            const bits = [(gc >> 3) & 1, (gc >> 2) & 1, (gc >> 1) & 1, gc & 1];
            for (let t = 0; t < TONE_COUNT; t++) {
              if (bits[t] === 0) {
                cal0I[t] += this.prevCalIQs[f][t].i;
                cal0Q[t] += this.prevCalIQs[f][t].q;
                cnt0[t]++;
              } else {
                cal1I[t] += this.prevCalIQs[f][t].i;
                cal1Q[t] += this.prevCalIQs[f][t].q;
                cnt1[t]++;
              }
            }
          }
          
          for (let t = 0; t < TONE_COUNT; t++) {
            if (cnt0[t] > 0) {
              this.ref0I[t] = cal0I[t] / cnt0[t];
              this.ref0Q[t] = cal0Q[t] / cnt0[t];
            }
            if (cnt1[t] > 0) {
              this.ref1I[t] = cal1I[t] / cnt1[t];
              this.ref1Q[t] = cal1Q[t] / cnt1[t];
            }
          }
          console.warn(`[CAL] Refs: ${[0,1,2,3].map(t => `t${t}: 0°=(${this.ref0I[t].toFixed(3)},${this.ref0Q[t].toFixed(3)}) 180°=(${this.ref1I[t].toFixed(3)},${this.ref1Q[t].toFixed(3)})`).join(' | ')}`);
          // Initialize absolute phase state from last calibration frame
          const lastGc = this.grayCodes[this.prevCalIQs.length - 1];
          this.absBits = [(lastGc >> 3) & 1, (lastGc >> 2) & 1, (lastGc >> 1) & 1, lastGc & 1];
          console.warn(`[CAL] Initial absBits: [${this.absBits.join(',')}]`);
          // Initialize differential BPSK from last calibration frame's I values
          const lastCal = this.prevCalIQs[this.prevCalIQs.length - 1];
          for (let t = 0; t < TONE_COUNT; t++) {
            this.prevFrameI[t] = lastCal[t].i;
            this.prevFrameQ[t] = lastCal[t].q;
          }
        }
        return;
      }
      // After calibration: guard frames (pilot only)
      if (this.calFrameCount >= 16) {
        this.guardFrames++;
        if (this.guardFrames === 1) console.warn(`[GUARD] pilot only, waiting 4 frames...`);
        if (this.guardFrames >= 4) {
          console.warn(`[FRAMES] alignOffset=${this.symbolAlignOffset}`);
          this.state = RxState.FRAMES;
          this.fileData = [];
          this.framesReceived = 0;
          this.fileID = 0;
          this.fileName = '';
          this.fileSize = 0;
          this.totalFrames = 0;
          this.buf = [];
        }
      }
      return;
    }

    // ── Differential BPSK bit detection ──
    // Compare each tone's I against the PREVIOUS frame's I.
    // Bit=0 if same sign (no phase change), Bit=1 if opposite sign (phase flip).
    // Differential BPSK using full I/Q dot product
    // Error propagation is handled by the Hamming-distance sentinel scanner
    let frameBits = 0;
    const bits: number[] = [];
    for (let t = 0; t < TONE_COUNT; t++) {
      const prevI = this.prevFrameI[t];
      const prevQ = this.prevFrameQ[t];
      // DBPSK: dot product of consecutive frames
      const dot = prevI * rawIQs[t].i + prevQ * rawIQs[t].q;
      const diffBit = (prevI !== 0 || prevQ !== 0) && dot < 0 ? 1 : 0;
      const dpskAbs = this.absBits[t] ^ diffBit;
      
      // Centroid: nearest neighbor to cal references
      const d0 = (rawIQs[t].i - this.ref0I[t])**2 + (rawIQs[t].q - this.ref0Q[t])**2;
      const d1 = (rawIQs[t].i - this.ref1I[t])**2 + (rawIQs[t].q - this.ref1Q[t])**2;
      const centAbs = d1 < d0 ? 1 : 0;
      
      // Hybrid: trust DBPSK for continuity, centroid for re-sync when confident
      const confident = Math.min(d0, d1) > 0 && Math.max(d0, d1) > Math.min(d0, d1) * 3.0;
      const absBit = (confident && centAbs !== dpskAbs) ? centAbs : dpskAbs;
      this.absBits[t] = absBit;
      
      bits.push(absBit);
      frameBits |= (absBit) << (7 - t * 2);
      frameBits |= (1) << (6 - t * 2);
      this.prevFrameI[t] = rawIQs[t].i;
      this.prevFrameQ[t] = rawIQs[t].q;
    }
    
    // Debug: first 5 frames with expected sentinel comparison
    this.dbgFrameCount++;
    if (this.dbgFrameCount <= 5) {
      const sentinelBytes = [0xE7, 0x9F, 0xE7];
      const byteIdx = Math.floor((this.dbgFrameCount - 1) / 2);
      const nibble = (this.dbgFrameCount - 1) % 2 === 0 ? 'upper' : 'lower';
      let expectedStr = '?';
      if (byteIdx < 3) {
        const b = sentinelBytes[byteIdx];
        const nibVal = nibble === 'upper' ? (b >> 4) & 0xF : b & 0xF;
        const expPh = [(nibVal >> 3) & 1, (nibVal >> 2) & 1, (nibVal >> 1) & 1, nibVal & 1];
        let eb = 0;
        for (let t = 0; t < TONE_COUNT; t++) {
          eb |= (expPh[t]) << (7 - t * 2);
          eb |= (1) << (6 - t * 2);
        }
        expectedStr = '0x' + eb.toString(16).padStart(2, '0');
        const rawSigns = rawIQs.map(r => r.i >= 0 ? '+' : '-').join('');
        // Extract absolute bits from frameBits (positions 7,5,3,1)
        const absBitsStr = [0,1,2,3].map(t => ((frameBits >> (7 - t * 2)) & 1).toString()).join('');
        const expStr = expPh.join('');
        const matchStr = absBitsStr.split('').map((b, i) => b === expStr[i] ? '✓' : '✗').join('');
        console.warn(`[RX] Frame ${this.dbgFrameCount}: bits=0x${frameBits.toString(16).padStart(2,'0')} exp=${expectedStr} I=${rawIQs.map(r=>r.i.toFixed(3)).join(',')} got=[${absBitsStr}] want=[${expStr}] ${matchStr}`);
      } else {
        console.warn(`[RX] Frame ${this.dbgFrameCount}: bits=0x${frameBits.toString(16).padStart(2,'0')}`);
      }
    }

    this.bchBuf.push(frameBits);
    this.bchBufCount++;
    if (this.bchBufCount >= 2) {
      const hi = ((this.bchBuf[0] >> 7) & 1) << 3 |
                 ((this.bchBuf[0] >> 5) & 1) << 2 |
                 ((this.bchBuf[0] >> 3) & 1) << 1 |
                 ((this.bchBuf[0] >> 1) & 1);
      const lo = ((this.bchBuf[1] >> 7) & 1) << 3 |
                 ((this.bchBuf[1] >> 5) & 1) << 2 |
                 ((this.bchBuf[1] >> 3) & 1) << 1 |
                 ((this.bchBuf[1] >> 1) & 1);
      const blockByte = (hi << 4) | lo;
      this.scanner.feedByte(blockByte);
      this.bchBuf = [];
      this.bchBufCount = 0;
    }
  }

  getState(): RxState {
    return this.state;
  }

  getFile(): ReceivedFile | null {
    return this.completedFile;
  }

  getDebugByteLog(): Array<{ byte: number; phase: string; bitOffset: number }> {
    return this.scanner.getByteLog();
  }

  getShiftRegHistory(): Array<{ bit: number; shiftReg: number; matched: boolean; phase: string }> {
    return this.scanner.getShiftRegHistory();
  }

  reset(): void {
    this.state = RxState.WAITING;
    this.warbleFrames = 0;
    this.warbleThreshold = 0.025;
    this.warbleTimeoutCount = 0;
    this.markerSeen = false;
    this.preambleFrames = 0;
    this.markerPeakE = 0;
    this.guardFrames = 0;
    this.buf = [];
    this.warbleSubEnergies = [0, 0, 0, 0];
    this.warbleSubFrames = 0;
    this.symbolAlignOffset = 0;
    this.pendingAlignSamples = 0;
    this.absBits = [0,0,0,0];
    this.warbleCodeBits = [];
    this.calFrameCount = 0;
    this.prevCalIQs = [];
    this.prevFrameI = [0,0,0,0];
    this.prevFrameQ = [0,0,0,0];
    this.ref0I = [1,1,1,1]; this.ref0Q = [0,0,0,0];
    this.ref1I = [-1,-1,-1,-1]; this.ref1Q = [0,0,0,0];
    this.bchBuf = [];
    this.bchBufCount = 0;
    this.pll = null;
    this.pilotAmplitude = 0;
    this.samplesSeen = 0;
    this.fileData = [];
    this.framesReceived = 0;
    this.fileName = '';
    this.fileSize = 0;
    this.totalFrames = 0;
    this.completedFile = null;
    this.scanner.reset();
  }

  // ─── Private ─────────────────────────────────────

  private computeCRC16(data: Uint8Array): number {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i] << 8;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
        else crc <<= 1;
      }
    }
    return crc & 0xFFFF;
  }

  private processFrame(frame: Uint8Array): void {
    // Log received CRC
    const receivedCRC = (frame[5] << 8) | frame[6];
    const computedCRC = this.computeCRC16(frame.slice(0, FRAME_SIZE - 2));
    console.log(`[RX] Received CRC: 0x${receivedCRC.toString(16).padStart(4, '0')}, Computed: 0x${computedCRC.toString(16).padStart(4, '0')}`);
    // CRC bytes (little-endian)
    const receivedCRCHigh = frame[5];
    const receivedCRCLow = frame[6];
    console.log(`[RX-ENDIAN] CRC: 0x${receivedCRCHigh.toString(16).padStart(2, '0')} 0x${receivedCRCLow.toString(16).padStart(2, '0')}`);

    let decoded = decodeFrame(frame);
    
    console.warn(`[RX] processFrame: valid=${decoded.valid} type=${decoded.header?.type} payload=${decoded.payload?.length}B`);
    if (!decoded.valid) return;

    switch (decoded.header!.type) {
      case 0x01: // HEADER
        console.warn(`[RX] HEADER frame received`);
        this.processHeader(decoded.payload);
        break;
      case 0x02: // PAYLOAD
        console.warn(`[RX] PAYLOAD frame #${this.framesReceived+1}`);
        this.processPayload(decoded.payload);
        break;
      case 0x03: // TAIL
        console.warn(`[RX] TAIL frame — assembling ${this.fileData.length}/${this.fileSize}B file`);
        this.processTail();
        break;
    }
  }

  private processHeader(payload: Uint8Array): void {
    // Header payload format: [fileID:4B][totalSize:4B][nameLen:1B][name...]
    const fileID = (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
    // File ID validation (little-endian)
    const receivedFileID = (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
    console.log(`[RX-ENDIAN] File ID: 0x${receivedFileID.toString(16)}`);

    const totalSize = (payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24)) >>> 0;
    const nameLen = Math.min(payload[8] & 0xFF, 31);

    let name = '';
    for (let i = 0; i < nameLen && i < PAYLOAD_DATA_SIZE - 9; i++) {
      const c = payload[9 + i];
      if (c >= 0x20 && c <= 0x7E) name += String.fromCharCode(c);
    }

    this.fileID = fileID;
    this.fileSize = totalSize;
    this.fileName = name;
    this.fileData = [];
    this.framesReceived = 0;
  }

  private processPayload(payload: Uint8Array): void {
    if (!this.fileName) {
      // No header received yet — ignore
      return;
    }

    for (let i = 0; i < payload.length && this.fileData.length < this.fileSize; i++) {
      this.fileData.push(payload[i]);
    }
    this.framesReceived++;
  }

  private processTail(): void {
    if (!this.fileName || this.fileData.length === 0) {
      return;
    }

    const data = new Uint8Array(this.fileData.slice(0, this.fileSize));
    this.completedFile = {
      fileName: this.fileName,
      data,
      totalBytes: this.fileSize,
    };
    this.state = RxState.COMPLETE;
    this.fileName = '';
    this.fileData = [];
  }
}
