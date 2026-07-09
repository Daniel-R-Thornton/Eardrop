/**
 * SentinelScanner — Sliding-window sentinel pattern detector.
 *
 * Extracted from RxEngine. Scans a continuous bit stream for a 24-bit
 * sentinel marker using Hamming-distance matching (tolerant to bit errors).
 * Once a sentinel is detected, collects the frame payload bytes that follow.
 *
 * Used by the atomic frame protocol (RxEngine) to locate frame boundaries
 * in the demodulated bit stream.
 */

import { FRAME_SIZE } from '../protocol/atomicFrame';

export interface ByteLogEntry {
  byte: number;
  phase: string;
  bitOffset: number;
}

export interface ShiftRegEntry {
  bit: number;
  shiftReg: number;
  matched: boolean;
  phase: string;
}

export class SentinelScanner {
  private shiftReg = 0;
  private bitCount = 0;
  private collecting = false;

  private byteAccum = 0;
  private byteBits = 0;
  private buf: number[] = [];
  private bitsCollected = 0;

  private readonly sentinel = 0xe79fe7;
  private readonly collectBytes = FRAME_SIZE - 3; // 76 bytes after 3-byte sentinel

  /** Hamming distance threshold for sentinel matching (allows bit errors) */
  private readonly sentinelHammingThreshold = 2;

  // Debug ring buffers
  public byteLog: ByteLogEntry[] = [];
  private maxByteLog = 256;

  public shiftRegHistory: ShiftRegEntry[] = [];
  private maxRegHistory = 64;

  onFrame: ((frameBytes: Uint8Array) => void) | null = null;

  reset(): void {
    this.shiftReg = 0;
    this.bitCount = 0;
    this.collecting = false;
    this.byteAccum = 0;
    this.byteBits = 0;
    this.buf = [];
    this.bitsCollected = 0;
  }

  feedByte(byte: number): void {
    for (let i = 7; i >= 0; i--) {
      this.feedBit((byte >> i) & 1);
    }
  }

  feedBit(bit: number): void {
    this.shiftReg = ((this.shiftReg << 1) | (bit & 1)) & 0xffffff;
    this.bitCount++;

    // Debug: record shift register state (sample every other bit to reduce noise)
    if (this.bitCount % 2 === 0 || this.collecting) {
      this.shiftRegHistory.push({
        bit,
        shiftReg: this.shiftReg,
        matched: !this.collecting && this.bitCount >= 24 && this.shiftReg === this.sentinel,
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
        this.byteLog.push({ byte: this.byteAccum, phase: 'DATA', bitOffset: this.bitCount });
        if (this.byteLog.length > this.maxByteLog) this.byteLog.shift();
        this.byteAccum = 0;
        this.byteBits = 0;
      }

      if (this.buf.length >= this.collectBytes) {
        this.collecting = false;
        const fullFrame = new Uint8Array(FRAME_SIZE);
        fullFrame[0] = 0xe7;
        fullFrame[1] = 0x9f;
        fullFrame[2] = 0xe7;
        for (let i = 0; i < this.buf.length && i < FRAME_SIZE - 3; i++) {
          fullFrame[3 + i] = this.buf[i];
        }
        console.warn(`[RX-SCAN] Frame collected: ${this.buf.length}B (expect ${FRAME_SIZE - 3})`);
        if (this.onFrame) {
          this.onFrame(fullFrame);
        }
        this.byteLog.push({ byte: 0x00, phase: 'FRAME', bitOffset: this.bitCount });
        if (this.byteLog.length > this.maxByteLog) this.byteLog.shift();
        this.buf = [];
      }
    } else if (this.bitCount >= 24) {
      // Hamming distance-based sentinel matching (tolerant to bit errors)
      const dist = this.popcount(this.shiftReg ^ this.sentinel);
      if (dist <= this.sentinelHammingThreshold) {
        this.collecting = true;
        this.byteAccum = 0;
      }
    }

    // Debug: log every 1000 bits scanned without hit
    if (this.bitCount > 0 && this.bitCount % 1000 === 0 && !this.collecting) {
      console.warn(
        `[RX-SCAN] ${this.bitCount} bits scanned, no sentinel (sr=0x${this.shiftReg.toString(16)})`,
      );
    }
  }

  getState(): string {
    return this.collecting ? 'COLLECTING' : 'SCANNING';
  }

  getByteLog(): ByteLogEntry[] {
    return this.byteLog.slice(-this.maxByteLog);
  }

  getShiftRegHistory(): ShiftRegEntry[] {
    return this.shiftRegHistory.slice(-this.maxRegHistory);
  }

  /** Count set bits in a 24-bit integer */
  private popcount(x: number): number {
    x = (x & 0xffffff) >>> 0;
    let count = 0;
    while (x) {
      count += x & 1;
      x >>>= 1;
    }
    return count;
  }
}
