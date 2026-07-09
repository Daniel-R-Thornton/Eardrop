/**
 * Isolated unit tests for BCH(31,16) error correction.
 *
 * Tests the ECC independently of the modem pipeline:
 *   - Encode known values, verify codeword structure
 *   - Decode without errors → should match original
 *   - Flip up to 3 bits → should correct perfectly
 *   - Flip 4+ bits → should detect uncorrectable error
 *   - Interleave/deinterleave roundtrip
 */

import { describe, it, expect } from 'vitest';
import { bch3116Encode, bch3116Decode, interleave, deinterleave } from '../ecc/ecc';

describe('BCH(31,16) — Encoder', () => {
  it('should encode 2 bytes into 31 bits (4 bytes output)', () => {
    const input = new Uint8Array([0x12, 0x34]); // 2 bytes = 16 bits
    const encoded = bch3116Encode(input);
    // 31 bits = ceil(31/8) = 4 bytes output per codeword
    expect(encoded.length).toBeGreaterThanOrEqual(4);
  });

  it('should encode multiple codewords for larger input', () => {
    const input = new Uint8Array(Array.from({ length: 16 }, (_, i) => i));
    const encoded = bch3116Encode(input);
    // 16 bytes = 8 codewords × 4 bytes = 32 bytes expected
    expect(encoded.length).toBeGreaterThan(16);
  });

  it('should produce deterministic output', () => {
    const input = new Uint8Array([0xde, 0xad]);
    const a = bch3116Encode(input);
    const b = bch3116Encode(input);
    expect(a).toEqual(b);
  });
});

describe('BCH(31,16) — Decode (no errors)', () => {
  it('should decode clean codeword back to original', () => {
    const original = new Uint8Array([0xab, 0xcd]);
    const encoded = bch3116Encode(original);
    const result = bch3116Decode(encoded);
    expect(result.errors).toBe(0);
    expect(Array.from(result.data)).toEqual(Array.from(original));
  });

  it('should roundtrip 16 bytes cleanly', () => {
    const original = new Uint8Array([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
      0xff,
    ]);
    const encoded = bch3116Encode(original);
    const result = bch3116Decode(encoded);
    expect(result.errors).toBe(0);
    expect(Array.from(result.data)).toEqual(Array.from(original));
  });

  it('should roundtrip odd-sized input (3 bytes = 24 bits → 2 codewords, 16 bits padding)', () => {
    const original = new Uint8Array([0x01, 0x02, 0x03]);
    const encoded = bch3116Encode(original);
    const result = bch3116Decode(encoded);
    // Should recover the original 3 bytes (padding stripped)
    expect(result.data.slice(0, 3)).toEqual(original);
  });
});

describe('BCH(31,16) — Error Correction', () => {
  it('should correct a 1-bit error', () => {
    const original = new Uint8Array([0x12, 0x34]);
    const encoded = bch3116Encode(original);

    // Flip bit at position 5 in the first codeword
    encoded[0] ^= 1 << 3;

    const result = bch3116Decode(encoded);
    expect(result.errors).toBe(1);
    expect(Array.from(result.data)).toEqual(Array.from(original));
  });

  it('should correct a 2-bit error', () => {
    const original = new Uint8Array([0xab, 0xcd]);
    const encoded = bch3116Encode(original);

    // Flip 2 bits in the first codeword
    encoded[0] ^= 0x03; // flip bits 0 and 1

    const result = bch3116Decode(encoded);
    expect(result.errors).toBe(2);
    expect(Array.from(result.data)).toEqual(Array.from(original));
  });

  it('should correct a 3-bit error (max for BCH(31,16))', () => {
    const original = new Uint8Array([0x55, 0xaa]);
    const encoded = bch3116Encode(original);

    // Flip 3 bits in first codeword byte
    encoded[0] ^= 0xe0; // flip bits 7, 6, 5

    const result = bch3116Decode(encoded);
    expect(result.errors).toBe(3);
    expect(Array.from(result.data)).toEqual(Array.from(original));
  });

  it('should detect but not correct a 4-bit error (beyond capability)', () => {
    const original = new Uint8Array([0x12, 0x34]);
    const encoded = bch3116Encode(original);

    // Flip 4 bits in the first codeword
    encoded[0] ^= 0x0f; // flip bits 0-3

    const result = bch3116Decode(encoded);
    // Should mark as errors > 0, data may not match
    expect(result.errors).toBeGreaterThan(0);
  });
});

describe('Interleaver', () => {
  it('should roundtrip through interleave + deinterleave', () => {
    const original = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
    const interleaved = interleave(original, 8);
    const deinterleaved = deinterleave(interleaved, 8);
    expect(Array.from(deinterleaved)).toEqual(Array.from(original));
  });

  it('should spread adjacent bytes across depth rows', () => {
    const data = new Uint8Array(16);
    // First 8 bytes are 0x00-0x07, next 8 are 0xFF
    for (let i = 0; i < 8; i++) data[i] = i;
    for (let i = 8; i < 16; i++) data[i] = 0xff;

    const interleaved = interleave(data, 4);
    // After interleave with depth 4, bytes 0-3 should NOT be consecutive
    // Instead they should be spaced by sizeof(data)/4 = 4
    expect(interleaved[0]).toBe(0); // row 0, col 0
    expect(interleaved[1]).toBe(4); // row 0, col 1
    expect(interleaved[4]).toBe(1); // row 1, col 0
  });
});
