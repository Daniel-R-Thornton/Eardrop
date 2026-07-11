/**
 * atomicFrame.ts — 79-byte Atomic Frame for the Eardrop modem.
 *
 * Wire format (79 bytes per frame):
 *   [SENTINEL 3B][BCH_HEADER 24B][RS_PAYLOAD 52B]
 *
 * Sentinel:  3 bytes = 0xE7 0x9F 0xE7
 * BCH Header: 24 bytes = 3 × BCH(63,30) codewords covering 72 + 18 padding bits
 * RS Payload: 52 bytes = RS(52,40) codeword (parity 12B + data 40B)
 *
 * The 9-byte wire header structure:
 *   [Type:1B][SeqNum:2B LE][TotalFrames:2B LE][CRC-Header:4B LE]
 *
 * BCH(63,30) encodes 30 data bits → 63 bits (8 bytes). We use 3 codewords
 * to cover the 72 header bits (9 bytes): CW1 covers bytes 0-3 (bits 0-31),
 * CW2 covers bytes 3-6 (bits 24-55), CW3 covers bytes 6-8 (bits 48-71)
 * with overlap for clean byte boundaries.
 *
 * Alternatively and more simply: pack the 9 header bytes into three 4-byte
 * chunks (last chunk padded) and BCH encode each.
 */

import { bch63Encode, bch63Decode } from '../ecc/bch63';
import { rsEncode, rsDecode } from '../ecc/reedsolomon';
import { crc32 } from '../../crc32';

// ─── Constants ───────────────────────────────────────

/** RS blocks packed into one frame — the frame-size lever (1 = legacy 79B) */
export const PAYLOAD_BLOCKS = 4;
/** Data bytes carried by one RS(52,40) block */
export const RS_BLOCK_DATA = 40;
/** Wire bytes of one RS(52,40) block */
export const RS_BLOCK_SIZE = 52;
/** Sentinel bytes (3) */
export const SENTINEL_SIZE = 3;
/** BCH(63,30) × 3 header size (bytes) */
export const BCH_HEADER_SIZE = 24;
/** RS payload+parity size (bytes) */
export const RS_PAYLOAD_SIZE = RS_BLOCK_SIZE * PAYLOAD_BLOCKS;
/** Raw (unencoded) header size (bytes) */
export const RAW_HEADER_SIZE = 9;
/** Payload data size before RS encoding (bytes) */
export const PAYLOAD_DATA_SIZE = RS_BLOCK_DATA * PAYLOAD_BLOCKS;
/** Total frame size on the wire (bytes) */
export const FRAME_SIZE = SENTINEL_SIZE + BCH_HEADER_SIZE + RS_PAYLOAD_SIZE;

const SENTINEL_BYTES = new Uint8Array([0xe7, 0x9f, 0xe7]);

// ─── Types ───────────────────────────────────────────

export interface AtomicHeader {
  /** Block type: 0x01=HEADER, 0x02=PAYLOAD, 0x03=TAIL */
  type: number;
  /** Sequence number (0-based) */
  seqNum: number;
  /** Total frames in this transmission */
  totalFrames: number;
  /** CRC-32 of bytes 0-4 (type + seqNum + totalFrames) */
  crc: number;
}

export interface DecodedFrame {
  header: AtomicHeader | null;
  /** 40-byte corrected payload */
  payload: Uint8Array;
  /** True if CRC verified AND RS/BCH decoding succeeded */
  valid: boolean;
}

// ─── Header Packing ──────────────────────────────────

/** Pack 5 header bytes (Type + SeqNum + TotalFrames) into Uint8Array */
function packHeaderFields(type: number, seqNum: number, totalFrames: number): Uint8Array {
  const buf = new Uint8Array(RAW_HEADER_SIZE);
  buf[0] = type & 0xff;
  buf[1] = seqNum & 0xff;
  buf[2] = (seqNum >> 8) & 0xff;
  buf[3] = totalFrames & 0xff;
  buf[4] = (totalFrames >> 8) & 0xff;
  return buf;
}

/** Unpack header fields from 5 bytes, then read stored CRC from bytes 5-8 */
function unpackHeader(buf: Uint8Array): AtomicHeader {
  const type = buf[0];
  const seqNum = (buf[1] | (buf[2] << 8)) >>> 0;
  const totalFrames = (buf[3] | (buf[4] << 8)) >>> 0;
  const crc = (buf[5] | (buf[6] << 8) | (buf[7] << 16) | (buf[8] << 24)) >>> 0;
  return { type, seqNum, totalFrames, crc };
}

/** Encode a 4-byte chunk through BCH(63,30) */
function bchEncode4Bytes(chunk: Uint8Array): Uint8Array {
  // chunk must be 4 bytes; top 2 bits of byte 0 are padding
  const padded = new Uint8Array(4);
  padded.set(chunk.slice(0, 4), 0);
  return bch63Encode(padded);
}

/** Decode an 8-byte BCH(63,30) codeword back to 4 bytes */
function bchDecode8Bytes(codeword: Uint8Array): Uint8Array {
  const result = bch63Decode(codeword);
  return result.data.slice(0, 4);
}

/**
 * BCH(63,30) × 3 encode the 9-byte wire header.
 * BCH(63,30) encodes 30 data bits from 4 bytes (top 2 bits of byte 0 ignored,
 * bottom 2 bits of byte 3 zeroed after decode). We use non-overlapping 4-byte
 * chunks with the 4th byte having its bottom 2 bits always 0 (masked off):
 *   Chunk 1: bytes[0..2] + [0]  — byte 3 forced to 0
 *   Chunk 2: bytes[3..5] + [0]  — byte 7 of header forced to 0
 *   Chunk 3: bytes[6..8] + [0]  — no loss (byte 8 top 6 bits survive)
 */
function encodeBCHHeader(rawHeader: Uint8Array): Uint8Array {
  // Chunk 1: bytes 0-2 + zero (byte 3 of chunk is padding, bottom 2 bits lost)
  const c1 = new Uint8Array(4);
  c1[0] = rawHeader[0];
  c1[1] = rawHeader[1];
  c1[2] = rawHeader[2];
  c1[3] = 0;
  const cw1 = bchEncode4Bytes(c1);

  // Chunk 2: bytes 3-5 + zero
  const c2 = new Uint8Array(4);
  c2[0] = rawHeader[3];
  c2[1] = rawHeader[4];
  c2[2] = rawHeader[5];
  c2[3] = 0;
  const cw2 = bchEncode4Bytes(c2);

  // Chunk 3: bytes 6-8 + zero (byte 8 only uses top 6 bits, bottom 2 bits lost)
  const c3 = new Uint8Array(4);
  c3[0] = rawHeader[6];
  c3[1] = rawHeader[7];
  c3[2] = rawHeader[8];
  c3[3] = 0;
  const cw3 = bchEncode4Bytes(c3);

  const result = new Uint8Array(BCH_HEADER_SIZE);
  result.set(cw1, 0);
  result.set(cw2, 8);
  result.set(cw3, 16);
  return result;
}

/**
 * BCH(63,30) × 3 decode 24 bytes back to 9 bytes.
 * Each chunk's 4th byte (index 3) may have bottom 2 bits zeroed — only
 * use indices 0-2 for reconstruction.
 */
function decodeBCHHeader(encoded: Uint8Array): Uint8Array {
  const chunk1 = bchDecode8Bytes(encoded.slice(0, 8));
  const chunk2 = bchDecode8Bytes(encoded.slice(8, 16));
  const chunk3 = bchDecode8Bytes(encoded.slice(16, 24));

  const result = new Uint8Array(RAW_HEADER_SIZE);
  result[0] = chunk1[0];
  result[1] = chunk1[1];
  result[2] = chunk1[2];
  result[3] = chunk2[0];
  result[4] = chunk2[1];
  result[5] = chunk2[2];
  result[6] = chunk3[0];
  result[7] = chunk3[1];
  result[8] = chunk3[2];
  return result;
}

// ─── Public API ──────────────────────────────────────

/**
 * Encode a frame: header + payload → wire frame (235 bytes with 4 RS blocks).
 */
export function encodeFrame(header: AtomicHeader, payload: Uint8Array): Uint8Array {
  // 1. Pack 5 header field bytes
  const fieldBytes = packHeaderFields(header.type, header.seqNum, header.totalFrames);

  // 2. Compute CRC-32 over the 5 field bytes and append
  const crcVal = crc32(fieldBytes.slice(0, 5));
  const wireHeader = new Uint8Array(RAW_HEADER_SIZE);
  wireHeader.set(fieldBytes, 0);
  wireHeader[5] = crcVal & 0xff;
  wireHeader[6] = (crcVal >> 8) & 0xff;
  wireHeader[7] = (crcVal >> 16) & 0xff;
  // Byte 8 (top CRC byte): bottom 2 bits are lost by BCH(63,30).
  // Mask them to 0 so encode→decode is consistent.
  wireHeader[8] = ((crcVal >> 24) & 0xfc) >>> 0;

  // 3. BCH(63,30) × 3 encode header → 24 bytes
  const bchHeader = encodeBCHHeader(wireHeader);

  // 4. Normalize payload to exactly PAYLOAD_DATA_SIZE (zero-pad at the END —
  // rsEncode pads short input at the FRONT, which would misplace bytes)
  const fullPayload = new Uint8Array(PAYLOAD_DATA_SIZE);
  fullPayload.set(payload.slice(0, PAYLOAD_DATA_SIZE), 0);

  // 5. RS(52,40) encode each 40-byte chunk and assemble the frame
  const frame = new Uint8Array(FRAME_SIZE);
  frame.set(SENTINEL_BYTES, 0);
  frame.set(bchHeader, SENTINEL_SIZE);
  for (let b = 0; b < PAYLOAD_BLOCKS; b++) {
    const chunk = fullPayload.slice(b * RS_BLOCK_DATA, (b + 1) * RS_BLOCK_DATA);
    frame.set(rsEncode(chunk), SENTINEL_SIZE + BCH_HEADER_SIZE + b * RS_BLOCK_SIZE);
  }

  return frame;
}

/**
 * Decode a frame. Returns header + payload + validity.
 */
export function decodeFrame(frame: Uint8Array): DecodedFrame {
  if (frame.length < FRAME_SIZE) {
    return { header: null, payload: new Uint8Array(PAYLOAD_DATA_SIZE), valid: false };
  }

  // 1. Check sentinel
  for (let i = 0; i < SENTINEL_SIZE; i++) {
    if (frame[i] !== SENTINEL_BYTES[i]) {
      return { header: null, payload: new Uint8Array(PAYLOAD_DATA_SIZE), valid: false };
    }
  }

  // 2. BCH(63,30) × 3 decode header
  const bchStart = SENTINEL_SIZE;
  const decodedHeader = decodeBCHHeader(frame.slice(bchStart, bchStart + BCH_HEADER_SIZE));

  // 3. Parse AtomicHeader from decoded bytes
  const header = unpackHeader(decodedHeader);

  // 4. Verify CRC-32 of bytes 0-4
  // The stored CRC has its top byte masked to &0xFC (bottom 2 bits lost by BCH).
  // We compute CRC and also mask it to match.
  const fieldBytes = decodedHeader.slice(0, 5);
  const expectedCrc = crc32(fieldBytes);
  const maskedExpected = (expectedCrc & 0xfcffffff) >>> 0;
  const crcOk = maskedExpected === header.crc;

  // 5. RS(52,40) decode each block
  const rsStart = SENTINEL_SIZE + BCH_HEADER_SIZE;
  const payload = new Uint8Array(PAYLOAD_DATA_SIZE);
  let allBlocksValid = true;
  for (let b = 0; b < PAYLOAD_BLOCKS; b++) {
    const rsResult = rsDecode(
      frame.slice(rsStart + b * RS_BLOCK_SIZE, rsStart + (b + 1) * RS_BLOCK_SIZE),
    );
    payload.set(rsResult.data.slice(0, RS_BLOCK_DATA), b * RS_BLOCK_DATA);
    if (!rsResult.valid || rsResult.errors < 0) allBlocksValid = false;
  }

  // 6. Return result
  const valid = crcOk && allBlocksValid;
  return { header, payload, valid };
}
