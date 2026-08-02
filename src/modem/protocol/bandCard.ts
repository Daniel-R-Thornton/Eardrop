/**
 * Band card — the compact handshake announcement.
 *
 * With bandHandshake enabled the TX opens on the fixed OFDM_HANDSHAKE band
 * and needs to tell the receiver WHERE the real transmission will be. The
 * v2 link-profile frame did that job before, but it rides the full 232-byte
 * atomic frame at the handshake band's 2 bytes/symbol — 116 symbols (2.9 s)
 * per copy, ~90% of it padding. The card carries the same tuning facts in
 * 9 raw bytes by table/bin coding every field:
 *
 *   byte 0  MAGIC (0xB5) — identifies a card and versions the layout
 *   byte 1  pilot bin      = pilotFreqHz / 50  (the OFDM grid is 50 Hz at
 *   byte 2  tone-start bin = toneStartHz / 50   any rate: 1000 ms / 20 ms)
 *   byte 3  toneCount code (2 bits, TONE_COUNT_TABLE) | settle count (6 bits)
 *   byte 4  CRC-8 over bytes 0-3
 *   bytes 5-8 reserved (0)
 *
 * Wire format: SENTINEL (3 B) + BCH(63,30)x3 (24 B) = 27 bytes → 14 QPSK
 * symbols on the 8-tone handshake band (0.35 s per copy vs 2.9 s).
 *
 * The card is ONLY radio tuning — where to listen and how long the settle
 * period is. Everything else (qamMap, eccT, …) rides the normal in-band
 * link profile of the target-band transmission, exactly as with the flag
 * off. That keeps the post-hop waveform byte-identical to a non-handshake
 * transmission.
 */
import { bch63Encode, bch63Decode } from '../ecc/bch63';
import { SENTINEL_BYTES, SENTINEL_SIZE, BCH_HEADER_SIZE } from './atomicFrame';

/** First card byte — layout version + "this is a card, not a frame header". */
export const BAND_CARD_MAGIC = 0xb5;

/** Tone counts expressible in the card's 2-bit code. */
export const BAND_CARD_TONE_COUNTS = [4, 8, 16, 32] as const;

/** Frequency grid the card's bin fields count in (50 Hz at any rate). */
export const BAND_CARD_BIN_HZ = 50;

/** Raw (pre-BCH) card size. */
export const BAND_CARD_RAW_SIZE = 9;

/** Wire size: sentinel + BCH(63,30)x3. */
export const BAND_CARD_WIRE_SIZE = SENTINEL_SIZE + BCH_HEADER_SIZE;

/** How many copies the TX sends (a lost card kills the whole transfer). */
export const BAND_CARD_REPEATS = 3;

export interface BandCard {
  /** Target-band pilot frequency in Hz (multiple of BAND_CARD_BIN_HZ). */
  pilotFreqHz: number;
  /** Target-band tone-grid start, Hz above the pilot (multiple of BAND_CARD_BIN_HZ). */
  toneStartHz: number;
  /** Target-band tone count — one of BAND_CARD_TONE_COUNTS. */
  toneCount: number;
  /** Settle symbols the target-band preamble uses (TX and RX must agree). */
  settleSymbols: number;
}

/** CRC-8 (poly 0x07, init 0) over a byte range. */
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

/**
 * Encode a card to its 27-byte wire form (sentinel + BCH). Throws on values
 * the card cannot express — those are config errors, not channel conditions.
 */
export function encodeBandCard(card: BandCard): Uint8Array {
  const pilotBin = Math.round(card.pilotFreqHz / BAND_CARD_BIN_HZ);
  const startBin = Math.round(card.toneStartHz / BAND_CARD_BIN_HZ);
  const countCode = BAND_CARD_TONE_COUNTS.indexOf(
    card.toneCount as (typeof BAND_CARD_TONE_COUNTS)[number],
  );
  if (pilotBin < 1 || pilotBin > 255) throw new Error(`band card: pilot ${card.pilotFreqHz} Hz out of range`);
  if (startBin < 1 || startBin > 255) throw new Error(`band card: toneStart ${card.toneStartHz} Hz out of range`);
  if (countCode < 0) throw new Error(`band card: toneCount ${card.toneCount} not in ${BAND_CARD_TONE_COUNTS}`);
  if (card.settleSymbols < 0 || card.settleSymbols > 63) throw new Error(`band card: settle ${card.settleSymbols} out of range`);

  const raw = new Uint8Array(BAND_CARD_RAW_SIZE);
  raw[0] = BAND_CARD_MAGIC;
  raw[1] = pilotBin;
  raw[2] = startBin;
  raw[3] = ((countCode & 0x3) << 6) | (card.settleSymbols & 0x3f);
  raw[4] = crc8(raw, 0, 4);

  // BCH(63,30) x 3, three meaningful bytes per codeword (same chunking as the
  // atomic frame header — the 4th byte of each chunk loses its bottom 2 bits).
  const wire = new Uint8Array(BAND_CARD_WIRE_SIZE);
  wire.set(SENTINEL_BYTES, 0);
  for (let c = 0; c < 3; c++) {
    const chunk = new Uint8Array(4);
    chunk[0] = raw[c * 3];
    chunk[1] = raw[c * 3 + 1];
    chunk[2] = raw[c * 3 + 2];
    wire.set(bch63Encode(chunk), SENTINEL_SIZE + c * 8);
  }
  return wire;
}

/**
 * Decode the 24 post-sentinel wire bytes back to a card. Returns null when
 * the bytes are not a valid card (BCH uncorrectable, wrong magic, CRC
 * mismatch, unusable field) — the scanner treats that as "keep looking".
 */
export function decodeBandCard(body: Uint8Array): BandCard | null {
  if (body.length < BCH_HEADER_SIZE) return null;
  const raw = new Uint8Array(BAND_CARD_RAW_SIZE);
  for (let c = 0; c < 3; c++) {
    const res = bch63Decode(body.slice(c * 8, (c + 1) * 8));
    if (!res.valid) return null;
    raw[c * 3] = res.data[0];
    raw[c * 3 + 1] = res.data[1];
    raw[c * 3 + 2] = res.data[2];
  }
  if (raw[0] !== BAND_CARD_MAGIC) return null;
  if (crc8(raw, 0, 4) !== raw[4]) return null;
  const pilotFreqHz = raw[1] * BAND_CARD_BIN_HZ;
  const toneStartHz = raw[2] * BAND_CARD_BIN_HZ;
  const toneCount = BAND_CARD_TONE_COUNTS[(raw[3] >> 6) & 0x3];
  const settleSymbols = raw[3] & 0x3f;
  if (pilotFreqHz <= 0 || toneStartHz <= 0) return null;
  return { pilotFreqHz, toneStartHz, toneCount, settleSymbols };
}
