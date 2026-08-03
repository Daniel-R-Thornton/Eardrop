/**
 * Control frame — small room-control messages on the fixed handshake band.
 *
 * Chatter rooms need to pass WELCOME/REPORT/FILE_COMING/BYE control traffic
 * between devices without ever leaving the handshake band (the same band
 * `bandCard.ts` uses to announce a target-band hop). A control message is a
 * 9-byte BCH-coded header — same sentinel + BCH(63,30)x3 skeleton as the
 * band card — followed by a variable-length BCH-coded payload (0-48 raw
 * bytes, capped so the largest payload, WELCOME's 35 bytes, still fits a
 * handful of codewords):
 *
 *   Header (9 raw bytes, BCH-chunked exactly like the band card):
 *     byte 0  CONTROL_MAGIC (0xC7) — identifies a control header, not a card
 *     byte 1  ControlType
 *     byte 2  senderId (1-255)
 *     byte 3  targetId (0 = broadcast)
 *     byte 4  payloadLen (raw bytes, 0-48)
 *     byte 5  CRC-8 over bytes 0-4
 *     bytes 6-8 reserved (0)
 *
 *   Wire: SENTINEL (3 B) + BCH(63,30)x3 (24 B) = 27 bytes (CONTROL_HEADER_WIRE),
 *   identical shape to BAND_CARD_WIRE_SIZE so both ride the same 8-tone band.
 *
 *   Payload: raw bytes + CRC-16 (low 16 bits of crc32) appended, chunked into
 *   3-byte groups (last group zero-padded) and BCH(63,30)-encoded per group,
 *   same 4th-byte caveat as the header (each chunk is padded to 4 bytes for
 *   bch63Encode; the padding byte carries no data and its low 2 bits are
 *   simply unused on the wire).
 *
 * Payload codecs (WELCOME/REPORT/FILE_COMING) pack their fields with the
 * same table/bin-coding discipline as the band card — see the per-field
 * comments below.
 */
import { bch63Encode, bch63Decode } from '../ecc/bch63';
import { SENTINEL_BYTES, SENTINEL_SIZE, BCH_HEADER_SIZE } from './atomicFrame';
import { crc32 } from '../../lib/crc';
import { BAND_CARD_TONE_COUNTS, BAND_CARD_BIN_HZ } from './bandCard';

/** First control-header byte — distinguishes a control frame from a band card. */
export const CONTROL_MAGIC = 0xc7;

export enum ControlType {
  Welcome = 1,
  Report = 2,
  FileComing = 3,
  Bye = 4,
}

export interface ControlMessage {
  type: ControlType;
  senderId: number; // 1-255
  targetId: number; // 0 = broadcast
  payload: Uint8Array; // 0-48 raw bytes
}

/** Raw (pre-BCH) header size. */
const CONTROL_HEADER_RAW_SIZE = 9;

/** Wire bytes of sentinel + BCH-coded header. */
export const CONTROL_HEADER_WIRE = SENTINEL_SIZE + BCH_HEADER_SIZE; // 27

/** Largest raw payload a control message may carry. */
export const CONTROL_PAYLOAD_MAX = 48;

/** Wire bytes of the BCH-coded payload for a given raw payload length. */
export function controlPayloadWireSize(payloadLen: number): number {
  const chunks = Math.ceil((payloadLen + 2) / 3); // +2 for the appended CRC-16
  return chunks * 8;
}

/** CRC-8 (poly 0x07, init 0) over a byte range — duplicated from bandCard.ts. */
function crc8(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** BCH-encode raw bytes in 3-byte groups (last group zero-padded), 8 B per codeword. */
function bchEncodeChunks(raw: Uint8Array): Uint8Array {
  const chunkCount = Math.ceil(raw.length / 3);
  const out = new Uint8Array(chunkCount * 8);
  for (let c = 0; c < chunkCount; c++) {
    const chunk = new Uint8Array(4);
    for (let i = 0; i < 3; i++) {
      const idx = c * 3 + i;
      if (idx < raw.length) chunk[i] = raw[idx];
    }
    out.set(bch63Encode(chunk), c * 8);
  }
  return out;
}

/**
 * BCH-decode `chunkCount` codewords back to raw bytes (3 per codeword).
 * Returns null if any codeword is uncorrectable.
 */
function bchDecodeChunks(wire: Uint8Array, chunkCount: number): Uint8Array | null {
  const raw = new Uint8Array(chunkCount * 3);
  for (let c = 0; c < chunkCount; c++) {
    const res = bch63Decode(wire.slice(c * 8, (c + 1) * 8));
    if (!res.valid) return null;
    raw[c * 3] = res.data[0];
    raw[c * 3 + 1] = res.data[1];
    raw[c * 3 + 2] = res.data[2];
  }
  return raw;
}

/** Encode a control message to its wire form (sentinel + header + payload). */
export function encodeControlMessage(msg: ControlMessage): Uint8Array {
  if (msg.senderId < 1 || msg.senderId > 255) throw new Error(`control frame: senderId ${msg.senderId} out of range`);
  if (msg.targetId < 0 || msg.targetId > 255) throw new Error(`control frame: targetId ${msg.targetId} out of range`);
  if (msg.payload.length > CONTROL_PAYLOAD_MAX) {
    throw new Error(`control frame: payload ${msg.payload.length} B exceeds ${CONTROL_PAYLOAD_MAX} B cap`);
  }

  const raw = new Uint8Array(CONTROL_HEADER_RAW_SIZE);
  raw[0] = CONTROL_MAGIC;
  raw[1] = msg.type;
  raw[2] = msg.senderId;
  raw[3] = msg.targetId;
  raw[4] = msg.payload.length;
  raw[5] = crc8(raw, 0, 5);

  const headerWire = bchEncodeChunks(raw);

  const crc16 = crc32(msg.payload) & 0xffff;
  const payloadRaw = new Uint8Array(msg.payload.length + 2);
  payloadRaw.set(msg.payload, 0);
  payloadRaw[msg.payload.length] = (crc16 >> 8) & 0xff;
  payloadRaw[msg.payload.length + 1] = crc16 & 0xff;
  const payloadWire = bchEncodeChunks(payloadRaw);

  const wire = new Uint8Array(SENTINEL_SIZE + headerWire.length + payloadWire.length);
  wire.set(SENTINEL_BYTES, 0);
  wire.set(headerWire, SENTINEL_SIZE);
  wire.set(payloadWire, SENTINEL_SIZE + headerWire.length);
  return wire;
}

/**
 * Decode the 24 post-sentinel header bytes. Returns null when the bytes are
 * not a valid control header (BCH uncorrectable, wrong magic, CRC mismatch).
 */
export function decodeControlHeader(
  header24: Uint8Array,
): { type: ControlType; senderId: number; targetId: number; payloadLen: number } | null {
  if (header24.length < BCH_HEADER_SIZE) return null;
  const raw = bchDecodeChunks(header24, 3);
  if (!raw) return null;
  if (raw[0] !== CONTROL_MAGIC) return null;
  if (crc8(raw, 0, 5) !== raw[5]) return null;
  const type = raw[1] as ControlType;
  if (!(type in ControlType)) return null;
  return { type, senderId: raw[2], targetId: raw[3], payloadLen: raw[4] };
}

/**
 * Decode the payload wire bytes (post-header) back to raw payload bytes.
 * Returns null on uncorrectable BCH or CRC-16 mismatch.
 */
export function decodeControlPayload(wire: Uint8Array, payloadLen: number): Uint8Array | null {
  const chunkCount = Math.ceil((payloadLen + 2) / 3);
  if (wire.length < chunkCount * 8) return null;
  const raw = bchDecodeChunks(wire, chunkCount);
  if (!raw) return null;
  const payload = raw.slice(0, payloadLen);
  const crc16 = (raw[payloadLen] << 8) | raw[payloadLen + 1];
  if ((crc32(payload) & 0xffff) !== crc16) return null;
  return payload;
}

// ---- payload codecs ----

export interface BestRangeClaim {
  lowHz: number;
  highHz: number;
  maxQamOrder: number;
}

export interface WelcomePayload {
  claim: BestRangeClaim;
  grid: number[]; // 64 linear mags
}

export interface FileComingPayload {
  pilotFreqHz: number;
  toneStartHz: number;
  toneCount: number;
  settleSymbols: number;
  fileBytes: number;
  durationMs: number;
}

/** Number of points on the report/welcome magnitude grid. */
const GRID_POINTS = 64;

/** Quantized grid packed 2 per byte → this many bytes. */
const GRID_PACKED_BYTES = GRID_POINTS / 2;

/** dB step per quantization code, and the clamp ceiling (code 15). */
const GRID_DB_STEP = 2;
const GRID_MAX_CODE = 15;

/**
 * 4-bit grid quantization: dB below the grid's max, 2 dB steps, clamped
 * 0-15 (15 = -30 dB or silence).
 */
export function quantizeGrid(linearMags: number[]): number[] {
  const max = Math.max(...linearMags);
  return linearMags.map((m) => {
    if (max <= 0 || m <= 0) return GRID_MAX_CODE;
    const db = 20 * Math.log10(m / max);
    const code = Math.round(-db / GRID_DB_STEP);
    return Math.min(GRID_MAX_CODE, Math.max(0, code));
  });
}

/** Inverse of quantizeGrid: relative linear mags (max = 1). */
export function dequantizeGrid(q: number[]): number[] {
  return q.map((code) => {
    const db = -GRID_DB_STEP * code;
    return Math.pow(10, db / 20);
  });
}

/** Pack 64 4-bit codes into 32 bytes, high nibble first. */
function packGrid(q: number[]): Uint8Array {
  const out = new Uint8Array(GRID_PACKED_BYTES);
  for (let i = 0; i < GRID_PACKED_BYTES; i++) {
    out[i] = ((q[2 * i] & 0xf) << 4) | (q[2 * i + 1] & 0xf);
  }
  return out;
}

/** Unpack 32 bytes into 64 4-bit codes. */
function unpackGrid(bytes: Uint8Array): number[] {
  const q: number[] = [];
  for (let i = 0; i < GRID_PACKED_BYTES; i++) {
    q.push((bytes[i] >> 4) & 0xf, bytes[i] & 0xf);
  }
  return q;
}

/**
 * Round a Hz value to a 1-255 bin on the BAND_CARD_BIN_HZ grid, throwing on
 * out-of-range values instead of silently truncating mod 256 (config error,
 * not a channel condition) — same discipline as `encodeBandCard`.
 */
function toBin(hz: number, label: string): number {
  const bin = Math.round(hz / BAND_CARD_BIN_HZ);
  if (bin < 1 || bin > 255) throw new Error(`control frame: ${label} ${hz} Hz out of range`);
  return bin;
}

/** Pack a BestRangeClaim into 3 bytes: lowBin, highBin, maxQamOrder. */
function packClaim(claim: BestRangeClaim): Uint8Array {
  if (claim.maxQamOrder < 0 || claim.maxQamOrder > 255) {
    throw new Error(`control frame: maxQamOrder ${claim.maxQamOrder} out of range`);
  }
  const out = new Uint8Array(3);
  out[0] = toBin(claim.lowHz, 'lowHz');
  out[1] = toBin(claim.highHz, 'highHz');
  out[2] = claim.maxQamOrder;
  return out;
}

function unpackClaim(bytes: Uint8Array): BestRangeClaim {
  return {
    lowHz: bytes[0] * BAND_CARD_BIN_HZ,
    highHz: bytes[1] * BAND_CARD_BIN_HZ,
    maxQamOrder: bytes[2],
  };
}

/** WELCOME payload: 3-byte claim + 32-byte quantized grid = 35 B. */
export function packWelcome(p: WelcomePayload): Uint8Array {
  const out = new Uint8Array(3 + GRID_PACKED_BYTES);
  out.set(packClaim(p.claim), 0);
  out.set(packGrid(quantizeGrid(p.grid)), 3);
  return out;
}

export function parseWelcome(b: Uint8Array): WelcomePayload | null {
  if (b.length < 3 + GRID_PACKED_BYTES) return null;
  const claim = unpackClaim(b.slice(0, 3));
  const grid = dequantizeGrid(unpackGrid(b.slice(3, 3 + GRID_PACKED_BYTES)));
  return { claim, grid };
}

/** REPORT payload: 32-byte quantized grid. */
export function packReport(grid: number[]): Uint8Array {
  return packGrid(quantizeGrid(grid));
}

export function parseReport(b: Uint8Array): number[] | null {
  if (b.length < GRID_PACKED_BYTES) return null;
  return dequantizeGrid(unpackGrid(b));
}

/** FILE_COMING payload: pilotBin, startBin, toneCountCode, settle, fileBytes u32 LE, durationMs u32 LE = 12 B. */
export function packFileComing(p: FileComingPayload): Uint8Array {
  const toneCountCode = BAND_CARD_TONE_COUNTS.indexOf(
    p.toneCount as (typeof BAND_CARD_TONE_COUNTS)[number],
  );
  if (toneCountCode < 0) throw new Error(`control frame: toneCount ${p.toneCount} not in ${BAND_CARD_TONE_COUNTS}`);

  if (p.settleSymbols < 0 || p.settleSymbols > 255) {
    throw new Error(`control frame: settleSymbols ${p.settleSymbols} out of range`);
  }

  const out = new Uint8Array(12);
  out[0] = toBin(p.pilotFreqHz, 'pilotFreqHz');
  out[1] = toBin(p.toneStartHz, 'toneStartHz');
  out[2] = toneCountCode;
  out[3] = p.settleSymbols;
  const view = new DataView(out.buffer);
  view.setUint32(4, p.fileBytes, true);
  view.setUint32(8, p.durationMs, true);
  return out;
}

export function parseFileComing(b: Uint8Array): FileComingPayload | null {
  if (b.length < 12) return null;
  const toneCount = BAND_CARD_TONE_COUNTS[b[2]];
  if (toneCount === undefined) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    pilotFreqHz: b[0] * BAND_CARD_BIN_HZ,
    toneStartHz: b[1] * BAND_CARD_BIN_HZ,
    toneCount,
    settleSymbols: b[3],
    fileBytes: view.getUint32(4, true),
    durationMs: view.getUint32(8, true),
  };
}
