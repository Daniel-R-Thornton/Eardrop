/**
 * bandCard.test.ts — compact handshake announcement codec.
 */
import { describe, expect, it } from 'vitest';
import {
  BAND_CARD_TONE_COUNTS,
  BAND_CARD_WIRE_SIZE,
  type BandCard,
  decodeBandCard,
  encodeBandCard,
} from '../protocol/bandCard';
import { SENTINEL_BYTES, SENTINEL_SIZE } from '../protocol/atomicFrame';

const BENCH: BandCard = { pilotFreqHz: 1850, toneStartHz: 5250, toneCount: 16, settleSymbols: 16 };

const body = (wire: Uint8Array) => wire.slice(SENTINEL_SIZE);

describe('band card codec', () => {
  it('round-trips the bench config', () => {
    const wire = encodeBandCard(BENCH);
    expect(wire.length).toBe(BAND_CARD_WIRE_SIZE);
    expect(Array.from(wire.slice(0, SENTINEL_SIZE))).toEqual(Array.from(SENTINEL_BYTES));
    expect(decodeBandCard(body(wire))).toEqual(BENCH);
  });

  it('round-trips every tone count and field extremes', () => {
    for (const toneCount of BAND_CARD_TONE_COUNTS) {
      for (const card of [
        { pilotFreqHz: 50, toneStartHz: 50, toneCount, settleSymbols: 0 },
        { pilotFreqHz: 12750, toneStartHz: 12750, toneCount, settleSymbols: 63 },
      ]) {
        expect(decodeBandCard(body(encodeBandCard(card)))).toEqual(card);
      }
    }
  });

  it('corrects bit errors within BCH capacity', () => {
    const wire = encodeBandCard(BENCH);
    const damaged = body(wire);
    // 3 bit flips in each codeword — well inside BCH(63,30)'s t=6.
    for (const cw of [0, 1, 2]) {
      damaged[cw * 8 + 1] ^= 0x01;
      damaged[cw * 8 + 3] ^= 0x10;
      damaged[cw * 8 + 6] ^= 0x80;
    }
    expect(decodeBandCard(damaged)).toEqual(BENCH);
  });

  it('rejects garbage, wrong magic and CRC damage', () => {
    expect(decodeBandCard(new Uint8Array(24))).toBeNull();
    expect(decodeBandCard(new Uint8Array(24).fill(0xff))).toBeNull();
    expect(decodeBandCard(new Uint8Array(5))).toBeNull();
    // Uncorrectable: saturate one codeword with errors.
    const wire = body(encodeBandCard(BENCH));
    const trashed = wire.slice();
    for (let i = 0; i < 8; i++) trashed[i] ^= 0xa7;
    expect(decodeBandCard(trashed)).toBeNull();
  });

  it('throws on values the card cannot express', () => {
    expect(() => encodeBandCard({ ...BENCH, pilotFreqHz: 20000 })).toThrow();
    expect(() => encodeBandCard({ ...BENCH, toneCount: 12 })).toThrow();
    expect(() => encodeBandCard({ ...BENCH, settleSymbols: 64 })).toThrow();
    expect(() => encodeBandCard({ ...BENCH, toneStartHz: 0 })).toThrow();
  });
});
