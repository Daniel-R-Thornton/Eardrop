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
import { dlog } from '../../lib/debug/dlog';

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
  /** Bytes collected after the 3-byte sentinel (defaults to a full atomic frame).
   *  Mutable so `continueCollecting` can retarget it for a second, contiguous
   *  collection (see below) — otherwise fixed for the scanner's lifetime. */
  private collectBytes: number;
  /** `collectBytes`'s original (header) value — restored after each
   *  `continueCollecting` run completes, so the NEXT sentinel hit collects a
   *  header again rather than another payload-sized run. */
  private readonly headerCollectBytes: number;
  /**
   * True while collecting the SECOND (extra) run requested via
   * `continueCollecting` — e.g. a control message's payload wire bytes,
   * collected right after its header with no new sentinel in between. Fires
   * `onExtraFrame` (raw bytes, no synthesized sentinel prefix) instead of
   * `onFrame` when that run completes.
   */
  private collectingExtra = false;

  /** Hamming distance threshold for sentinel matching (allows bit errors) */
  private readonly sentinelHammingThreshold = 2;

  // Debug ring buffers
  public byteLog: ByteLogEntry[] = [];
  private maxByteLog = 256;

  public shiftRegHistory: ShiftRegEntry[] = [];
  private maxRegHistory = 64;

  onFrame: ((frameBytes: Uint8Array) => void) | null = null;
  /** Fires for a `continueCollecting` run — see `collectingExtra`. */
  onExtraFrame: ((bytes: Uint8Array) => void) | null = null;

  /** @param collectBytes bytes to collect after the sentinel — defaults to a full atomic frame */
  constructor(collectBytes: number = FRAME_SIZE - 3) {
    this.collectBytes = collectBytes;
    this.headerCollectBytes = collectBytes;
  }

  reset(): void {
    this.shiftReg = 0;
    this.bitCount = 0;
    this.collecting = false;
    this.collectingExtra = false;
    this.byteAccum = 0;
    this.byteBits = 0;
    this.buf = [];
    this.bitsCollected = 0;
    // A reset mid-payload-collection must not leave collectBytes stuck at
    // the payload size — the next sentinel hit is always a header.
    this.collectBytes = this.headerCollectBytes;
  }

  /**
   * Call from within `onFrame` to keep collecting `byteCount` MORE bytes
   * immediately (no new sentinel search) instead of returning to scanning —
   * e.g. a control message's BCH header (`onFrame`) telling the scanner its
   * payload length, so the payload wire bytes (`onExtraFrame`) are collected
   * right after with no sentinel of their own. The completed run always
   * starts from an empty buffer (the caller's `buf = []` right after
   * `onFrame` returns), so `collectBytes` can simply be retargeted here.
   */
  continueCollecting(byteCount: number): void {
    this.collectBytes = byteCount;
    this.collecting = true;
    this.collectingExtra = true;
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
        if (this.collectingExtra) {
          this.collectingExtra = false;
          dlog('RX-SCAN', { extraFrame: this.buf.length });
          const extraBytes = new Uint8Array(this.buf.slice(0, this.collectBytes));
          this.collectBytes = this.headerCollectBytes; // next sentinel hit collects a header again
          if (this.onExtraFrame) this.onExtraFrame(extraBytes);
        } else {
          const fullFrame = new Uint8Array(3 + this.collectBytes);
          fullFrame[0] = 0xe7;
          fullFrame[1] = 0x9f;
          fullFrame[2] = 0xe7;
          for (let i = 0; i < this.buf.length && i < this.collectBytes; i++) {
            fullFrame[3 + i] = this.buf[i];
          }
          dlog('RX-SCAN', { frame: this.buf.length });
          if (this.onFrame) {
            this.onFrame(fullFrame);
          }
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

    // Debug: heartbeat every 8000 bits scanned without a sentinel hit
    if (this.bitCount > 0 && this.bitCount % 8000 === 0 && !this.collecting) {
      dlog('RX-SCAN', {
        bits: this.bitCount,
        sr: `0x${this.shiftReg.toString(16)}`,
      });
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
