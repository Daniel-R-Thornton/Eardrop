/**
 * Protocol — preamble packet for file transfer.
 *
 * Preamble is prepended to every file before modem encoding.
 * The receiver parses it first to recover file metadata and verify integrity.
 *
 * Wire format (little-endian):
 * ┌──────────┬────────────────┬────────────┬──────────┬──────────────┐
 * │ nameLen  │ fileName (UTF8)│ totalSize  │ crc32    │ payload      │
 * │ (2B LE)  │ (nameLen B)    │ (4B LE)    │ (4B LE)  │ (totalSize B)│
 * └──────────┴────────────────┴────────────┴──────────┴──────────────┘
 */

import { crc32 } from "./crc32";

export interface FilePreamble {
  fileName: string;
  totalSize: number;   // payload byte count (after preamble)
  crc32: number;       // CRC-32 of the payload bytes
}

/** Size of the fixed header fields (nameLen + totalSize + crc32) */
const FIXED_HEADER_BYTES = 2 + 4 + 4;

/** Total preamble size = fixed header + variable-length file name */
export function preambleSize(nameLen: number): number {
  return FIXED_HEADER_BYTES + nameLen;
}

/**
 * Encode preamble + payload into one Uint8Array.
 * The caller should pass this entire buffer to the modem encoder.
 */
export function buildPacket(
  fileName: string,
  payload: Uint8Array,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(fileName);
  const psize = preambleSize(nameBytes.length);
  const packet = new Uint8Array(psize + payload.length);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  let off = 0;
  view.setUint16(off, nameBytes.length, true); off += 2;
  packet.set(nameBytes, off);                   off += nameBytes.length;
  view.setUint32(off, payload.length, true);    off += 4;
  view.setUint32(off, crc32(payload), true);    off += 4;
  packet.set(payload, off);

  return packet;
}

/** Result of trying to parse a preamble from the front of a buffer. */
export interface ParseResult {
  preamble: FilePreamble;
  /** How many bytes the preamble consumed (nameLen + 10) */
  consumed: number;
}

/**
 * Scan for a valid preamble anywhere in `data`.
 * Returns `null` if the buffer is too short or no valid preamble found.
 * On success, `consumed` includes any garbage bytes skipped before the preamble.
 */
export function tryParsePreamble(data: Uint8Array): ParseResult | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Try each possible start offset
  for (let off = 0; off <= data.length - 2; off++) {
    const nameLen = view.getUint16(off, true);

    // Basic sanity: filename must be between 1 and 255 bytes
    if (nameLen === 0 || nameLen > 255) continue;

    const total = off + preambleSize(nameLen);
    if (data.length < total) return null; // need more data

    const totalSize = view.getUint32(off + 2 + nameLen, true);
    if (totalSize === 0 || totalSize > 10_485_760) continue;

    const nameBytes = data.slice(off + 2, off + 2 + nameLen);
    const fileName = new TextDecoder().decode(nameBytes);

    // Quick sanity on filename: must be printable ASCII
    if (!/^[\x20-\x7e.]+$/.test(fileName)) continue;

    const expectedCrc = view.getUint32(off + 2 + nameLen + 4, true);

    // Must have the full payload to verify CRC — otherwise keep scanning
    const payloadStart = off + preambleSize(nameLen);
    const payloadEnd = payloadStart + totalSize;
    if (data.length < payloadEnd) continue; // need more data, skip this candidate

    const payload = data.slice(payloadStart, payloadEnd);
    if (crc32(payload) !== expectedCrc) continue; // CRC mismatch, keep scanning

    return {
      preamble: { fileName, totalSize, crc32: expectedCrc },
      consumed: payloadStart,
    };
  }

  return null;
}

/**
 * Verify payload CRC against the preamble.
 * Returns `true` if the CRC matches.
 */
export function verifyPayload(preamble: FilePreamble, payload: Uint8Array): boolean {
  if (payload.length !== preamble.totalSize) return false;
  return crc32(payload) === preamble.crc32;
}
