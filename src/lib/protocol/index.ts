/**
 * src/lib/protocol/index.ts
 *
 * File transfer protocol structures.
 * - FilePreamble: metadata prepended to every file
 * - FileBlock: framed data blocks
 * - ProtocolParser: parse and validate protocol messages
 */

import { CRC32 } from '../crc/index';
import { littleEndianPack, littleEndianUnpack } from '../encoding/index';

/**
 * File preamble: metadata about the file being transferred.
 */
export interface FilePreamble {
  fileName: string;
  totalSize: number; // Payload byte count (after preamble header)
  crc32: number; // CRC-32 of payload
}

/**
 * File block: a complete encoded frame with header and payload.
 */
export interface FileBlock {
  type: number; // Block type (e.g., PREAMBLE, DATA, SYNC)
  length: number; // Payload length
  crc16?: number; // Optional CRC-16 for block integrity
  data: Uint8Array; // Block payload
}

/** Size of fixed preamble header (nameLen + totalSize + crc32) */
const FIXED_HEADER_BYTES = 2 + 4 + 4;

/**
 * Calculate total preamble size for a given filename length.
 */
export function preambleSize(nameLen: number): number {
  return FIXED_HEADER_BYTES + nameLen;
}

/**
 * Build a complete packet: preamble + payload.
 * Wire format (little-endian):
 *   [nameLen: 2B] [fileName: nameLen bytes] [totalSize: 4B] [crc32: 4B] [payload: totalSize bytes]
 */
export function buildPacket(fileName: string, payload: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(fileName);
  const psize = preambleSize(nameBytes.length);
  const packet = new Uint8Array(psize + payload.length);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  let offset = 0;
  view.setUint16(offset, nameBytes.length, true);
  offset += 2;
  packet.set(nameBytes, offset);
  offset += nameBytes.length;
  view.setUint32(offset, payload.length, true);
  offset += 4;
  view.setUint32(offset, CRC32.compute(payload), true);
  offset += 4;
  packet.set(payload, offset);

  return packet;
}

/**
 * Result of parsing a preamble from a buffer.
 */
export interface ParseResult {
  preamble: FilePreamble;
  consumed: number; // Bytes consumed from start of buffer
}

/**
 * Parse and validate a preamble from data.
 * Scans for a valid preamble anywhere in the buffer.
 *
 * Returns null if:
 * - Buffer is too short
 * - No valid preamble found
 * - CRC verification fails
 *
 * On success, `consumed` indicates where the payload starts.
 */
export function tryParsePreamble(data: Uint8Array): ParseResult | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Try each possible start offset
  for (let offset = 0; offset <= data.length - 2; offset++) {
    const nameLen = view.getUint16(offset, true);

    // Sanity check: filename must be 1-255 bytes
    if (nameLen === 0 || nameLen > 255) continue;

    const total = offset + preambleSize(nameLen);
    if (data.length < total) return null; // Need more data

    const totalSize = view.getUint32(offset + 2 + nameLen, true);
    if (totalSize === 0 || totalSize > 10_485_760) continue; // 10 MB limit

    const nameBytes = data.slice(offset + 2, offset + 2 + nameLen);
    const fileName = new TextDecoder().decode(nameBytes);

    // Sanity: filename should be printable ASCII
    if (!/^[\x20-\x7e.]+$/.test(fileName)) continue;

    const expectedCrc = view.getUint32(offset + 2 + nameLen + 4, true);

    // Must have full payload to verify CRC
    const payloadStart = offset + preambleSize(nameLen);
    const payloadEnd = payloadStart + totalSize;
    if (data.length < payloadEnd) continue; // Need more data

    const payload = data.slice(payloadStart, payloadEnd);
    if (CRC32.verify(payload, expectedCrc)) {
      return {
        preamble: { fileName, totalSize, crc32: expectedCrc },
        consumed: payloadStart,
      };
    }
    // CRC mismatch; continue scanning
  }

  return null;
}

/**
 * Verify that a received payload matches the preamble CRC.
 */
export function verifyPayload(payload: Uint8Array, expectedCrc: number): boolean {
  return CRC32.verify(payload, expectedCrc);
}
