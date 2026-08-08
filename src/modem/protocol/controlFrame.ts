/**
 * Control frame — small room-control messages on the fixed handshake band.
 *
 * Chatter rooms need to pass WELCOME/REPORT/FILE_COMING/BYE control traffic
 * between devices without ever leaving the handshake band (the same band
 * `bandCard.ts` uses to announce a target-band hop). A control message is a
 * 9-byte BCH-coded header — same sentinel + BCH(63,30)x3 skeleton as the
 * band card — followed by a variable-length BCH-coded payload (0-255 raw
 * bytes; the ceiling is the `payloadLen` header byte itself, not any
 * per-message-type size — see CONTROL_PAYLOAD_MAX below):
 *
 *   Header (9 raw bytes, BCH-chunked exactly like the band card):
 *     byte 0  CONTROL_MAGIC (0xC7) — identifies a control header, not a card
 *     byte 1  ControlType
 *     byte 2  senderId (1-255)
 *     byte 3  targetId (0 = broadcast)
 *     byte 4  payloadLen (raw bytes, 0-255)
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
import { sanitizeNickname } from '../../lib/identity';

/** First control-header byte — distinguishes a control frame from a band card. */
export const CONTROL_MAGIC = 0xc7;

export enum ControlType {
  Welcome = 1,
  Report = 2,
  FileComing = 3,
  Bye = 4,
  Text = 5,
  Ack = 6,
}

export interface ControlMessage {
  type: ControlType;
  senderId: number; // 1-255
  targetId: number; // 0 = broadcast
  payload: Uint8Array; // 0-255 raw bytes
}

/** Raw (pre-BCH) header size. */
const CONTROL_HEADER_RAW_SIZE = 9;

/** Wire bytes of sentinel + BCH-coded header. */
export const CONTROL_HEADER_WIRE = SENTINEL_SIZE + BCH_HEADER_SIZE; // 27

/**
 * Largest raw payload a control message may carry.
 *
 * 255, not the 48 this shipped with. 48 was never structural — it was picked
 * so the largest payload then in use (WELCOME's 35 bytes) "still fits a
 * handful of codewords". The header carries `payloadLen` as a full byte, so
 * the frame is already variable-length and self-describing: the receiver
 * reads exactly as many bytes as the header declares, and 255 is that field's
 * true ceiling.
 *
 * Nothing downstream assumed the smaller value — SentinelScanner's collect
 * size is retargeted per message via `continueCollecting`, and both that
 * sizing and `decodeControlPayload` read `header.payloadLen`.
 *
 * COST OF A LONG PAYLOAD: BCH decodes per three-byte chunk and
 * `bchDecodeChunks` returns null if ANY chunk is uncorrectable, so a control
 * message is all-or-nothing. A 255-byte payload is 86 chunks — one bad chunk
 * loses the whole message. A message this long is also ~10.4 s of air, four
 * times anything the control plane previously carried, which is why the
 * receiver's sync watchdog had to become length-aware (see rxEngine's
 * OFDM_WATCHDOG_WINDOWS).
 */
export const CONTROL_PAYLOAD_MAX = 255;

/** Largest text a TEXT payload can carry: the payload cap less the 1-byte
 *  msgId. Counted in UTF-8 BYTES, not characters — an emoji is 4. */
export const TEXT_MAX_BYTES = CONTROL_PAYLOAD_MAX - 1;

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
  /**
   * Optional human-readable name for the sender, so peers can label each other
   * with something better than an 8-bit hex id. Absent when the user has not
   * set one — see packWelcome for why absence is a distinct wire case rather
   * than an empty string.
   */
  nickname?: string;
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

/** Bytes before the optional nickname: 3-byte claim + 32-byte grid. */
const WELCOME_FIXED_BYTES = 3 + GRID_PACKED_BYTES;

/**
 * WELCOME payload: 3-byte claim + 32-byte quantized grid = 35 B, then — only
 * when a nickname is set — a 1-byte length and that many UTF-8 bytes.
 *
 * APPENDED, and omitted entirely when there is no nickname, on purpose. This is
 * a live acoustic protocol being changed while a sync/ACK investigation is open,
 * so the extension is deliberately one an old build cannot notice:
 *
 *  - Old parser, new sender: `parseWelcome` has always tested `length <` its
 *    fixed size and ignored anything past the grid, so trailing name bytes are
 *    skipped rather than misread.
 *  - New parser, old sender: a 35-byte payload simply has no name, which is
 *    exactly how "no nickname" is already represented.
 *  - No nickname set: the payload is byte-identical to the pre-nickname format,
 *    so nobody pays airtime — or the extra BCH chunks' all-or-nothing loss risk
 *    (see NICKNAME_MAX_BYTES) — for a feature they are not using.
 *
 * The name is sanitized and byte-truncated here rather than trusted from the
 * caller, so an over-long or exotic nickname cannot silently push the payload
 * past its declared length.
 */
export function packWelcome(p: WelcomePayload): Uint8Array {
  const nick = p.nickname ? sanitizeNickname(p.nickname) : '';
  const nameBytes = nick ? new TextEncoder().encode(nick) : new Uint8Array(0);
  const extra = nameBytes.length > 0 ? 1 + nameBytes.length : 0;

  const out = new Uint8Array(WELCOME_FIXED_BYTES + extra);
  out.set(packClaim(p.claim), 0);
  out.set(packGrid(quantizeGrid(p.grid)), 3);
  if (extra > 0) {
    out[WELCOME_FIXED_BYTES] = nameBytes.length;
    out.set(nameBytes, WELCOME_FIXED_BYTES + 1);
  }
  return out;
}

export function parseWelcome(b: Uint8Array): WelcomePayload | null {
  if (b.length < WELCOME_FIXED_BYTES) return null;
  const claim = unpackClaim(b.slice(0, 3));
  const grid = dequantizeGrid(unpackGrid(b.slice(3, WELCOME_FIXED_BYTES)));

  // Everything past the grid is optional. A declared length that overruns the
  // payload means a corrupt or foreign frame: drop the NAME, keep the claim and
  // grid, because those already passed the payload CRC and the room's band
  // decisions depend on them. A cosmetic field must not cost a valid WELCOME.
  let nickname: string | undefined;
  if (b.length > WELCOME_FIXED_BYTES) {
    const len = b[WELCOME_FIXED_BYTES];
    const start = WELCOME_FIXED_BYTES + 1;
    if (len > 0 && start + len <= b.length) {
      const decoded = new TextDecoder().decode(b.slice(start, start + len));
      const clean = sanitizeNickname(decoded);
      if (clean) nickname = clean;
    }
  }

  return nickname === undefined ? { claim, grid } : { claim, grid, nickname };
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

/** UTF-8 byte length of `text` — what the TEXT cap is measured in, and what a
 *  composer's live counter must display. `text.length` is UTF-16 code units
 *  and would under-count every emoji. */
export function textByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * TEXT payload: [msgId:1][utf8 text: 0..TEXT_MAX_BYTES].
 *
 * `msgId` is monotonic per sender and wraps at 256; the receiver dedupes on
 * (senderId, msgId). Throws rather than truncating an over-long message:
 * cutting UTF-8 at a byte boundary can split a codepoint and put invalid
 * bytes on the air, and `encodeControlMessage` would reject the oversized
 * payload anyway. Callers must check `textByteLength` first.
 */
export function packText(msgId: number, text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > TEXT_MAX_BYTES) {
    throw new Error(`control frame: text ${bytes.length} B exceeds ${TEXT_MAX_BYTES} B cap`);
  }
  const out = new Uint8Array(1 + bytes.length);
  out[0] = msgId & 0xff;
  out.set(bytes, 1);
  return out;
}

export function parseText(b: Uint8Array): { msgId: number; text: string } | null {
  if (b.length < 1) return null;
  return { msgId: b[0], text: new TextDecoder().decode(b.subarray(1)) };
}

/**
 * ACK payload: [msgId:1].
 *
 * Nothing else is needed to identify the acked message: an ACK's `targetId`
 * is the original sender and its `senderId` is the acknowledging device, so
 * (targetId, msgId) is unique — msgId is only ever unique per sender.
 */
export function packAck(msgId: number): Uint8Array {
  return new Uint8Array([msgId & 0xff]);
}

export function parseAck(b: Uint8Array): { msgId: number } | null {
  if (b.length < 1) return null;
  return { msgId: b[0] };
}
