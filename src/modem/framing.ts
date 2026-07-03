/**
 * framing.ts — Self-framing block protocol.
 *
 * Every logical unit (squawk, config, dictionary, payload, EOF) is wrapped
 * in a frame with sentinel + type + length + data + CRC.
 *
 * The decoder uses a bit-level sliding window scanner so it can find block
 * boundaries even without symbol alignment. Each block is independently
 * validated by CRC — corrupt blocks are silently discarded.
 *
 * Block wire format (little-endian):
 *   [SENTINEL: 2B] [TYPE: 1B] [LEN: 2B] [DATA: N B] [CRC16: 2B]
 *
 * Sentinel = 0xE79F (16 bits, Hamming distance >= 4 from any shifted copy)
 * CRC-16-CCITT over (TYPE + LEN + DATA)
 */

// ─── Block Types ──────────────────────────────────────

export const BLOCK_TYPE = {
  SQUAWK: 0x01,       // Calibration beacon
  CONFIG: 0x02,       // File metadata header
  DICTIONARY: 0x03,   // Adaptive dictionary entries
  PAYLOAD: 0x04,      // Compressed file data chunk
  EOF: 0xFF,          // End of transmission marker
} as const;

export type BlockType = (typeof BLOCK_TYPE)[keyof typeof BLOCK_TYPE];

export const SENTINEL = 0x8888;
export const SENTINEL_BYTES = 2;
export const BLOCK_HEADER_BYTES = 5;   // type(1) + len(2) + sentinel(2)
export const BLOCK_FOOTER_BYTES = 2;   // crc(2)
export const BLOCK_OVERHEAD = SENTINEL_BYTES + BLOCK_HEADER_BYTES - SENTINEL_BYTES + BLOCK_FOOTER_BYTES; // 5
// Actually: sentinel(2) + type(1) + len(2) + crc(2) = 7 bytes overhead total
export const BLOCK_TOTAL_OVERHEAD = SENTINEL_BYTES + 1 + 2 + 2; // 7

// ─── CRC-16-CCITT ─────────────────────────────────────

let crcTable: Uint16Array | null = null;

function buildCrcTable(): Uint16Array {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1);
    }
    t[i] = c & 0xFFFF;
  }
  return t;
}

function crc16(data: Uint8Array): number {
  if (!crcTable) crcTable = buildCrcTable();
  let c = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    c = ((c << 8) ^ crcTable[((c >> 8) ^ data[i]) & 0xFF]) & 0xFFFF;
  }
  return c ^ 0xFFFF;
}

// ─── Block Encoder ────────────────────────────────────

export interface EncodedBlock {
  /** Serialized block bytes (sentinel + header + data + crc), ready for ECC */
  bytes: Uint8Array;
  /** Total bit count (bytes * 8) */
  bitLength: number;
}

/**
 * Wrap raw data into a framed block.
 * The caller provides the block type and data bytes.
 * Returns the complete serialized block.
 */
export function encodeBlock(type: BlockType, data: Uint8Array): EncodedBlock {
  // sentinel(2) + type(1) + len(2) + data(N) + crc(2)
  const len = data.length;
  const buf = new Uint8Array(BLOCK_TOTAL_OVERHEAD + len);

  let off = 0;

  // Sentinel (big-endian)
  buf[off++] = (SENTINEL >> 8) & 0xFF;
  buf[off++] = SENTINEL & 0xFF;

  // Block type
  buf[off++] = type;

  // Data length (little-endian)
  buf[off++] = len & 0xFF;
  buf[off++] = (len >> 8) & 0xFF;

  // Data
  buf.set(data, off);
  off += len;

  // CRC-16 over type + len + data
  const crcInput = buf.slice(SENTINEL_BYTES, SENTINEL_BYTES + 1 + 2 + len);
  const crc = crc16(crcInput);
  buf[off++] = crc & 0xFF;
  buf[off++] = (crc >> 8) & 0xFF;

  return { bytes: buf, bitLength: buf.length * 8 };
}

/**
 * Decode and verify a framed block from raw bytes.
 * Returns null if CRC fails.
 */
export function decodeBlock(bytes: Uint8Array): { type: BlockType; data: Uint8Array } | null {
  if (bytes.length < BLOCK_TOTAL_OVERHEAD) return null;

  // Verify sentinel
  const sentinel = (bytes[0] << 8) | bytes[1];
  if (sentinel !== SENTINEL) return null;

  const type = bytes[2] as BlockType;
  const len = bytes[3] | (bytes[4] << 8);

  const expectedTotal = BLOCK_TOTAL_OVERHEAD + len;
  if (bytes.length < expectedTotal) return null;
  if (len > 65535 - BLOCK_TOTAL_OVERHEAD) return null;

  // Verify CRC
  const crcInput = bytes.slice(SENTINEL_BYTES, SENTINEL_BYTES + 1 + 2 + len);
  const expectedCrc = (bytes[5 + len] | (bytes[5 + len + 1] << 8)) & 0xFFFF;
  if (crc16(crcInput) !== expectedCrc) return null;

  const data = bytes.slice(SENTINEL_BYTES + 1 + 2, SENTINEL_BYTES + 1 + 2 + len);
  return { type, data };
}

// ─── Block Decoder (Bit-Level Sentinel Scanner) ───────

export interface PendingBlock {
  type: number;
  len: number;
  data: number[];       // raw bits (8 per byte)
  crc: number;
}

export type BlockScanPhase = 'SCAN' | 'HEADER' | 'DATA' | 'CRC';

export interface BlockEvent {
  type: number;
  data: Uint8Array;
  /** Index in the bit stream where this block was found */
  bitOffset: number;
}

/**
 * Bit-level framed block decoder.
 *
 * Feeds decoded bits one at a time. Maintains a 16-bit sliding shift register
 * to detect the sentinel pattern. On match, reads header, then data, then CRC.
 * Emits completed blocks via onBlock callback.
 *
 * This is the core of the self-framing protocol — it can find block boundaries
 * at any bit offset, making it immune to symbol misalignment.
 */
export class FramedBlockDecoder {
  /** 16-bit sliding window for sentinel detection */
  private shiftReg = 0;
  private bitCount = 0;

  private phase: BlockScanPhase = 'SCAN';
  private pending: PendingBlock | null = null;

  /** Bytes being accumulated for the current field */
  private byteAccum = 0;
  private byteBits = 0;
  private bytesCollected: number[] = [];

  /** How many bytes to read before advancing to next phase */
  private expectedBytes = 0;

  /** Total bits fed since last reset */
  totalBits = 0;
  /** Number of blocks successfully decoded */
  blocksDecoded = 0;
  /** Number of blocks discarded due to CRC failure */
  blocksCrcFailed = 0;
  /** Number of blocks discarded due to insane length */
  blocksLenRejected = 0;

  /** Maximum allowed data payload per block (safety limit) */
  maxBlockDataBytes = 4096;

  onBlock: ((event: BlockEvent) => void) | null = null;

  /** Feed one bit (0 or 1). The scanner state machine processes it. */
  feedBit(bit: number): void {
    this.totalBits++;

    // Update shift register
    this.shiftReg = ((this.shiftReg << 1) | (bit & 1)) & 0xFFFF;
    this.bitCount++;

    switch (this.phase) {
      case 'SCAN':
        if (this.bitCount >= 16 && this.shiftReg === SENTINEL) {
          this.phase = 'HEADER';
          this.byteAccum = 0;
          this.byteBits = 0;
          this.bytesCollected = [];
          this.expectedBytes = 3; // type(1) + len(2)
        }
        break;

      case 'HEADER':
        this.byteAccum = (this.byteAccum << 1) | (bit & 1);
        this.byteBits++;
        if (this.byteBits >= 8) {
          this.bytesCollected.push(this.byteAccum);
          this.byteAccum = 0;
          this.byteBits = 0;
          this.expectedBytes--;

          if (this.expectedBytes <= 0) {
            // We have type + len
            const type = this.bytesCollected[0];
            const len = (this.bytesCollected[1] | (this.bytesCollected[2] << 8));

            if (len > this.maxBlockDataBytes) {
              // Insane length — discard, resume scan
              this.blocksLenRejected++;
              this.phase = 'SCAN';
              this.bytesCollected = [];
              break;
            }

            this.pending = { type, len, data: [], crc: 0 };
            this.phase = 'DATA';
            this.expectedBytes = len;
            this.bytesCollected = [];
          }
        }
        break;

      case 'DATA':
        this.byteAccum = (this.byteAccum << 1) | (bit & 1);
        this.byteBits++;
        if (this.byteBits >= 8) {
          this.bytesCollected.push(this.byteAccum);
          this.byteAccum = 0;
          this.byteBits = 0;
          this.expectedBytes--;

          if (this.expectedBytes <= 0) {
            this.pending!.data = this.bytesCollected;
            this.phase = 'CRC';
            this.expectedBytes = 2;
            this.bytesCollected = [];
          }
        }
        break;

      case 'CRC':
        this.byteAccum = (this.byteAccum << 1) | (bit & 1);
        this.byteBits++;
        if (this.byteBits >= 8) {
          this.bytesCollected.push(this.byteAccum);
          this.byteAccum = 0;
          this.byteBits = 0;
          this.expectedBytes--;

          if (this.expectedBytes <= 0) {
            const pb = this.pending!;
            const crc = (this.bytesCollected[0] | (this.bytesCollected[1] << 8)) & 0xFFFF;

            // Verify CRC over type + len + data
            const crcInput = new Uint8Array(1 + 2 + pb.data.length);
            crcInput[0] = pb.type;
            crcInput[1] = pb.len & 0xFF;
            crcInput[2] = (pb.len >> 8) & 0xFF;
            for (let i = 0; i < pb.data.length; i++) {
              crcInput[3 + i] = pb.data[i];
            }

            if (crc16(crcInput) === crc) {
              this.blocksDecoded++;
              const data = new Uint8Array(pb.data);
              if (this.onBlock) {
                this.onBlock({
                  type: pb.type,
                  data,
                  bitOffset: this.totalBits - (7 + 2 + pb.len + 2) * 8,
                });
              }
            } else {
              this.blocksCrcFailed++;
            }

            // Reset to scan for next block
            this.phase = 'SCAN';
            this.pending = null;
            this.bytesCollected = [];
          }
        }
        break;
    }
  }

  /** Feed up to 8 bits at once from a symbol value. Bits are MSB-first. */
  feedSymbol(symbolBits: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.feedBit((symbolBits >> i) & 1);
    }
  }

  /** Feed an array of bit values. */
  feedBits(bits: readonly number[]): void {
    for (const b of bits) {
      this.feedBit(b);
    }
  }

  /** Feed a Uint8Array as a stream of bits. */
  feedBytes(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.feedSymbol(byte, 8);
    }
  }

  /** Reset the scanner state. */
  reset(): void {
    this.shiftReg = 0;
    this.bitCount = 0;
    this.phase = 'SCAN';
    this.pending = null;
    this.byteAccum = 0;
    this.byteBits = 0;
    this.bytesCollected = [];
    this.expectedBytes = 0;
    this.totalBits = 0;
    this.blocksDecoded = 0;
    this.blocksCrcFailed = 0;
    this.blocksLenRejected = 0;
  }

  /** Get current scan phase for debug display */
  getPhase(): BlockScanPhase { return this.phase; }
}
