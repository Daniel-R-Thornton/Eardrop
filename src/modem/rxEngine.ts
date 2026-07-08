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
const SPS = 128;
/** Bits per symbol (4 = 1 phase bit × 4 tones) */
const BITS_PER_SYMBOL = 4;
/** Tones count */
const TONE_COUNT = 4;
/** Preamble duration in samples (620ms at 3200Hz) */
const PREAMBLE_SAMPLES = 1984;
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

    if (this.collecting) {
      this.byteAccum = (this.byteAccum << 1) | (bit & 1);
      this.byteBits++;
      this.bitsCollected++;
      
      if (this.byteBits >= 8) {
        this.buf.push(this.byteAccum);
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
        this.buf = [];
      }
    } else if (this.bitCount >= 24 && this.shiftReg === this.sentinel) {
      this.collecting = true;
      this.byteAccum = 0;
      this.phaseInverted = false;
      console.warn(`[RX-SCAN] Sentinel at bit ${this.bitCount}`);
    } else if (this.bitCount >= 24 && this.shiftReg === this.sentinelInv) {
      this.collecting = true;
      this.phaseInverted = true;
      this.byteAccum = 0;
      this.byteBits = 0;
      this.buf = [];
      this.bitsCollected = 0;
      console.warn(`[RX-SCAN] Sentinel found at bit ${this.bitCount}, collecting ${FRAME_SIZE-3} bytes...`);
    }
    
    // Debug: log every 1000 bits scanned without hit
    if (this.bitCount > 0 && this.bitCount % 1000 === 0 && !this.collecting) {
      console.warn(`[RX-SCAN] ${this.bitCount} bits scanned, no sentinel (sr=0x${this.shiftReg.toString(16)})`);
    }
  }

  getState(): string {
    return this.collecting ? 'COLLECTING' : 'SCANNING';
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
  private toneFreqs: [number, number, number, number] = [500, 700, 900, 1100];

  // Accumulators for BPSK bit -> byte packing
  private bchBuf: number[] = [];
  private bchBufCount = 0;
  private samplesSeen = 0;

  // State machine
  private state: RxState = RxState.WAITING;
  private signalDetectedAt = -1;
  private preambleStartSample = 0;
  private skipRemaining = 0;
  private skipCount = 0;

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

  // BPSK calibration
  private calPhaseFlip: number[] = [1, 1, 1, 1];
  private calSum: number[] = [0, 0, 0, 0];
  private calCount: number[] = [0, 0, 0, 0];
  private calDone = false;

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
    
    // Skip preamble (samples 0 through 1983). The preamble is always at the
    // start of the audio. samplesSeen starts at 1 on the first call.
    if (this.samplesSeen <= PREAMBLE_SAMPLES) {
      if (this.samplesSeen === 1) console.warn(`[RX] Preamble: ${PREAMBLE_SAMPLES}samp to skip`);
      if (this.samplesSeen === 1000) console.warn(`[RX] Preamble: 1000/1984 samples done, pilotAmp=${this.pilotAmplitude.toExponential(2)}`);
      return;
    }
    
    // After preamble: the first call here has samplesSeen = PREAMBLE_SAMPLES + 1
    // which corresponds to audio sample 1984 (the frame start).
    // The next 128 samples form the first frame symbol, starting at this sample.
    
    if (this.state === RxState.WAITING) {
      this.state = RxState.FRAMES;
      this.fileData = [];
      this.framesReceived = 0;
      this.fileID = 0;
      this.fileName = '';
      this.fileSize = 0;
      this.totalFrames = 0;
      console.warn(`[RX] Preamble done, entering FRAMES state at sample ${this.samplesSeen}, pilotAmp=${this.pilotAmplitude.toExponential(2)}`);
    }

    // ── Frame scanning: buffer samples and demodulate ──
    this.buf.push(sample);
    if (this.buf.length < this.sps) return;
    
    const window = this.buf.slice(0, this.sps);
    this.buf.splice(0, this.sps);
    
    const rawIQs = this.toneFreqs.map(f => toneIQ(window, f, this.cfg.sampleRate));
    
    // ── BPSK bit detection from raw I ──
    // Using raw I directly (not pilot-rotated) because the data tone phase
    // accumulators are independent from the pilot. The toneIQ correlation
    // at each data tone frequency produces I/Q with consistent sign.
    let frameBits = 0;
    for (let t = 0; t < TONE_COUNT; t++) {
      const bit = rawIQs[t].i < 0 ? 1 : 0;
      frameBits |= (bit) << (7 - t * 2);
      frameBits |= (1) << (6 - t * 2);
    }
    
    // Debug: log first few frames
    this.dbgFrameCount++;
    if (this.dbgFrameCount <= 5) {
      const energies = rawIQs.map(r => Math.hypot(r.i, r.q).toExponential(2)).join(',');
      console.warn(`[RX] Frame ${this.dbgFrameCount}: bits=0x${frameBits.toString(16).padStart(2,'0')} I=${rawIQs.map(r=>r.i.toFixed(3)).join(',')} eng=[${energies}]`);
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

  reset(): void {
    this.state = RxState.WAITING;
    this.signalDetectedAt = -1;
    this.skipCount = 0;
    this.skipRemaining = 0;
    this.buf = [];
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

  private processFrame(frame: Uint8Array): void {
    const decoded = decodeFrame(frame);
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
