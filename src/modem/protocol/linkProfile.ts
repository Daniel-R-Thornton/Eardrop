/**
 * linkProfile.ts — pack/unpack for the PROFILE (0x04) atomic frame payload.
 *
 * Announces how the rest of a transmission is encoded: per-tone QAM order,
 * ECC rate (RS t), and cyclic-prefix id. Carried inside the base-rate
 * (all-QPSK, RS t=6, 5ms CP) 160-byte atomic frame payload so it always
 * decodes before the receiver knows anything about the adaptive scheme.
 *
 * Wire layout (see plan Phase 4):
 *   [ver:1][flags:1][eccT:1][cpId:1][toneCount:1]
 *   [qamMap: ceil(toneCount*2/8) bytes]  // 2 bits/tone, LSB-first within byte
 *                                        // 0=QPSK 1=16QAM 2=64QAM 3=reserved
 *   [crc32:4 LE]                         // over all preceding profile bytes
 *   [zero pad to 160]
 */

import { crc32 } from '../../crc32';
import { PAYLOAD_DATA_SIZE } from './atomicFrame';

/** Current profile payload version. */
export const LINK_PROFILE_VERSION = 1;

/** QAM order per tone, as carried in the 2-bit qamMap. */
export enum QamOrder {
  QPSK = 0,
  QAM16 = 1,
  QAM64 = 2,
  RESERVED = 3,
}

export interface LinkProfile {
  /** Payload version (always 1 for now). */
  ver: number;
  /** Reserved flag bits — 0 for this phase. */
  flags: number;
  /** Reed-Solomon error-correction parameter t (symbols correctable per block). */
  eccT: number;
  /** Cyclic-prefix id: 0 = 5ms CP (today's default). */
  cpId: number;
  /** Number of OFDM data tones this profile describes. */
  toneCount: number;
  /** Per-tone QAM order (length === toneCount), values 0-3 (see QamOrder). */
  qamMap: number[];
}

/** Base/default link profile — exactly today's modulation (all-QPSK, t=6, 5ms CP). */
export function DEFAULT_LINK_PROFILE(toneCount: number): LinkProfile {
  return {
    ver: LINK_PROFILE_VERSION,
    flags: 0,
    eccT: 6,
    cpId: 0,
    toneCount,
    qamMap: new Array(toneCount).fill(QamOrder.QPSK),
  };
}

/** Fixed header length (ver+flags+eccT+cpId+toneCount) before the qamMap. */
const PROFILE_HEADER_LEN = 5;
/** crc32 field length. */
const CRC_LEN = 4;

/** Bytes needed to pack `toneCount` tones at 2 bits/tone. */
function qamMapBytes(toneCount: number): number {
  return Math.ceil((toneCount * 2) / 8);
}

/**
 * Pack a LinkProfile into a 160-byte (PAYLOAD_DATA_SIZE) profile payload,
 * zero-padded at the end.
 */
export function packLinkProfile(p: LinkProfile): Uint8Array {
  const mapLen = qamMapBytes(p.toneCount);
  const preCrcLen = PROFILE_HEADER_LEN + mapLen;
  const buf = new Uint8Array(PAYLOAD_DATA_SIZE);

  buf[0] = p.ver & 0xff;
  buf[1] = p.flags & 0xff;
  buf[2] = p.eccT & 0xff;
  buf[3] = p.cpId & 0xff;
  buf[4] = p.toneCount & 0xff;

  for (let t = 0; t < p.toneCount; t++) {
    const byteIdx = PROFILE_HEADER_LEN + (t >> 2);
    const bitOff = (t & 3) * 2;
    const order = (p.qamMap[t] ?? QamOrder.QPSK) & 0x3;
    buf[byteIdx] |= order << bitOff;
  }

  const crcVal = crc32(buf.slice(0, preCrcLen));
  buf[preCrcLen] = crcVal & 0xff;
  buf[preCrcLen + 1] = (crcVal >> 8) & 0xff;
  buf[preCrcLen + 2] = (crcVal >> 16) & 0xff;
  buf[preCrcLen + 3] = (crcVal >> 24) & 0xff;

  // Remaining bytes (preCrcLen + CRC_LEN .. end) are already zero.
  return buf;
}

/**
 * Parse a profile payload. Returns null (never throws) on:
 *   - too-short input to hold the fixed header,
 *   - unsupported version,
 *   - too-short input to hold the qamMap + crc for the declared toneCount,
 *   - crc32 mismatch.
 */
export function parseLinkProfile(payload: Uint8Array): LinkProfile | null {
  if (!payload || payload.length < PROFILE_HEADER_LEN) return null;

  const ver = payload[0];
  if (ver !== LINK_PROFILE_VERSION) return null;

  const flags = payload[1];
  const eccT = payload[2];
  const cpId = payload[3];
  const toneCount = payload[4];

  const mapLen = qamMapBytes(toneCount);
  const preCrcLen = PROFILE_HEADER_LEN + mapLen;
  if (payload.length < preCrcLen + CRC_LEN) return null;

  const storedCrc =
    (payload[preCrcLen] |
      (payload[preCrcLen + 1] << 8) |
      (payload[preCrcLen + 2] << 16) |
      (payload[preCrcLen + 3] << 24)) >>>
    0;
  const computedCrc = crc32(payload.slice(0, preCrcLen));
  if (computedCrc !== storedCrc) return null;

  const qamMap: number[] = new Array(toneCount);
  for (let t = 0; t < toneCount; t++) {
    const byteIdx = PROFILE_HEADER_LEN + (t >> 2);
    const bitOff = (t & 3) * 2;
    qamMap[t] = (payload[byteIdx] >> bitOff) & 0x3;
  }

  return { ver, flags, eccT, cpId, toneCount, qamMap };
}
