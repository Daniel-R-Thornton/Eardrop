/**
 * linkProfile.test.ts — pure pack/unpack roundtrip for the Phase 4 profile frame.
 */
import { expect, test } from 'vitest';
import {
  packLinkProfile,
  parseLinkProfile,
  DEFAULT_LINK_PROFILE,
  QamOrder,
  type LinkProfile,
} from '../protocol/linkProfile';
import { PAYLOAD_DATA_SIZE } from '../protocol/atomicFrame';

test('pack produces exactly PAYLOAD_DATA_SIZE (160) bytes', () => {
  const p = DEFAULT_LINK_PROFILE(32);
  const packed = packLinkProfile(p);
  expect(packed.length).toBe(PAYLOAD_DATA_SIZE);
});

test('default profile: all-QPSK, t=6, cpId=0', () => {
  const p = DEFAULT_LINK_PROFILE(32);
  expect(p.eccT).toBe(6);
  expect(p.cpId).toBe(0);
  expect(p.qamMap.every((q) => q === QamOrder.QPSK)).toBe(true);
  const parsed = parseLinkProfile(packLinkProfile(p));
  expect(parsed).toEqual(p);
});

const cases: LinkProfile[] = [
  DEFAULT_LINK_PROFILE(4),
  DEFAULT_LINK_PROFILE(32),
  { ver: 1, flags: 0, eccT: 2, cpId: 1, toneCount: 8, qamMap: [0, 1, 2, 3, 0, 1, 2, 3] },
  { ver: 1, flags: 0, eccT: 4, cpId: 0, toneCount: 1, qamMap: [2] },
  {
    ver: 1,
    flags: 0,
    eccT: 6,
    cpId: 0,
    toneCount: 32,
    qamMap: Array.from({ length: 32 }, (_, i) => i % 4),
  },
];

for (const [i, profile] of cases.entries()) {
  test(`pack → parse round-trip #${i} (toneCount=${profile.toneCount}, eccT=${profile.eccT}, cpId=${profile.cpId})`, () => {
    const packed = packLinkProfile(profile);
    expect(packed.length).toBe(PAYLOAD_DATA_SIZE);
    const parsed = parseLinkProfile(packed);
    expect(parsed).toEqual(profile);
  });
}

test('corrupted payload (flipped byte) fails crc32 → parseLinkProfile returns null', () => {
  const profile = DEFAULT_LINK_PROFILE(16);
  const packed = packLinkProfile(profile);
  // Flip a bit deep in the qamMap region (still within the pre-crc range).
  const corrupted = new Uint8Array(packed);
  corrupted[6] ^= 0xff;
  expect(parseLinkProfile(corrupted)).toBeNull();
});

test('corrupted crc field itself also fails', () => {
  const profile = DEFAULT_LINK_PROFILE(16);
  const packed = packLinkProfile(profile);
  const corrupted = new Uint8Array(packed);
  // toneCount=16 → mapLen=4 → preCrcLen=9 → crc bytes at [9..12]
  corrupted[9] ^= 0x01;
  expect(parseLinkProfile(corrupted)).toBeNull();
});

test('unsupported version returns null', () => {
  const profile = DEFAULT_LINK_PROFILE(4);
  const packed = packLinkProfile(profile);
  const bumped = new Uint8Array(packed);
  bumped[0] = 2; // ver
  expect(parseLinkProfile(bumped)).toBeNull();
});

test('truncated/short payload → null, no throw', () => {
  expect(() => parseLinkProfile(new Uint8Array(0))).not.toThrow();
  expect(parseLinkProfile(new Uint8Array(0))).toBeNull();

  expect(() => parseLinkProfile(new Uint8Array(3))).not.toThrow();
  expect(parseLinkProfile(new Uint8Array(3))).toBeNull();

  // Just the fixed 5-byte header but toneCount implies a longer qamMap+crc
  // than what's actually present.
  const shortHeader = new Uint8Array([1, 0, 6, 0, 32]); // toneCount=32, nothing else
  expect(() => parseLinkProfile(shortHeader)).not.toThrow();
  expect(parseLinkProfile(shortHeader)).toBeNull();
});

test('mixed qamMap values pack/unpack bit-exact across a byte boundary (5 tones)', () => {
  // 5 tones × 2 bits = 10 bits → 2 bytes; exercises the partial top byte.
  const profile: LinkProfile = {
    ver: 1,
    flags: 0,
    eccT: 6,
    cpId: 0,
    toneCount: 5,
    qamMap: [3, 2, 1, 0, 3],
  };
  const packed = packLinkProfile(profile);
  const parsed = parseLinkProfile(packed);
  expect(parsed).toEqual(profile);
});
