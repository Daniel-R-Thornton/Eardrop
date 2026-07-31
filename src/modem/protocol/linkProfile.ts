/**
 * linkProfile.ts — pack/unpack for the PROFILE (0x04) atomic frame payload.
 *
 * Announces how the rest of a transmission is encoded: per-tone QAM order,
 * ECC rate (RS t), and cyclic-prefix id. Carried inside the base-rate
 * (all-QPSK, RS t=6, 5ms CP) 160-byte atomic frame payload so it always
 * decodes before the receiver knows anything about the adaptive scheme.
 *
 * Wire layout v2 (v1 in parentheses where it differs):
 *   [ver:1][flags:1][eccT:1][cpId:1][toneCount:1]
 *   [pilotFreqHz:2 LE][toneStartHz:2 LE]  // v2 only — the TARGET BAND, so a
 *                                         // receiver listening on the fixed
 *                                         // handshake band learns where the
 *                                         // data band is from the air
 *   [qamMap: ceil(toneCount*2/8) bytes]  // 2 bits/tone, LSB-first within byte
 *                                        // 0=QPSK 1=16QAM 2=64QAM 3=reserved
 *   [crc32:4 LE]                         // over all preceding profile bytes
 *   [zero pad to 160]
 *
 * flags bit 0 (LINK_PROFILE_FLAG_BAND_HOP): a second preamble (settle +
 * training) follows the profile frames IN THE ANNOUNCED BAND — the receiver
 * must retune and retrain before the header frame.
 */

import { crc32 } from '../../crc32';
import { PAYLOAD_DATA_SIZE } from './atomicFrame';
import {
  qamMapValueToOrder,
  orderToQamMapValue,
  type QamOrder as ConstellationQamOrder,
} from '../modulation/constellation';

/** Current profile payload version. */
export const LINK_PROFILE_VERSION = 2;

/** Oldest payload version parseLinkProfile still accepts. */
export const LINK_PROFILE_MIN_VERSION = 1;

/**
 * flags bit 0: the transmission hops to the announced band after the profile
 * frames — a second settle+training preamble follows at pilotFreqHz /
 * toneStartHz / toneCount, then the data frames.
 */
export const LINK_PROFILE_FLAG_BAND_HOP = 0x01;

/**
 * Repeat count for the PROFILE frame on the wire — cheap insurance since a
 * lost profile kills interpretation of the whole transmission. Shared
 * between txEngine (how many copies to send) and rxEngine (how many valid
 * decodes to wait for before switching demod tone orders — see rxEngine's
 * FRAME_TYPE_PROFILE handling doc: RX must not switch mid-repeat, since
 * every copy is transmitted at the base rate).
 */
export const PROFILE_FRAME_REPEATS = 2;

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
  /**
   * TARGET pilot frequency in Hz (v2). 0 = not announced (v1 payloads) —
   * receiver stays on its configured band.
   */
  pilotFreqHz: number;
  /** TARGET tone-grid start, Hz above the pilot (v2). 0 = not announced. */
  toneStartHz: number;
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
    pilotFreqHz: 0,
    toneStartHz: 0,
    qamMap: new Array(toneCount).fill(QamOrder.QPSK),
  };
}

/** Fixed v1 header length (ver+flags+eccT+cpId+toneCount) before the qamMap. */
const PROFILE_HEADER_LEN_V1 = 5;
/** v2 adds pilotFreqHz + toneStartHz, 2 bytes LE each. */
const PROFILE_HEADER_LEN_V2 = PROFILE_HEADER_LEN_V1 + 4;
/** crc32 field length. */
const CRC_LEN = 4;

function headerLen(ver: number): number {
  return ver >= 2 ? PROFILE_HEADER_LEN_V2 : PROFILE_HEADER_LEN_V1;
}

/** Bytes needed to pack `toneCount` tones at 2 bits/tone. */
function qamMapBytes(toneCount: number): number {
  return Math.ceil((toneCount * 2) / 8);
}

/**
 * Pack a LinkProfile into a 160-byte (PAYLOAD_DATA_SIZE) profile payload,
 * zero-padded at the end.
 */
export function packLinkProfile(p: LinkProfile): Uint8Array {
  // Always emit the CURRENT version — v1 exists only on the parse side.
  const ver = LINK_PROFILE_VERSION;
  const hdrLen = headerLen(ver);
  const mapLen = qamMapBytes(p.toneCount);
  const preCrcLen = hdrLen + mapLen;
  const buf = new Uint8Array(PAYLOAD_DATA_SIZE);

  buf[0] = ver & 0xff;
  buf[1] = p.flags & 0xff;
  buf[2] = p.eccT & 0xff;
  buf[3] = p.cpId & 0xff;
  buf[4] = p.toneCount & 0xff;
  buf[5] = p.pilotFreqHz & 0xff;
  buf[6] = (p.pilotFreqHz >> 8) & 0xff;
  buf[7] = p.toneStartHz & 0xff;
  buf[8] = (p.toneStartHz >> 8) & 0xff;

  for (let t = 0; t < p.toneCount; t++) {
    const byteIdx = hdrLen + (t >> 2);
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
  if (!payload || payload.length < PROFILE_HEADER_LEN_V1) return null;

  const ver = payload[0];
  if (ver < LINK_PROFILE_MIN_VERSION || ver > LINK_PROFILE_VERSION) return null;

  const flags = payload[1];
  const eccT = payload[2];
  const cpId = payload[3];
  const toneCount = payload[4];
  const hdrLen = headerLen(ver);
  if (payload.length < hdrLen) return null;

  // v1 has no band fields — 0 means "not announced".
  const pilotFreqHz = ver >= 2 ? payload[5] | (payload[6] << 8) : 0;
  const toneStartHz = ver >= 2 ? payload[7] | (payload[8] << 8) : 0;

  const mapLen = qamMapBytes(toneCount);
  const preCrcLen = hdrLen + mapLen;
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
    const byteIdx = hdrLen + (t >> 2);
    const bitOff = (t & 3) * 2;
    qamMap[t] = (payload[byteIdx] >> bitOff) & 0x3;
  }

  return { ver, flags, eccT, cpId, toneCount, pilotFreqHz, toneStartHz, qamMap };
}

/**
 * Convert a profile's 2-bit-per-tone `qamMap` (0=QPSK/1=16QAM/2=64QAM, 3=
 * reserved) into the bits-per-tone `QamOrder[]` the modulator/demodulator
 * use. Value 3 (reserved, never emitted by packLinkProfile) safely falls
 * back to QPSK rather than throwing — a forward-compat guard for a field
 * that's currently unused.
 */
export function qamMapToOrders(qamMap: number[]): ConstellationQamOrder[] {
  return qamMap.map((v) => {
    const code = (v & 0x3) as 0 | 1 | 2 | 3;
    return code === 3 ? 2 : qamMapValueToOrder(code);
  });
}

/** Inverse of qamMapToOrders: bits-per-tone orders → 2-bit-per-tone qamMap values. */
export function ordersToQamMap(orders: ConstellationQamOrder[]): number[] {
  return orders.map(orderToQamMapValue);
}
