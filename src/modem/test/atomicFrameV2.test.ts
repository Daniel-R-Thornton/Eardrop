/**
 * Frame geometry V2 — multiple RS(52,40) blocks per frame.
 */
import { expect, test } from 'vitest';
import {
  encodeFrame,
  decodeFrame,
  FRAME_SIZE,
  PAYLOAD_DATA_SIZE,
  PAYLOAD_BLOCKS,
  SENTINEL_SIZE,
  BCH_HEADER_SIZE,
} from '../protocol/atomicFrame';

test('frame geometry: 4 RS blocks, 160-byte payload, 235-byte frame', () => {
  expect(PAYLOAD_BLOCKS).toBe(4);
  expect(PAYLOAD_DATA_SIZE).toBe(160);
  expect(FRAME_SIZE).toBe(235);
});

test('roundtrip: full 160-byte payload survives encode → decode', () => {
  const payload = new Uint8Array(PAYLOAD_DATA_SIZE);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 11) & 0xff;
  const frame = encodeFrame({ type: 0x02, seqNum: 7, totalFrames: 9, crc: 0 }, payload);
  expect(frame.length).toBe(FRAME_SIZE);

  const dec = decodeFrame(frame);
  expect(dec.valid).toBe(true);
  expect(dec.header!.type).toBe(0x02);
  expect(dec.header!.seqNum).toBe(7);
  expect(dec.header!.totalFrames).toBe(9);
  expect(dec.payload.length).toBe(PAYLOAD_DATA_SIZE);
  expect(Array.from(dec.payload)).toEqual(Array.from(payload));
});

test('each RS block independently corrects up to 6 byte errors', () => {
  const payload = new Uint8Array(PAYLOAD_DATA_SIZE);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 53 + 3) & 0xff;
  const frame = encodeFrame({ type: 0x02, seqNum: 1, totalFrames: 2, crc: 0 }, payload);

  // RS bytes are striped round-robin across the 4 blocks on the wire: block
  // b's byte at index `off` (0-51) lives at wire position rsStart + off*4 + b
  // (see atomicFrame.ts encodeFrame/decodeFrame). Corrupt the same 6
  // per-block indices as before, translated through the stripe.
  const rsStart = SENTINEL_SIZE + BCH_HEADER_SIZE;
  for (let b = 0; b < PAYLOAD_BLOCKS; b++) {
    // 6 corrupted bytes per 52-byte block — RS(52,40) correction limit
    for (const off of [0, 9, 18, 27, 36, 51]) {
      frame[rsStart + off * PAYLOAD_BLOCKS + b] ^= 0xff;
    }
  }

  const dec = decodeFrame(frame);
  expect(dec.valid).toBe(true);
  expect(Array.from(dec.payload)).toEqual(Array.from(payload));
});

test('burst tolerance: 8 consecutive corrupted wire bytes in the RS region still decode', () => {
  // One corrupted 25ms OFDM symbol ~= 8 consecutive wire bytes. With RS bytes
  // striped round-robin across the 4 blocks (wire byte j carries block j%4),
  // any 8 consecutive wire bytes hit each block exactly twice — comfortably
  // inside RS(52,40)'s t=6 correction limit. A contiguous (non-striped)
  // layout would dump all 8 into one block and kill the frame.
  const payload = new Uint8Array(PAYLOAD_DATA_SIZE);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 29 + 5) & 0xff;
  const frame = encodeFrame({ type: 0x02, seqNum: 3, totalFrames: 5, crc: 0 }, payload);

  const rsStart = SENTINEL_SIZE + BCH_HEADER_SIZE;
  // Pick a burst location well inside the RS region, away from the edges.
  const burstStart = rsStart + 40;
  for (let i = 0; i < 8; i++) {
    frame[burstStart + i] ^= 0xff;
  }

  const dec = decodeFrame(frame);
  expect(dec.valid).toBe(true);
  expect(Array.from(dec.payload)).toEqual(Array.from(payload));
});

test('short payload (40 bytes) still encodes — remaining blocks zero-pad', () => {
  const payload = new Uint8Array(40).fill(0xab);
  const frame = encodeFrame({ type: 0x01, seqNum: 0, totalFrames: 1, crc: 0 }, payload);
  const dec = decodeFrame(frame);
  expect(dec.valid).toBe(true);
  expect(Array.from(dec.payload.slice(0, 40))).toEqual(Array.from(payload));
  expect(dec.payload.slice(40).every((b) => b === 0)).toBe(true);
});
